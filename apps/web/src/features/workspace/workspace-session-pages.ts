import { z } from 'zod';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import {
  sessionPageRequestSchema,
  SESSION_PAGE_LIMITS,
  validateSessionPageResult,
  type SessionPageRequest,
} from '@moor/protocol/session-page';
import type { StorageBackend, StorageChange } from '../../platform/indexed-storage';
import type { WorkspaceScope } from './workspace-store';

export const SESSION_PAGE_CACHE_LIMITS = { pages: 64, bytes: 8 * 1024 * 1024 } as const;
const pageKey = (scope: WorkspaceScope, request: SessionPageRequest) =>
  canonical(['moor-workspace-session-page-v1', scope, request]);
const headKey = (scope: WorkspaceScope) =>
  canonical(['moor-workspace-session-pages-index-v1', scope]);
const bytes = (value: unknown) => new TextEncoder().encode(canonical(value)).byteLength;
const referenceSchema = z
  .object({
    request: sessionPageRequestSchema,
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(SESSION_PAGE_LIMITS.responseBytes),
  })
  .strict();
const headSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    pages: z.array(referenceSchema).max(SESSION_PAGE_CACHE_LIMITS.pages),
  })
  .strict();
const filterKey = ({ cursor: _cursor, ...request }: SessionPageRequest) => canonical(request);
function checkedRequest(scope: WorkspaceScope, raw: SessionPageRequest) {
  const request = sessionPageRequestSchema.parse(raw);
  if (
    request.workspaceId !== scope.target.workspaceId ||
    request.localProjectId !== scope.target.localProjectId
  )
    throw Error('缓存会话分页不属于原电脑和项目。');
  return request;
}

/** Bounded disposable metadata. References carry typed requests, never database
 * keys; every deletion key is derived inside this scope's page namespace. */
export async function workspaceSessionPage(
  backend: StorageBackend,
  scope: WorkspaceScope,
  current: () => void,
  rawRequest: SessionPageRequest,
  input?: unknown,
) {
  const request = checkedRequest(scope, rawRequest),
    key = pageKey(scope, request);
  const raw = input === undefined ? await backend.read(key) : input;
  current();
  if (raw === null || raw === undefined) return undefined;
  const page = validateSessionPageResult(request, raw);
  if (
    page.items.some(
      (item) => item.userId !== scope.target.userId || item.machineId !== scope.target.machineId,
    )
  )
    throw Error('缓存会话分页不属于原账号和电脑。');
  if (input === undefined) return page;
  if (!backend.compareAndSetMany) throw Error('当前本机存储不能原子保存分页缓存。');
  const index = headKey(scope);
  await backend.exclusive(index, current, async () => {
    const original = await backend.read(index);
    current();
    const head =
      original == null
        ? { version: 1 as const, revision: 0, pages: [] }
        : headSchema.parse(original);
    const keys = new Set<string>();
    for (const entry of head.pages) {
      const stored = checkedRequest(scope, entry.request),
        storedKey = pageKey(scope, stored);
      if (keys.has(storedKey)) throw Error('缓存分页索引包含重复位置。');
      keys.add(storedKey);
    }
    if (
      bytes(head) + head.pages.reduce((sum, entry) => sum + entry.bytes, 0) >
      SESSION_PAGE_CACHE_LIMITS.bytes
    )
      throw Error('缓存分页索引超过容量限制。');
    const next = {
      version: 1 as const,
      revision: head.revision + 1,
      pages: [
        ...head.pages.filter(
          (entry) =>
            pageKey(scope, entry.request) !== key &&
            (request.cursor ||
              filterKey(entry.request) !== filterKey(request) ||
              entry.revision === page.revision),
        ),
        { request, revision: page.revision, bytes: bytes(page) },
      ],
    };
    while (
      next.pages.length > SESSION_PAGE_CACHE_LIMITS.pages ||
      bytes(next) + next.pages.reduce((sum, entry) => sum + entry.bytes, 0) >
        SESSION_PAGE_CACHE_LIMITS.bytes
    )
      next.pages.shift();
    headSchema.parse(next);
    const retained = new Set(next.pages.map((entry) => pageKey(scope, entry.request)));
    if (!retained.has(key)) throw Error('会话页超过本机缓存容量。');
    const changes: StorageChange[] = [
      { key: index, expected: original, value: next },
      { key, expected: await backend.read(key), value: page },
    ];
    for (const entry of head.pages) {
      const retiredKey = pageKey(scope, entry.request);
      if (!retained.has(retiredKey))
        changes.push({ key: retiredKey, expected: await backend.read(retiredKey), delete: true });
    }
    current();
    await backend.compareAndSetMany!(changes, current);
    current();
  });
  return page;
}
