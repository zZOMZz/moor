import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { metas, mirror } from '../model';
import { id } from '../protocol';
import type { ContentScope } from '../content-protocol';
import { projectDiffReferenceSchema } from '../project-content-protocol';
import {
  SEARCH_LIMITS,
  sessionSearchRequestSchema,
  sessionSearchResultSchema,
  type SessionSearchRequest,
  type SessionSearchResult,
} from '../search-protocol';
import { sessionSearchDocument, type SearchScope } from '../runtime/session-search';
import type { RuntimeStore } from '../runtime/store';

const PROJECTION_VERSION = 2;
export const HOST_SEARCH_LIMITS = {
  sessions: 100,
  bytes: 64 * 1024 * 1024,
  candidates: 5000,
} as const;
type Lease = SearchScope & { rootPath: string };
export type HostSearchContext = {
  store: RuntimeStore;
  settlementFailures: ReadonlyMap<string, unknown>;
  projectLease(scope: ContentScope, localProjectId?: string): Lease;
  checkProjectLease(lease: Lease): void;
};
type SearchOptions = {
  // Local limits and deterministic checkpoints are never accepted over the host protocol.
  sessions?: number;
  bytes?: number;
  checkpoint?: (
    stage: 'before-refresh' | 'after-refresh',
    sessionId: string,
  ) => void | Promise<void>;
};

function authorizedSessions(host: HostSearchContext, lease: Lease, range: 'session' | 'project') {
  return Object.entries(metas(host.store.meta))
    .filter(
      ([name, meta]) =>
        id.safeParse(meta.id).success &&
        name === 'session-' + meta.id &&
        meta.userId === lease.userId &&
        meta.machineId === lease.machineId &&
        (meta.project as { localProjectId?: string } | undefined)?.localProjectId ===
          lease.localProjectId &&
        host.store.attachmentScopeMatches({ ...lease, sessionId: String(meta.id) }) &&
        (range === 'project' || meta.id === lease.sessionId),
    )
    .map(([, meta]) => ({
      id: String(meta.id),
      lastMessageAt: typeof meta.lastMessageAt === 'number' ? meta.lastMessageAt : 0,
    }))
    .sort((a, b) =>
      a.id === lease.sessionId
        ? -1
        : b.id === lease.sessionId
          ? 1
          : b.lastMessageAt - a.lastMessageAt || a.id.localeCompare(b.id),
    );
}

function current(host: HostSearchContext, scope: SearchScope) {
  if (host.settlementFailures.has(scope.sessionId)) return false;
  const source = host.store.searchSource(scope.sessionId);
  const cached = host.store.searchIndexVersion(scope);
  return !!(
    source &&
    cached?.revision === source.revision &&
    cached.projectionVersion === PROJECTION_VERSION
  );
}

