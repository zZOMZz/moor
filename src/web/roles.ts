import { z } from 'zod';
import { gitTargetSchema } from './git-workspace';
import { roleActionSchema, type RoleView } from '../role-protocol';

export const rolesStoredSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    pending: roleActionSchema.optional(),
    ending: z.literal(true).optional(),
  })
  .strict();
export const roleAppliedSchema = z
  .object({
    version: z.literal(1),
    target: gitTargetSchema,
    base: z.string().max(160),
    applied: z
      .array(
        z
          .object({
            roleId: z.string().min(1).max(160),
            revision: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export function roleInstruction(role: RoleView) {
  return role.instructions
    ? `[角色预设：${role.name} · 版本 ${role.revision}]\n${role.instructions}\n[/角色预设]`
    : '';
}
