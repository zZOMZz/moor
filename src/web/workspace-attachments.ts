import { z } from 'zod';
import { attachmentDraftSchema, verifyAttachmentBytes } from './attachments';
import { MAX_SESSION_ATTACHMENT_BYTES } from '../attachment-protocol';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';

export const workspaceAttachmentDraftSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    items: attachmentDraftSchema.shape.items,
  })
  .strict();
export type WorkspaceAttachmentDraft = z.infer<typeof workspaceAttachmentDraftSchema>;
export const emptyWorkspaceAttachments = (): WorkspaceAttachmentDraft => ({
  revision: 0,
  items: [],
});
export async function validateWorkspaceAttachments(
  input: WorkspaceAttachmentDraft,
  scope: {
    owner: string;
    deviceId: string;
    workspaceId: string;
    localProjectId: string;
    sessionId: string;
    catalogWorkspaceId: string;
    replicaId: string;
  },
  current: () => void,
) {
  const value = workspaceAttachmentDraftSchema.parse(input);
  const ids = new Set<string>();
  let total = 0;
  for (const item of value.items) {
    current();
    if (ids.has(item.reference.attachmentId)) throw Error('附件标识重复。');
    ids.add(item.reference.attachmentId);
    total += item.reference.content.byteLength;
    if (total > MAX_SESSION_ATTACHMENT_BYTES) throw Error('附件总容量超出限制。');
    await verifyAttachmentBytes(item.reference, item.data);
    current();
    const pending = item.pending;
    if (!pending) continue;
    if (
      pending.owner !== scope.owner ||
      pending.deviceId !== scope.deviceId ||
      pending.catalogWorkspaceId !== scope.catalogWorkspaceId ||
      pending.replicaId !== scope.replicaId ||
      pending.request.workspaceId !== scope.workspaceId ||
      pending.request.localProjectId !== scope.localProjectId ||
      pending.request.sessionId !== scope.sessionId ||
      (pending.request.action === 'upload'
        ? canonical(pending.request.attachment) !== canonical(item.reference) ||
          pending.request.data !== item.data
        : pending.request.attachmentId !== item.reference.attachmentId)
    )
      throw Error('附件原请求与当前内容和执行范围不匹配。');
  }
  return value;
}
