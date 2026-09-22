import { useEffect, useMemo, useState } from 'react';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import type { DesktopWorkspaceSource } from '@moor/client/workspace-protocol';
import {
  WorkspaceRequestError,
  isWorkspaceListOfflineFailure,
  type WorkspaceController,
  type WorkspaceClientState,
  type WorkspaceSessionPage,
} from '../workspace/workspace-controller';
export type NavigationProject = NonNullable<WorkspaceClientState['project']> & {
  source: DesktopWorkspaceSource;
};
export const projectKey = (entry: NavigationProject) => canonical([entry.source, entry.target]);
export const workspaceKey = (entry: NavigationProject) =>
  canonical([
    entry.source,
    entry.target.serverKey,
    entry.target.owner,
    entry.target.catalogWorkspaceId,
  ]);
export function navigationProjects(state: WorkspaceClientState): NavigationProject[] {
  return (['local', 'remote'] as const).flatMap((source) =>
    (state.catalogs[source]?.targets ?? []).map((entry) => ({ ...entry, source })),
  );
}

type Kind = 'pinned' | 'recent' | 'all';
type Entry = {
  connection: string;
  generation: number;
  online: boolean;
  page?: WorkspaceSessionPage;
  loading?: boolean;
  error?: string;
};
export const sessionPageError = (error: unknown) =>
  error instanceof WorkspaceRequestError && error.status === 409
    ? '会话列表已变化，请重新读取。'
    : '会话列表尚未确认，请重新读取或检查连接。';

export function appendNavigationPage(
  previous: WorkspaceSessionPage,
  next: WorkspaceSessionPage,
): WorkspaceSessionPage {
  if (
    previous.revision !== next.revision ||
    next.items.some((item) => previous.items.some((old) => old.id === item.id))
  )
    throw Error('会话分页版本或位置已改变，请重新读取。');
  const cached = previous.source === 'cache' || next.source === 'cache';
  return {
    ...next,
    items: [...previous.items, ...next.items],
    source: cached ? 'cache' : 'host',
    partial: cached || next.nextCursor !== null,
  };
}

/** Metadata summaries only. Project bodies, drafts and unknown operations never
 * participate in this reader or its invalidation/caching lifecycle. */
