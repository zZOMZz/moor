import { z } from 'zod';
import { agentSchema, assert, id, type SessionAction } from './protocol';
import { forkOriginSchema } from './fork-protocol';

export const SESSION_RESPONSE_LIMITS = {
  readBytes: 48 * 1024 * 1024,
  listBytes: 8 * 1024 * 1024,
  receiptBytes: 64 * 1024,
  listItems: 10000,
} as const;
// Opaque CRDT bytes remain host-authored. The relay validates the envelope but
// never imports a document or persists its contents.
export const sessionBase64Schema = z
  .string()
  .max(44000000)
  .refine(
    (value) =>
      value.length % 4 === 0 &&
      !/[^A-Za-z0-9+/=]/.test(value) &&
      (value.indexOf('=') === -1 ||
        value.indexOf('=') === value.length - 1 ||
        (value.indexOf('=') === value.length - 2 && value.endsWith('=='))),
    '无效的文档编码',
  );
export const sessionMetadataSchema = z.object({
  id,
  userId: z.string().min(1).max(1000),
  machineId: id,
  project: z.object({ kind: z.literal('local'), localProjectId: id }),
  agentConfigId: id,
  cliType: z.string().max(200),
  agentType: z.string().max(200),
  // Older host-generated Fork titles appended a suffix to a 200-character title.
  title: z.string().max(220).optional(),
  titleSource: z.string().max(100).optional(),
  createdAt: z.string().max(100).optional(),
  lastMessageAt: z.number().finite().optional(),
  status: z.object({ type: z.string().max(100) }).optional(),
  isArchived: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  metadataRevision: z.number().int().nonnegative().safe().optional(),
  latestUserMsgId: id.optional(),
  lastHandledUserMsgId: id.optional(),
  forkOrigin: forkOriginSchema.optional(),
});
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export const sessionListSchema = z
  .array(sessionMetadataSchema)
  .max(SESSION_RESPONSE_LIMITS.listItems);
export const sessionReadResponseSchema = z.object({
  meta: sessionMetadataSchema,
  metaBundle: z
    .object({
      version: z.number().int().nonnegative(),
      entries: z.record(
        z
          .object({
            c: z.string().max(1000),
            d: z.unknown().optional(),
            m: z.record(z.unknown()).optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  update: sessionBase64Schema,
  synced: z.literal(true),
  online: z.literal(true),
  persisted: z.boolean().optional(),
  persistenceError: z.string().max(1000).optional(),
  agent: agentSchema.optional(),
});
const acceptedMutationReceiptSchema = z
  .object({
    accepted: z.literal(true),
    delivered: z.literal(true),
    operationId: id,
  })
  .strict();
const acceptedSessionActionReceiptSchema = acceptedMutationReceiptSchema
  .extend({ meta: sessionMetadataSchema })
  .strict();
const abandonedReceiptSchema = z
  .object({
    accepted: z.literal(false),
    delivered: z.literal(false),
    abandoned: z.literal(true),
    operationId: id,
  })
  .strict();
export const mutationReceiptSchema = z.discriminatedUnion('accepted', [
  acceptedMutationReceiptSchema,
  abandonedReceiptSchema,
]);
export const sessionActionReceiptSchema = z.discriminatedUnion('accepted', [
  acceptedSessionActionReceiptSchema,
  abandonedReceiptSchema,
]);
export const sessionCancelSchema = z.object({ sessionId: id, turnId: id }).strict();
export const sessionCancelReceiptSchema = z.object({ success: z.literal(true) }).strict();

export function validateSessionActionReceipt(action: SessionAction, raw: unknown) {
  const result = sessionActionReceiptSchema.parse(raw);
  assert(result.operationId === action.operationId, 502, '会话操作确认与原请求不匹配');
  if (!result.accepted) return result;
  assert(
    result.operationId === action.operationId &&
      result.meta.id === action.sessionId &&
      result.meta.project.localProjectId === action.localProjectId &&
      result.meta.metadataRevision === action.expectedRevision + 1,
    502,
    '会话操作确认与原请求不匹配',
  );
  const meta = result.meta;
  assert(
    action.action === 'rename'
      ? meta.title === action.title && meta.titleSource === 'user'
      : action.action === 'archive'
        ? meta.isArchived === true
        : action.action === 'restore'
          ? meta.isArchived === false
          : action.action === 'pin'
            ? meta.isPinned === true
            : meta.isPinned === false,
    502,
    '会话操作确认与原操作不匹配',
  );
  return result;
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameJsonValue(v, b[i]))
    );
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameJsonValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

export function validateSessionBundle(result: z.infer<typeof sessionReadResponseSchema>) {
  const name = 'session-' + result.meta.id;
  for (const [encoded, entry] of Object.entries(result.metaBundle.entries)) {
    const key: unknown = JSON.parse(encoded);
    assert(
      Array.isArray(key) &&
        key[1] === name &&
        ((key.length === 2 && key[0] === 'e') ||
          (key.length === 3 &&
            key[0] === 'm' &&
            typeof key[2] === 'string' &&
            Object.hasOwn(sessionMetadataSchema.shape, key[2]))),
      502,
      '会话元数据超出原请求范围',
    );
    assert(!entry.m || Object.keys(entry.m).length === 0, 502, '会话元数据包含不支持的属性');
    if (entry.d === undefined) continue;
    const field =
      key[0] === 'e'
        ? z.boolean()
        : sessionMetadataSchema.shape[key[2] as keyof typeof sessionMetadataSchema.shape];
    const parsed = field.parse(entry.d);
    assert(sameJsonValue(parsed, entry.d), 502, '会话元数据包含不支持的字段');
    if (
      key[0] === 'm' &&
      ['id', 'userId', 'machineId', 'project', 'agentConfigId', 'cliType', 'agentType'].includes(
        key[2],
      )
    )
      assert(
        sameJsonValue(parsed, result.meta[key[2] as keyof SessionMetadata]),
        502,
        '会话元数据身份与响应不匹配',
      );
  }
}
