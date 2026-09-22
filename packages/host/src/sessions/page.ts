import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import { sessionMetadataSchema } from '@moor/protocol/session-responses';
import {
  SESSION_PAGE_FEATURE,
  compareSessionPageItems,
  sessionPageMatches,
  sessionPageRequestSchema,
  validateSessionPageResult,
  type SessionPageRequest,
} from '@moor/protocol/session-page';

type Source = { workspace: RuntimeWorkspace; list(localProjectId: string): readonly unknown[] };
const fingerprint = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cursorSchema = z
  .object({
    version: z.literal(1),
    binding: z.string(),
    revision: z.string(),
    offset: z.number().int().positive().safe(),
  })
  .strict();

/** Transport-bounded metadata page. Source.list still scans host metadata; this
 * does not move an index or any session body to the relay. */
export function readSessionPage(source: Source, raw: SessionPageRequest, localProjectId?: string) {
  const request = sessionPageRequestSchema.parse(raw),
    runtime = source.workspace;
  assert(
    request.workspaceId === runtime.id && request.localProjectId === localProjectId,
    400,
    '会话分页范围与原项目不匹配',
  );
  assert(
    runtime.projects.some((project) => project.id === request.localProjectId),
    404,
    '会话分页项目不可用',
  );
  assert(runtime.features?.includes(SESSION_PAGE_FEATURE), 409, '执行主机不支持会话分页');
  const rows = source.list(request.localProjectId).map((raw) => sessionMetadataSchema.parse(raw));
  assert(
    rows.every(
      (row) =>
        row.userId === runtime.userId &&
        row.machineId === runtime.machineId &&
        row.project.localProjectId === request.localProjectId,
    ),
    502,
    '会话目录包含其他执行范围',
  );
  assert(new Set(rows.map((row) => row.id)).size === rows.length, 502, '会话目录包含重复编号');
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const identity = [runtime.id, runtime.userId, runtime.machineId, request.localProjectId];
  const binding = fingerprint([
    identity,
    request.archived,
    request.pinned,
    request.query,
    request.limit,
  ]);
  const revision = fingerprint([identity, rows]);
  let offset = 0;
  if (request.cursor) {
    let cursor: z.infer<typeof cursorSchema> | undefined;
    try {
      const bytes = Buffer.from(request.cursor, 'base64url');
      if (bytes.toString('base64url') === request.cursor)
        cursor = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      /* A malformed or retired cursor never relaxes the current scope. */
    }
    assert(
      cursor?.binding === binding && cursor.revision === revision,
      409,
      '会话列表或筛选条件已变化，请从第一页重新读取',
    );
    offset = cursor.offset;
  }
  const filtered = rows
    .filter((row) => sessionPageMatches(row, request))
    .sort(compareSessionPageItems);
  assert(offset === 0 || offset < filtered.length, 409, '会话分页位置已失效，请从第一页重新读取');
  const items = filtered.slice(offset, offset + request.limit),
    next = offset + items.length;
  return validateSessionPageResult(request, {
    pageVersion: 1,
    workspaceId: request.workspaceId,
    localProjectId: request.localProjectId,
    confirmed: true,
    archived: request.archived,
    pinned: request.pinned,
    query: request.query,
    limit: request.limit,
    revision,
    items,
    nextCursor:
      next < filtered.length
        ? Buffer.from(JSON.stringify({ version: 1, binding, revision, offset: next })).toString(
            'base64url',
          )
        : null,
  });
}