export function useNavigationSessions(
  controller: WorkspaceController,
  state: WorkspaceClientState,
  visible?: NavigationProject[],
  query = '',
) {
  const paged = typeof controller.listProjectSessionPage === 'function';
  const projects = visible ?? navigationProjects(state);
  const reads = projects.flatMap((project) =>
    (paged ? (['pinned', 'recent'] as const) : (['all'] as const)).map((kind) => ({
      project,
      kind: kind as Kind,
      query: query.trim(),
      key: canonical([projectKey(project), kind, query.trim()]),
      connection: canonical([
        state.catalogs[project.source]?.connectionId,
        state.catalogs[project.source]?.actor ?? null,
      ]),
      generation:
        controller.projectRevision?.(project.source, project.target) ??
        controller.navigationRevision ??
        0,
      online: project.online,
    })),
  );
  type Read = (typeof reads)[number];
  const [result, setResult] = useState<Record<string, Entry>>({});
  const reader = useMemo(
    () => ({
      active: true,
      running: false,
      desired: [] as Read[],
      cache: {} as Record<string, Entry>,
      inFlight: new Set<string>(),
      moreRunning: new Set<string>(),
      start: () => {},
    }),
    [controller],
  );
  const signature = canonical(reads.map(({ project: _project, ...read }) => read));
  const fetchPage = async (
    read: Read,
    cursor?: string,
    fresh = false,
  ): Promise<WorkspaceSessionPage> => {
    if (paged)
      return controller.listProjectSessionPage(read.project.source, read.project.target, {
        archived: 'active',
        pinned: read.kind === 'pinned' ? 'pinned' : 'unpinned',
        query: read.query,
        limit: 30,
        ...(cursor ? { cursor } : {}),
        fresh,
      });
    return {
      items: await controller.listProjectSessions(read.project.source, read.project.target),
      nextCursor: null,
      source: 'host',
      partial: false,
      legacy: true,
    };
  };
  const publish = () => {
    if (reader.active) setResult({ ...reader.cache });
  };
  useEffect(() => {
    reader.active = true;
    return () => {
      reader.active = false;
    };
  }, [reader]);
  useEffect(() => {
    reader.desired = reads;
    const keys = new Set(reads.map((read) => read.key));
    for (const key of Object.keys(reader.cache)) if (!keys.has(key)) delete reader.cache[key];
    const needed = (read: Read) => {
      const entry = reader.cache[read.key];
      return (
        !entry ||
        entry.connection !== read.connection ||
        entry.generation !== read.generation ||
        entry.online !== read.online
      );
    };
    reader.start = () => {
      if (!reader.active || reader.running) return;
      reader.running = true;
      const worker = async () => {
        while (reader.active) {
          const read = reader.desired.find(
            (entry) => !reader.inFlight.has(entry.key) && needed(entry),
          );
          if (!read) return;
          reader.inFlight.add(read.key);
          let page: WorkspaceSessionPage | undefined, error: string | undefined;
          try {
            page = await fetchPage(read, undefined, true);
          } catch (reason) {
            error = sessionPageError(reason);
          } finally {
            reader.inFlight.delete(read.key);
          }
          if (
            reader.desired.some(
              (entry) => entry.key === read.key && entry.connection === read.connection,
            )
          ) {
            reader.cache[read.key] = {
              connection: read.connection,
              generation: read.generation,
              online: read.online,
              page,
              error,
            };
            publish();
          }
        }
      };
      void Promise.all(Array.from({ length: 4 }, worker)).finally(() => {
        reader.running = false;
        if (reader.active && reader.desired.some(needed)) reader.start();
      });
    };
    publish();
    reader.start();
  }, [controller, reader, signature]);

  const refresh = (kind: 'pinned' | 'recent') => {
    for (const read of reader.desired.filter((read) => read.kind === kind || read.kind === 'all')) {
      delete reader.cache[read.key];
    }
    publish();
    reader.start();
  };
  const loadMore = async (kind: 'pinned' | 'recent') => {
    const identity = () =>
      canonical([
        kind,
        reader.desired
          .filter((read) => read.kind === kind || read.kind === 'all')
          .map(({ key, connection, generation }) => ({ key, connection, generation })),
      ]);
    const original = identity();
    if (reader.moreRunning.has(original)) return false;
    reader.moreRunning.add(original);
    const pending = reader.desired.filter(
      (read) =>
        read.kind === kind &&
        reader.cache[read.key]?.page?.nextCursor &&
        !reader.cache[read.key]?.loading,
    );
    const worker = async () => {
      while (pending.length && reader.active) {
        const read = pending.shift()!,
          entry = reader.cache[read.key];
        if (
          !entry?.page ||
          !reader.desired.some(
            (current) =>
              current.key === read.key &&
              current.connection === read.connection &&
              current.generation === read.generation,
          )
        )
          continue;
        const previous = entry.page;
        entry.loading = true;
        delete entry.error;
        publish();
        try {
          const next = await fetchPage(read, previous.nextCursor!, true);
          if (reader.cache[read.key] === entry) entry.page = appendNavigationPage(previous, next);
        } catch (error) {
          if (reader.cache[read.key] === entry) {
            entry.page = isWorkspaceListOfflineFailure(error)
              ? { ...previous, source: 'cache', partial: true }
              : undefined;
            entry.error = isWorkspaceListOfflineFailure(error)
              ? '下一页尚未缓存，请连接后再读取。'
              : sessionPageError(error);
          }
        } finally {
          entry.loading = false;
          publish();
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
      return reader.active && identity() === original;
    } finally {
      reader.moreRunning.delete(original);
    }
  };
  const sessions: Record<string, SessionMetadata[]> = {},
    unavailable: string[] = [],
    cached: string[] = [];
  const summaries = {
    pinned: { more: false, loading: false, cached: false, legacy: false, error: false },
    recent: { more: false, loading: false, cached: false, legacy: false, error: false },
  };
  for (const read of reads) {
    const entry = result[read.key];
    if (entry?.connection !== read.connection) continue;
    const key = projectKey(read.project);
    const values = (sessions[key] ??= []);
    for (const item of entry.page?.items ?? [])
      if (!values.some((old) => old.id === item.id)) values.push(item);
    if (entry.error && !unavailable.includes(key)) unavailable.push(key);
    if (entry.page?.source === 'cache' && !cached.includes(key)) cached.push(key);
    for (const kind of read.kind === 'all' ? (['pinned', 'recent'] as const) : [read.kind]) {
      const summary = summaries[kind];
      summary.more ||= !!entry.page?.nextCursor;
      summary.loading ||= !!entry.loading;
      summary.cached ||= entry.page?.source === 'cache';
      summary.legacy ||= !!entry.page?.legacy;
      summary.error ||= !!entry.error;
    }
  }
  if (!paged && state.project && state.scope)
    sessions[projectKey({ ...state.project, source: state.scope.source })] = state.sessions;
  return { sessions, unavailable, cached, summaries, loadMore, refresh };
}
