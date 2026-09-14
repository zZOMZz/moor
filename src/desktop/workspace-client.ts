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
} from '../attention';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CliHttp, CliHttpError } from '../cli/http';
import { catalogSchema, devicesSchema } from '../cli/targets';
import { type HostCommand, type HostCommandMethod } from '../bridge/host-command';
import { AppError } from '../protocol';
import { validateHostResponse } from '../host-response';
import { publicAgentFailure } from '../agent-errors';
export { normalizeLegacyCache } from './legacy-cache';
import {
  desktopWorkspaceRequestSchema,
  desktopWorkspaceCatalogSchema,
  DESKTOP_WORKSPACE_LIMITS,
  type DesktopWorkspaceSource,
  type DesktopWorkspaceTarget,
  type DesktopWorkspaceCatalog,
} from './workspace-protocol';

const unavailable = () => new AppError(409, '连接或执行目标已变化，请核查原操作后手动继续');
// Each entry is an existing, bounded application route. Encrypted-only recovery
// methods have no legacy route and are rejected; they never select another link.
const routes = {
  'agent-options': 'agent-options',
  'roles-read': 'roles/read',
  'roles-action': 'roles/action',
  'mcp-read': 'mcp/read',
  'skills-read': 'skills/read',
  'session-control': 'session-control',
  'session-operations': 'session-operations',
  'tasks-read': 'tasks-read',
  'tasks-action': 'tasks-action',
  'preview-read': 'preview/read',
  'preview-action': 'preview/action',
  'preview-inspect': 'preview/inspect',
  'preview-close': 'preview/close',
  'github-write-read': 'github-write/read',
  'github-write-action': 'github-write/action',
  'github-write-inspect': 'github-write/inspect',
  'github-write-abandon': 'github-write/abandon',
  'github-read': 'github/read',
  'github-action': 'github/action',
  'github-abandon': 'github/abandon',
  mutate: 'mutations',
  'session-action': 'session-actions',
  'file-content': 'file-content',
  'attachment-action': 'attachment-actions',
  'read-attachment': 'attachments/read',
  'read-project-tree': 'project-tree',
  'read-turn-diff': 'turn-diff',
  'read-diff-file': 'diff-file',
  'answer-question': 'question-answers',
  steer: 'steer',
  'search-sessions': 'session-search',
  'git-state': 'git/state',
  'git-action': 'git/action',
  'fork-options': 'fork/options',
  'fork-action': 'fork/action',
  cancel: 'cancel',
} satisfies Partial<Record<HostCommandMethod, string>>;

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
  if (command.method === 'sessions') return { path: base + 'sessions', body: undefined };
  if (command.method === 'session')
    return {
      path:
        base +
        'sessions/' +
        encodeURIComponent(command.params.sessionId) +
        (command.params.version === undefined
          ? ''
          : '?version=' + encodeURIComponent(command.params.version)),
      body: undefined,
    };
  if (!(command.method in routes)) throw new AppError(409, '此连接不支持该操作，请使用原连接核查');
  return { path: base + routes[command.method as keyof typeof routes], body: command.params };
}

export type LocalWorkspaceIdentity = Pick<
  DesktopWorkspaceTarget,
  'owner' | 'deviceId' | 'workspaceId' | 'machineId' | 'userId'
>;
/** One native-owned connection. No login, credential persistence, operation journal or retry. */
export class DesktopWorkspaceClient {
  readonly connectionId: string;
  readonly #http: CliHttp;
  readonly #lifetime = new AbortController();
  #owner: string | undefined;
  constructor(
    private options: {
      source: DesktopWorkspaceSource;
      origin: string;
      cookie: string;
      localIdentity?: LocalWorkspaceIdentity;
      current(): void;
      fetch?: typeof fetch;
      uuid?: () => string;
    },
  ) {
    if ((options.source === 'local') !== !!options.localIdentity) throw unavailable();
    this.connectionId = (options.uuid ?? randomUUID)();
    this.#owner = options.localIdentity?.owner;
    this.#http = new CliHttp(
      { origin: options.origin, cookie: options.cookie, owner: this.#owner },
      {
        current: () => this.current(),
        signal: this.#lifetime.signal,
        fetch: options.fetch,
      },
    );
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
    const identity = await this.#http.identityContext(),
      owner = identity.owner;
    if (this.#owner && owner !== this.#owner) throw unavailable();
    this.#owner = owner;
    const catalog = catalogSchema.parse(
      await this.#http.json('/api/workspaces', undefined, 8 * 1024 * 1024),
    );
    const devices = devicesSchema.parse(
      await this.#http.json('/api/devices', undefined, 8 * 1024 * 1024),
    );
    if (!isDeepStrictEqual(await this.#http.identityContext(), identity)) throw unavailable();
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
    const catalog = await this.catalog();
    if (actor && !isDeepStrictEqual(catalog.actor, actorSchema.parse(actor))) throw unavailable();
    const { sessionId: _sessionId, ...project } = target;
    const found = catalog.targets.filter((entry) => isDeepStrictEqual(entry.target, project));
    if (found.length !== 1 || !found[0]!.online) throw unavailable();
    return found[0]!;
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
            !selected.runtime.features?.includes(FOLLOWUP_FEATURE)))
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
      if (!isDeepStrictEqual(selected.target, after.target)) throw unavailable();
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
      return {
        ok: false,
        error: {
          code: error instanceof CliHttpError ? 'host' : 'unavailable',
          status: error instanceof CliHttpError ? error.status : null,
          rejected: error instanceof CliHttpError && error.rejected,
          message: publicAgentFailure(
            error,
            '连接或原操作结果未确认，请重新读取目标并手动核查原操作。',
          ),
        },
      };
    }
  }
}
