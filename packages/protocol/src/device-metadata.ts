import { z } from 'zod';

export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
export const deviceMetadataSchema = z
  .object({
    version: z.literal(1),
    name: deviceNameSchema,
    revision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export type DeviceMetadata = z.infer<typeof deviceMetadataSchema>;
export const deviceMetadataActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('rename'),
      name: deviceNameSchema,
      expectedRevision: deviceMetadataSchema.shape.revision,
    })
    .strict(),
]);
export const deviceMetadataStateSchema = z
  .object({
    metadata: deviceMetadataSchema,
    sync: z.enum(['unpaired', 'pending', 'synced', 'unsupported', 'conflict', 'revoked']),
  })
  .strict();
export type DeviceMetadataState = z.infer<typeof deviceMetadataStateSchema>;
