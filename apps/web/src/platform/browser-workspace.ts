import { z } from 'zod';
import { BrowserWorkspaceClient } from '@moor/client/browser-workspace-client';
import { WorkspaceTransportClient } from '@moor/client/workspace-transport';
import {
  desktopWorkspaceCatalogSchema,
  desktopWorkspaceRequestSchema,
  type DesktopWorkspaceCatalog,
  type DesktopWorkspaceRequest,
} from '@moor/client/workspace-protocol';
import { workspaceCatalogSnapshotSchema } from '@moor/protocol/workspace-catalog';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import { sessionReadResponseSchema, sessionListSchema } from '@moor/protocol/session-responses';
import { mutationSchema } from '@moor/protocol/protocol';
import { readClientSession } from '@moor/client/session-client';
import { runSelectionSchema } from '@moor/protocol/run-config';
import { WorkspaceStore, type WorkspaceScope } from '../features/workspace/workspace-store';
import { readLegacyWebRecord } from './retired-records';
import { browserOwnerKey as ownerKey } from './browser-storage';
import { pendingSessionActionSchema, sessionActionKey } from '../features/sessions/session-actions';

const catalogKey = (origin: string, owner: string) =>
  canonical(['moor-browser-catalog-v1', origin, owner]);
const selectionKey = (origin: string, owner: string) =>
  canonical(['moor-browser-selection-v1', origin, owner]);
type Result =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { code: string; status: number | null; rejected: boolean; message: string };
    };
const unavailable = (): Result => ({
  ok: false,
  error: {
    code: 'network',
    status: null,
    rejected: false,
    message: '浏览器当前离线，仅可读取本机缓存。',
  },
});

