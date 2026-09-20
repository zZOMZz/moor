import { z } from 'zod';
import { CollaborationReplica } from '@moor/session/collaboration-replica';
import {
  COLLABORATION_LIMITS,
  COLLABORATION_VERSION,
  collaborationOfferReceiptSchema,
  type CollaborationOffer,
  collaborationAuthorSchema,
  collaborationKey,
  collaborationOperationSchema,
  collaborationScopeSchema,
  collaborationSyncRequestSchema,
  taskStateSchema,
  validateCollaborationSyncResponse,
  type CollaborationAuthor,
  type CollaborationInput,
  type CollaborationOperation,
  type CollaborationScope,
  type CollaborationSyncRequest,
  type SharedDraftRevision,
  type TaskExecutionTarget,
  type TaskIntent,
} from '@moor/protocol/collaboration-protocol';
import {
  mergeCollaborationOperations,
  sharedDraftHeads,
  validateCollaborationDependencies,
} from '@moor/session/collaboration-document';

export interface CollaborationStorage {
  read(key: string): Promise<unknown>;
  exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T>;
  compareAndSet(key: string, expected: unknown, value: unknown, current: () => void): Promise<void>;
}
export interface CollaborationTransport {
  /** The adapter authenticates the current actor; no credentials are stored in the shared document. */
  sync(request: CollaborationSyncRequest): Promise<unknown>;
  offer?(request: CollaborationOffer): Promise<unknown>;
}

/** Preserve causal order while bounding actual JSON bytes, including escaped prompt text. */
export function collaborationSyncBatch(
  scope: CollaborationScope,
  after: number,
  pending: readonly CollaborationOperation[],
  documentVersion?: string,
): CollaborationSyncRequest {
  const request: CollaborationSyncRequest = {
    version: COLLABORATION_VERSION,
    scope,
    after,
    operations: [],
    ...(documentVersion ? { documentVersion } : {}),
  };
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(request)).byteLength;
  for (const raw of pending.slice(0, COLLABORATION_LIMITS.batch)) {
    const operation = collaborationOperationSchema.parse(raw);
    const addition =
      encoder.encode(JSON.stringify(operation)).byteLength + (request.operations.length ? 1 : 0);
    if (bytes + addition > COLLABORATION_LIMITS.requestBytes) break;
    request.operations.push(operation);
    bytes += addition;
  }
  if (pending.length && !request.operations.length) throw Error('单个协作操作超过同步大小限制');
  return collaborationSyncRequestSchema.parse(request);
}
const legacyDocumentSchema = z
  .object({
    version: z.literal(1),
    scope: collaborationScopeSchema,
    author: collaborationAuthorSchema,
    cursor: z.number().int().nonnegative().safe(),
    operations: z.array(collaborationOperationSchema),
    pending: z.array(z.string()),
    tasks: z.array(taskStateSchema),
  })
  .strict();
const storedDocumentSchema = z
  .object({
    storageVersion: z.literal(2),
    scope: collaborationScopeSchema,
    author: collaborationAuthorSchema,
    cursor: z.number().int().nonnegative().safe(),
    pending: z.array(z.string()),
    snapshot: z.string(),
    peer: z.string(),
    documentVersion: z.string().optional(),
  })
  .strict();
type StoredDocument = z.infer<typeof storedDocumentSchema>;
export type CollaborationDocument = z.infer<typeof legacyDocumentSchema> & {
  admissions: Record<string, number>;
};
export interface CollaborationStatePlane {
  snapshot(): CollaborationDocument;
  subscribe(listener: () => void): () => void;
  recover(): Promise<void>;
  sync(): Promise<void>;
  draftHeads(draftId: string): SharedDraftRevision[];
}
export interface CollaborationControlPlane {
  saveDraft(input: {
    draftId: string;
    parents: string[];
    input: CollaborationInput;
  }): Promise<SharedDraftRevision>;
  sendTurn(input: {
    draftRevisionId: string;
    target: TaskExecutionTarget;
    expiresAt: number;
  }): Promise<TaskIntent>;
  withdrawTask(taskId: string): Promise<void>;
}

