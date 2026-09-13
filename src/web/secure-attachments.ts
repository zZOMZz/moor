import { z } from 'zod';
import {
  attachmentBase64Schema,
  attachmentContentSchema,
  attachmentReceiptSchema,
  MAX_TURN_ATTACHMENTS,
  MAX_SESSION_ATTACHMENT_BYTES,
  promptAttachmentsSchema,
} from '../attachment-protocol';
import {
  attachmentReferenceSchema,
  CONTENT_LIMITS,
  type AttachmentReference,
} from '../content-protocol';
import { hostCommandSchema } from '../bridge/host-command';
import {
  secureOperationSchema,
  secureTargetSchema,
  type SecureCliOperation,
  type SecureCliTarget,
} from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { SecureStore } from './secure-store';

const entrySchema = z
  .object({ reference: attachmentReferenceSchema, data: attachmentBase64Schema })
  .strict();
const entriesSchema = z
  .array(entrySchema)
  .max(MAX_TURN_ATTACHMENTS)
  .superRefine((entries, context) => {
    if (
      new Set(entries.map((entry) => entry.reference.attachmentId)).size !== entries.length ||
      entries.reduce((total, entry) => total + entry.reference.content.byteLength, 0) >
        MAX_SESSION_ATTACHMENT_BYTES
    )
      context.addIssue({ code: 'custom', message: '附件草稿数量或容量不符合限制。' });
  });
const documentSchema = z
  .object({
    target: secureTargetSchema,
    revision: z.number().int().nonnegative().safe(),
    entries: entriesSchema,
  })
  .strict();
type LoadedDocument = { key: string; raw: unknown; document: z.infer<typeof documentSchema> };
const draftSchema = entrySchema
  .extend({
    status: z.enum(['draft', 'uploaded', 'pending']),
    pendingOperationId: z.string().optional(),
    pendingAction: z.enum(['upload', 'remove']).optional(),
  })
  .strict();
