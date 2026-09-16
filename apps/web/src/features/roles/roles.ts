import { z } from 'zod';
import { gitTargetSchema } from '../git/git-workspace';
import { roleActionSchema } from '@moor/protocol/role-protocol';

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
