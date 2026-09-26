import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import {
  CONTENT_LIMITS,
  CONTENT_VERSION,
  attachmentReferenceSchema,
  contentScopeSchema,
  type AttachmentReference,
} from '@moor/protocol/content-protocol';
import {
  MAX_TURN_ATTACHMENTS,
  attachmentActionSchema,
  attachmentBase64Schema,
  type PromptInputCapabilities,
} from '@moor/protocol/attachment-protocol';

const scopeSchema = contentScopeSchema.extend({ owner: z.string().min(1), deviceId: id }).strict();
const pendingSchema = z
  .object({
    owner: z.string().min(1),
    deviceId: id,
    catalogWorkspaceId: id,
    replicaId: id,
    request: attachmentActionSchema,
  })
  .strict();
const itemSchema = z
  .object({
    reference: attachmentReferenceSchema,
    data: attachmentBase64Schema,
    uploaded: z.boolean(),
    pending: pendingSchema.optional(),
  })
  .strict();
export type AttachmentDraftItem = z.infer<typeof itemSchema>;
const draftSchema = z
  .object({
    version: z.literal(CONTENT_VERSION),
    scope: scopeSchema,
    items: z.array(itemSchema).max(MAX_TURN_ATTACHMENTS),
  })
  .strict();
export const attachmentDraftSchema = draftSchema;
export function attachmentBytes(data: string) {
  const binary = atob(attachmentBase64Schema.parse(data));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
async function version(bytes: Uint8Array<ArrayBuffer>) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return 'sha256:' + [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function verify(reference: AttachmentReference, data: string) {
  const bytes = attachmentBytes(data);
  if (
    bytes.length !== reference.content.byteLength ||
    (await version(bytes)) !== reference.content.version
  )
    throw new Error('附件内容校验失败，请重新选择文件。');
  return bytes;
}
export const verifyAttachmentBytes = verify;
export async function createAttachmentDraftItem(
  file: File,
  attachmentId: string,
): Promise<AttachmentDraftItem> {
  if (file.size > CONTENT_LIMITS.attachmentBytes) throw Error('每个附件最多 8 MiB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength > CONTENT_LIMITS.attachmentBytes)
    throw Error('附件大小发生变化，请重新选择文件。');
  return {
    reference: attachmentReferenceSchema.parse({
      contentVersion: CONTENT_VERSION,
      attachmentId,
      name: file.name,
      content: {
        byteLength: bytes.length,
        version: await version(bytes),
        mediaType: file.type.toLowerCase() || 'application/octet-stream',
      },
    }),
    data: base64(bytes),
    uploaded: false,
  };
}
export function attachmentInputReason(
  reference: AttachmentReference,
  capabilities?: PromptInputCapabilities,
) {
  if (!capabilities) return '等待 Agent 确认附件输入能力。';
  const type = reference.content.mediaType;
  if (type.startsWith('image/'))
    return capabilities.image ? undefined : '当前 Agent 不支持图片输入。';
  if (type.startsWith('audio/'))
    return capabilities.audio ? undefined : '当前 Agent 不支持音频输入。';
  return capabilities.embeddedContext ? undefined : '当前 Agent 不支持文件附件输入。';
}
export function attachmentPreviewUrl(reference: AttachmentReference, data: string) {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(reference.content.mediaType))
    return undefined;
  if (!attachmentBase64Schema.safeParse(data).success) return undefined;
  return `data:${reference.content.mediaType};base64,${data}`;
}
export function attachmentText(reference: AttachmentReference, data: string) {
  if (!['text/plain', 'text/markdown'].includes(reference.content.mediaType)) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(attachmentBytes(data));
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}
export function formatAttachmentSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
