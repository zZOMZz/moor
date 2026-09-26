import { z } from 'zod';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import { sessionReadResponseSchema, validateSessionBundle } from '@moor/protocol/session-responses';
import { readClientSession, verifiedSessionDelta } from '@moor/client/session-client';
import { decode, VersionVector } from '@moor/session/model';
import type { StorageBackend, StorageChange } from '../../platform/indexed-storage';
import type { WorkspaceScope } from './workspace-store';

type Envelope = z.infer<typeof sessionReadResponseSchema>;
export type SessionCacheChain = { checkpoint: Envelope; deltas: Envelope[]; version?: string };
export const SESSION_CACHE_LIMITS = { deltas: 64, bytes: 1024 * 1024 } as const;
const headSchema = z
  .object({
    cacheVersion: z.literal(2),
    revision: z.number().int().nonnegative().safe(),
    checkpointVersion: z
      .string()
      .min(1)
      .max(1024 * 1024),
    version: z
      .string()
      .min(1)
      .max(1024 * 1024),
    count: z.number().int().min(0).max(SESSION_CACHE_LIMITS.deltas),
    bytes: z.number().int().min(0).max(SESSION_CACHE_LIMITS.bytes),
  })
  .strict();
const segmentSchema = z
  .object({
    baseVersion: z.string(),
    version: z.string(),
    response: sessionReadResponseSchema,
  })
  .strict();
const keys = (scope: WorkspaceScope, sessionId: string) => ({
  head: canonical(['moor-workspace-session-cache-v2', scope, sessionId]),
  checkpoint: canonical(['moor-workspace-session-cache-v2', scope, sessionId, 'checkpoint']),
  delta: (index: number) =>
    canonical(['moor-workspace-session-cache-v2', scope, sessionId, 'delta', index]),
  legacy: canonical(['moor-desktop-session-v1', scope, sessionId]),
});
function envelope(raw: unknown, scope: WorkspaceScope, sessionId: string) {
  const value = sessionReadResponseSchema.parse(raw);
  validateSessionBundle(value);
  if (
    value.meta.id !== sessionId ||
    value.meta.userId !== scope.target.userId ||
    value.meta.machineId !== scope.target.machineId ||
    value.meta.project.localProjectId !== scope.target.localProjectId
  )
    throw Error('缓存会话不属于原电脑和项目。');
  if (value.persisted === false || value.persistenceError)
    throw Error('缓存会话尚未由主机持久确认。');
  return value;
}

/** Read a consistent, bounded chain. CRDT replay and final version verification are
 * performed by the caller's session replica; no live-session decode happens here. */
export async function loadWorkspaceSessionCache(
  backend: StorageBackend,
  scope: WorkspaceScope,
  sessionId: string,
  current: () => void,
): Promise<SessionCacheChain | null> {
  const key = keys(scope, sessionId);
  return backend.exclusive(key.head, current, async () => {
    const raw = await backend.read(key.head);
    current();
    if (raw == null) {
      const legacy = await backend.read(key.legacy);
      current();
      return legacy == null ? null : { checkpoint: envelope(legacy, scope, sessionId), deltas: [] };
    }
    const head = headSchema.parse(raw);
    const checkpoint = envelope(await backend.read(key.checkpoint), scope, sessionId);
    current();
    let version = head.checkpointVersion;
    let storedBytes = 0;
    const deltas: Envelope[] = [];
    for (let index = 1; index <= head.count; index++) {
      const segment = segmentSchema.parse(await backend.read(key.delta(index)));
      current();
      if (segment.baseVersion !== version) throw Error('缓存会话增量缺少前置版本。');
      deltas.push(envelope(segment.response, scope, sessionId));
      storedBytes += new TextEncoder().encode(JSON.stringify(segment.response)).byteLength;
      if (storedBytes > SESSION_CACHE_LIMITS.bytes) throw Error('缓存会话增量超过容量限制。');
      version = segment.version;
    }
    if (version !== head.version) throw Error('缓存会话增量版本不匹配。');
    if (storedBytes !== head.bytes) throw Error('缓存会话增量容量记录不匹配。');
    return { checkpoint, deltas, version };
  });
}

/** Only replica-verified deltas can enter the cache. Normal commits write one
 * small segment and the head; a checkpoint and segment deletion commit together. */
export async function cacheWorkspaceSessionDelta(
  backend: StorageBackend,
  scope: WorkspaceScope,
  sessionId: string,
  rawDelta: unknown,
  current: () => void,
  checkpoint: () => Envelope,
) {
  const accepted = verifiedSessionDelta(rawDelta, { ...scope.target, sessionId });
  const { response, baseVersion, version } = accepted;
  if (response.persisted === false || response.persistenceError) return;
  if (!backend.compareAndSetMany) throw Error('当前本机存储不能原子保存会话增量。');
  const key = keys(scope, sessionId);
  const bytes = new TextEncoder().encode(JSON.stringify(accepted.response)).byteLength;
  await backend.exclusive(key.head, current, async () => {
    const original = await backend.read(key.head);
    current();
    const head = original == null ? undefined : headSchema.parse(original);
    if (head && head.version !== version) {
      const existing = VersionVector.decode(decode(head.version)),
        incoming = VersionVector.decode(decode(version));
      try {
        const order = existing.compare(incoming);
        // A slower window cannot roll a confirmed cache back or discard a branch.
        if (order === undefined || order > 0) return;
      } finally {
        existing.free();
        incoming.free();
      }
    }
    const append =
      head &&
      baseVersion === head.version &&
      head.count < SESSION_CACHE_LIMITS.deltas &&
      head.bytes + bytes <= SESSION_CACHE_LIMITS.bytes;
    const changes: StorageChange[] = [];
    let next: z.infer<typeof headSchema>;
    if (append) {
      const segmentKey = key.delta(head.count + 1);
      const before = await backend.read(segmentKey);
      current();
      changes.push({
        key: segmentKey,
        expected: before,
        value: { baseVersion, version, response },
      });
      next = {
        ...head,
        revision: head.revision + 1,
        version,
        count: head.count + 1,
        bytes: head.bytes + bytes,
      };
    } else {
      // Full materialization and verification are deliberately confined to this
      // recovery boundary, never performed once per streaming delta.
      const snapshot = envelope(checkpoint(), scope, sessionId);
      if (readClientSession(snapshot, { ...scope.target, sessionId }).version !== version)
        throw Error('缓存检查点与已确认增量版本不匹配。');
      const before = await backend.read(key.checkpoint);
      current();
      changes.push({ key: key.checkpoint, expected: before, value: snapshot });
      for (let index = 1; index <= (head?.count ?? 0); index++) {
        const segmentKey = key.delta(index);
        const previous = await backend.read(segmentKey);
        current();
        changes.push({ key: segmentKey, expected: previous, delete: true });
      }
      next = {
        cacheVersion: 2,
        revision: (head?.revision ?? 0) + 1,
        checkpointVersion: version,
        version,
        count: 0,
        bytes: 0,
      };
    }
    changes.push({ key: key.head, expected: original, value: headSchema.parse(next) });
    current();
    await backend.compareAndSetMany!(changes, current);
  });
}