export class BrowserWorkspaceRuntime {
  readonly client: BrowserWorkspaceClient;
  #closed = false;
  #authenticated = false;
  #catalog?: DesktopWorkspaceCatalog;
  #catalogRead = 0;
  #initialCache: boolean;
  constructor(
    readonly options: {
      origin: string;
      owner: string;
      store: WorkspaceStore;
      fetch?: typeof fetch;
      legacyRead?: <T>(key: string) => Promise<T | undefined>;
      initialCache?: boolean;
    },
  ) {
    this.#initialCache = options.initialCache === true;
    this.client = new BrowserWorkspaceClient({
      origin: options.origin,
      current: () => {
        if (this.#closed) throw Error('浏览器工作区已关闭。');
      },
      fetch: options.fetch,
    });
  }
  get authenticated() {
    return this.#authenticated;
  }
  get catalog() {
    return this.#catalog;
  }
  async #write(key: string, value: unknown) {
    const backend = this.options.store.backend;
    const current = () => {
      if (this.#closed) throw Error('浏览器工作区已关闭。');
    };
    await backend.exclusive(key, current, async () => {
      const before = await backend.read(key);
      current();
      await backend.compareAndSet(key, before, value, current);
    });
  }
  async request(raw: DesktopWorkspaceRequest): Promise<unknown> {
    const request = desktopWorkspaceRequestSchema.parse(raw);
    if (request.source !== 'remote') return unavailable();
    if (request.action !== 'catalog' && !this.#authenticated) return unavailable();
    if (request.action === 'catalog' && this.#initialCache) {
      this.#initialCache = false;
      const cached = await this.#cachedCatalog();
      if (cached) return { ok: true, value: cached };
    }
    const attempt = request.action === 'catalog' ? ++this.#catalogRead : undefined;
    const result = (await this.client.request(request)) as Result;
    if (request.action !== 'catalog') return result;
    if (attempt !== this.#catalogRead)
      return {
        ok: false,
        error: {
          code: 'stale',
          status: 409,
          rejected: false,
          message: '目录读取已被更新的请求替代。',
        },
      };
    if (result.ok) {
      const value = desktopWorkspaceCatalogSchema.parse(result.value);
      if (value.owner !== this.options.owner || value.origin !== this.options.origin) {
        this.#authenticated = false;
        return {
          ok: false,
          error: {
            code: 'identity',
            status: 401,
            rejected: false,
            message: '登录账号已改变，请重新打开工作区。',
          },
        };
      }
      this.#authenticated = true;
      this.#catalog = value;
      await this.#write(catalogKey(this.options.origin, this.options.owner), value);
      await this.#write(ownerKey(this.options.origin), this.options.owner);
      return result;
    }
    this.#authenticated = false;
    if (
      result.error.code !== 'network' &&
      !(!result.error.rejected && [502, 503, 504].includes(result.error.status ?? 0))
    )
      return result;
    const cached = await this.#cachedCatalog();
    return cached ? { ok: true, value: cached } : result;
  }
  async #cachedCatalog() {
    let cached = await this.options.store.backend.read(
      catalogKey(this.options.origin, this.options.owner),
    );
    if (cached === null) cached = await this.#legacyCatalog();
    if (cached === undefined || cached === null) return undefined;
    const value = desktopWorkspaceCatalogSchema.parse(cached);
    if (
      value.owner !== this.options.owner ||
      value.origin !== this.options.origin ||
      value.source !== 'remote'
    )
      throw Error('缓存目录不属于当前来源和账号。');
    this.#catalog = {
      ...value,
      connectionId: this.client.connectionId,
      targets: value.targets.map((target) => ({ ...target, online: false })),
    };
    return this.#catalog;
  }
  async #legacyCatalog() {
    const read = this.options.legacyRead ?? readLegacyWebRecord;
    const [workspaces, devices, actor] = await Promise.all([
      read(this.options.owner + '/workspaces'),
      read(this.options.owner + '/devices'),
      read(this.options.owner + '/attention-actor'),
    ]);
    const parsed = workspaceCatalogSnapshotSchema.safeParse({
      version: 1,
      identity: { owner: this.options.owner, actor },
      workspaces,
      devices,
    });
    if (!parsed.success) return undefined;
    const projection = new WorkspaceTransportClient({
      source: 'remote',
      origin: this.options.origin,
      uuid: () => this.client.connectionId,
      current() {},
      createHttp: () => ({ origin: this.options.origin, json: async () => parsed.data }),
    });
    try {
      const result = (await projection.request({ action: 'catalog', source: 'remote' })) as Result;
      if (!result.ok) return undefined;
      const catalog = desktopWorkspaceCatalogSchema.parse(result.value);
      for (const entry of catalog.targets) {
        const target = entry.target;
        const raw = await read<unknown[]>(
          [target.owner, target.deviceId, target.workspaceId, 'list'].join('/'),
        );
        const list = sessionListSchema.safeParse(
          Array.isArray(raw)
            ? raw.filter(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  'project' in item &&
                  (item.project as { localProjectId?: string })?.localProjectId ===
                    target.localProjectId,
              )
            : [],
        );
        if (list.success)
          await this.options.store.sessionList({ source: 'remote', target }, () => {}, list.data);
      }
      return catalog;
    } finally {
      projection.close();
    }
  }
  async restoreLegacy(scope: WorkspaceScope, sessionId: string, current: () => void) {
    // A cache supplies reading context, never authority to reinterpret an old outbox.
    if (
      !this.#catalog?.targets.some((entry) => canonical(entry.target) === canonical(scope.target))
    )
      return;
    const read = this.options.legacyRead ?? readLegacyWebRecord;
    const prefix = [
      scope.target.owner,
      scope.target.deviceId,
      scope.target.workspaceId,
      sessionId,
    ].join('/');
    const snapshot = await read<Record<string, unknown>>(prefix + '/session');
    const pending = await read(prefix + '/pending');
    const pendingMetadata = await read(sessionActionKey({ ...scope.target, sessionId }));
    const text = await read<string>(prefix + '/draft');
    current();
    if (snapshot === undefined) {
      if (pending !== undefined || pendingMetadata !== undefined || text)
        throw Error('旧网页记录缺少完整会话身份，请从账号设置读取并导出原记录后核对。');
      return;
    }
    const raw = sessionReadResponseSchema.parse({
      ...snapshot,
      update: snapshot.snapshot,
      synced: true,
      online: true,
      persisted: true,
    });
    const session = readClientSession(raw, { ...scope.target, sessionId });
    if (!this.#authenticated) {
      // Historical display is allowed offline; drafts and original operations remain untouched.
      await this.options.store.cacheSession(scope, sessionId, raw, current);
      return;
    }
    const markerKey = canonical(['moor-browser-legacy-copy-v1', scope, sessionId]);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        canonical([snapshot, pending ?? null, pendingMetadata ?? null, text ?? null]),
      ),
    );
    const signature =
      'sha256:' +
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if ((await this.options.store.backend.read(markerKey)) === signature) return;
    current();
    const live = (await this.client.request({
      action: 'execute',
      source: 'remote',
      connectionId: this.client.connectionId,
      target: { ...scope.target, sessionId },
      command: {
        workspaceId: scope.target.workspaceId,
        localProjectId: scope.target.localProjectId,
        method: 'session',
        params: { sessionId },
      },
    })) as Result;
    current();
    if (!live.ok) throw Error('原主机尚未确认旧记录的会话身份，原数据已保留，未迁移或执行。');
    const confirmed = readClientSession(live.value, { ...scope.target, sessionId });
    if (confirmed.meta.agentConfigId !== session.meta.agentConfigId)
      throw Error('原会话 Agent 绑定不匹配，旧记录已保留。');
    if (pending !== undefined) {
      const mutation = mutationSchema.parse(pending);
      if (mutation.workspaceId !== scope.target.workspaceId || mutation.sessionId !== sessionId)
        throw Error('旧请求与原会话不匹配，未复制或执行。');
      await this.options.store.stage(
        scope,
        { kind: 'mutation', value: mutation },
        undefined,
        current,
      );
    }
    if (pendingMetadata !== undefined) {
      const operation = pendingSessionActionSchema.parse(pendingMetadata);
      if (
        operation.owner !== scope.target.owner ||
        operation.deviceId !== scope.target.deviceId ||
        operation.catalogWorkspaceId !== scope.target.catalogWorkspaceId ||
        operation.replicaId !== scope.target.replicaId
      )
        throw Error('旧整理请求的账号或项目映射已经改变，原记录未迁移。');
      await this.options.store.stage(
        scope,
        { kind: 'metadata', value: operation.request },
        undefined,
        current,
      );
    }
    if (typeof text === 'string' && text) {
      const draft = await this.options.store.readDraft(scope, sessionId, current);
      if (draft.revision === 0) {
        const saved = await read<{ selection?: unknown }>(
          prefix + '/run-options/' + session.meta.agentConfigId,
        );
        const selection = runSelectionSchema.safeParse(saved?.selection);
        await this.options.store.saveDraft(
          scope,
          sessionId,
          0,
          text,
          selection.success ? selection.data : {},
          current,
        );
      }
    }
    await this.options.store.cacheSession(scope, sessionId, live.value, current);
    await this.#write(markerKey, signature);
  }
  async saveSelection(scope: WorkspaceScope, sessionId: string) {
    await this.#write(selectionKey(this.options.origin, this.options.owner), { scope, sessionId });
  }
  async selection() {
    const current = await this.options.store.backend.read(
      selectionKey(this.options.origin, this.options.owner),
    );
    if (current !== null) return current;
    const legacy = await (this.options.legacyRead ?? readLegacyWebRecord)<{
      deviceId?: string;
      workspaceId?: string;
      sessionId?: string;
      replicaId?: string;
    }>(this.options.owner + '/view');
    if (!legacy?.sessionId) return undefined;
    const matches =
      this.#catalog?.targets.filter(
        (entry) =>
          entry.target.deviceId === legacy.deviceId &&
          entry.target.workspaceId === legacy.workspaceId &&
          entry.target.replicaId === legacy.replicaId,
      ) ?? [];
    return matches.length === 1
      ? { scope: { source: 'remote', target: matches[0]!.target }, sessionId: legacy.sessionId }
      : undefined;
  }
  close() {
    this.#closed = true;
    this.#authenticated = false;
    this.client.close();
  }
}
