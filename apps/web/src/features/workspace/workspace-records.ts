import { z } from 'zod';
import { productCanonicalJson as canonical } from '@moor/client/encrypted-product';
import type { SecureStorageBackend, StorageChange } from '../../platform/secure-store';
import type { WorkspaceLedger, WorkspaceOperation, WorkspaceScope } from './workspace-store';

export const WORKSPACE_RECENT_OPERATIONS = 64;
export const WORKSPACE_RECENT_OPERATION_BYTES = 4 * 1024 * 1024;
const revision = z.number().int().nonnegative().safe();
const operationRefSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    revision,
    sequence: revision,
    bytes: revision,
    status: z.enum(['pending', 'confirmed', 'abandoned']),
  })
  .strict();
export const workspaceRecordHeadSchema = z
  .object({
    version: z.literal(2),
    scope: z.unknown(),
    revision,
    sequence: revision,
    pending: z.array(operationRefSchema),
    recent: z.array(operationRefSchema).max(WORKSPACE_RECENT_OPERATIONS),
    features: z.record(z.record(revision)),
  })
  .strict();
type Head = z.infer<typeof workspaceRecordHeadSchema>;
const recordSchema = z
  .object({
    version: z.literal(2),
    scope: z.unknown(),
    kind: z.string(),
    id: z.string(),
    revision,
    value: z.unknown(),
  })
  .strict();
export const workspaceFeatureNames = [
  'attachments',
  'interactions',
  'mcp',
  'tasks',
  'git',
  'github',
  'attention',
  'githubWrite',
  'forks',
  'roles',
  'roleApplied',
  'previews',
  'annotations',
] as const;
type Feature = (typeof workspaceFeatureNames)[number];
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
const fail = () => Error('本机工作区记录已改变或引用不完整，请重新读取。');
export const workspaceLedgerKey = (scope: WorkspaceScope) =>
  canonical(['moor-desktop-ledger-v1', scope]);
export const workspaceRecordKey = (scope: WorkspaceScope, kind: string, id: string) =>
  canonical(['moor-desktop-record-v2', scope, kind, id]);
export const workspaceConfirmationKey = (scope: WorkspaceScope, sessionId: string) =>
  workspaceRecordKey(scope, 'confirmed-draft', sessionId);
type Loaded = {
  head: Head;
  ledger: WorkspaceLedger;
  rawRecords: Map<string, unknown>;
};

/** A small atomic head selects independently stored operations and session feature records.
 * Completed operations leave the hot index, but remain addressable by their original ID.
 */
export class WorkspaceRecords {
  constructor(readonly backend: SecureStorageBackend) {}

