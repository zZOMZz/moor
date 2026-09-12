import { z } from 'zod';
import { id } from './protocol';
import { contentScopeSchema, contentVersionSchema, isCanonicalBase64 } from './content-protocol';
import { sessionExecutionSchema } from './git-protocol';

export const PREVIEW_FEATURE = 'project-preview-v1';
export const PREVIEW_LIMITS = {
  imageBytes: 4 * 1024 * 1024,
  width: 1920,
  height: 1200,
  instances: 4,
  idleMs: 30_000,
  operationMs: 20_000,
  text: 4000,
  annotations: 20,
} as const;
const version = contentVersionSchema;
export const previewScopeSchema = contentScopeSchema.extend({ previewVersion: z.literal(1) });
export const previewViewportSchema = z
  .object({
    width: z.number().int().min(240).max(PREVIEW_LIMITS.width),
    height: z.number().int().min(240).max(PREVIEW_LIMITS.height),
  })
  .strict();
export type PreviewViewport = z.infer<typeof previewViewportSchema>;
export const previewPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value))
      return false;
    try {
      const url = new URL(value, 'http://127.0.0.1');
      if (url.origin !== 'http://127.0.0.1' || url.pathname + url.search + url.hash !== value)
        return false;
      return !decodeURIComponent(url.pathname)
        .split('/')
        .some((part) => part === '..' || part === '.' || /[\\\u0000-\u001f\u007f]/.test(part));
    } catch {
      return false;
    }
  }, '需要当前登记服务内的规范路径');
export const previewServiceSchema = z
  .object({ id, label: z.string().min(1).max(100), version, startPath: previewPathSchema })
  .strict();
export type PreviewService = z.infer<typeof previewServiceSchema>;
export const previewImageSchema = z
  .object({
    mediaType: z.literal('image/png'),
    version,
    byteLength: z.number().int().min(1).max(PREVIEW_LIMITS.imageBytes),
    data: z
      .string()
      .max(4 * Math.ceil(PREVIEW_LIMITS.imageBytes / 3))
      .refine(isCanonicalBase64),
  })
  .strict()
  .refine(
    (v) =>
      (v.data.length / 4) * 3 - (v.data.endsWith('==') ? 2 : v.data.endsWith('=') ? 1 : 0) ===
      v.byteLength,
  );
export const previewFrameSchema = z
  .object({
    previewId: id,
    frameId: id,
    documentId: id,
    revision: z.number().int().nonnegative().safe(),
    viewport: previewViewportSchema,
    path: previewPathSchema,
    title: z.string().max(200),
    capturedAt: z.string().datetime(),
    image: previewImageSchema,
  })
  .strict();
export type PreviewFrame = z.infer<typeof previewFrameSchema>;
export const previewElementSchema = z
  .object({
    elementId: id,
    frameId: id,
    tag: z.string().min(1).max(40),
    role: z.string().max(100),
    name: z.string().max(200),
    text: z.string().max(1000),
    rect: z
      .object({
        x: z.number().finite().min(-20000).max(20000),
        y: z.number().finite().min(-20000).max(20000),
        width: z.number().finite().min(0).max(40000),
        height: z.number().finite().min(0).max(40000),
      })
      .strict(),
    editable: z.boolean(),
    password: z.boolean(),
  })
  .strict();
