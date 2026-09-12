import { z } from 'zod';
import { id } from './protocol';
import { contentScopeSchema } from './content-protocol';

export const ROLE_FEATURE = 'roles-v1';
export const ROLE_LIMITS = {
  items: 50,
  instructionBytes: 16 * 1024,
  catalogBytes: 1024 * 1024,
  requestBytes: 128 * 1024,
  responseBytes: 2 * 1024 * 1024,
} as const;
const revision = z.number().int().nonnegative().safe();
const label = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\x00-\x1f\x7f]+$/u)
  .refine((v) => !!v.trim());
const choice = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\x00-\x1f\x7f]+$/u);
export const roleSelectionSchema = z
  .object({
    modelId: choice.optional(),
    reasoningEffort: choice.optional(),
    modeId: choice.optional(),
  })
  .strict()
  .refine((value) => !value.reasoningEffort || !!value.modelId, '请选择 effort 对应的模型');
export const roleInstructionsSchema = z
  .string()
  .max(ROLE_LIMITS.instructionBytes)
  .refine(
    (value) => new TextEncoder().encode(value).length <= ROLE_LIMITS.instructionBytes,
    '角色说明超过 16 KiB',
  );
export const roleSchema = z
  .object({
    id,
    name: label,
    revision: revision.refine((value) => value > 0),
    agentId: id,
    selection: roleSelectionSchema,
    instructions: roleInstructionsSchema,
  })
  .strict();
export const roleViewSchema = roleSchema
  .extend({ available: z.boolean(), unavailableReason: z.string().min(1).max(500).optional() })
  .strict()
  .refine((value) => (value.available ? !value.unavailableReason : !!value.unavailableReason));
const base = contentScopeSchema.extend({ rolesVersion: z.literal(1) });
export const rolesReadSchema = base.strict();
export const rolesReadResultSchema = base
  .extend({
    confirmed: z.literal(true),
    catalogRevision: revision,
    roles: z.array(roleViewSchema).max(ROLE_LIMITS.items),
  })
  .strict();
const mutation = base.extend({ operationId: id, expectedRevision: revision });
export const roleActionSchema = z.discriminatedUnion('action', [
  mutation
    .extend({
      action: z.literal('save'),
      id: id.optional(),
      name: label,
      agentId: id,
      selection: roleSelectionSchema,
      instructions: roleInstructionsSchema,
    })
    .strict(),
  mutation.extend({ action: z.literal('remove'), id }).strict(),
]);
export const rolesInspectSchema = z
  .object({ action: z.literal('inspect'), request: roleActionSchema })
  .strict();
export const rolesAbandonSchema = z
  .object({ action: z.literal('abandon'), request: roleActionSchema })
  .strict();
export const rolesActionRequestSchema = z.union([
  roleActionSchema,
  rolesInspectSchema,
  rolesAbandonSchema,
]);
const receipt = base.extend({
  confirmed: z.literal(true),
  operationId: id,
  action: z.enum(['save', 'remove']),
});
export const roleReceiptSchema = z.discriminatedUnion('accepted', [
  receipt
    .extend({
      accepted: z.literal(true),
      catalogRevision: revision.refine((value) => value > 0),
      roleId: id,
    })
    .strict(),
  receipt
    .extend({ accepted: z.literal(false), abandoned: z.literal(true), catalogRevision: revision })
    .strict(),
]);
const inspected = base.extend({
  confirmed: z.literal(true),
  operationId: id,
  action: z.literal('inspect'),
});
export const rolesInspectResultSchema = z.discriminatedUnion('found', [
  inspected.extend({ found: z.literal(true), receipt: roleReceiptSchema }).strict(),
  inspected.extend({ found: z.literal(false) }).strict(),
]);
export type Role = z.infer<typeof roleSchema>;
export type RoleView = z.infer<typeof roleViewSchema>;
export type RolesRead = z.infer<typeof rolesReadSchema>;
export type RolesReadResult = z.infer<typeof rolesReadResultSchema>;
export type RoleAction = z.infer<typeof roleActionSchema>;
export type RoleReceipt = z.infer<typeof roleReceiptSchema>;
export type RoleAcceptedReceipt = Extract<RoleReceipt, { accepted: true }>;
export type RolesInspect = z.infer<typeof rolesInspectSchema>;
export type RolesAbandon = z.infer<typeof rolesAbandonSchema>;
export type RolesInspectResult = z.infer<typeof rolesInspectResultSchema>;
export type RolesActionRequest = z.infer<typeof rolesActionRequestSchema>;

function sameScope(value: RolesRead, request: RolesRead) {
  if (
    value.workspaceId !== request.workspaceId ||
    value.localProjectId !== request.localProjectId ||
    value.sessionId !== request.sessionId
  )
    throw new Error('角色响应不属于当前请求');
}
export function validateRolesRead(value: unknown, request: RolesRead): RolesReadResult {
  const result = rolesReadResultSchema.parse(value);
  sameScope(result, request);
  if (
    new Set(result.roles.map((role) => role.id)).size !== result.roles.length ||
    result.roles.some((role) => role.revision > result.catalogRevision)
  )
    throw new Error('角色目录版本不可验证');
  return result;
}
/** A historical receipt confirms the original operation, not the current role contents. */
export function validateRoleReceipt(value: unknown, request: RoleAction): RoleReceipt {
  const result = roleReceiptSchema.parse(value);
  sameScope(result, request);
  if (
    result.operationId !== request.operationId ||
    result.action !== request.action ||
    result.catalogRevision !== request.expectedRevision + (result.accepted ? 1 : 0) ||
    (result.accepted && request.id && result.roleId !== request.id)
  )
    throw new Error('角色操作回执不可验证');
  return result;
}
/** Missing receipts are observations only: they neither cancel nor replay an operation. */
export function validateRolesInspect(value: unknown, request: RoleAction): RolesInspectResult {
  const result = rolesInspectResultSchema.parse(value);
  sameScope(result, request);
  if (result.operationId !== request.operationId) throw new Error('角色查询回执不可验证');
  if (result.found) validateRoleReceipt(result.receipt, request);
  return result;
}