/** Durable local authoring and state replication; this object has no Agent dispatch capability. */
export class CollaborationClient {
  readonly state: CollaborationStatePlane;
  readonly control: CollaborationControlPlane;
  readonly #key: string;
  readonly #scope: CollaborationScope;
  readonly #author: CollaborationAuthor;
  #document: CollaborationDocument;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly options: {
      scope: CollaborationScope;
      author: CollaborationAuthor;
      storage: CollaborationStorage;
      transport: CollaborationTransport;
      current(): void;
      uuid(): string;
      now(): number;
    },
  ) {
    this.#scope = collaborationScopeSchema.parse(options.scope);
    this.#author = collaborationAuthorSchema.parse(options.author);
    if (this.#author.actor.authorityId !== this.#scope.authorityId)
      throw Error('协作账号与空间不匹配');
    this.#key = JSON.stringify([
      'moor-collaboration-v1',
      collaborationKey(this.#scope),
      this.#author,
    ]);
    this.#document = this.#view(this.#empty());
    this.state = {
      snapshot: () => structuredClone(this.#document),
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => {
          this.#listeners.delete(listener);
        };
      },
      recover: () => this.#recover(),
      sync: () => this.#sync(),
      draftHeads: (draftId) => sharedDraftHeads(this.state.snapshot().operations, draftId),
    };
    this.control = {
      saveDraft: async (input) =>
        this.#authorOperation((document) => {
          const operation = collaborationOperationSchema.parse({
            ...this.#base(),
            kind: 'draft',
            draftId: input.draftId,
            parents: input.parents,
            input: input.input,
          }) as SharedDraftRevision;
          validateCollaborationDependencies(operation, document.operations);
          return operation;
        }),
      sendTurn: async (input) => {
        const intent = await this.#authorOperation((document) => {
          const draft = document.operations.find(
            (operation) => operation.operationId === input.draftRevisionId,
          );
          if (draft?.kind !== 'draft') throw Error('请先保存需要提交的草稿版本');
          const heads = sharedDraftHeads(document.operations, draft.draftId);
          if (heads.length !== 1 || heads[0].operationId !== draft.operationId)
            throw Error('草稿已有并发修改，请合并并审阅后再提交');
          if (input.expiresAt <= this.options.now()) throw Error('执行授权已经过期');
          return collaborationOperationSchema.parse({
            ...this.#base(),
            kind: 'submit',
            draftId: draft.draftId,
            draftRevisionId: draft.operationId,
            input: draft.input,
            target: input.target,
            authorization: {
              kind: 'execute',
              ordering: 'after-previous',
              expiresAt: input.expiresAt,
            },
          }) as TaskIntent;
        });
        void this.#offer(intent.operationId);
        return intent;
      },
      withdrawTask: async (taskId) => {
        const withdrawal = await this.#authorOperation((document) => {
          const operation = collaborationOperationSchema.parse({
            ...this.#base(),
            kind: 'withdraw',
            taskId,
          });
          validateCollaborationDependencies(operation, document.operations);
          return operation;
        });
        void this.#offer(withdrawal.operationId);
      },
    };
  }

  #base() {
    return {
      version: 1 as const,
      operationId: this.options.uuid(),
      scope: this.#scope,
      author: this.#author,
      createdAt: this.options.now(),
    };
  }
  #empty(): StoredDocument {
    const replica = new CollaborationReplica(this.#scope);
    try {
      return {
        storageVersion: 2,
        scope: this.#scope,
        author: this.#author,
        cursor: 0,
        pending: [],
        snapshot: replica.snapshot(),
        peer: replica.peerId,
      };
    } finally {
      replica.close();
    }
  }
  #view(record: StoredDocument): CollaborationDocument {
    const replica = new CollaborationReplica(this.#scope, record.snapshot, record.peer);
    try {
      return {
        version: 1,
        scope: record.scope,
        author: record.author,
        cursor: record.cursor,
        pending: [...record.pending],
        ...replica.view(),
      };
    } finally {
      replica.close();
    }
  }
  async #read() {
    this.options.current();
    const raw = await this.options.storage.read(this.#key);
    this.options.current();
    let record: StoredDocument;
    if (raw == null) record = this.#empty();
    else if ((raw as { storageVersion?: unknown }).storageVersion === 2)
      record = storedDocumentSchema.parse(raw);
    else {
      const legacy = legacyDocumentSchema.parse(raw);
      if (
        collaborationKey(legacy.scope) !== collaborationKey(this.#scope) ||
        JSON.stringify(legacy.author) !== JSON.stringify(this.#author)
      )
        throw Error('本机协作记录的身份不匹配');
      const replica = new CollaborationReplica(this.#scope);
      try {
        for (const operation of mergeCollaborationOperations(this.#scope, legacy.operations))
          replica.append(operation);
        for (const task of legacy.tasks) replica.publishExecution(task);
        record = {
          storageVersion: 2,
          scope: legacy.scope,
          author: legacy.author,
          cursor: 0,
          pending: legacy.pending,
          snapshot: replica.snapshot(),
          peer: replica.peerId,
        };
      } finally {
        replica.close();
      }
    }
    const document = this.#view(record);
    if (
      collaborationKey(record.scope) !== collaborationKey(this.#scope) ||
      JSON.stringify(record.author) !== JSON.stringify(this.#author) ||
      new Set(record.pending).size !== record.pending.length ||
      record.pending.some(
        (id) =>
          !document.operations.some(
            (op) =>
              op.operationId === id && JSON.stringify(op.author) === JSON.stringify(this.#author),
          ),
      )
    )
      throw Error('本机协作记录的身份或原操作不匹配');
    return { raw: raw ?? null, record, document };
  }
  #publish(document: CollaborationDocument) {
    this.#document = document;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Rendering cannot alter persistence or delivery. */
      }
    }
  }
  async #recover() {
    await this.options.storage.exclusive(this.#key, this.options.current, async () => {
      const { raw, record, document } = await this.#read();
      if (raw && (raw as { storageVersion?: unknown }).storageVersion !== 2)
        await this.options.storage.compareAndSet(this.#key, raw, record, this.options.current);
      this.options.current();
      this.#publish(document);
    });
  }
  async #authorOperation<T extends CollaborationOperation>(
    build: (document: CollaborationDocument) => T,
  ): Promise<T> {
    return this.options.storage.exclusive(this.#key, this.options.current, async () => {
      const { raw, record, document } = await this.#read(),
        operation = build(document);
      if (document.operations.some((entry) => entry.operationId === operation.operationId))
        throw Error('新的协作操作必须使用新的编号');
      const replica = new CollaborationReplica(this.#scope, record.snapshot, record.peer);
      try {
        replica.append(operation);
        record.snapshot = replica.snapshot();
      } finally {
        replica.close();
      }
      record.pending.push(operation.operationId);
      await this.options.storage.compareAndSet(this.#key, raw, record, this.options.current);
      this.options.current();
      this.#publish(this.#view(record));
      return structuredClone(operation);
    });
  }
  async #offer(operationId: string) {
    if (!this.options.transport.offer) return;
    try {
      const { record, document } = await this.#read();
      const byId = new Map(document.operations.map((op) => [op.operationId, op])),
        seen = new Set<string>();
      const operations: CollaborationOperation[] = [];
      const visit = (id: string) => {
        if (seen.has(id) || !record.pending.includes(id)) return;
        const op = byId.get(id);
        if (!op) throw Error('本机任务意图缺少依赖');
        seen.add(id);
        if (op.kind === 'draft') op.parents.forEach(visit);
        else visit(op.kind === 'submit' ? op.draftRevisionId : op.taskId);
        operations.push(op);
      };
      // Preserve this writer's already-published order even when a later RPC arrives first.
      const subject = record.pending.indexOf(operationId);
      if (subject < 0) return;
      record.pending.slice(0, subject + 1).forEach(visit);
      if (!operations.length || operations.length > COLLABORATION_LIMITS.batch) return;
      const offer: CollaborationOffer = {
        version: COLLABORATION_VERSION,
        scope: this.#scope,
        operationId,
        operations,
      };
      if (
        new TextEncoder().encode(JSON.stringify(offer)).byteLength >
        COLLABORATION_LIMITS.requestBytes
      )
        return;
      this.options.current();
      const receipt = collaborationOfferReceiptSchema.parse(
        await this.options.transport.offer(offer),
      );
      this.options.current();
      if (
        receipt.operationId !== operationId ||
        collaborationKey(receipt.scope) !== collaborationKey(this.#scope)
      )
        throw Error('RPC 送达回执范围不匹配');
      // The document, not an RPC acknowledgement, updates visible execution state.
    } catch {
      /* Offline or uncertain RPC delivery is recovered by durable state sync. */
    }
  }
  #sync(): Promise<void> {
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    let failed = false;
    const syncing = this.#synchronize()
      .catch((error) => {
        failed = true;
        throw error;
      })
      .finally(() => {
        if (this.#syncing === syncing) {
          this.#syncing = undefined;
          if (!failed && this.#syncAgain) return this.#sync();
        }
      });
    this.#syncing = syncing;
    return syncing;
  }
  async #synchronize() {
    for (;;) {
      this.#syncAgain = false;
      const request = await this.options.storage.exclusive(
        this.#key,
        this.options.current,
        async () => {
          const { document, record } = await this.#read();
          const pending = document.pending.slice(0, COLLABORATION_LIMITS.batch);
          const batch = collaborationSyncBatch(
            this.#scope,
            document.cursor,
            pending.map((id) => document.operations.find((entry) => entry.operationId === id)!),
            record.documentVersion,
          );
          return batch;
        },
      );
      // Network waits must not hold the local authoring lock. A later draft or another
      // page's sync is merged into the fresh durable state when this response arrives.
      this.options.current();
      const result = validateCollaborationSyncResponse(
        await this.options.transport.sync(request),
        request,
      );
      this.options.current();
      const more = await this.options.storage.exclusive(
        this.#key,
        this.options.current,
        async () => {
          const { raw, record, document } = await this.#read();
          // A first full Host snapshot also replaces legacy locally reconstructed status clocks.
          const replica = new CollaborationReplica(
            this.#scope,
            record.documentVersion ? record.snapshot : result.document.update,
            record.peer,
          );
          try {
            if (record.documentVersion) replica.import(result.document.update);
            for (const operation of document.operations) replica.append(operation);
            replica.view();
            record.snapshot = replica.snapshot();
          } finally {
            replica.close();
          }
          record.pending = record.pending.filter((id) => !result.storedOperationIds.includes(id));
          if (result.cursor >= record.cursor) record.documentVersion = result.document.version;
          record.cursor = Math.max(record.cursor, result.cursor);
          await this.options.storage.compareAndSet(this.#key, raw, record, this.options.current);
          this.options.current();
          this.#publish(this.#view(record));
          return result.hasMore || record.pending.length > 0;
        },
      );
      if (!more && !this.#syncAgain) return;
    }
  }
}
