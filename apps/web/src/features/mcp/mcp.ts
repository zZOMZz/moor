import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import { MCP_LIMITS, mcpServerViewSchema } from '@moor/protocol/mcp-protocol';
import { gitTargetSchema } from '../git/git-workspace';

const reviewSchema = z
  .object({ reviewId: id, servers: z.array(mcpServerViewSchema).max(MCP_LIMITS.selected) })
  .strict();
export type McpReview = z.infer<typeof reviewSchema>;
const deliverySchema = z
  .object({
    operationId: id,
    review: reviewSchema,
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    review: reviewSchema.optional(),
    delivery: deliverySchema.optional(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;
export const mcpStoredSchema = storedSchema;
export const mcpReviewSchema = reviewSchema;
export type McpSaved = Stored;
