import { type AttentionActor } from '@moor/protocol/attention';
import { productCanonicalJson } from '@moor/protocol/canonical-json';
import { RequestFailure } from '@moor/protocol/request-failure';
import { type RunSelection } from '@moor/protocol/run-config';
import { type SearchHit } from '@moor/protocol/search-protocol';
import { type SessionPageRequest } from '@moor/protocol/session-page';
import { type SessionMetadata } from '@moor/protocol/session-responses';
import {
  type WorkspaceCatalog,
  type WorkspaceRequest,
  type WorkspaceSource,
} from '@moor/protocol/workspace-client-protocol';
import { ClientSessionReplica } from '@moor/session/client-session-replica';
import { readClientSession } from '@moor/session/session-operations';
import { z } from 'zod';
import {
  WorkspacePersistence,
  type WorkspaceDraft,
  type WorkspaceLedger,
  type WorkspaceScope,
} from '../../operations/workspace/compose';
export type Project = WorkspaceCatalog['targets'][number];
export type WorkspaceSessionPageOptions = Partial<
  Pick<SessionPageRequest, 'archived' | 'pinned' | 'query' | 'limit' | 'cursor'>
> & { fresh?: boolean };
export type WorkspaceSessionPage = {
  items: SessionMetadata[];
  nextCursor: string | null;
  revision?: string;
  source: 'host' | 'cache';
  partial: boolean;
  legacy: boolean;
};
export const projectListingIdentity = (project: Project) => ({
  target: project.target,
  online: project.online,
  runtime: {
    id: project.runtime.id,
    userId: project.runtime.userId,
    machineId: project.runtime.machineId,
    project: project.runtime.projects.find((entry) => entry.id === project.target.localProjectId),
    features: project.runtime.features,
    agents: project.runtime.agents.map(({ id, cliType, agentType }) => ({
      id,
      cliType,
      agentType,
    })),
  },
});
export type Session = Omit<ReturnType<typeof readClientSession>, 'update'>;
export type ClientSessionDelta = NonNullable<ClientSessionReplica['lastRead']>;
export type Context = {
  scope: WorkspaceScope;
  project: Project;
  sessionId?: string;
  connectionId: string;
  current: () => void;
};
export type WorkspaceClientState = {
  catalogs: Partial<Record<WorkspaceSource, WorkspaceCatalog>>;
  errors: Partial<Record<WorkspaceSource, string>>;
  scope?: WorkspaceScope;
  project?: Project;
  sessions: SessionMetadata[];
  sessionPage?: WorkspaceSessionPage;
  sessionListError?: string;
  sessionId?: string;
  session?: Session;
  /** Host confirmation and an offline cache commit are independent facts. */
  sessionCache?: { status: 'saving' | 'saved' | 'failed' | 'unavailable'; version?: string };
  sendProgress?: {
    sessionId: string;
    stage: 'preparing' | 'uploading' | 'sending';
    uploaded?: number;
    total?: number;
  };
  offline: boolean;
  sessionLoad:
    | { status: 'idle' }
    | { status: 'loading-cache'; showIndicator?: boolean }
    | { status: 'refreshing'; source: 'none' | 'cache' | 'host' }
    | { status: 'ready'; source: 'host' }
    | {
        status: 'failed';
        source: 'none' | 'cache' | 'host';
        reason: 'connection' | 'local';
      };
  ledger?: WorkspaceLedger;
  draft?: WorkspaceDraft;
  modelError?: string;
  usageLoading?: boolean;
  modelLoading?: boolean;
  searchFocus?: SearchHit;
  focusedTurnId?: string;
  syncDisconnected?: Partial<Record<WorkspaceSource, boolean>>;
};
export const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string(),
          status: z.number().nullable(),
          rejected: z.boolean(),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);
export const same = (a: unknown, b: unknown) => productCanonicalJson(a) === productCanonicalJson(b);
export const isWorkspaceListOfflineFailure = (error: unknown) =>
  error instanceof RequestFailure &&
  (error.code === 'network' ||
    (error.delivery !== 'not-dispatched' && [503, 504].includes(error.status ?? 0)));
export const DRAFT_SAVE_DELAY_MS = 300;
export const SESSION_LOADING_DELAY_MS = 120;
export const SESSION_VIEW_LIMIT = 30;
export const SESSION_VIEW_BYTES = 32 * 1024 * 1024;
export type SessionView = {
  session: Session;
  draft: WorkspaceDraft;
  sessionBytes: number;
  draftBytes: number;
  bytes: number;
};
export const frozenSnapshots = new WeakSet<object>();
export const snapshotSizes = new WeakMap<object, number>();
export const viewBudgetSizes = new WeakMap<object, number>();
export const snapshotEncoder = new TextEncoder();
export function immutableSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object' || frozenSnapshots.has(value)) return value;
  frozenSnapshots.add(value);
  for (const child of Object.values(value)) immutableSnapshot(child);
  return Object.freeze(value);
}
export function immutableJsonBytes(value: unknown, viewBudget = false): number {
  // A JSON string needs at most six UTF-8 bytes per UTF-16 code unit (\uXXXX),
  // plus quotes. Only the in-memory view LRU uses this conservative budget:
  // large text may be evicted earlier, without serializing it on every chunk.
  if (viewBudget && typeof value === 'string' && value.length > 4096) return 2 + 6 * value.length;
  if (value === null || typeof value !== 'object')
    return snapshotEncoder.encode(JSON.stringify(value) ?? 'null').byteLength;
  const sizes = viewBudget ? viewBudgetSizes : snapshotSizes;
  const previous = sizes.get(value);
  if (previous !== undefined) return previous;
  let bytes = 2,
    count = 0;
  if (Array.isArray(value)) {
    for (const child of value) {
      bytes += immutableJsonBytes(child, viewBudget);
      count++;
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      bytes += immutableJsonBytes(key, viewBudget) + 1 + immutableJsonBytes(child, viewBudget);
      count++;
    }
  }
  bytes += Math.max(0, count - 1);
  sizes.set(value, bytes);
  return bytes;
}
export const sessionViewBudget = (value: unknown) => immutableJsonBytes(value, true);
export const withoutSource = <T>(
  values: Partial<Record<WorkspaceSource, T>>,
  source: WorkspaceSource,
) => {
  const result = { ...values };
  delete result[source];
  return result;
};
export type BufferedDraft = {
  scope: WorkspaceScope;
  sessionId: string;
  text: string;
  selection: RunSelection;
  actor?: AttentionActor;
  failed?: (error: unknown) => void;
  saved?: () => void;
  committed?: WorkspaceDraft;
};
export type WorkspaceOptions = {
  sessionReceived?: () => ((owner: object, sessionId: string, version: string) => void) | undefined;
  request: (request: WorkspaceRequest) => Promise<unknown>;
  store: WorkspacePersistence;
  uuid: () => string;
  now: () => string;
  schedule: (ms: number, work: () => void) => () => void;
  /** Yield low-priority cache work; tests inject deterministic barriers. */
  yieldCache: () => Promise<void>;
  restoreLegacy?: (scope: WorkspaceScope, sessionId: string, current: () => void) => Promise<void>;
};
