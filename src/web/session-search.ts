import { id } from '../protocol';
import {
  SEARCH_LIMITS,
  sessionSearchRequestSchema,
  sessionSearchResultSchema,
  type SearchHit,
  type SessionSearchRequest,
} from '../search-protocol';
import { projectDiffReferenceSchema } from '../project-content-protocol';
import {
  sessionSearchDocument,
  searchExcerpt,
  type FrozenSearchDiff,
} from '../session-search-document';
import {
  projectContentKey,
  readProjectTurnDiff,
  readProjectDiffFile,
  type ProjectContentTarget,
  type ProjectContentDependencies,
} from './project-content';

export type SearchSession = { id: string; title: string };
export type SessionSearchView = {
  source: 'host-index' | 'cache';
  query: string;
  scope: 'session' | 'project';
  hits: SearchHit[];
  more: boolean;
  partial: boolean;
  coverage?: { cachedSessions: number; knownSessions: number; cachedDiffFiles: number };
};
export type SearchDependencies = ProjectContentDependencies & {
  // The caller verifies each cached document's owner, machine and project before
  // exposing its history. Never pass an unpersisted display document here.
  readHistory(target: ProjectContentTarget): Promise<readonly any[] | undefined>;
};
export const OFFLINE_SEARCH_LIMITS = { sessions: 100, diffFiles: 64 } as const;

export async function searchSessionContent(
  target: ProjectContentTarget,
  options: Pick<SessionSearchRequest, 'query' | 'scope'> & { limit?: number },
  online: boolean,
  sessions: readonly SearchSession[],
  dependencies: SearchDependencies,
): Promise<SessionSearchView> {
  projectContentKey(target); // validate the complete immutable execution identity
  const request = sessionSearchRequestSchema.parse({
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    searchVersion: 1,
    ...options,
  });
  if (online) {
    const result = sessionSearchResultSchema.parse(
      await dependencies.request(
        `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/session-search`,
        request,
      ),
    );
    if (
      result.workspaceId !== request.workspaceId ||
      result.localProjectId !== request.localProjectId ||
      result.sessionId !== request.sessionId ||
      result.query !== request.query ||
      result.scope !== request.scope ||
      result.hits.length > request.limit ||
      (request.scope === 'session' && result.hits.some((hit) => hit.sessionId !== target.sessionId))
    )
      throw new Error('搜索响应与当前执行范围或查询不匹配。');
    return {
      source: 'host-index',
      query: result.query,
      scope: result.scope,
      hits: result.hits,
      more: result.more,
      partial: result.partial,
    };
  }
  const known =
    request.scope === 'session'
      ? [target.sessionId]
      : [...new Set(sessions.map((session) => id.parse(session.id)))];
  const result: SessionSearchView = {
    source: 'cache',
    query: request.query,
    scope: request.scope,
    hits: [],
    more: false,
    partial: known.length > OFFLINE_SEARCH_LIMITS.sessions,
    coverage: { cachedSessions: 0, knownSessions: known.length, cachedDiffFiles: 0 },
  };
  const terms = request.query.toLowerCase().split(/\s+/u);
  let bytes = 0,
    candidates = 0,
    diffReads = 0;
  const encoder = new TextEncoder();
  const cacheOnly: ProjectContentDependencies = {
    read: dependencies.read,
    write: async () => {
      throw new Error('离线搜索不会修改缓存');
    },
    request: async () => {
      throw new Error('离线搜索不会请求主机');
    },
  };
  sessions: for (const sessionId of known.slice(0, OFFLINE_SEARCH_LIMITS.sessions)) {
    const scope = { ...target, sessionId };
    let history: readonly any[] | undefined;
    try {
      history = await dependencies.readHistory(scope);
    } catch {
      result.partial = true;
      continue;
    }
    if (!history) {
      result.partial = true;
      continue;
    }
    result.coverage!.cachedSessions++;
    if (history.length > SEARCH_LIMITS.entries) result.partial = true;
    const frozen: FrozenSearchDiff[] = [];
    for (const turn of history.slice(-SEARCH_LIMITS.entries)) {
      const parsed = projectDiffReferenceSchema.safeParse(turn?.fileDiff);
      if (!parsed.success) continue;
      const ref = parsed.data;
      if (ref.turnId !== turn.id || !ref.version) {
        result.partial = true;
        continue;
      }
      if (diffReads >= OFFLINE_SEARCH_LIMITS.diffFiles) {
        result.partial = true;
        break;
      }
      diffReads++;
      try {
        const summary = await readProjectTurnDiff(scope, turn.id, false, cacheOnly, ref);
        const changes: FrozenSearchDiff['diff']['changes'] = [];
        for (const change of summary.result.changes) {
          if (diffReads >= OFFLINE_SEARCH_LIMITS.diffFiles) {
            result.partial = true;
            break;
          }
          diffReads++;
          // The summary paths are useful even if the file's bytes were never read.
          let saved = change;
          try {
            const file = await readProjectDiffFile(scope, ref, change, false, cacheOnly);
            const size = encoder.encode(
              (file.result.before?.text ?? '') + (file.result.after?.text ?? ''),
            ).byteLength;
            if (bytes + size > SEARCH_LIMITS.scanBytes) {
              result.partial = true;
              break;
            }
            bytes += size;
            saved = { ...change, before: file.result.before, after: file.result.after };
            result.coverage!.cachedDiffFiles++;
          } catch {
            result.partial = true;
          }
          changes.push({
            ...change,
            before: saved.before ? { ...saved.before, metadataVersion: '' } : null,
            after: saved.after ? { ...saved.after, metadataVersion: '' } : null,
          });
        }
        frozen.push({
          frozen: true,
          turnId: turn.id,
          itemIndex: 0,
          diff: {
            version: 1,
            basis: 'project-snapshot',
            changes,
            partial: summary.result.partial,
            issues: [],
          },
        });
      } catch {
        result.partial = true;
      }
    }
    const projection = sessionSearchDocument(history, frozen);
    result.partial ||= projection.partial;
    for (const entry of projection.entries.slice().reverse()) {
      bytes += encoder.encode(entry.text).byteLength;
      if (++candidates > SEARCH_LIMITS.candidates || bytes > SEARCH_LIMITS.scanBytes) {
        result.partial = true;
        break sessions;
      }
      const folded = entry.text.toLowerCase();
      if (!terms.every((term) => folded.includes(term))) continue;
      if (result.hits.length >= request.limit) {
        result.more = true;
        break sessions;
      }
      const { text: _text, ...anchor } = entry;
      result.hits.push({
        ...anchor,
        sessionId,
        excerpt: searchExcerpt(entry.text, folded.indexOf(terms[0]!)),
      });
    }
  }
  return result;
}
