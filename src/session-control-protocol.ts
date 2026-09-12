import { z } from 'zod';
import { id, mutationSchema, sessionActionSchema } from './protocol';
import { contentScopeSchema } from './content-protocol';

export const SESSION_CONTROL_FEATURE = 'session-control-v1';
export const SESSION_CONTROL_LIMITS = { requestBytes: 48 * 1024 * 1024, responseBytes: 4096 };
export const sessionControlScopeSchema = contentScopeSchema.extend({
  sessionId: id.regex(/^[A-Za-z0-9_-]+$/),
  controlVersion: z.literal(1),
  userId: z.string().min(1).max(160),
  machineId: id,
});
const base = sessionControlScopeSchema.extend({ operationId: id });
export const sessionControlActionSchema = z.discriminatedUnion('action', [
  base
    .extend({
      action: z.literal('create'),
      agentId: id,
      title: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  base.extend({ action: z.literal('stop'), turnId: id }).strict(),
]);
export const sessionOriginalOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('control'), value: sessionControlActionSchema }).strict(),
  z.object({ kind: z.literal('mutation'), value: mutationSchema }).strict(),
  z.object({ kind: z.literal('metadata'), value: sessionActionSchema }).strict(),
]);
export const sessionOperationSchema = sessionControlScopeSchema
  .extend({
    action: z.enum(['inspect', 'abandon']),
    request: sessionOriginalOperationSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    const original = input.request.value;
    if (
      original.workspaceId !== input.workspaceId ||
      original.sessionId !== input.sessionId ||
      ('localProjectId' in original && original.localProjectId !== input.localProjectId) ||
      ('userId' in original &&
        (original.userId !== input.userId || original.machineId !== input.machineId))
    )
      ctx.addIssue({ code: 'custom', message: '原操作与恢复范围不匹配' });
  });
export const sessionControlReceiptSchema = base
  .extend({
    confirmed: z.literal(true),
    kind: z.enum(['create', 'stop', 'mutation', 'metadata']),
    status: z.enum(['accepted', 'abandoned', 'stopping', 'interrupted']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (['stopping', 'interrupted'].includes(value.status) && value.kind !== 'stop')
      ctx.addIssue({ code: 'custom', message: '只有停止操作可以处于停止核查状态' });
  });
const result = sessionControlScopeSchema.extend({
  confirmed: z.literal(true),
  action: z.enum(['inspect', 'abandon']),
  operationId: id,
});
export const sessionOperationResultSchema = z.discriminatedUnion('found', [
  result.extend({ found: z.literal(false) }).strict(),
  result.extend({ found: z.literal(true), receipt: sessionControlReceiptSchema }).strict(),
]);
export type SessionControlScope = z.infer<typeof sessionControlScopeSchema>;
export type SessionControlAction = z.infer<typeof sessionControlActionSchema>;
export type SessionOriginalOperation = z.infer<typeof sessionOriginalOperationSchema>;
export type SessionOperation = z.infer<typeof sessionOperationSchema>;
export type SessionControlReceipt = z.infer<typeof sessionControlReceiptSchema>;
export type SessionOperationResult = z.infer<typeof sessionOperationResultSchema>;

export function validateSessionControlReceipt(
  raw: unknown,
  scope: SessionControlScope,
  original: SessionOriginalOperation,
) {
  const parsed = sessionControlReceiptSchema.parse(raw),
    request = original.value;
  if (
    parsed.workspaceId !== scope.workspaceId ||
    parsed.userId !== scope.userId ||
    parsed.machineId !== scope.machineId ||
    parsed.localProjectId !== scope.localProjectId ||
    parsed.sessionId !== scope.sessionId ||
    parsed.operationId !== request.operationId ||
    parsed.kind !== (original.kind === 'control' ? original.value.action : original.kind)
  )
    throw new Error('主机回执与原会话操作不匹配');
  return parsed;
}
export function validateSessionOperationResult(raw: unknown, request: SessionOperation) {
  const parsed = sessionOperationResultSchema.parse(raw);
  if (
    parsed.workspaceId !== request.workspaceId ||
    parsed.userId !== request.userId ||
    parsed.machineId !== request.machineId ||
    parsed.localProjectId !== request.localProjectId ||
    parsed.sessionId !== request.sessionId ||
    parsed.operationId !== request.request.value.operationId ||
    parsed.action !== request.action ||
    (request.action === 'abandon' && !parsed.found)
  )
    throw new Error('主机核查结果与原会话操作不匹配');
  if (parsed.found) validateSessionControlReceipt(parsed.receipt, request, request.request);
  return parsed;
}