/** Refresh a bounded set of dirty, authorized documents; never execute an Agent or read the project. */
export async function searchHostSessions(
  host: HostSearchContext,
  input: SessionSearchRequest,
  localProjectId?: string,
  options: SearchOptions = {},
): Promise<SessionSearchResult> {
  const request = sessionSearchRequestSchema.parse(input);
  const lease = host.projectLease(request, localProjectId);
  const { rootPath: _rootPath, ...scope } = lease;
  const sessionLimit = z
    .number()
    .int()
    .min(1)
    .max(HOST_SEARCH_LIMITS.sessions)
    .parse(options.sessions ?? HOST_SEARCH_LIMITS.sessions);
  const byteLimit = z
    .number()
    .int()
    .min(1)
    .max(HOST_SEARCH_LIMITS.bytes)
    .parse(options.bytes ?? HOST_SEARCH_LIMITS.bytes);
  const all = authorizedSessions(host, lease, request.scope);
  const candidates = all.slice(0, HOST_SEARCH_LIMITS.candidates);
  let partial = all.length > candidates.length,
    refreshed = 0,
    bytes = 0;
  for (const candidate of candidates) {
    const sessionScope = { ...scope, sessionId: candidate.id };
    if (current(host, sessionScope)) continue;
    if (host.settlementFailures.has(candidate.id) || refreshed >= sessionLimit) {
      partial = true;
      continue;
    }
    await options.checkpoint?.('before-refresh', candidate.id);
    host.checkProjectLease(lease);
    if (
      !authorizedSessions(host, lease, request.scope).some((entry) => entry.id === candidate.id)
    ) {
      partial = true;
      continue;
    }
    const source = host.store.searchSource(candidate.id);
    if (!source || bytes + source.bytes > byteLimit) {
      partial = true;
      continue;
    }
    refreshed++;
    bytes += source.bytes;
    try {
      const view = mirror(host.store.doc(candidate.id), candidate.id);
      let history: any[];
      try {
        history = view.getState().history;
      } finally {
        view.dispose();
      }
      const anchors = [];
      let incomplete = false;
      // The projector has its own entry/text limits. Bound traversal of snapshot
      // references independently, including turns with no visible text items.
      for (const turn of history.slice(0, 8000)) {
        if (turn?.fileDiff === undefined || turn.fileDiff === null) continue;
        const reference = projectDiffReferenceSchema.safeParse(turn.fileDiff);
        if (!reference.success || reference.data.turnId !== turn.id) {
          incomplete = true;
          continue;
        }
        anchors.push({ reference: reference.data, itemIndex: 0 });
      }
      if (history.length > 8000) incomplete = true;
      const document = sessionSearchDocument(history);
      const messages = document.entries;
      document.entries = [];
      let documentBytes = 0;
      const append = (entries: typeof messages) => {
        for (const entry of entries) {
          const size = Buffer.byteLength(entry.text);
          if (
            bytes + size > byteLimit ||
            documentBytes + size > SEARCH_LIMITS.documentBytes ||
            document.entries.length >= SEARCH_LIMITS.entries
          ) {
            document.partial = true;
            continue;
          }
          document.entries.push(entry);
          bytes += size;
          documentBytes += size;
        }
      };
      // Visible messages remain searchable even when the same session has more
      // frozen file history than this bounded refresh can load.
      append(messages);
      const frozen = host.store.projectHistory.searchDiffs(
        sessionScope,
        anchors,
        byteLimit - bytes,
      );
      bytes += frozen.bytes;
      const files = sessionSearchDocument([], frozen.diffs);
      append(files.entries);
      document.partial ||= incomplete || frozen.partial || files.partial;
      host.store.transaction(() => {
        host.store.sessionSearch.replace(sessionScope, document);
        host.store.markSearchIndexed(sessionScope, source.revision, PROJECTION_VERSION);
      });
    } catch {
      // The previous index remains intact for recovery, but its old revision is
      // excluded from this response. A later manual search may retry the refresh.
      partial = true;
    }
    await options.checkpoint?.('after-refresh', candidate.id);
    await setImmediate();
    host.checkProjectLease(lease);
  }
  host.checkProjectLease(lease);
  const available = new Set(
    authorizedSessions(host, lease, request.scope).map((entry) => entry.id),
  );
  const allowed = candidates
    .filter((entry) => available.has(entry.id) && current(host, { ...scope, sessionId: entry.id }))
    .map((entry) => entry.id);
  partial ||= allowed.length !== candidates.length || available.size !== candidates.length;
  const result = host.store.sessionSearch.search(
    scope,
    request.query,
    request.scope,
    request.limit,
    allowed,
  );
  host.checkProjectLease(lease);
  return sessionSearchResultSchema.parse({
    searchVersion: 1,
    workspaceId: request.workspaceId,
    localProjectId: request.localProjectId,
    sessionId: request.sessionId,
    scope: request.scope,
    query: request.query,
    confirmed: true,
    source: 'host-index',
    ...result,
    partial: partial || result.partial,
  });
}