export type PreviewElement = z.infer<typeof previewElementSchema>;
const instance = previewScopeSchema.extend({ clientId: id, previewId: id });
const point = {
  x: z.number().finite().nonnegative().max(PREVIEW_LIMITS.width),
  y: z.number().finite().nonnegative().max(PREVIEW_LIMITS.height),
};
export const previewReadSchema = z.discriminatedUnion('view', [
  previewScopeSchema.extend({ view: z.literal('options') }).strict(),
  instance.extend({ view: z.literal('frame') }).strict(),
  instance.extend({ view: z.literal('status') }).strict(),
  instance.extend({ view: z.literal('locate'), frameId: id, ...point }).strict(),
]);
export type PreviewRead = z.infer<typeof previewReadSchema>;
export const previewReadResultSchema = z.discriminatedUnion('view', [
  previewScopeSchema
    .extend({
      view: z.literal('options'),
      confirmed: z.literal(true),
      available: z.boolean(),
      reason: z.string().max(1000).optional(),
      execution: sessionExecutionSchema,
      services: z.array(previewServiceSchema).max(20),
    })
    .strict(),
  instance
    .extend({
      view: z.literal('frame'),
      confirmed: z.literal(true),
      frame: previewFrameSchema,
      expiresAt: z.number().int().nonnegative().safe(),
    })
    .strict(),
  instance
    .extend({
      view: z.literal('status'),
      confirmed: z.literal(true),
      status: z.enum(['open', 'closed']),
      expiresAt: z.number().int().nonnegative().safe().optional(),
    })
    .strict(),
  instance
    .extend({
      view: z.literal('locate'),
      confirmed: z.literal(true),
      frameId: id,
      element: previewElementSchema.nullable(),
    })
    .strict(),
]);
export type PreviewReadResult = z.infer<typeof previewReadResultSchema>;
const action = previewScopeSchema.extend({
  clientId: id,
  operationId: id,
  confirmed: z.literal(true),
});
export const previewOpenSchema = action
  .extend({
    action: z.literal('open'),
    serviceId: id,
    serviceVersion: version,
    executionRevision: z.number().int().nonnegative().safe(),
    viewport: previewViewportSchema,
  })
  .strict();
export type PreviewOpen = z.infer<typeof previewOpenSchema>;
const interact = action.extend({ previewId: id, frameId: id });
export const previewActionSchema = z.discriminatedUnion('action', [
  previewOpenSchema,
  interact.extend({ action: z.literal('click'), elementId: id }).strict(),
  interact
    .extend({
      action: z.literal('input'),
      elementId: id,
      text: z
        .string()
        .max(PREVIEW_LIMITS.text)
        .refine((v) => !v.includes('\0')),
      replace: z.boolean(),
    })
    .strict(),
  interact
    .extend({
      action: z.literal('key'),
      key: z.enum([
        'Enter',
        'Tab',
        'Escape',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Backspace',
        'Delete',
      ]),
    })
    .strict(),
  interact
    .extend({
      action: z.literal('scroll'),
      deltaX: z.number().int().min(-4000).max(4000),
      deltaY: z.number().int().min(-4000).max(4000),
    })
    .strict(),
  interact.extend({ action: z.literal('resize'), viewport: previewViewportSchema }).strict(),
  interact.extend({ action: z.literal('navigate'), path: previewPathSchema }).strict(),
  interact.extend({ action: z.literal('reload') }).strict(),
]);
export type PreviewAction = z.infer<typeof previewActionSchema>;
export const previewInspectSchema = z.object({ request: previewActionSchema }).strict();
export const previewCloseSchema = z.object({ request: previewOpenSchema }).strict();
export const previewReceiptSchema = previewScopeSchema
  .extend({
    clientId: id,
    operationId: id,
    requestVersion: version,
    action: z.enum(['open', 'click', 'input', 'key', 'scroll', 'resize', 'navigate', 'reload']),
    phase: z.enum(['accepted', 'rejected', 'unknown', 'closed']),
    previewId: id.optional(),
    closed: z.boolean(),
    message: z.string().max(1000),
    checkedAt: z.string().datetime(),
    frame: previewFrameSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.phase !== 'accepted' || !!v.previewId) &&
      (!v.frame || (!v.closed && v.previewId === v.frame.previewId)) &&
      (v.phase !== 'closed' || v.closed),
  );
export type PreviewReceipt = z.infer<typeof previewReceiptSchema>;

/** User-selected page material; only explicit saving puts it into a scoped client draft. */
export const previewAnnotationSchema = z
  .object({
    id,
    version,
    service: previewServiceSchema,
    path: previewPathSchema,
    title: z.string().max(200),
    frameId: id,
    documentId: id,
    viewport: previewViewportSchema,
    element: previewElementSchema,
    note: z.string().trim().min(1).max(PREVIEW_LIMITS.text),
    capturedAt: z.string().datetime(),
    image: previewImageSchema.optional(),
  })
  .strict()
  .refine((v) => v.frameId === v.element.frameId);
export type PreviewAnnotation = z.infer<typeof previewAnnotationSchema>;
