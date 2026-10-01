import { notificationPreferencesSchema } from '@moor/protocol/notification-protocol';
import { id } from '@moor/protocol/protocol';
import { z } from 'zod';
const owner = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const notificationLocalSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe().default(0),
    binding: z.object({ owner, preferences: notificationPreferencesSchema }).strict().optional(),
    records: z
      .array(
        z
          .object({
            owner,
            id,
            endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
            pendingDisable: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type NotificationLocalState = z.infer<typeof notificationLocalSchema>;
export type NotificationLocalRecord = NotificationLocalState['records'][number];
