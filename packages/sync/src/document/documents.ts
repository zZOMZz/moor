import type {
  CollaborationPersistence,
  CollaborationDocumentRow as DocumentRow,
} from './persistence';
import { actorKey, actorSchema, type AttentionActor } from '@moor/protocol/attention';
import { assert, id } from '@moor/protocol/protocol';
import {
  COLLABORATION_VERSION,
  collaborationAllows,
  collaborationKey,
  collaborationOperationSchema,
  migrateCollaborationOperation,
  collaborationRoleSchema,
  collaborationScopeSchema,
  collaborationSyncRequestSchema,
  taskExecutionTargetSchema,
  taskStateSchema,
  type CollaborationOperation,
  type CollaborationPermission,
  type CollaborationRole,
  type CollaborationScope,
  type CollaborationSyncRequest,
  type CollaborationSyncResponse,
  type TaskExecutionTarget,
  type TaskState,
} from '@moor/protocol/collaboration-protocol';
import { validateCollaborationDependencies } from '@moor/session/collaboration-document';
import {
  CollaborationReplica,
  migrateCollaborationSnapshot,
} from '@moor/session/collaboration-replica';

export type CollaborationChange = { scope: CollaborationScope; authored: boolean };

/** State Plane storage: authorized document edits and replication, with no queue or Agent rules. */
export class CollaborationDocuments {
  #depth = 0;
  #changed = new Map<string, CollaborationChange>();
  #listeners = new Set<(change: CollaborationChange) => void>();
  constructor(
    private readonly persistence: CollaborationPersistence,
    readonly authorityId: string,
    readonly now: () => number,
  ) {
    id.parse(authorityId);
  }
  close() {
    this.persistence.close();
  }
  subscribe(listener: (change: CollaborationChange) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  atomic<T>(work: () => T): T {
    if (this.#depth) return work();
    let result: T;
    try {
      result = this.persistence.atomic(() => {
        this.#depth++;
        try {
          return work();
        } finally {
          this.#depth--;
        }
      });
    } catch (error) {
      this.#changed.clear();
      throw error;
    }
    const changes = [...this.#changed.values()];
    this.#changed.clear();
    for (const change of changes)
      for (const listener of this.#listeners) {
        try {
          listener(change);
        } catch {
          /* A notification cannot change a committed result. */
        }
      }
    return result;
  }
  private workspaceKey(workspaceId: string) {
    return JSON.stringify([this.authorityId, workspaceId]);
  }
  private actor(actor: AttentionActor) {
    const parsed = actorSchema.parse(actor);
    assert(parsed.authorityId === this.authorityId, 403, '协作账号不属于此授权服务');
    return actorKey(parsed);
  }
  authorize(actor: AttentionActor, workspaceId: string, permission: CollaborationPermission) {
    const role = this.persistence.role(this.workspaceKey(workspaceId), this.actor(actor));
    assert(
      role !== undefined && collaborationAllows(collaborationRoleSchema.parse(role), permission),
      403,
      '当前成员没有此协作权限',
    );
    return collaborationRoleSchema.parse(role);
  }
  hasWorkspace(workspaceId: string) {
    return this.persistence.workspaceOwner(this.workspaceKey(workspaceId)) !== undefined;
  }
  registered(scope: CollaborationScope) {
    return this.persistence.sessionTarget(collaborationKey(scope)) !== undefined;
  }
  authorizeRead(actor: AttentionActor, scope: CollaborationScope) {
    const role = this.authorize(actor, scope.workspaceId, 'read');
    this.target(scope);
    return role;
  }
  sessions() {
    return this.persistence.sessions().flatMap((row) => {
      const [authorityId, workspaceId, projectId, sessionId] = JSON.parse(
        String(row.scope),
      ) as string[];
      return authorityId === this.authorityId
        ? [
            {
              scope: collaborationScopeSchema.parse({
                authorityId,
                workspaceId,
                projectId,
                sessionId,
              }),
              target: taskExecutionTargetSchema.parse(JSON.parse(row.target)),
            },
          ]
        : [];
    });
  }
  createWorkspace(actor: AttentionActor, workspaceId: string) {
    const owner = this.actor(actor);
    id.parse(workspaceId);
    this.atomic(() => this.persistence.createWorkspace(this.workspaceKey(workspaceId), owner));
  }

  setMember(
    actor: AttentionActor,
    workspaceId: string,
    member: AttentionActor,
    role: CollaborationRole | null,
  ) {
    this.authorize(actor, workspaceId, 'manage');
    const key = this.actor(member),
      owner = this.persistence.workspaceOwner(this.workspaceKey(workspaceId));
    assert(key !== owner && role !== 'owner', 409, '不能通过成员接口更改所有者');
    this.persistence.setMember(
      this.workspaceKey(workspaceId),
      key,
      role === null ? null : collaborationRoleSchema.parse(role),
    );
  }

  registerSession(
    actor: AttentionActor,
    rawScope: CollaborationScope,
    rawTarget: TaskExecutionTarget,
  ) {
    const scope = collaborationScopeSchema.parse(rawScope),
      target = taskExecutionTargetSchema.parse(rawTarget);
    this.authorize(actor, scope.workspaceId, 'manage');
    assert(
      scope.authorityId === this.authorityId && scope.sessionId === target.sessionId,
      400,
      '共享会话与执行目标不匹配',
    );
    this.atomic(() => {
      const key = collaborationKey(scope),
        existing = this.persistence.sessionTarget(key);
      if (existing) assert(existing === JSON.stringify(target), 409, '会话执行绑定不可静默更换');
      else this.persistence.registerSession(key, JSON.stringify(target));
      this.migrate(scope);
    });
  }
  target(scope: CollaborationScope) {
    assert(scope.authorityId === this.authorityId, 403, '协作空间不属于此授权服务');
    const target = this.persistence.sessionTarget(collaborationKey(scope));
    assert(target !== undefined, 404, '共享会话尚未登记');
    return taskExecutionTargetSchema.parse(JSON.parse(target!));
  }
  private row(scope: CollaborationScope) {
    return this.persistence.document(collaborationKey(scope));
  }

  private load(scope: CollaborationScope) {
    this.target(scope);
    const row = this.row(scope);
    assert(row, 409, '协作文档需要在主机启动时迁移');
    return { row, replica: new CollaborationReplica(scope, row.snapshot, row.peer) };
  }
  private save(
    scope: CollaborationScope,
    replica: CollaborationReplica,
    row: DocumentRow,
    authored: boolean,
  ) {
    const revision = row.revision + 1;
    this.persistence.updateDocument(
      collaborationKey(scope),
      replica.snapshot(),
      revision,
      row.sequence,
    );
    const key = collaborationKey(scope);
    this.#changed.set(key, {
      scope,
      authored: authored || this.#changed.get(key)?.authored === true,
    });
  }
  /** Explicit startup/enable migration. Reads never migrate, register or recover execution. */
  migrate(scope: CollaborationScope) {
    const existing = this.row(scope);
    if (existing) {
      const upgraded = migrateCollaborationSnapshot(scope, existing.snapshot);
      if (upgraded)
        this.atomic(() => {
          this.persistence.upgradeDocument(
            collaborationKey(scope),
            upgraded.snapshot,
            upgraded.peer,
          );
        });
      return;
    }
    this.atomic(() => {
      const replica = new CollaborationReplica(scope);
      try {
        let sequence = 0;
        const legacy = this.persistence.legacyDocument(collaborationKey(scope));
        for (const row of legacy.operations) {
          const operation = migrateCollaborationOperation(JSON.parse(row.body));
          if (!operation) continue;
          replica.append(operation, row.sequence);
          sequence = Math.max(sequence, row.sequence);
        }
        for (const state of legacy.executions)
          replica.publishExecution(taskStateSchema.parse(JSON.parse(state)));
        this.persistence.insertDocument(collaborationKey(scope), {
          snapshot: replica.snapshot(),
          peer: replica.peerId,
          revision: 1,
          sequence,
        });
      } finally {
        replica.close();
      }
    });
  }
  projection(scope: CollaborationScope) {
    const { replica } = this.load(scope);
    try {
      return replica.view();
    } finally {
      replica.close();
    }
  }
  read(actor: AttentionActor, scope: CollaborationScope, version?: string) {
    this.authorizeRead(actor, scope);
    const { replica, row } = this.load(scope);
    try {
      return { document: replica.export(version), revision: row.revision };
    } finally {
      replica.close();
    }
  }
  /** Typed author edits only. Queue transitions belong exclusively to the execution coordinator. */
  append(
    actor: AttentionActor,
    scope: CollaborationScope,
    operations: readonly CollaborationOperation[],
  ) {
    this.authorizeRead(actor, scope);
    return this.atomic(() => {
      const { replica, row } = this.load(scope),
        target = this.target(scope),
        author = this.actor(actor);
      let changed = false;
      try {
        const previous = replica.view().operations,
          byId = new Map(previous.map((op) => [op.operationId, op]));
        for (const raw of operations) {
          const operation = collaborationOperationSchema.parse(raw);
          assert(
            collaborationKey(operation.scope) === collaborationKey(scope) &&
              this.actor(operation.author.actor) === author,
            403,
            '不能代替其他成员发布原操作',
          );
          this.authorize(actor, scope.workspaceId, 'submit');
          const existing = byId.get(operation.operationId);
          if (existing) {
            assert(
              JSON.stringify(existing) === JSON.stringify(operation),
              409,
              '协作操作编号对应不同内容',
            );
            continue;
          }
          validateCollaborationDependencies(operation, previous);
          if (operation.kind === 'submit')
            assert(
              JSON.stringify(operation.target) === JSON.stringify(target),
              409,
              '任务执行绑定与已登记会话不匹配',
            );
          replica.append(operation, ++row.sequence);
          previous.push(operation);
          byId.set(operation.operationId, operation);
          changed = true;
        }
        if (changed) this.save(scope, replica, row, true);
      } finally {
        replica.close();
      }
      return operations.map((op) => op.operationId);
    });
  }
  sync(actor: AttentionActor, raw: CollaborationSyncRequest): CollaborationSyncResponse {
    const request = collaborationSyncRequestSchema.parse(raw);
    this.authorizeRead(actor, request.scope);
    assert(
      request.after <= (this.row(request.scope)?.revision ?? 0),
      409,
      '协作文档进度超过主机当前版本',
    );
    const storedOperationIds = this.append(actor, request.scope, request.operations);
    const read = this.read(actor, request.scope, request.documentVersion);
    return {
      version: COLLABORATION_VERSION,
      scope: request.scope,
      cursor: read.revision,
      hasMore: false,
      storedOperationIds,
      document: read.document,
    };
  }
  /** Host-private projection writer; no sync or RPC route accepts caller-authored TaskState. */
  publishExecution(state: TaskState) {
    assert(this.#depth > 0, 500, '执行投影必须与私有账本原子提交');
    const { replica, row } = this.load(state.scope);
    try {
      replica.publishExecution(state);
      this.save(state.scope, replica, row, false);
    } finally {
      replica.close();
    }
  }
}
