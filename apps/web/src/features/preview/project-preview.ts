import {
  PREVIEW_ANNOTATION_LIMIT,
  previewAnnotationSchema,
  previewAnnotationSnapshotSchema,
  type PreviewAnnotationSnapshot,
} from '@moor/client/preview-annotation';
import { MAX_SESSION_ATTACHMENT_BYTES } from '@moor/protocol/attachment-protocol';
import { contentVersionSchema } from '@moor/protocol/content-protocol';
import {
  previewActionSchema,
  previewOpenSchema,
  previewReceiptSchema,
} from '@moor/protocol/preview-protocol';
import { id } from '@moor/protocol/protocol';
import { z } from 'zod';
import { attachmentBytes } from '../attachments/attachments';
import { gitTargetSchema } from '../git/git-workspace';

export { PREVIEW_ANNOTATION_LIMIT, previewAnnotationSchema, previewAnnotationSnapshotSchema };
export type { PreviewAnnotationSnapshot };
export const previewAnnotationSelectionSchema = z
  .object({
    id,
    version: contentVersionSchema,
    selectionId: id,
  })
  .strict();
export const previewAnnotationSubmissionSchema = z
  .object({
    target: gitTargetSchema,
    selection: z.array(previewAnnotationSelectionSchema).max(PREVIEW_ANNOTATION_LIMIT),
  })
  .strict();
export type PreviewAnnotationSubmission = z.infer<typeof previewAnnotationSubmissionSchema>;
export const previewAnnotationsStoredSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().safe().nonnegative(),
    target: gitTargetSchema,
    annotations: z.array(previewAnnotationSchema).max(PREVIEW_ANNOTATION_LIMIT),
  })
  .strict()
  .refine(
    (value) => new Set(value.annotations.map((item) => item.id)).size === value.annotations.length,
  )
  .refine(
    (value) =>
      value.annotations.reduce(
        (total, item) => total + (item.snapshot.image?.content.byteLength ?? 0),
        0,
      ) <= MAX_SESSION_ATTACHMENT_BYTES,
  );
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return (
    'sha256:' +
    Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
function pngViewport(bytes: Uint8Array, viewport: { width: number; height: number }) {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
    ![73, 72, 68, 82].every((value, index) => bytes[12 + index] === value)
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(8) === 13 &&
    view.getUint32(16) === viewport.width &&
    view.getUint32(20) === viewport.height
  );
}
export async function snapshotVersion(snapshot: PreviewAnnotationSnapshot) {
  if (snapshot.image) {
    const bytes = attachmentBytes(snapshot.image.data);
    if (
      bytes.byteLength !== snapshot.image.content.byteLength ||
      (await digest(bytes)) !== snapshot.image.content.version ||
      !pngViewport(bytes, snapshot.viewport)
    )
      throw new Error('标注截图内容与冻结版本不匹配。');
  }
  return digest(new TextEncoder().encode(JSON.stringify(snapshot)));
}

export const previewStoredSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    open: previewOpenSchema.optional(),
    pending: previewActionSchema.optional(),
    receipt: previewReceiptSchema.optional(),
    closing: z.boolean().default(false),
    uncertainClosed: z.boolean().default(false),
  })
  .strict();
