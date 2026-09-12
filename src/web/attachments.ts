import { z } from 'zod';
import { id } from '../protocol';
import {
  CONTENT_LIMITS,
  CONTENT_VERSION,
  attachmentReferenceSchema,
  contentScopeSchema,
  type AttachmentReference,
} from '../content-protocol';
import {
  MAX_TURN_ATTACHMENTS,
  attachmentActionSchema,
  attachmentBase64Schema,
  attachmentContentSchema,
  attachmentReceiptSchema,
  type AttachmentAction,
  type AttachmentContent,
  type AttachmentRead,
  type PromptInputCapabilities,
} from '../attachment-protocol';
import { ApiError } from './api';

const scopeSchema = contentScopeSchema.extend({ owner: z.string().min(1), deviceId: id }).strict();
export type AttachmentScope = z.infer<typeof scopeSchema>;
export type AttachmentTarget = AttachmentScope & { catalogWorkspaceId: string; replicaId: string };
const pendingSchema = z
  .object({
    owner: z.string().min(1),
    deviceId: id,
    catalogWorkspaceId: id,
    replicaId: id,
    request: attachmentActionSchema,
  })
  .strict();
export type PendingAttachmentAction = z.infer<typeof pendingSchema>;
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
export function attachmentDraftKey(scope: AttachmentScope) {
  const value = scopeSchema.parse(scope);
  return (
    'attachment-draft-v1/' +
    JSON.stringify([
      value.owner,
      value.deviceId,
      value.workspaceId,
      value.localProjectId,
      value.sessionId,
    ])
  );
}
function sameReference(a: AttachmentReference, b: AttachmentReference) {
  return (
    a.attachmentId === b.attachmentId &&
    a.name === b.name &&
    a.contentVersion === b.contentVersion &&
    a.content.version === b.content.version &&
    a.content.byteLength === b.content.byteLength &&
    a.content.mediaType === b.content.mediaType
  );
}
function sameScope(a: AttachmentScope, b: AttachmentScope) {
  return attachmentDraftKey(a) === attachmentDraftKey(b);
}
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
type Dependencies = {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  request(path: string, action: AttachmentAction): Promise<unknown>;
  onChange?(): void;
  uuid?(): string;
};

