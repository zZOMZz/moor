import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import { secureMcpReviewSchema, secureTargetSchema } from '@moor/client/secure-operation';

// Keep the historical review shape for scope checks; client selection is retired.
const deliverySchema = z
  .object({
    operationId: id,
    state: z.enum(['pending', 'ending']),
    review: secureMcpReviewSchema,
  })
  .strict();
const draftSchema = z
  .object({
    target: secureTargetSchema,
    review: secureMcpReviewSchema.optional(),
    delivery: deliverySchema.optional(),
  })
  .strict();
export type SecureMcpDraft = z.infer<typeof draftSchema>;
