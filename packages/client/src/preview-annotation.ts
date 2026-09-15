import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import { contentDescriptorSchema, contentVersionSchema } from '@moor/protocol/content-protocol';
import { attachmentBase64Schema } from '@moor/protocol/attachment-protocol';

export const PREVIEW_ANNOTATION_LIMIT = 20;
const dimension = z.number().int().positive().max(4096);
const rectangle = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
// Only an explicit save copies a frozen selection into this local record.
// The live preview protocol is deliberately separate from durable annotations.
export const previewAnnotationSnapshotSchema = z
  .object({
    serviceId: id,
    serviceLabel: z.string().min(1).max(200),
    pagePath: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => v.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(v)),
    frameId: id,
    documentId: id.optional(),
    serviceVersion: contentVersionSchema.optional(),
    title: z.string().max(200).optional(),
    capturedAt: z.string().datetime(),
    viewport: z.object({ width: dimension, height: dimension }).strict(),
    element: z
      .object({
        elementId: id,
        tagName: z.string().max(100),
        role: z.string().max(100),
        name: z.string().max(500),
        text: z.string().max(2000),
        bounds: rectangle,
      })
      .strict(),
    note: z
      .string()
      .min(1)
      .max(8000)
      .refine((v) => !!v.trim()),
    image: z
      .object({
        content: contentDescriptorSchema.extend({ mediaType: z.literal('image/png') }).strict(),
        data: attachmentBase64Schema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type PreviewAnnotationSnapshot = z.infer<typeof previewAnnotationSnapshotSchema>;
export const previewAnnotationSchema = z
  .object({
    id,
    version: contentVersionSchema,
    createdAt: z.string().datetime(),
    snapshot: previewAnnotationSnapshotSchema,
    selectionId: id.optional(),
  })
  .strict();
export type PreviewAnnotation = z.infer<typeof previewAnnotationSchema>;
