import { z } from 'zod';
import {
  actorSchema,
  attentionListQuerySchema,
  attentionSeenSchema,
  attentionDispositionSchema,
  attentionPermissionSchema,
  attentionContinueSchema,
} from '@moor/protocol/attention';
import {
  attentionPageSchema,
  attentionDetailSchema,
  attentionItemSchema,
  attentionItemsPageSchema,
} from '@moor/protocol/attention-response';
import { id } from '@moor/protocol/protocol';
import type { DesktopWorkspaceTarget } from './workspace-protocol';

const item = z.string().min(1).max(1024);
export const workspaceAttentionCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), query: attentionListQuerySchema }).strict(),
  z.object({ kind: z.literal('items'), query: attentionListQuerySchema }).strict(),
  z.object({ kind: z.literal('detail'), itemId: item }).strict(),
  z.object({ kind: z.literal('seen'), itemId: item, input: attentionSeenSchema }).strict(),
  z
    .object({ kind: z.literal('disposition'), itemId: item, input: attentionDispositionSchema })
    .strict(),
  z
    .object({ kind: z.literal('permission'), itemId: item, input: attentionPermissionSchema })
    .strict(),
  z.object({ kind: z.literal('continue'), itemId: item, input: attentionContinueSchema }).strict(),
]);
export type WorkspaceAttentionCommand = z.infer<typeof workspaceAttentionCommandSchema>;
export { actorSchema };
export function workspaceAttentionRoute(
  target: DesktopWorkspaceTarget,
  input: WorkspaceAttentionCommand,
) {
  const command = workspaceAttentionCommandSchema.parse(input);
  if ((command.kind === 'list') === !!target.sessionId)
    throw Error('待办请求缺少原项目或会话范围。');
  if (
    command.kind === 'continue' &&
    (command.input.mutation.workspaceId !== target.workspaceId ||
      command.input.mutation.sessionId !== target.sessionId)
  )
    throw Error('待办后续指令不属于原会话。');
  const e = encodeURIComponent;
  let path = `/api/workspaces/${e(target.catalogWorkspaceId)}/replicas/${e(target.replicaId)}/`;
  path += command.kind === 'list' ? 'attention' : `sessions/${e(target.sessionId!)}/attention`;
  if ('itemId' in command) path += '/' + e(command.itemId);
  if ('input' in command) return { path: path + '/' + command.kind, body: command.input };
  if ('query' in command)
    path +=
      '?' +
      new URLSearchParams(
        Object.entries(command.query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ).toString();
  return { path, body: undefined };
}
const receiptSchema = z
  .object({
    accepted: z.literal(true),
    delivered: z.literal(true),
    operationId: id,
    item: attentionItemSchema.optional(),
  })
  .strict();
export function validateWorkspaceAttentionResponse(
  input: unknown,
  target: DesktopWorkspaceTarget,
  command: WorkspaceAttentionCommand,
) {
  workspaceAttentionRoute(target, command);
  const checkItem = (item: z.infer<typeof attentionItemSchema>) => {
    if (
      item.localProjectId !== target.localProjectId ||
      (target.sessionId && item.sessionId !== target.sessionId) ||
      ('itemId' in command && item.itemId !== command.itemId)
    )
      throw Error('待办回执不属于原项目、会话或事项。');
  };
  if (command.kind === 'items') {
    const page = attentionItemsPageSchema.parse(input);
    for (const item of page.items) checkItem(item);
    return page;
  }
  if (command.kind === 'list') {
    const page = attentionPageSchema.parse(input);
    for (const group of page.sessions) {
      if (target.sessionId && group.sessionId !== target.sessionId)
        throw Error('待办列表不属于原会话。');
      for (const item of group.items) {
        checkItem(item);
        if (item.sessionId !== group.sessionId) throw Error('待办分组与会话不匹配。');
      }
    }
    return page;
  }
  if (command.kind === 'detail') {
    const detail = attentionDetailSchema.parse(input);
    checkItem(detail.item);
    if (
      detail.permission &&
      (detail.item.kind !== 'permission' ||
        detail.permission.requestId !== detail.item.requestId ||
        detail.permission.expectedTurnId !== detail.item.userTurnId)
    )
      throw Error('待办审批不属于原回合和请求。');
    return detail;
  }
  const receipt = receiptSchema.parse(input);
  const operationId =
    command.kind === 'continue' ? command.input.mutation.operationId : command.input.operationId;
  if (receipt.operationId !== operationId) throw Error('待办回执与原操作编号不匹配。');
  if (receipt.item) checkItem(receipt.item);
  return receipt;
}