export type SecureAttachmentDraft = z.infer<typeof draftSchema>;
export type SecureAttachmentContent = {
  target: SecureCliTarget;
  reference: AttachmentReference;
  data: string;
  source: 'host' | 'cache';
  cacheSaved: boolean;
};
const canonical = productCanonicalJson;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const conflict = () => Error('附件草稿已改变，请重新读取并审阅后继续。');
function targetSnapshot(input: SecureCliTarget) {
  const target = secureTargetSchema.parse(input);
  if (!target.product) throw Error('加密附件必须固定产品副本。');
  return target;
}
function key(target: SecureCliTarget, kind: 'draft' | 'cache' | 'lock') {
  return canonical([`moor-secure-attachments-${kind}-v1`, target]);
}
function bytes(data: string) {
  const binary = atob(attachmentBase64Schema.parse(data));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function encode(data: Uint8Array) {
  let binary = '';
  for (let start = 0; start < data.length; start += 16384)
    binary += String.fromCharCode(...data.subarray(start, start + 16384));
  return btoa(binary);
}
async function digest(data: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
  return (
    'sha256:' +
    Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
async function verify(reference: AttachmentReference, data: string, current: () => void) {
  current();
  const decoded = bytes(data);
  if (decoded.length !== reference.content.byteLength) throw Error('附件字节数不匹配。');
  const version = await digest(decoded);
  current();
  if (version !== reference.content.version) throw Error('附件内容摘要不匹配。');
}
function action(operation: SecureCliOperation) {
  if (operation.kind !== 'attachment-upload' && operation.kind !== 'attachment-remove')
    return undefined;
  const command = hostCommandSchema.parse(JSON.parse(operation.body));
  if (command.method !== 'attachment-action') throw Error('附件原操作不匹配。');
  return command.params;
}
function referenceId(operation: SecureCliOperation) {
  const request = action(operation);
  return request?.action === 'upload' ? request.attachment.attachmentId : request?.attachmentId;
}
function storedEntries(items: SecureAttachmentDraft[]) {
  return items.map(({ reference, data }) => ({ reference, data }));
}

/** Local drafts and verified cache only. Transport and every explicit retry remain with the caller. */
export class SecureAttachments {
  constructor(
    readonly store: SecureStore,
    private readonly options: { uuid?: () => string } = {},
  ) {}

  async #document(target: SecureCliTarget, kind: 'draft' | 'cache', current: () => void) {
    current();
    const storageKey = key(target, kind),
      raw = await this.store.backend.read(storageKey);
    current();
    const document = raw == null ? { target, revision: 0, entries: [] } : documentSchema.parse(raw);
    if (!same(document.target, target)) throw Error('本机附件记录与当前完整执行身份不匹配。');
    for (const entry of document.entries) await verify(entry.reference, entry.data, current);
    current();
    return { key: storageKey, raw: raw ?? null, document };
  }
  async #load(target: SecureCliTarget, current: () => void) {
    const loaded = await this.#document(target, 'draft', current);
    current();
    const ledger = await this.store.list(target);
    current();
    const operations = ledger.filter((operation) => same(operation.target, target));
    const attachmentOperations = operations.flatMap((operation) => {
      const request = action(operation);
      return request ? [{ operation, request }] : [];
    });
    const items: SecureAttachmentDraft[] = [];
    for (const entry of loaded.document.entries) {
      for (const { request: upload } of attachmentOperations) {
        if (
          upload.action === 'upload' &&
          upload.attachment.attachmentId === entry.reference.attachmentId &&
          (!same(upload.attachment, entry.reference) || upload.data !== entry.data)
        )
          throw Error('本机附件与持久原上传正文不匹配。');
      }
      const latest = attachmentOperations.find(
        ({ operation, request }) =>
          ['pending', 'ending', 'accepted'].includes(operation.state) &&
          (request.action === 'upload' ? request.attachment.attachmentId : request.attachmentId) ===
            entry.reference.attachmentId,
      );
      const { operation: original, request } = latest ?? {};
      if (request?.action === 'remove' && original?.state === 'accepted') continue;
      items.push({
        ...entry,
        status:
          original && ['pending', 'ending'].includes(original.state)
            ? 'pending'
            : original?.state === 'accepted'
              ? 'uploaded'
              : 'draft',
        ...(original && ['pending', 'ending'].includes(original.state)
          ? { pendingOperationId: original.operationId, pendingAction: request!.action }
          : {}),
      });
    }
    return { ...loaded, items, operations };
  }
  async #save(loaded: LoadedDocument, items: SecureAttachmentDraft[], current: () => void) {
    const next = documentSchema.parse({
      target: loaded.document.target,
      revision: loaded.document.revision + 1,
      entries: storedEntries(items),
    });
    await this.store.backend.compareAndSet(loaded.key, loaded.raw, next, current);
    current();
    return structuredClone(items);
  }
  async read(input: SecureCliTarget, current: () => void): Promise<SecureAttachmentDraft[]> {
    const target = targetSnapshot(input);
    return structuredClone((await this.#load(target, current)).items);
  }
  async addFiles(
    input: SecureCliTarget,
    expected: SecureAttachmentDraft[],
    files: File[],
    current: () => void,
  ) {
    const target = targetSnapshot(input),
      snapshot = z.array(draftSchema).max(MAX_TURN_ATTACHMENTS).parse(expected);
    if (files.length === 0 || snapshot.length + files.length > MAX_TURN_ATTACHMENTS)
      throw Error('每条指令最多添加 8 个附件。');
    // Capture file metadata before reading any bytes. File contents are immutable in the trusted renderer.
    const sources = files.map((file) => {
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > CONTENT_LIMITS.attachmentBytes
      )
        throw Error('单个附件不得超过 8 MiB。');
      const reference = attachmentReferenceSchema.parse({
        contentVersion: 1,
        attachmentId: (this.options.uuid ?? (() => crypto.randomUUID()))(),
        name: file.name,
        content: {
          version: 'sha256:' + '0'.repeat(64),
          byteLength: file.size,
          mediaType: file.type || 'application/octet-stream',
        },
      });
      return { file, reference };
    });
    current();
    const additions: SecureAttachmentDraft[] = [];
    for (const source of sources) {
      const buffer = await source.file.arrayBuffer();
      current();
      if (
        !(buffer instanceof ArrayBuffer) ||
        buffer.byteLength !== source.reference.content.byteLength
      )
        throw Error('附件读取字节数发生变化。');
      const data = new Uint8Array(buffer).slice(),
        version = await digest(data);
      current();
      additions.push({
        reference: { ...source.reference, content: { ...source.reference.content, version } },
        data: encode(data),
        status: 'draft',
      });
    }
    return this.store.backend.exclusive(key(target, 'lock'), current, async () => {
      const loaded = await this.#load(target, current);
      if (!same(loaded.items, snapshot)) throw conflict();
      for (const entry of additions)
        if (
          loaded.operations.some(
            (operation) => referenceId(operation) === entry.reference.attachmentId,
          )
        )
          throw Error('附件编号已用于原操作，请重新选择文件。');
      return this.#save(loaded, [...loaded.items, ...additions], current);
    });
  }
  async removeDraft(
    input: SecureCliTarget,
    expected: SecureAttachmentDraft[],
    attachmentId: string,
    current: () => void,
  ) {
    const target = targetSnapshot(input),
      snapshot = z.array(draftSchema).max(MAX_TURN_ATTACHMENTS).parse(expected);
    return this.store.backend.exclusive(key(target, 'lock'), current, async () => {
      const loaded = await this.#load(target, current);
      if (!same(loaded.items, snapshot)) throw conflict();
      const item = loaded.items.find((entry) => entry.reference.attachmentId === attachmentId);
      if (!item || item.status !== 'draft')
        throw Error('附件已上传或结果待确认，不能仅从本机移除。');
      return this.#save(
        loaded,
        loaded.items.filter((entry) => entry !== item),
        current,
      );
    });
  }
  async forget(input: SecureCliTarget, sent: AttachmentReference[], current: () => void) {
    const target = targetSnapshot(input),
      references = promptAttachmentsSchema.parse(sent);
    return this.store.backend.exclusive(key(target, 'lock'), current, async () => {
      const loaded = await this.#load(target, current);
      const items = loaded.items.filter((entry) => {
        const reference = references.find(
          (item) => item.attachmentId === entry.reference.attachmentId,
        );
        if (!reference) return true;
        if (!same(reference, entry.reference) || entry.status !== 'uploaded') throw conflict();
        return false;
      });
      return this.#save(loaded, items, current);
    });
  }
  async stage(
    input: SecureCliTarget,
    attachmentId: string,
    requestedAction: 'upload' | 'remove',
    operationId: string,
    now: string,
    current: () => void,
  ) {
    const target = targetSnapshot(input);
    return this.store.backend.exclusive(key(target, 'lock'), current, async () => {
      const loaded = await this.#load(target, current),
        item = loaded.items.find((entry) => entry.reference.attachmentId === attachmentId);
      if (!item || item.status !== (requestedAction === 'upload' ? 'draft' : 'uploaded'))
        throw Error('附件状态已改变；结果待确认时只能手动重试原操作。');
      const command = hostCommandSchema.parse({
        method: 'attachment-action',
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        params: {
          contentVersion: 1,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId: target.sessionId,
          operationId,
          action: requestedAction,
          ...(requestedAction === 'upload'
            ? { attachment: item.reference, data: item.data }
            : { attachmentId }),
        },
      });
      return this.store.stage(
        {
          operationId,
          kind: requestedAction === 'upload' ? 'attachment-upload' : 'attachment-remove',
          target,
          body: JSON.stringify(command),
        },
        now,
        current,
      );
    });
  }
  async confirm(input: SecureCliOperation, rawReceipt: unknown, current: () => void) {
    const original = secureOperationSchema.parse(input);
    if (!action(original)) throw Error('不是附件原操作。');
    const receipt = attachmentReceiptSchema.parse(rawReceipt);
    // The persistent schema verifies scope, operation ID and the complete uploaded reference.
    secureOperationSchema.parse({ ...original, state: 'accepted', receipt });
    current();
    return this.store.transition(original, ['pending', 'ending'], 'accepted', receipt, current);
  }
  async readContent(
    input: SecureCliTarget,
    inputReference: AttachmentReference,
    current: () => void,
    read?: () => Promise<unknown>,
  ): Promise<SecureAttachmentContent> {
    const target = targetSnapshot(input),
      reference = attachmentReferenceSchema.parse(inputReference);
    current();
    if (!read) {
      const loaded = await this.#document(target, 'cache', current);
      const found = loaded.document.entries.find((entry) => same(entry.reference, reference));
      if (!found) throw Error('此执行目标尚无经过验证的本机附件缓存。');
      return { target, reference, data: found.data, source: 'cache', cacheSaved: true };
    }
    const raw = await read();
    current();
    const result = attachmentContentSchema.parse(raw);
    if (
      result.workspaceId !== target.workspaceId ||
      result.localProjectId !== target.localProjectId ||
      result.sessionId !== target.sessionId ||
      !same(result.attachment, reference)
    )
      throw Error('主机附件回传与当前审阅内容不匹配。');
    await verify(reference, result.data, current);
    let cacheSaved = false;
    try {
      const loaded = await this.#document(target, 'cache', current);
      const entries = [
        { reference, data: result.data },
        ...loaded.document.entries.filter(
          (entry) => entry.reference.attachmentId !== reference.attachmentId,
        ),
      ].slice(0, MAX_TURN_ATTACHMENTS);
      await this.store.backend.compareAndSet(
        loaded.key,
        loaded.raw,
        documentSchema.parse({ target, revision: loaded.document.revision + 1, entries }),
        current,
      );
      current();
      cacheSaved = true;
    } catch {
      // A failed cache write must not erase a verified host response; an expired lease still fails.
      current();
    }
    return { target, reference, data: result.data, source: 'host', cacheSaved };
  }
}
