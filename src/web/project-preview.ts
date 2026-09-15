import { z } from 'zod';
import { id, mutationSchema } from '../protocol';
import { contentDescriptorSchema, contentVersionSchema } from '../content-protocol';
import { attachmentBase64Schema, MAX_SESSION_ATTACHMENT_BYTES } from '../attachment-protocol';
import { attachmentBytes } from './attachments';
import { previewActionSchema, previewOpenSchema, previewReceiptSchema } from '../preview-protocol';
import { gitTargetSchema, gitWorkspaceKey, type GitTarget } from './git-workspace';

export type PreviewTarget = GitTarget;
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
export const pendingPreviewMutationSchema = z
  .object({
    previewDraftVersion: z.literal(1),
    mutation: mutationSchema,
    annotationDelivery: z
      .object({ operationId: id, submission: previewAnnotationSubmissionSchema })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.mutation.kind === 'turn' &&
      value.mutation.operationId === value.annotationDelivery.operationId &&
      value.mutation.workspaceId === value.annotationDelivery.submission.target.workspaceId &&
      value.mutation.sessionId === value.annotationDelivery.submission.target.sessionId,
  );
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
export const previewAnnotationKey = (target: PreviewTarget) =>
  gitWorkspaceKey(gitTargetSchema.parse(target)).replace(
    'git-workspace-v1/',
    'preview-annotations-v1/',
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
