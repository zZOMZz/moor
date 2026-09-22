import { SESSION_INTENTS_FEATURE } from '@moor/protocol/session-intent-protocol';
import { hostCommandHttpRequest } from '@moor/protocol/host-command-contract';
import {
  actorSchema,
  workspaceAttentionRoute,
  validateWorkspaceAttentionResponse,
} from './workspace-attention';
import {
  ATTENTION_FEATURE,
  ACTOR_FEATURE,
  FOLLOWUP_FEATURE,
  type AttentionActor,
} from '@moor/protocol/attention';
import { productCanonicalJson } from '@moor/protocol/canonical-json';
const isDeepStrictEqual = (a: unknown, b: unknown) =>
  productCanonicalJson(a) === productCanonicalJson(b);
import {
  workspaceCatalogSnapshotSchema,
  workspaceReplicaContextSchema,
} from '@moor/protocol/workspace-catalog';
import { type HostCommand } from '@moor/protocol/host-command';
import { AppError } from '@moor/protocol/protocol';
import { validateHostResponse } from '@moor/protocol/host-response';
import { publicAgentFailure } from '@moor/protocol/agent-errors';
import {
  desktopWorkspaceRequestSchema,
  desktopWorkspaceCatalogSchema,
  DESKTOP_WORKSPACE_LIMITS,
  type DesktopWorkspaceSource,
  type DesktopWorkspaceTarget,
  type DesktopWorkspaceCatalog,
} from './workspace-protocol';

const unavailable = () => new AppError(409, '连接或执行目标已变化，请核查原操作后手动继续');
export function workspaceCommandRoute(target: DesktopWorkspaceTarget, command: HostCommand) {
  if (
    command.workspaceId !== target.workspaceId ||
    command.localProjectId !== target.localProjectId
  )
    throw unavailable();
  const outer = command.params as Record<string, unknown>;
  const inner = (
    outer.request && typeof outer.request === 'object' ? outer.request : outer
  ) as Record<string, unknown>;
  for (const input of [outer, inner])
    for (const field of [
      'workspaceId',
      'localProjectId',
      'userId',
      'machineId',
      'sessionId',
    ] as const)
      if (field in input && input[field] !== target[field]) throw unavailable();
  const base =
    '/api/workspaces/' +
    encodeURIComponent(target.catalogWorkspaceId) +
    '/replicas/' +
    encodeURIComponent(target.replicaId) +
    '/';
  const route = hostCommandHttpRequest(command);
  return { ...route, path: base + route.path };
}

export type LocalWorkspaceIdentity = Pick<
  DesktopWorkspaceTarget,
  'owner' | 'deviceId' | 'workspaceId' | 'machineId' | 'userId'