// Network transmission exists only in explicit upload/remove/retry methods.
// Loading a draft, changing connection state and editing text cannot deliver it.
export class AttachmentDraftController {
  readonly scope: AttachmentScope;
  private values: AttachmentDraftItem[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private working?: string;
  constructor(
    scope: AttachmentScope,
    private dependencies: Dependencies,
  ) {
    this.scope = scopeSchema.parse(scope);
  }
  get items(): readonly AttachmentDraftItem[] {
    return this.values;
  }
  get busyId() {
    return this.working;
  }
  references() {
    return this.values
      .filter((item) => item.uploaded && !item.pending)
      .map((item) => item.reference);
  }
  private serial<T>(fn: () => Promise<T>) {
    const work = this.queue.then(fn);
    this.queue = work.catch(() => {});
    return work;
  }
  private async save(items: AttachmentDraftItem[]) {
    const record = draftSchema.parse({ version: CONTENT_VERSION, scope: this.scope, items });
    await this.dependencies.write(attachmentDraftKey(this.scope), record);
    this.values = record.items;
    this.dependencies.onChange?.();
  }
  private item(attachmentId: string) {
    const item = this.values.find((value) => value.reference.attachmentId === attachmentId);
    if (!item) throw new Error('附件草稿不存在。');
    return item;
  }
  private operation(target: AttachmentTarget, request: AttachmentAction): PendingAttachmentAction {
    const { catalogWorkspaceId, replicaId, ...scope } = target;
    if (!sameScope(this.scope, scope))
      throw new Error('附件执行目标已改变，不能发送到其他会话或电脑。');
    return pendingSchema.parse({
      owner: this.scope.owner,
      deviceId: this.scope.deviceId,
      catalogWorkspaceId,
      replicaId,
      request,
    });
  }
  load() {
    return this.serial(async () => {
      const raw = await this.dependencies.read(attachmentDraftKey(this.scope));
      if (raw === undefined) {
        this.values = [];
        this.dependencies.onChange?.();
        return;
      }
      const draft = draftSchema.parse(raw);
      if (!sameScope(draft.scope, this.scope)) throw new Error('附件草稿与当前会话不匹配。');
      const ids = new Set<string>();
      for (const item of draft.items) {
        if (ids.has(item.reference.attachmentId)) throw new Error('附件草稿包含重复标识。');
        ids.add(item.reference.attachmentId);
        await verify(item.reference, item.data);
        const pending = item.pending;
        if (pending) {
          const { workspaceId, localProjectId, sessionId } = pending.request;
          if (
            !sameScope(this.scope, {
              owner: pending.owner,
              deviceId: pending.deviceId,
              workspaceId,
              localProjectId,
              sessionId,
            }) ||
            (pending.request.action === 'upload'
              ? !sameReference(pending.request.attachment, item.reference) ||
                pending.request.data !== item.data
              : pending.request.attachmentId !== item.reference.attachmentId)
          )
            throw new Error('待确认的附件操作与草稿不匹配。');
        }
      }
      this.values = draft.items;
      this.dependencies.onChange?.();
    });
  }
  add(files: readonly File[]) {
    return this.serial(async () => {
      if (files.length + this.values.length > MAX_TURN_ATTACHMENTS)
        throw new Error(`每条指令最多添加 ${MAX_TURN_ATTACHMENTS} 个附件。`);
      const additions: AttachmentDraftItem[] = [];
      for (const file of files) {
        if (file.size > CONTENT_LIMITS.attachmentBytes) throw new Error('每个附件最多 8 MiB。');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength !== file.size || bytes.byteLength > CONTENT_LIMITS.attachmentBytes)
          throw new Error('附件大小发生变化，请重新选择文件。');
        const reference = attachmentReferenceSchema.parse({
          contentVersion: CONTENT_VERSION,
          attachmentId: this.dependencies.uuid?.() ?? crypto.randomUUID(),
          name: file.name,
          content: {
            byteLength: bytes.length,
            version: await version(bytes),
            mediaType: file.type.toLowerCase() || 'application/octet-stream',
          },
        });
        additions.push({ reference, data: base64(bytes), uploaded: false });
      }
      await this.save([...this.values, ...additions]);
      return additions.map((item) => item.reference);
    });
  }
  upload(attachmentId: string, target: AttachmentTarget) {
    return this.serial(async () => {
      const item = this.item(attachmentId);
      if (item.pending) throw new Error('附件尚未确认，请点击手动重试。');
      if (item.uploaded) return item.reference;
      const { workspaceId, localProjectId, sessionId } = this.scope;
      const request: AttachmentAction = {
        contentVersion: CONTENT_VERSION,
        operationId: this.dependencies.uuid?.() ?? crypto.randomUUID(),
        workspaceId,
        localProjectId,
        sessionId,
        action: 'upload',
        attachment: item.reference,
        data: item.data,
      };
      await this.deliver(attachmentId, this.operation(target, request));
      return this.item(attachmentId).reference;
    });
  }
  retry(attachmentId: string, target: AttachmentTarget) {
    return this.serial(async () => {
      const pending = this.item(attachmentId).pending;
      if (!pending) throw new Error('附件没有待确认的操作。');
      await this.deliver(attachmentId, this.operation(target, pending.request));
    });
  }
  remove(attachmentId: string, target?: AttachmentTarget) {
    return this.serial(async () => {
      const item = this.item(attachmentId);
      if (item.pending) throw new Error('请先手动确认附件操作，再移除附件。');
      if (!item.uploaded) {
        await this.save(this.values.filter((value) => value !== item));
        return;
      }
      if (!target) throw new Error('移除已上传附件需要执行电脑在线确认。');
      const { workspaceId, localProjectId, sessionId } = this.scope;
      await this.deliver(
        attachmentId,
        this.operation(target, {
          contentVersion: CONTENT_VERSION,
          operationId: this.dependencies.uuid?.() ?? crypto.randomUUID(),
          workspaceId,
          localProjectId,
          sessionId,
          action: 'remove',
          attachmentId,
        }),
      );
    });
  }
  // Forget composer entries only after their prompt is host-confirmed. Referenced
  // attachment bytes remain on the host as part of the session history.
  forget(attachmentIds: readonly string[]) {
    return this.serial(async () => {
      const ids = new Set(attachmentIds);
      if (this.values.some((item) => ids.has(item.reference.attachmentId) && item.pending))
        throw new Error('待确认附件不能从草稿清除。');
      await this.save(this.values.filter((item) => !ids.has(item.reference.attachmentId)));
    });
  }
  private async deliver(attachmentId: string, operation: PendingAttachmentAction) {
    this.working = attachmentId;
    this.dependencies.onChange?.();
    try {
      await this.save(
        this.values.map((item) =>
          item.reference.attachmentId === attachmentId ? { ...item, pending: operation } : item,
        ),
      );
      let result: unknown;
      try {
        result = await this.dependencies.request(
          `/api/workspaces/${operation.catalogWorkspaceId}/replicas/${operation.replicaId}/attachment-actions`,
          operation.request,
        );
      } catch (error) {
        if (error instanceof ApiError && error.rejected)
          await this.save(
            this.values.map((item) =>
              item.reference.attachmentId === attachmentId ? { ...item, pending: undefined } : item,
            ),
          );
        throw error;
      }
      const receipt = attachmentReceiptSchema.safeParse(result),
        request = operation.request;
      if (
        !receipt.success ||
        receipt.data.operationId !== request.operationId ||
        receipt.data.workspaceId !== request.workspaceId ||
        receipt.data.localProjectId !== request.localProjectId ||
        receipt.data.sessionId !== request.sessionId ||
        (request.action === 'upload'
          ? !receipt.data.attachment || !sameReference(receipt.data.attachment, request.attachment)
          : receipt.data.removed !== true)
      )
        throw new Error('附件操作尚未获得有效的主机确认，请手动重试。');
      await this.save(
        request.action === 'remove'
          ? this.values.filter((item) => item.reference.attachmentId !== attachmentId)
          : this.values.map((item) =>
              item.reference.attachmentId === attachmentId
                ? { ...item, uploaded: true, pending: undefined }
                : item,
            ),
      );
    } finally {
      this.working = undefined;
      this.dependencies.onChange?.();
    }
  }
}

