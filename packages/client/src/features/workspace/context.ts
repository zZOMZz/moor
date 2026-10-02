import { publicAgentFailure } from '@moor/protocol/agent-errors';
import type { HostCommand } from '@moor/protocol/host-command';
import { validateHostResponse } from '@moor/protocol/host-response';
import { RequestFailure } from '@moor/protocol/request-failure';
import { type WorkspaceRequest } from '@moor/protocol/workspace-client-protocol';
import { type WorkspaceScope } from '../../operations/workspace/compose';
import {
  Context,
  immutableSnapshot,
  resultSchema,
  WorkspaceClientState,
  WorkspaceOptions,
} from './model';

/** Capabilities consumed by context use cases; supplied only by the workspace composition root. */
export class WorkspaceContextService {
  constructor(readonly options: Pick<WorkspaceOptions, 'request' | 'uuid' | 'schedule'>) {}
  value: WorkspaceClientState = {
    catalogs: {},
    errors: {},
    sessions: [],
    offline: true,
    sessionLoad: { status: 'idle' },
  };
  snapshot?: WorkspaceClientState;
  generation = 0;
  closed = false;
  listeners = new Set<() => void>();
  get state() {
    const keys = Object.keys(this.value) as (keyof WorkspaceClientState)[];
    if (
      !this.snapshot ||
      keys.length !== Object.keys(this.snapshot).length ||
      keys.some(
        (key) => !Object.hasOwn(this.snapshot!, key) || this.snapshot![key] !== this.value[key],
      )
    )
      this.snapshot = immutableSnapshot({ ...this.value });
    return this.snapshot;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit() {
    // Navigation revisions also live outside #state. A notification publishes a
    // new root while unchanged immutable session/ledger branches stay shared.
    this.snapshot = undefined;
    for (const listener of this.listeners) listener();
  }
  get contextRevision() {
    return this.generation;
  }
  current() {
    const generation = this.generation;
    return () => {
      if (this.closed || generation !== this.generation)
        throw Error('当前电脑、项目或会话已改变，请重新读取。');
    };
  }
  resetSelection(
    value: Pick<
      WorkspaceClientState,
      'catalogs' | 'errors' | 'sessions' | 'offline' | 'sessionLoad'
    >,
  ) {
    this.value = value;
  }
  uuid() {
    return this.options.uuid();
  }
  schedule(milliseconds: number, work: () => void) {
    return this.options.schedule(milliseconds, work);
  }
  async request(request: WorkspaceRequest, current: () => void) {
    current();
    const result = resultSchema.parse(await this.options.request(structuredClone(request)));
    current();
    if (!result.ok)
      throw new RequestFailure(
        publicAgentFailure(
          Error(result.error.message),
          '执行电脑暂不可用，原草稿和待确认操作已保留。',
        ),
        result.error.code,
        result.error.status,
        result.error.rejected ? 'not-dispatched' : 'unconfirmed',
      );
    return result.value;
  }
  context(sessionId = this.value.sessionId): Context {
    const scope = this.value.scope,
      project = this.value.project;
    if (!scope || !project) throw Error('请先选择电脑和项目。');
    const catalog = this.value.catalogs[scope.source];
    if (!catalog || catalog.owner !== scope.target.owner) throw Error('请重新连接原电脑。');
    const current = this.current();
    return {
      scope: structuredClone(scope),
      project: structuredClone(project),
      sessionId,
      connectionId: catalog.connectionId,
      current,
    };
  }
  async execute(context: Context, command: HostCommand) {
    const { scope, sessionId, current, connectionId, project } = context;
    if (this.value.errors[scope.source]) throw Error('请重新连接原电脑；可以继续编辑本机草稿。');
    const raw = await this.request(
      {
        action: 'execute',
        source: scope.source,
        connectionId,
        target: { ...scope.target, ...(sessionId ? { sessionId } : {}) },
        command,
      },
      current,
    );
    const value = await validateHostResponse(raw, { command, workspace: project.runtime, current });
    current();
    return value;
  }
  command(scope: WorkspaceScope, method: HostCommand['method'], params: unknown): HostCommand {
    // All request variants are revalidated by the finite native boundary before dispatch.
    return {
      method,
      params,
      workspaceId: scope.target.workspaceId,
      localProjectId: scope.target.localProjectId,
    } as HostCommand;
  }
  dispose() {
    this.closed = true;
    this.generation++;
    this.listeners.clear();
  }
}
