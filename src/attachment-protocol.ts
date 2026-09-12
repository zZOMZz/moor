import { z } from 'zod';
import { id } from './protocol';
import {
  CONTENT_LIMITS,
  CONTENT_VERSION,
  attachmentReferenceSchema,
  contentScopeSchema,
  isCanonicalBase64,
} from './content-protocol';

export const ATTACHMENTS_FEATURE = 'attachments-v1';
export const MAX_TURN_ATTACHMENTS = 8;
export const MAX_SESSION_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const attachmentBase64Schema = z
  .string()
  .max(4 * Math.ceil(CONTENT_LIMITS.attachmentBytes / 3))
  .refine(isCanonicalBase64);
const actionBase = contentScopeSchema.extend({
  contentVersion: z.literal(CONTENT_VERSION),
  operationId: id,
});
export const attachmentActionSchema = z
  .discriminatedUnion('action', [
    actionBase
      .extend({
        action: z.literal('upload'),
        attachment: attachmentReferenceSchema,
        data: attachmentBase64Schema,
      })
      .strict(),
    actionBase.extend({ action: z.literal('remove'), attachmentId: id }).strict(),
  ])
  .refine(
    (input) =>
      input.action !== 'upload' ||
      (input.data.length / 4) * 3 -
        (input.data.endsWith('==') ? 2 : input.data.endsWith('=') ? 1 : 0) ===
        input.attachment.content.byteLength,
    '附件字节数不匹配',
  );
export const attachmentReadSchema = contentScopeSchema
  .extend({ contentVersion: z.literal(CONTENT_VERSION), attachmentId: id })
  .strict();
export const attachmentReceiptSchema = actionBase
  .extend({
    accepted: z.literal(true),
    delivered: z.literal(true),
    attachment: attachmentReferenceSchema.optional(),
    removed: z.literal(true).optional(),
  })
  .strict()
  .refine((result) => !!result.attachment !== !!result.removed);
export const attachmentContentSchema = contentScopeSchema
  .extend({
    contentVersion: z.literal(CONTENT_VERSION),
    confirmed: z.literal(true),
    attachment: attachmentReferenceSchema,
    data: attachmentBase64Schema,
  })
  .strict()
  .refine(
    (input) =>
      (input.data.length / 4) * 3 -
        (input.data.endsWith('==') ? 2 : input.data.endsWith('=') ? 1 : 0) ===
      input.attachment.content.byteLength,
    '附件字节数不匹配',
  );
export const promptAttachmentsSchema = z
  .array(attachmentReferenceSchema)
  .max(MAX_TURN_ATTACHMENTS)
  .refine(
    (items) => new Set(items.map((item) => item.attachmentId)).size === items.length,
    '附件不能重复',
  );
export const promptInputCapabilitiesSchema = z
  .object({ image: z.boolean(), audio: z.boolean(), embeddedContext: z.boolean() })
  .strict();
export type AttachmentAction = z.infer<typeof attachmentActionSchema>;
export type AttachmentRead = z.infer<typeof attachmentReadSchema>;
export type AttachmentReceipt = z.infer<typeof attachmentReceiptSchema>;
export type AttachmentContent = z.infer<typeof attachmentContentSchema>;
export type PromptInputCapabilities = z.infer<typeof promptInputCapabilitiesSchema>;
export type AgentAttachment = {
  reference: z.infer<typeof attachmentReferenceSchema>;
  data: string;
};
