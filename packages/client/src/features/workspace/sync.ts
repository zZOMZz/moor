import type { FeatureContext } from './feature-context';
import {
  workspaceChangeSchema,
  type WorkspaceChange,
  type WorkspaceSource,
} from '@moor/protocol/workspace-client-protocol';
import type { WorkspaceCatalogService } from './catalog';
import { same } from './model';
import type { WorkspaceSessionsService } from './sessions';
/** Capabilities consumed by sync use cases; supplied only by the workspace composition root. */
export interface WorkspaceSyncPorts {
  context: FeatureContext<
    'closed' | 'value' | 'emit' | 'schedule' | 'generation' | 'current',
    'catalogs' | 'scope' | 'sessionId' | 'sessionLoad' | 'syncDisconnected',
    never,
    never
  >;
  sessions: Pick<WorkspaceSessionsService, 'refreshSession'>;
  catalog: Pick<
    WorkspaceCatalogService,
    'catalogReads' | 'projectRevision' | 'refreshCatalog' | 'invalidateProject' | 'refreshSessions'
  >;
}
export class WorkspaceSyncService {
  constructor(readonly ports: WorkspaceSyncPorts) {}
  sessionSyncPending = false;
  sessionSyncing?: { generation: number; promise: Promise<void> };
  syncPending = new Map<WorkspaceSource, WorkspaceChange & { catalogOnly: boolean }>();
  syncing?: Promise<void>;
  cancelSync?: () => void;
  sessionListReads = 0;
  syncAfterRead = false;
  syncAfterList = false;
  syncAfterCatalog = new Set<WorkspaceSource>();
  enqueueSync(raw?: unknown) {
    if (this.ports.context.closed) return;
    if (raw === undefined) {
      for (const catalog of Object.values(this.ports.context.value.catalogs))
        this.enqueueSync({
          source: catalog.source,
          connectionId: catalog.connectionId,
          owner: catalog.owner,
          kind: 'connected',
        });
      return;
    }
    const parsed = workspaceChangeSchema.safeParse(raw);
    if (!parsed.success) return;
    const notice = parsed.data,
      catalog = this.ports.context.value.catalogs[notice.source];
    if (!catalog || catalog.connectionId !== notice.connectionId || catalog.owner !== notice.owner)
      return;
    if (
      notice.deviceId &&
      !catalog.targets.some(
        ({ target }) =>
          target.deviceId === notice.deviceId &&
          (!notice.workspaceId || target.workspaceId === notice.workspaceId),
      )
    )
      return;
    this.ports.context.value.syncDisconnected = {
      ...this.ports.context.value.syncDisconnected,
      [notice.source]: notice.kind === 'disconnected',
    };
    if (notice.kind === 'disconnected') {
      this.ports.context.emit();
      return;
    }
    const scope = this.ports.context.value.scope;
    if (
      this.ports.context.value.sessionId &&
      scope?.source === notice.source &&
      (!notice.deviceId || scope.target.deviceId === notice.deviceId) &&
      (!notice.workspaceId || scope.target.workspaceId === notice.workspaceId) &&
      (!notice.sessionId || notice.sessionId === this.ports.context.value.sessionId) &&
      (notice.kind === 'connected' || notice.workspaceId || notice.sessionId)
    )
      this.sessionSyncPending = true;
    const prior = this.syncPending.get(notice.source),
      catalogOnly = notice.kind === 'changed' && !notice.workspaceId && !notice.sessionId;
    this.syncPending.set(
      notice.source,
      prior
        ? {
            ...notice,
            kind: prior.kind === 'connected' ? 'connected' : notice.kind,
            deviceId: prior.deviceId === notice.deviceId ? notice.deviceId : undefined,
            workspaceId: prior.workspaceId === notice.workspaceId ? notice.workspaceId : undefined,
            sessionId: prior.sessionId === notice.sessionId ? notice.sessionId : undefined,
            catalogOnly: prior.catalogOnly && catalogOnly,
          }
        : { ...notice, catalogOnly },
    );
  }
  scheduleSync(raw?: unknown) {
    this.enqueueSync(raw);
    void this.drainSessionSync();
    this.scheduleSidebarSync();
  }
  scheduleSidebarSync() {
    if (this.ports.context.closed || this.cancelSync || !this.syncPending.size) return;
    this.cancelSync = this.ports.context.schedule(500, () => {
      this.cancelSync = undefined;
      void this.drainSync();
    });
  }
  async synchronize(raw?: unknown) {
    this.enqueueSync(raw);
    this.cancelSync?.();
    this.cancelSync = undefined;
    await Promise.all([this.drainSessionSync(), this.drainSync()]);
    await this.drainSessionSync();
  }
  drainSessionSync(): Promise<void> {
    if (this.sessionSyncing?.generation === this.ports.context.generation)
      return this.sessionSyncing.promise;
    if (this.ports.context.closed || !this.sessionSyncPending) return Promise.resolve();
    const drain = { generation: this.ports.context.generation, promise: Promise.resolve() };
    this.sessionSyncing = drain;
    // A microtask joins a synchronous notification burst without adding a timer
    // to the active transcript. Subsequent reads only chase notices received in flight.
    drain.promise = Promise.resolve()
      .then(async () => {
        while (
          !this.ports.context.closed &&
          this.ports.context.generation === drain.generation &&
          this.sessionSyncing === drain &&
          this.sessionSyncPending
        ) {
          this.sessionSyncPending = false;
          if (!this.ports.context.value.sessionId) continue;
          if (
            ['loading-cache', 'refreshing'].includes(this.ports.context.value.sessionLoad.status)
          ) {
            this.syncAfterRead = true;
            break;
          }
          try {
            await this.ports.sessions.refreshSession({ announce: false, background: true });
          } catch {
            // The read retains the confirmed transcript and reports connectivity.
          }
        }
      })
      .finally(() => {
        // A response from a previous selection cannot consume its successor's
        // pending notice or clear the new selection's in-flight drain.
        if (this.sessionSyncing !== drain) return;
        this.sessionSyncing = undefined;
        if (
          drain.generation === this.ports.context.generation &&
          this.sessionSyncPending &&
          !this.ports.context.closed
        )
          void this.drainSessionSync();
      });
    return drain.promise;
  }
  drainSync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      if (!this.ports.context.closed && this.syncPending.size) {
        const pending = [...this.syncPending.values()];
        this.syncPending.clear();
        for (const notice of pending) {
          const catalog = this.ports.context.value.catalogs[notice.source];
          if (catalog?.connectionId !== notice.connectionId || catalog.owner !== notice.owner)
            continue;
          try {
            if (this.ports.catalog.catalogReads[notice.source]) {
              this.syncAfterCatalog.add(notice.source);
              continue;
            }
            const selected = this.ports.context.value.scope,
              selectedRevision = selected
                ? this.ports.catalog.projectRevision(selected.source, selected.target)
                : undefined;
            if (notice.kind === 'connected' || !notice.workspaceId)
              await this.ports.catalog.refreshCatalog(notice.source);
            const targets = this.ports.context.value.catalogs[notice.source]?.targets ?? [];
            for (const { target } of targets)
              if (
                !notice.catalogOnly &&
                (!notice.deviceId || target.deviceId === notice.deviceId) &&
                (!notice.workspaceId || target.workspaceId === notice.workspaceId)
              )
                this.ports.catalog.invalidateProject(notice.source, target);
            this.ports.context.emit();
            const scope = this.ports.context.value.scope;
            if (
              !scope ||
              scope.source !== notice.source ||
              (notice.deviceId && scope.target.deviceId !== notice.deviceId) ||
              (notice.workspaceId && scope.target.workspaceId !== notice.workspaceId)
            )
              continue;
            if (
              notice.catalogOnly &&
              same(selected, scope) &&
              selectedRevision === this.ports.catalog.projectRevision(scope.source, scope.target)
            )
              continue;
            const current = this.ports.context.current();
            await this.ports.catalog.refreshSessions({ background: true });
            current();
            if (notice.kind === 'connected' && this.ports.context.value.sessionId) {
              this.sessionSyncPending = true;
              void this.drainSessionSync();
            }
          } catch {
            // Read methods retain the last confirmed view and expose their connection state.
          }
        }
      }
    })().finally(() => {
      this.syncing = undefined;
      this.scheduleSidebarSync();
    });
    return this.syncing;
  }
  dispose() {
    this.cancelSync?.();
    this.syncPending.clear();
    this.sessionSyncPending = false;
  }
}
