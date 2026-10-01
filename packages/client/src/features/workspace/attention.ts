import { actorKey } from '@moor/protocol/attention';
import { AGENT_MODEL_OPTIONS_FEATURE, agentSchema } from '@moor/protocol/protocol';
import { SESSION_INTENTS_FEATURE } from '@moor/protocol/session-intent-protocol';
import {
  validateWorkspaceAttentionResponse,
  workspaceAttentionCommandSchema,
  type WorkspaceAttentionCommand,
} from '@moor/protocol/workspace-attention';
import { readClientSession } from '@moor/session/session-operations';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import {
  AttentionController,
  attentionPendingKey,
  attentionRouteSchema,
  attentionScopeKey,
  deliverAttention,
  type AttentionDependencies,
  type AttentionRoute,
} from '../attention/attention';
import { workspaceAttentionKey } from '../attention/workspace-attention';
import { buildSendTurn } from '../sessions/session-intent';
import type { WorkspaceCatalogService } from './catalog';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
import type { WorkspaceOptions } from './model';
import { same } from './model';
import type { WorkspaceSessionsService } from './sessions';
/** Capabilities consumed by attention use cases; supplied only by the workspace composition root. */
export interface WorkspaceAttentionPorts {
  drafts: Pick<WorkspaceDraftsService, 'flushDraft' | 'reloadLedger'>;
  context: Pick<
    WorkspaceContextService,
    'context' | 'value' | 'request' | 'uuid' | 'execute' | 'command'
  >;
  store: Pick<
    WorkspacePersistence,
    | 'read'
    | 'saveAttention'
    | 'exclusiveOperation'
    | 'readDraft'
    | 'attentionBlocked'
    | 'githubBlocked'
    | 'forkBlocked'
  >;
  sessions: Pick<WorkspaceSessionsService, 'refreshSession' | 'openSession'>;
  catalog: Pick<WorkspaceCatalogService, 'refreshSessions' | 'selectProject'>;
}
export class WorkspaceAttentionService {
  constructor(
    readonly ports: WorkspaceAttentionPorts,
    readonly options: Pick<WorkspaceOptions, 'now'>,
  ) {}
  async openAttention(changed: () => void = () => {}) {
    await this.ports.drafts.flushDraft();
    const base = this.ports.context.context(),
      catalog = structuredClone(this.ports.context.value.catalogs[base.scope.source]!);
    if (!catalog.actor) throw Error('原连接尚未提供可核对的待办账号，请重新连接或更新主机。');
    const actor = catalog.actor;
    let open = true;
    const current = () => {
      base.current();
      if (!open || !same(this.ports.context.value.catalogs[base.scope.source]?.actor, actor))
        throw Error('待办账号、面板或执行目标已改变。');
    };
    const projects = catalog.targets.filter(
      (entry) => entry.target.catalogWorkspaceId === base.scope.target.catalogWorkspaceId,
    );
    const routes = projects.map((project) => ({
      origin: catalog.origin,
      actor,
      catalogWorkspaceId: project.target.catalogWorkspaceId,
      projectId: project.target.catalogProjectId,
      replicaId: project.target.replicaId,
      executionDeviceId: project.target.deviceId,
      machineId: project.target.machineId,
      runtimeWorkspaceId: project.target.workspaceId,
      localProjectId: project.target.localProjectId,
    }));
    const scoped = (route: AttentionRoute, sessionId?: string) => {
      current();
      route = attentionRouteSchema.parse(
        Object.fromEntries(
          Object.keys(attentionRouteSchema.shape).map((key) => [
            key,
            route[key as keyof AttentionRoute],
          ]),
        ),
      );
      const index = routes.findIndex((item) => same(item, route));
      if (index < 0) throw Error('待办不属于原账号的已确认项目。');
      const project = projects[index]!;
      return {
        ...base,
        project,
        scope: { source: base.scope.source, target: project.target },
        sessionId,
        current,
      };
    };
    const routeForKey = (key: string) => {
      current();
      for (const route of routes) {
        try {
          workspaceAttentionKey(route, key);
          return route;
        } catch {}
      }
      throw Error('待办存储键不属于原项目。');
    };
    const read = async <T>(key: string): Promise<T | undefined> => {
      const route = routeForKey(key),
        context = scoped(route);
      const ledger = await this.ports.store.read(context.scope, current, context.sessionId ?? []);
      return structuredClone(ledger.attention?.[attentionScopeKey(route)]?.entries[key]) as
        | T
        | undefined;
    };
    const save = async (key: string, value: unknown, compare?: { expected: unknown }) => {
      const route = routeForKey(key),
        context = scoped(route);
      const saved = await this.ports.store.saveAttention(
        context.scope,
        route,
        key,
        value,
        current,
        compare,
      );
      if (same(context.scope, this.ports.context.value.scope))
        await this.ports.drafts.reloadLedger(context);
      return saved;
    };
    const request = async (
      route: AttentionRoute,
      input: WorkspaceAttentionCommand,
      sessionId?: string,
    ) => {
      current();
      const command = workspaceAttentionCommandSchema.parse(input);
      const context = scoped(route, sessionId);
      if (this.ports.context.value.offline || this.ports.context.value.errors[base.scope.source])
        throw Error('执行电脑离线，原待办记录保留。');
      const target = {
        ...context.scope.target,
        ...(sessionId ? { sessionId: sessionId } : {}),
      };
      const value = await this.ports.context.request(
        {
          action: 'attention',
          source: context.scope.source,
          connectionId: context.connectionId,
          target,
          actor,
          command: command,
        },
        current,
      );
      current();
      return validateWorkspaceAttentionResponse(value, target, command);
    };
    const dependencies: AttentionDependencies = {
      read,
      write: async (key, value) => {
        await save(key, value);
      },
      compareAndSet: (key, expected, value) => save(key, value, { expected }),
      request,
      now: () => Date.parse((this.options.now ?? (() => new Date().toISOString()))()),
      uuid: () => this.ports.context.uuid(),
      changed,
      deliver: async (original, retry, authorized, onPending) => {
        const context = scoped(original.route, original.sessionId);
        const check = () => {
          current();
          if (!authorized()) throw Error('待办原事项已改变。');
        };
        await this.ports.drafts.flushDraft();
        check();
        return this.ports.store.exclusiveOperation(
          context.scope,
          'attention:' + original.sessionId,
          check,
          async () => {
            const key = attentionPendingKey(original),
              previous = await read(key);
            check();
            if (retry && (!previous || !same(previous, original)))
              throw Error('原待办操作已改变或已有结果，请重新读取。');
            return deliverAttention(original, {
              read,
              compareAndSet: dependencies.compareAndSet,
              request,
              onPending,
              isAuthorized: () => {
                try {
                  check();
                  return true;
                } catch {
                  return false;
                }
              },
            });
          },
        );
      },
      readSessionDraft: async (route, sessionId) => {
        await this.ports.drafts.flushDraft();
        const context = scoped(route, sessionId),
          ledger = await this.ports.store.read(context.scope, current, context.sessionId ?? []),
          draft = await this.ports.store.readDraft(context.scope, sessionId, current, ledger);
        return draft?.actor && actorKey(draft.actor) === actorKey(actor)
          ? draft.text
          : { text: '', unscoped: !!draft?.text };
      },
      prepareTurn: async (route, sessionId, text) => {
        await this.ports.drafts.flushDraft();
        const context = scoped(route, sessionId);
        const ledger = await this.ports.store.read(context.scope, current, context.sessionId ?? []),
          draft = await this.ports.store.readDraft(context.scope, sessionId, current, ledger);
        if (
          this.ports.store.attentionBlocked(ledger, sessionId) ||
          this.ports.store.githubBlocked(ledger, sessionId) ||
          this.ports.store.forkBlocked(ledger, sessionId) ||
          ledger.git?.[sessionId]?.pending ||
          ledger.interactions?.[sessionId]?.value.pending ||
          ledger.tasks?.[sessionId]?.pending ||
          ledger.mcp?.[sessionId]?.delivery ||
          ledger.operations.some(
            (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
          )
        )
          throw Error('请先核查原会话操作，再发送后续指令。');
        const raw = await this.ports.context.execute(
          context,
          this.ports.context.command(context.scope, 'session', { sessionId }),
        );
        const read = readClientSession(raw, { ...context.scope.target, sessionId });
        const agent = agentSchema.parse(
          await this.ports.context.execute(
            context,
            this.ports.context.command(context.scope, 'agent-options', {
              sessionId,
              agentId: read.meta.agentConfigId,
              ...(context.project.runtime.features?.includes(AGENT_MODEL_OPTIONS_FEATURE) &&
              draft?.selection.modelId
                ? { modelId: draft.selection.modelId }
                : {}),
            }),
          ),
        );
        const latestLedger = await this.ports.store.read(
            context.scope,
            current,
            context.sessionId ?? [],
          ),
          latest = await this.ports.store.readDraft(
            context.scope,
            sessionId,
            current,
            latestLedger,
          );
        if (!same(latest.selection, draft.selection))
          throw Error('运行选项已改变，请重新查看后续要求。');
        if (!context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE))
          throw Error('请先升级执行电脑，再发送新的待办后续指令。');
        return buildSendTurn({
          scope: { ...context.scope.target, sessionId },
          read,
          agent,
          prompt: text,
          selection: draft.selection,
          operationId: this.ports.context.uuid(),
          turnId: this.ports.context.uuid(),
        });
      },
      continued: async (route, sessionId) => {
        const context = scoped(route, sessionId);
        if (
          same(context.scope, this.ports.context.value.scope) &&
          this.ports.context.value.sessionId === sessionId
        )
          await this.ports.sessions.refreshSession();
        current();
        await this.ports.catalog.refreshSessions();
      },
    };
    const controller = new AttentionController(dependencies);
    controller.configure({
      origin: catalog.origin,
      actor,
      workspaceId: base.scope.target.catalogWorkspaceId,
      workspaceName: base.project.workspaceName,
      connected: !this.ports.context.value.offline,
      targets: routes.map((route, index) => ({
        ...route,
        hostName: projects[index]!.hostName,
        projectName: projects[index]!.projectName,
        online: projects[index]!.online,
        features: projects[index]!.runtime.features ?? [],
      })),
    });
    await controller.refresh();
    current();
    return {
      controller,
      close: () => {
        open = false;
        controller.configure(undefined);
      },
      openSession: async (route: AttentionRoute, sessionId: string, turnId?: string) => {
        const context = scoped(route, sessionId);
        await this.ports.drafts.flushDraft();
        current();
        if (!same(context.scope, this.ports.context.value.scope))
          await this.ports.catalog.selectProject(context.scope.source, context.scope.target);
        await this.ports.sessions.openSession(sessionId, turnId);
      },
    };
  }
}