export type AttachmentView = {
  source: 'host' | 'cache';
  result: AttachmentContent;
  bytes: Uint8Array;
  cacheSaved: boolean;
};
export async function readAttachment(
  target: AttachmentTarget,
  reference: AttachmentReference,
  online: boolean,
  dependencies: {
    read(key: string): Promise<unknown>;
    write(key: string, value: unknown): Promise<void>;
    request(path: string, input: AttachmentRead): Promise<unknown>;
  },
): Promise<AttachmentView> {
  const { owner, deviceId, workspaceId, localProjectId, sessionId } = scopeSchema.parse({
    owner: target.owner,
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
  });
  const key =
    attachmentDraftKey({ owner, deviceId, workspaceId, localProjectId, sessionId }) +
    '/content/' +
    JSON.stringify([reference.attachmentId, reference.content.version]);
  const input: AttachmentRead = {
    contentVersion: CONTENT_VERSION,
    workspaceId,
    localProjectId,
    sessionId,
    attachmentId: reference.attachmentId,
  };
  const checked = async (raw: unknown) => {
    const result = attachmentContentSchema.parse(raw);
    if (
      result.workspaceId !== workspaceId ||
      result.localProjectId !== localProjectId ||
      result.sessionId !== sessionId ||
      !sameReference(reference, result.attachment)
    )
      throw new Error('附件响应与当前会话或版本不匹配。');
    return { result, bytes: await verify(reference, result.data) };
  };
  if (!online) {
    const cached = z
      .object({ owner: z.string(), deviceId: id, result: attachmentContentSchema })
      .strict()
      .safeParse(await dependencies.read(key));
    if (!cached.success || cached.data.owner !== owner || cached.data.deviceId !== deviceId)
      throw new Error('执行电脑离线，本机没有这个附件版本的缓存。');
    return { ...(await checked(cached.data.result)), source: 'cache', cacheSaved: true };
  }
  const value = await checked(
    await dependencies.request(
      `/api/workspaces/${id.parse(target.catalogWorkspaceId)}/replicas/${id.parse(target.replicaId)}/attachments/read`,
      input,
    ),
  );
  let cacheSaved = true;
  try {
    await dependencies.write(key, { owner, deviceId, result: value.result });
  } catch {
    cacheSaved = false;
  }
  return { ...value, source: 'host', cacheSaved };
}
