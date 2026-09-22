import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import {
  SESSION_PAGE_FEATURE,
  sessionPageRequestSchema,
  validateSessionPageResult,
  type SessionPageRequest,
} from '@moor/protocol/session-page';

import type { SessionMetadataIndex } from '../persistence/session-metadata';

type Source = { workspace: RuntimeWorkspace; index: SessionMetadataIndex };
const fingerprint = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cursorSchema = z
  .object({
    version: z.literal(2),
    binding: z.string(),
    revision: z.string(),
    position: z
      .object({
        pin: z.number().int().min(0).max(1),
        time: z.number().finite(),
        id: z.string().min(1).max(160),
      })
      .strict(),
  })
  .strict();

/** Read only the selected SQL metadata page; never import session bodies. */
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
  const scope = {
    userId: runtime.userId,
    machineId: runtime.machineId,
    localProjectId: request.localProjectId,
  };
  const identity = [runtime.id, runtime.userId, runtime.machineId, request.localProjectId];
  const binding = fingerprint([
    identity,
    request.archived,
    request.pinned,
    request.query,
    request.limit,
  ]);
  return source.index.snapshot(() => {
    const revision = fingerprint([identity, source.index.version(scope)]);
    let position: z.infer<typeof cursorSchema>['position'] | undefined;
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
      position = cursor.position;
    }
    const rows = source.index.page(scope, request, position);
    assert(!position || rows.length > 0, 409, '会话分页位置已失效，请从第一页重新读取');
    const page = rows.slice(0, request.limit);
    const items = page.map((row) => row.item);
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
        rows.length > request.limit
          ? Buffer.from(
              JSON.stringify({ version: 2, binding, revision, position: page.at(-1)!.position }),
            ).toString('base64url')
          : null,
    });
  });
}
