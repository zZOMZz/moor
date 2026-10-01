import { productCanonicalJson } from '@moor/protocol/canonical-json';
import { RequestFailure } from '@moor/protocol/request-failure';
import {
  SESSION_PAGE_FEATURE,
  compareSessionPageItems,
  sessionPageMatches,
  sessionPageRequestSchema,
  validateSessionPageResult,
} from '@moor/protocol/session-page';
import { sessionListSchema, type SessionMetadata } from '@moor/protocol/session-responses';
import {
  workspaceCatalogSchema,
  type WorkspaceSource,
} from '@moor/protocol/workspace-client-protocol';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
import type { WorkspaceInteractionsService } from './interactions';
import {
  Context,
  Project,
  WorkspaceSessionPage,
  WorkspaceSessionPageOptions,
  isWorkspaceListOfflineFailure,
  projectListingIdentity,
  same,
  withoutSource,
} from './model';
import type { WorkspaceSessionsService } from './sessions';
import type { WorkspaceSyncService } from './sync';
/** Capabilities consumed by catalog use cases; supplied only by the workspace composition root. */
export interface WorkspaceCatalogPorts {
  context: Pick<
    WorkspaceContextService,
    | 'value'
    | 'closed'
    | 'request'
    | 'generation'
    | 'emit'
    | 'current'
    | 'context'
    | 'execute'
    | 'command'
  >;
  drafts: Pick<
    WorkspaceDraftsService,
    'flushDraft' | 'cancelDraftSave' | 'draftBuffer' | 'draftInput' | 'draftWrites'
  >;
  sessions: Pick<WorkspaceSessionsService, 'discardSessionCacheQueue' | 'discardSessionReplica'>;
  sync: Pick<
    WorkspaceSyncService,
    | 'syncAfterCatalog'
    | 'scheduleSync'
    | 'syncPending'
    | 'sessionSyncPending'
    | 'syncAfterRead'
    | 'sessionListReads'
    | 'syncAfterList'
  >;
  interactions: Pick<WorkspaceInteractionsService, 'interactionWrites'>;
  store: Pick<WorkspacePersistence, 'read' | 'sessionPage' | 'sessionList'>;
}
export class WorkspaceCatalogService {
  constructor(readonly ports: WorkspaceCatalogPorts) {}
  warmScopes = new Set<string>();
  catalogVersions = { local: 0, remote: 0 };
  sessionListReadVersion = 0;
  projectRevisions = new Map<string, number>();
  sessionPages = new Map<string, { page: WorkspaceSessionPage; scope: string; bytes: number }>();
  sessionPageBytes = 0;
  sessionPagesReading = new Map<string, Promise<WorkspaceSessionPage>>();
  legacyListsReading = new Map<string, Promise<SessionMetadata[]>>();
  catalogFailures = new Map<WorkspaceSource, unknown>();
  catalogReads = { local: 0, remote: 0 };
  get navigationRevision() {
    return this.catalogVersions.local + this.catalogVersions.remote;
  }
  projectRevision(source: WorkspaceSource, target: Project['target']) {
    return this.projectRevisions.get(productCanonicalJson([source, target])) ?? 0;
  }
  invalidateProject(source: WorkspaceSource, target: Project['target']) {
    const key = productCanonicalJson([source, target]);
    this.projectRevisions.set(key, this.projectRevision(source, target) + 1);
    this.forgetSessionPages(key);
  }
  forgetSessionPages(scope: string) {
    for (const [key, value] of this.sessionPages)
      if (value.scope === scope) {
        this.sessionPages.delete(key);
        this.sessionPageBytes -= value.bytes;
      }
  }
  async refreshCatalog(source: WorkspaceSource) {
    if (this.ports.context.value.scope?.source === source) await this.ports.drafts.flushDraft();
    const version = ++this.catalogVersions[source];
    this.catalogReads[source]++;
    const current = () => {
      if (this.ports.context.closed || this.catalogVersions[source] !== version)
        throw Error('电脑列表读取已过期。');
    };
    try {
      const catalog = workspaceCatalogSchema.parse(
        await this.ports.context.request({ action: 'catalog', source }, current),
      );
      if (catalog.source !== source) throw Error('电脑列表来源不匹配。');
      const previous = this.ports.context.value.catalogs[source];
      if (
        this.ports.context.value.scope?.source === source &&
        (!previous ||
          previous.connectionId !== catalog.connectionId ||
          previous.owner !== catalog.owner ||
          !same(previous.actor ?? null, catalog.actor ?? null) ||
          !catalog.targets.some((entry) =>
            same(entry.target, this.ports.context.value.scope!.target),
          ))
      )
        this.clearSelection();
      this.ports.context.value.catalogs = {
        ...this.ports.context.value.catalogs,
        [source]: catalog,
      };
      const identityChanged =
        !previous ||
        previous.connectionId !== catalog.connectionId ||
        previous.owner !== catalog.owner ||
        !same(previous.actor ?? null, catalog.actor ?? null);
      for (const project of catalog.targets) {
        const old = previous?.targets.find((entry) => same(entry.target, project.target));
        if (
          identityChanged ||
          !old ||
          !same(projectListingIdentity(old), projectListingIdentity(project)) ||
          !same(old.runtime.agents, project.runtime.agents)
        )
          this.invalidateProject(source, project.target);
      }
      for (const old of previous?.targets ?? [])
        if (!catalog.targets.some((entry) => same(entry.target, old.target)))
          this.invalidateProject(source, old.target);
      if (this.ports.context.value.scope?.source === source) {
        const active = catalog.targets.find((entry) =>
          same(entry.target, this.ports.context.value.scope!.target),
        )!;
        this.ports.context.value.project = structuredClone(active);
        this.ports.context.value.offline = !active.online;
      }
      this.ports.context.value.errors = withoutSource(this.ports.context.value.errors, source);
      this.catalogFailures.delete(source);
    } catch (error) {
      current();
      this.catalogFailures.set(source, error);
      this.ports.context.value.errors = {
        ...this.ports.context.value.errors,
        [source]: '暂时无法连接此电脑列表。',
      };
      if (this.ports.context.value.scope?.source === source) {
        this.ports.context.generation++;
        // The visible replica can resume after reconnect, but its cache writer
        // holds the old connection generation and must never be reused.
        this.ports.sessions.discardSessionCacheQueue();
        this.ports.context.value.offline = true;
      }
      throw error;
    } finally {
      this.catalogReads[source]--;
      if (!this.catalogReads[source] && this.ports.sync.syncAfterCatalog.delete(source))
        this.ports.sync.scheduleSync();
      if (!this.ports.context.closed && this.catalogVersions[source] === version)
        this.ports.context.emit();
    }
  }
  async disconnectSource(source: WorkspaceSource) {
    if (this.ports.context.value.scope?.source === source) {
      await this.ports.drafts.flushDraft();
      this.clearSelection();
    }
    this.catalogVersions[source]++;
    this.ports.sync.syncPending.delete(source);
    this.ports.context.value.catalogs = withoutSource(this.ports.context.value.catalogs, source);
    this.catalogFailures.delete(source);
    this.ports.context.value.errors = withoutSource(this.ports.context.value.errors, source);
    if (this.ports.context.value.syncDisconnected)
      this.ports.context.value.syncDisconnected = withoutSource(
        this.ports.context.value.syncDisconnected,
        source,
      );
    this.ports.context.emit();
  }
  clearSelection() {
    this.ports.sync.sessionSyncPending = false;
    this.ports.sync.syncAfterRead = false;
    this.ports.drafts.cancelDraftSave?.();
    this.ports.drafts.cancelDraftSave = undefined;
    this.ports.drafts.draftBuffer = undefined;
    this.ports.drafts.draftInput = undefined;
    this.ports.sessions.discardSessionReplica();
    this.ports.context.generation++;
    this.ports.context.value = {
      catalogs: this.ports.context.value.catalogs,
      errors: this.ports.context.value.errors,
      sessions: [],
      offline: true,
      sessionLoad: { status: 'idle' },
    };
    this.ports.drafts.draftWrites = Promise.resolve();
    this.ports.interactions.interactionWrites = Promise.resolve();
  }
  async selectProject(source: WorkspaceSource, target: Project['target']) {
    await this.ports.drafts.flushDraft();
    const project = this.ports.context.value.catalogs[source]?.targets.find((entry) =>
      same(entry.target, target),
    );
    if (!project) throw Error('项目不属于当前电脑列表。');
    this.clearSelection();
    this.ports.context.value.scope = { source, target: structuredClone(project.target) };
    this.ports.context.value.project = structuredClone(project);
    this.ports.context.value.offline = !project.online;
    const current = this.ports.context.current();
    this.ports.context.emit();
    this.ports.context.value.ledger = await this.ports.store.read(
      this.ports.context.value.scope,
      current,
      [],
    );
    this.ports.context.emit();
    await this.refreshSessions();
    const warmKey = JSON.stringify([source, target]);
    if (
      project.online &&
      project.runtime.features?.includes('agent-catalog-cache-v1') &&
      !this.warmScopes.has(warmKey)
    ) {
      this.warmScopes.add(warmKey);
      const context = this.ports.context.context();
      // Workspace readiness owns initialization; native probes are coalesced by the host.
      for (const agent of project.runtime.agents) {
        void this.ports.context
          .execute(
            context,
            this.ports.context.command(context.scope, 'agent-options', { agentId: agent.id }),
          )
          .catch(() => {});
        void this.ports.context
          .execute(
            context,
            this.ports.context.command(context.scope, 'agent-usage', { agentId: agent.id }),
          )
          .catch(() => {});
      }
    }
  }
  async refreshSessions({ background = false }: { background?: boolean } = {}) {
    if (background && this.ports.sync.sessionListReads) {
      this.ports.sync.syncAfterList = true;
      return;
    }
    const context = this.ports.context.context();
    this.ports.sync.sessionListReads++;
    const version = ++this.sessionListReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.sessionListReadVersion) throw Error('会话列表读取已由较新的请求替代。');
    };
    try {
      const page = await this.listProjectSessionPage(context.scope.source, context.scope.target, {
        fresh: true,
      });
      context.current();
      this.ports.context.value.sessions = page.items;
      this.ports.context.value.sessionPage = page;
      delete this.ports.context.value.sessionListError;
      this.ports.context.value.offline = page.source === 'cache';
    } catch (error) {
      context.current();
      if (isWorkspaceListOfflineFailure(error)) this.ports.context.value.offline = true;
      this.ports.context.value.sessions = [];
      delete this.ports.context.value.sessionPage;
      this.ports.context.value.sessionListError = '会话列表尚未确认，请重新读取。';
      throw error;
    } finally {
      this.ports.sync.sessionListReads--;
      if (!this.ports.sync.sessionListReads && this.ports.sync.syncAfterList) {
        this.ports.sync.syncAfterList = false;
        this.ports.sync.scheduleSync();
      }
      context.current();
      this.ports.context.emit();
    }
  }
  async listProjectSessions(source: WorkspaceSource, target: Project['target']) {
    return (await this.listProjectSessionPage(source, target, { fresh: true })).items;
  }
  async refreshProjectSessions(source: WorkspaceSource, target: Project['target']) {
    await this.refreshCatalog(source);
    const context = this.projectContext(source, target);
    context.current();
    this.invalidateProject(source, target);
    this.ports.context.emit();
    if (same(this.ports.context.value.scope, context.scope)) await this.refreshSessions();
  }
  async listProjectSessionPage(
    source: WorkspaceSource,
    target: Project['target'],
    options: WorkspaceSessionPageOptions = {},
  ): Promise<WorkspaceSessionPage> {
    const context = this.projectContext(source, target);
    const revision = this.projectRevision(source, target),
      identity = projectListingIdentity(context.project),
      current = context.current;
    context.current = () => {
      current();
      const latest = this.ports.context.value.catalogs[source]?.targets.find((entry) =>
        same(entry.target, target),
      );
      if (
        !latest ||
        revision !== this.projectRevision(source, target) ||
        !same(identity, projectListingIdentity(latest))
      )
        throw Error('项目列表已改变，请重新读取。');
    };
    const { fresh = false, ...filters } = options;
    const request = sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      ...filters,
    });
    const key = productCanonicalJson([
      context.scope,
      context.connectionId,
      identity,
      revision,
      request,
    ]);
    context.current();
    if (!fresh && context.project.online && !this.ports.context.value.errors[source]) {
      const saved = this.sessionPages.get(key);
      if (saved) return structuredClone(saved.page);
    }
    const active = this.sessionPagesReading.get(key);
    if (active) return structuredClone(await active);
    const read = (async (): Promise<WorkspaceSessionPage> => {
      const paged = context.project.runtime.features?.includes(SESSION_PAGE_FEATURE) === true;
      let online = context.project.online;
      const checkItems = (items: SessionMetadata[]) => {
        if (
          items.some(
            (item) =>
              item.userId !== target.userId ||
              item.machineId !== target.machineId ||
              item.project.localProjectId !== target.localProjectId,
          )
        )
          throw Error('会话列表执行范围不匹配。');
      };
      if (paged) {
        let page;
        try {
          if (this.ports.context.value.errors[source])
            throw this.catalogFailures.get(source) ?? Error('请重新连接原电脑。');
          if (!online) throw new RequestFailure('执行电脑离线。', 'network', null, 'unconfirmed');
          page = validateSessionPageResult(
            request,
            await this.ports.context.execute(
              context,
              this.ports.context.command(context.scope, 'sessions-page', request),
            ),
          );
          checkItems(page.items);
          await this.ports.store
            .sessionPage(context.scope, context.current, request, page)
            .catch(() => context.current());
        } catch (error) {
          context.current();
          this.forgetSessionPages(productCanonicalJson([source, target]));
          if (!isWorkspaceListOfflineFailure(error)) throw error;
          page = await this.ports.store.sessionPage(context.scope, context.current, request);
          if (!page) throw error;
          online = false;
        }
        return {
          items: page.items,
          nextCursor: page.nextCursor,
          revision: page.revision,
          source: online ? 'host' : 'cache',
          partial: !online || page.nextCursor !== null,
          legacy: false,
        };
      }
      if (request.cursor) throw Error('旧主机没有可继续的分页游标，请重新读取。');
      // Only an unadvertised capability chooses this compatibility path. An
      // unsuccessful modern page never retries using the full-list endpoint.
      let sessions: SessionMetadata[];
      try {
        if (this.ports.context.value.errors[source])
          throw this.catalogFailures.get(source) ?? Error('请重新连接原电脑。');
        if (!online) throw new RequestFailure('执行电脑离线。', 'network', null, 'unconfirmed');
        const legacyKey = productCanonicalJson([
          context.scope,
          context.connectionId,
          identity,
          revision,
        ]);
        let pending = this.legacyListsReading.get(legacyKey);
        if (!pending) {
          pending = (async () => {
            const items = sessionListSchema.parse(
              await this.ports.context.execute(
                context,
                this.ports.context.command(context.scope, 'sessions', {}),
              ),
            );
            checkItems(items);
            await this.ports.store
              .sessionList(context.scope, context.current, items)
              .catch(() => context.current());
            return items;
          })().finally(() => this.legacyListsReading.delete(legacyKey));
          this.legacyListsReading.set(legacyKey, pending);
        }
        sessions = await pending;
      } catch (error) {
        context.current();
        this.forgetSessionPages(productCanonicalJson([source, target]));
        if (!isWorkspaceListOfflineFailure(error)) throw error;
        const cached = await this.ports.store.sessionList(context.scope, context.current);
        if (!cached) throw error;
        sessions = cached;
        online = false;
      }
      return {
        items: sessions
          .filter((item) => sessionPageMatches(item, request))
          .sort(compareSessionPageItems),
        nextCursor: null,
        source: online ? 'host' : 'cache',
        partial: !online,
        legacy: true,
      };
    })()
      .then((page) => {
        context.current();
        if (page.source === 'host') {
          const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
          const previous = this.sessionPages.get(key);
          if (previous) {
            this.sessionPages.delete(key);
            this.sessionPageBytes -= previous.bytes;
          }
          if (bytes <= 8 * 1024 * 1024) {
            this.sessionPages.set(key, {
              page: structuredClone(page),
              scope: productCanonicalJson([source, target]),
              bytes,
            });
            this.sessionPageBytes += bytes;
          }
          while (this.sessionPages.size > 64 || this.sessionPageBytes > 8 * 1024 * 1024) {
            const oldest = this.sessionPages.keys().next().value!;
            this.sessionPageBytes -= this.sessionPages.get(oldest)!.bytes;
            this.sessionPages.delete(oldest);
          }
        }
        return page;
      })
      .finally(() => this.sessionPagesReading.delete(key));
    this.sessionPagesReading.set(key, read);
    return structuredClone(await read);
  }
  projectContext(source: WorkspaceSource, target: Project['target'], sessionId?: string): Context {
    const catalog = this.ports.context.value.catalogs[source];
    const project = catalog?.targets.find((entry) => same(entry.target, target));
    if (!catalog || !project) throw Error('项目不属于当前电脑列表。');
    const current = () => {
      const latest = this.ports.context.value.catalogs[source];
      if (
        this.ports.context.closed ||
        latest?.connectionId !== catalog.connectionId ||
        latest.owner !== catalog.owner ||
        !same(latest.actor ?? null, catalog.actor ?? null) ||
        !latest.targets.some((entry) => same(entry.target, target))
      )
        throw Error('项目列表已改变，请重新读取。');
    };
    const scope = { source, target: structuredClone(project.target) };
    return {
      scope,
      project: structuredClone(project),
      connectionId: catalog.connectionId,
      current,
      sessionId,
    };
  }
  dispose() {
    this.sessionPages.clear();
    this.sessionPageBytes = 0;
  }
}