>;
export type WorkspaceJsonTransport = {
  origin: string;
  json(path: string, body?: unknown, limit?: number): Promise<unknown>;
};
export class WorkspaceNetworkFailure extends Error {}
/** One authenticated connection. No login, credential persistence, operation journal or retry. */
export class WorkspaceTransportClient {
  readonly connectionId: string;
  readonly #http: WorkspaceJsonTransport;
  readonly #lifetime = new AbortController();
  #owner: string | undefined;
  constructor(
    private options: {
      source: DesktopWorkspaceSource;
      origin: string;
      localIdentity?: LocalWorkspaceIdentity;
      current(): void;
      uuid?: () => string;
      createHttp(context: { current(): void; signal: AbortSignal }): WorkspaceJsonTransport;
      classifyHttpError?(error: unknown): { status: number; rejected: boolean } | undefined;
      isNetworkError?(error: unknown): boolean;
    },
  ) {
    if ((options.source === 'local') !== !!options.localIdentity) throw unavailable();
    this.connectionId = (options.uuid ?? (() => crypto.randomUUID()))();
    this.#owner = options.localIdentity?.owner;
    this.#http = options.createHttp({
      current: () => this.current(),
      signal: this.#lifetime.signal,
    });
  }
  close() {
    this.#lifetime.abort();
  }
  private current() {
    if (this.#lifetime.signal.aborted) throw unavailable();
    this.options.current();
  }
  private async catalog(): Promise<DesktopWorkspaceCatalog> {
    this.current();
    const snapshot = workspaceCatalogSnapshotSchema.parse(
      await this.#http.json('/api/workspace-catalog', undefined, 16 * 1024 * 1024),
    );
    const { identity, workspaces: catalog, devices } = snapshot,
      owner = identity.owner;
    if (this.#owner && owner !== this.#owner) throw unavailable();
    this.#owner = owner;
    this.current();
    const unique = (rows: { id: string }[]) => {
      if (new Set(rows.map((row) => row.id)).size !== rows.length) throw unavailable();
    };
    unique(catalog);
    unique(devices);
    const targets: DesktopWorkspaceCatalog['targets'] = [];
    for (const workspace of catalog) {
      unique(workspace.hosts);
      unique(workspace.projects);
      unique(workspace.replicas);
      for (const replica of workspace.replicas) {
        const host = workspace.hosts.find((entry) => entry.id === replica.hostId);
        const project = workspace.projects.find((entry) => entry.id === replica.projectId);
        const device = devices.find((entry) => entry.id === host?.deviceId);
        if (!host || !project || !device) continue;
        unique(device.workspaces);
        const runtime = device.workspaces.find(
          (entry) => entry.id === host.runtimeWorkspaceId && entry.machineId === host.machineId,
        );
        if (!runtime) continue;
        unique(runtime.projects);
        unique(runtime.agents);
        if (!runtime.projects.some((entry) => entry.id === replica.localProjectId)) continue;
        const identity = {
          owner,
          deviceId: host.deviceId,
          workspaceId: runtime.id,
          machineId: runtime.machineId,
          userId: runtime.userId,
        };
        if (this.options.localIdentity && !isDeepStrictEqual(identity, this.options.localIdentity))
          throw unavailable();
        targets.push({
          target: {
            ...identity,
            serverKey: this.options.localIdentity
              ? 'local:' + runtime.machineId
              : this.#http.origin,
            localProjectId: replica.localProjectId,
            catalogWorkspaceId: workspace.id,
            catalogProjectId: project.id,
            replicaId: replica.id,
          },
          workspaceName: workspace.name,
          projectName: project.name,
          hostName: host.name,
          online: device.online && host.online && replica.available,
          runtime,
        });
      }
    }
    return desktopWorkspaceCatalogSchema.parse({
      connectionId: this.connectionId,
      source: this.options.source,
      origin: this.#http.origin,
      owner,
      ...(identity.actor ? { actor: identity.actor } : {}),
      targets,
    });
  }
  private async resolve(target: DesktopWorkspaceTarget, actor?: AttentionActor) {
    this.current();
    const context = workspaceReplicaContextSchema.parse(
      await this.#http.json(
        '/api/workspaces/' +
          encodeURIComponent(target.catalogWorkspaceId) +
          '/replicas/' +
          encodeURIComponent(target.replicaId) +
          '/context',
        undefined,
        8 * 1024 * 1024,
      ),
    );
    this.current();
    if (
      context.identity.owner !== this.#owner ||
      (actor && !isDeepStrictEqual(context.identity.actor, actorSchema.parse(actor)))
    )
      throw unavailable();
    const { sessionId: _sessionId, ...project } = target;
    const selected = {
      ...context.target,
      serverKey: this.options.localIdentity
        ? 'local:' + context.runtime.machineId
        : this.#http.origin,
    };
    if (!isDeepStrictEqual(selected, project)) throw unavailable();
    if (
      this.options.localIdentity &&
      !isDeepStrictEqual(
        {
          owner: context.identity.owner,
          deviceId: context.target.deviceId,
          workspaceId: context.runtime.id,
          machineId: context.runtime.machineId,
          userId: context.runtime.userId,
        },
        this.options.localIdentity,
      )
    )
      throw unavailable();
    return {
      target: selected,
      runtime: context.runtime,
      actor: context.identity.actor,
      mappingVersion: context.mappingVersion,
    };
  }
  async request(raw: unknown): Promise<unknown> {
    try {
      const request = desktopWorkspaceRequestSchema.parse(raw);
      this.current();
      if (request.source !== this.options.source) throw unavailable();
      if (request.action === 'catalog') return { ok: true, value: await this.catalog() };
      if (
        request.connectionId !== this.connectionId ||
        !this.#owner ||
        request.target.owner !== this.#owner
      )
        throw unavailable();
      const attention = request.action === 'attention';
      const route = attention
        ? workspaceAttentionRoute(request.target, request.command)
        : workspaceCommandRoute(request.target, request.command);
      const selected = await this.resolve(request.target, attention ? request.actor : undefined);
      if (
        attention &&
        (![ATTENTION_FEATURE, ACTOR_FEATURE].every((feature) =>
          selected.runtime.features?.includes(feature),
        ) ||
          (request.command.kind === 'continue' &&
            (!selected.runtime.features?.includes(FOLLOWUP_FEATURE) ||
              ('turn' in request.command.input &&
                !selected.runtime.features?.includes(SESSION_INTENTS_FEATURE)))))
      )
        throw new AppError(409, '此执行电脑尚未支持待办操作。');
      let value: unknown, failure: unknown;
      try {
        value = await this.#http.json(
          route.path,
          route.body,
          DESKTOP_WORKSPACE_LIMITS.responseBytes,
        );
      } catch (error) {
        failure = error;
      }
      this.current();
      const after = await this.resolve(request.target, attention ? request.actor : undefined);
      if (
        !isDeepStrictEqual(selected.target, after.target) ||
        !isDeepStrictEqual(selected.actor, after.actor) ||
        selected.mappingVersion !== after.mappingVersion
      )
        throw unavailable();
      if (failure) throw failure;
      return {
        ok: true,
        value: attention
          ? validateWorkspaceAttentionResponse(value, request.target, request.command)
          : await validateHostResponse(value, {
              command: request.command,
              workspace: after.runtime,
              current: () => this.current(),
            }),
      };
    } catch (error) {
      try {
        this.current();
      } catch {
        error = unavailable();
      }
      const httpError = this.options.classifyHttpError?.(error);
      return {
        ok: false,
        error: {
          code: httpError
            ? 'host'
            : error instanceof WorkspaceNetworkFailure || this.options.isNetworkError?.(error)
              ? 'network'
              : 'unavailable',
          status: httpError?.status ?? (error instanceof AppError ? error.status : null),
          rejected: httpError?.rejected ?? false,
          message: publicAgentFailure(
            error,
            '连接或原操作结果未确认，请重新读取目标并手动核查原操作。',
          ),
        },
      };
    }
  }
}
