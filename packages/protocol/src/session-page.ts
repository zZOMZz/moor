import { z } from 'zod';
import { assert, id } from './protocol';
import { sessionMetadataSchema, type SessionMetadata } from './session-responses';

export const SESSION_PAGE_FEATURE = 'session-page-v1';
export const SESSION_PAGE_LIMITS = {
  items: 100,
  query: 200,
  cursor: 2048,
  responseBytes: 1024 * 1024,
} as const;
const cursorSchema = z
  .string()
  .min(1)
  .max(SESSION_PAGE_LIMITS.cursor)
  .regex(/^[A-Za-z0-9_-]+$/);
const filters = {
  archived: z.enum(['active', 'archived', 'all']).default('active'),
  pinned: z.enum(['all', 'pinned', 'unpinned']).default('all'),
  query: z
    .string()
    .trim()
    .max(SESSION_PAGE_LIMITS.query)
    .refine((value) => !/[\x00-\x1f\x7f]/u.test(value))
    .default(''),
  limit: z.number().int().min(1).max(SESSION_PAGE_LIMITS.items).default(30),
};
export const sessionPageRequestSchema = z
  .object({
    pageVersion: z.literal(1),
    workspaceId: id,
    localProjectId: id,
    ...filters,
    cursor: cursorSchema.optional(),
  })
  .strict();
export type SessionPageRequest = z.infer<typeof sessionPageRequestSchema>;

export function sessionPageMatches(meta: SessionMetadata, request: SessionPageRequest) {
  const query = request.query.toLowerCase();
  return (
    (request.archived === 'all' ||
      (meta.isArchived === true) === (request.archived === 'archived')) &&
    (request.pinned === 'all' || (meta.isPinned === true) === (request.pinned === 'pinned')) &&
    (!query ||
      meta.id.toLowerCase().includes(query) ||
      (meta.title ?? '').toLowerCase().includes(query))
  );
}
export function compareSessionPageItems(a: SessionMetadata, b: SessionMetadata) {
  return (
    Number(b.isPinned === true) - Number(a.isPinned === true) ||
    (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
export const sessionPageResultSchema = z
  .object({
    pageVersion: z.literal(1),
    workspaceId: id,
    localProjectId: id,
    confirmed: z.literal(true),
    archived: filters.archived.removeDefault(),
    pinned: filters.pinned.removeDefault(),
    query: filters.query.removeDefault(),
    limit: filters.limit.removeDefault(),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    items: z.array(sessionMetadataSchema).max(SESSION_PAGE_LIMITS.items),
    nextCursor: cursorSchema.nullable(),
  })
  .strict();
export type SessionPageResult = z.infer<typeof sessionPageResultSchema>;

/** Scope and filtering are verified again at every receiving boundary. */
export function validateSessionPageResult(
  request: SessionPageRequest,
  raw: unknown,
): SessionPageResult {
  request = sessionPageRequestSchema.parse(request);
  assert(
    new TextEncoder().encode(JSON.stringify(raw) ?? '').length <= SESSION_PAGE_LIMITS.responseBytes,
    502,
    '会话分页响应超过限制',
  );
  const parsed = sessionPageResultSchema.safeParse(raw);
  assert(parsed.success, 502, '会话分页响应结构不可验证');
  const result = parsed.data;
  assert(
    result.workspaceId === request.workspaceId &&
      result.localProjectId === request.localProjectId &&
      result.archived === request.archived &&
      result.pinned === request.pinned &&
      result.query === request.query &&
      result.limit === request.limit &&
      result.items.length <= request.limit &&
      new Set(result.items.map((item) => item.id)).size === result.items.length &&
      result.items.every(
        (item, index) =>
          item.project.localProjectId === request.localProjectId &&
          sessionPageMatches(item, request) &&
          (!index || compareSessionPageItems(result.items[index - 1], item) < 0),
      ) &&
      (result.nextCursor === null ||
        (result.items.length > 0 && result.nextCursor !== request.cursor)),
    502,
    '会话分页响应与原请求不匹配',
  );
  return result;
}