  #parse(raw: unknown, scope: WorkspaceScope, kind: string, id: string, expectedRevision?: number) {
    const record = recordSchema.parse(raw);
    if (
      !same(record.scope, scope) ||
      record.kind !== kind ||
      record.id !== id ||
      (expectedRevision !== undefined && record.revision !== expectedRevision)
    )
      throw fail();
    return record;
  }
  async operation(scope: WorkspaceScope, id: string, current: () => void) {
    const raw = await this.backend.read(workspaceRecordKey(scope, 'operation', id));
    current();
    return raw === null ? undefined : this.#parse(raw, scope, 'operation', id).value;
  }
  async confirmedDraft(scope: WorkspaceScope, sessionId: string, current: () => void) {
    const raw = await this.backend.read(workspaceConfirmationKey(scope, sessionId));
    current();
    return raw === null
      ? undefined
      : revision.parse(this.#parse(raw, scope, 'confirmed-draft', sessionId).value);
  }
  async load(
    scope: WorkspaceScope,
    raw: unknown,
    current: () => void,
    sessionIds?: readonly string[],
    extraOperationIds: readonly string[] = [],
  ): Promise<Loaded> {
    const head = workspaceRecordHeadSchema.parse(raw);
    if (
      !same(head.scope, scope) ||
      head.pending.some((ref) => ref.status !== 'pending') ||
      head.recent.some((ref) => ref.status === 'pending') ||
      new Set([...head.pending, ...head.recent].map((ref) => ref.id)).size !==
        head.pending.length + head.recent.length ||
      Object.keys(head.features).some((kind) => !workspaceFeatureNames.includes(kind as Feature))
    )
      throw fail();
    const selected = sessionIds === undefined ? undefined : new Set(sessionIds);
    const ledger: WorkspaceLedger = { version: 1, scope, revision: head.revision, operations: [] };
    const rawRecords = new Map<string, unknown>();
    const read = async (kind: string, id: string, expectedRevision?: number) => {
      const key = workspaceRecordKey(scope, kind, id);
      const value = await this.backend.read(key);
      current();
      rawRecords.set(key, value);
      return this.#parse(value, scope, kind, id, expectedRevision).value;
    };
    const refs = [...head.pending, ...head.recent].sort((a, b) => a.sequence - b.sequence);
    for (const ref of refs) {
      if (selected && !selected.has(ref.sessionId) && !extraOperationIds.includes(ref.id)) continue;
      const operation = (await read('operation', ref.id, ref.revision)) as WorkspaceOperation;
      if (
        operation.original?.value.operationId !== ref.id ||
        operation.original.value.sessionId !== ref.sessionId ||
        operation.status !== ref.status
      )
        throw fail();
      ledger.operations.push(operation);
    }
    for (const id of extraOperationIds) {
      if (ledger.operations.some((operation) => operation.original.value.operationId === id))
        continue;
      const value = await this.operation(scope, id, current);
      if (value !== undefined) {
        ledger.operations.push(value as WorkspaceOperation);
        const key = workspaceRecordKey(scope, 'operation', id);
        rawRecords.set(key, await this.backend.read(key));
        current();
      }
    }
    for (const kind of workspaceFeatureNames) {
      for (const [id, expectedRevision] of Object.entries(head.features[kind] ?? {})) {
        // Forks can reserve a different child session. Attention has actor/project keys.
        if (selected && !selected.has(id) && kind !== 'forks' && kind !== 'attention') continue;
        let value = await read(kind, id, expectedRevision);
        if (kind === 'attachments')
          value = await this.#hydrateAttachments(scope, id, value, current);
        const records = (ledger[kind] ??= {}) as Record<string, unknown>;
        Object.defineProperty(records, id, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    // A writer may commit between individual reads. Never assemble two revisions.
    if (!same(await this.backend.read(workspaceLedgerKey(scope)), raw)) throw fail();
    current();
    return { head, ledger, rawRecords };
  }
  async #hydrateAttachments(
    scope: WorkspaceScope,
    sessionId: string,
    raw: unknown,
    current: () => void,
  ) {
    const document = structuredClone(raw) as {
      revision: number;
      items: Array<Record<string, any>>;
    };
    if (!document || !Array.isArray(document.items)) throw fail();
    const items = [];
    for (const item of document.items) {
      const { blob, ...rest } = item;
      const id = canonical([
        sessionId,
        item.reference?.attachmentId,
        item.reference?.content?.version,
      ]);
      if (blob !== id) throw fail();
      const raw = await this.backend.read(workspaceRecordKey(scope, 'attachment-blob', id));
      current();
      const data = z.string().parse(this.#parse(raw, scope, 'attachment-blob', id).value);
      if (rest.pending?.request?.action === 'upload') rest.pending.request.data = data;
      items.push({ ...rest, data });
    }
    return { revision: document.revision, items };
  }
  async commit(
    scope: WorkspaceScope,
    rawHead: unknown,
    before: WorkspaceLedger,
    value: WorkspaceLedger,
    current: () => void,
    loaded?: Loaded,
  ) {
    if (!this.backend.compareAndSetMany)
      throw Error('本机存储不支持可靠的多记录事务，尚未保存或发送。');
    const head: Head = loaded
      ? structuredClone(loaded.head)
      : {
          version: 2,
          scope,
          revision: before.revision,
          sequence: 0,
          pending: [],
          recent: [],
          features: {},
        };
    head.revision = value.revision;
    const changes = new Map<string, StorageChange>();
    const save = async (
      kind: string,
      id: string,
      payload: unknown,
      recordRevision = value.revision,
    ) => {
      const key = workspaceRecordKey(scope, kind, id);
      const expected = loaded?.rawRecords.has(key)
        ? loaded.rawRecords.get(key)
        : await this.backend.read(key);
      current();
      const record = { version: 2, scope, kind, id, revision: recordRevision, value: payload };
      changes.set(key, { key, expected, value: record });
    };
    const oldOperations = new Map(
      before.operations.map((operation) => [operation.original.value.operationId, operation]),
    );
    for (const operation of value.operations) {
      const id = operation.original.value.operationId;
      if (loaded && same(oldOperations.get(id), operation)) continue;
      const oldRef = [...head.pending, ...head.recent].find((ref) => ref.id === id);
      await save('operation', id, operation);
      const ref = {
        id,
        sessionId: operation.original.value.sessionId,
        status: operation.status,
        revision: value.revision,
        sequence: oldRef?.sequence ?? head.sequence++,
        bytes: new TextEncoder().encode(JSON.stringify(operation)).byteLength,
      };
      head.pending = head.pending.filter((entry) => entry.id !== id);
      head.recent = head.recent.filter((entry) => entry.id !== id);
      if (operation.status === 'pending') head.pending.push(ref);
      else head.recent.push(ref);
      if (operation.status === 'confirmed' && operation.draft) {
        const sessionId = operation.draft.sessionId;
        const key = workspaceConfirmationKey(scope, sessionId);
        const previous = changes.get(key)?.value ?? (await this.backend.read(key));
        current();
        const earlier =
          previous === null
            ? -1
            : revision.parse(this.#parse(previous, scope, 'confirmed-draft', sessionId).value);
        if (operation.draft.revision > earlier)
          await save('confirmed-draft', sessionId, operation.draft.revision);
      }
    }
    let recentBytes = 0;
    head.recent = head.recent
      .slice(-WORKSPACE_RECENT_OPERATIONS)
      .reverse()
      .filter((ref) => {
        if (recentBytes + ref.bytes > WORKSPACE_RECENT_OPERATION_BYTES) return false;
        recentBytes += ref.bytes;
        return true;
      })
      .reverse();
    for (const kind of workspaceFeatureNames) {
      const records = value[kind] as Record<string, unknown> | undefined;
      for (const [id, original] of Object.entries(records ?? {})) {
        if (loaded && same((before[kind] as Record<string, unknown> | undefined)?.[id], original))
          continue;
        let payload = original;
        if (kind === 'attachments') {
          const attachments = structuredClone(original) as {
            revision: number;
            items: Array<Record<string, any>>;
          };
          for (const item of attachments.items) {
            const blob = canonical([
              id,
              item.reference.attachmentId,
              item.reference.content.version,
            ]);
            const key = workspaceRecordKey(scope, 'attachment-blob', blob);
            const existing = await this.backend.read(key);
            current();
            if (existing === null) await save('attachment-blob', blob, item.data, 1);
            else if (this.#parse(existing, scope, 'attachment-blob', blob).value !== item.data)
              throw fail();
            item.blob = blob;
            delete item.data;
            if (item.pending?.request?.action === 'upload') delete item.pending.request.data;
          }
          payload = attachments;
        }
        await save(kind, id, payload);
        Object.defineProperty((head.features[kind] ??= {}), id, {
          value: value.revision,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    workspaceRecordHeadSchema.parse(head);
    changes.set(workspaceLedgerKey(scope), {
      key: workspaceLedgerKey(scope),
      expected: rawHead,
      value: head,
    });
    current();
    await this.backend.compareAndSetMany([...changes.values()], current);
    current();
  }
}
