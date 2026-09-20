import { DatabaseSync } from 'node:sqlite';
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

type DocumentRow = { snapshot: string; peer: string; revision: number; sequence: number };
export type CollaborationChange = { scope: CollaborationScope; authored: boolean };

/** State Plane storage: authorized document edits and replication, with no queue or Agent rules. */
export class CollaborationStore {
  readonly db: DatabaseSync;
  readonly #ownsDatabase: boolean;
  #depth = 0;
  #changed = new Map<string, CollaborationChange>();
  #listeners = new Set<(change: CollaborationChange) => void>();
  static prepare(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_workspace(id TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_member(workspace TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(workspace,actor));
      CREATE TABLE IF NOT EXISTS collaboration_session(scope TEXT PRIMARY KEY, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_document(scope TEXT PRIMARY KEY, snapshot TEXT NOT NULL, peer TEXT NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL);
    `);
  }
  constructor(
    file: string | DatabaseSync,
    readonly authorityId: string,
    readonly now: () => number,
    prepared = false,
  ) {
    id.parse(authorityId);
    this.#ownsDatabase = typeof file === 'string';
    this.db = typeof file === 'string' ? new DatabaseSync(file) : file;
    if (this.#ownsDatabase) this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!prepared) CollaborationStore.prepare(this.db);
  }
  close() {
    if (this.#ownsDatabase) this.db.close();
  }
  subscribe(listener: (change: CollaborationChange) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  atomic<T>(work: () => T): T {
    if (this.#depth) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.#depth++;
    let result: T;
    try {
      result = work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.#changed.clear();
      throw error;
    } finally {
      this.#depth--;
    }
    const changes = [...this.#changed.values()];
    this.#changed.clear();
    for (const change of changes)
      for (const listener of this.#listeners) {
        try {
          listener(change);
        } catch {
          /* Notifications cannot change a committed result. */
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
    const row = this.db
      .prepare('SELECT role FROM collaboration_member WHERE workspace=? AND actor=?')
      .get(this.workspaceKey(workspaceId), this.actor(actor));
    assert(
      row && collaborationAllows(collaborationRoleSchema.parse(row.role), permission),
      403,
      '当前成员没有此协作权限',
    );
    return collaborationRoleSchema.parse(row.role);
  }
  hasWorkspace(workspaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM collaboration_workspace WHERE id=?')
      .get(this.workspaceKey(workspaceId));
  }
  registered(scope: CollaborationScope) {
    return !!this.db
      .prepare('SELECT 1 FROM collaboration_session WHERE scope=?')
      .get(collaborationKey(scope));
  }
  authorizeRead(actor: AttentionActor, scope: CollaborationScope) {
    const role = this.authorize(actor, scope.workspaceId, 'read');
    this.target(scope);
    return role;
  }
  sessions() {
    return this.db
      .prepare('SELECT scope,target FROM collaboration_session')
      .all()
      .flatMap((row) => {
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
                target: taskExecutionTargetSchema.parse(JSON.parse(String(row.target))),
              },
            ]
          : [];
      });
  }
  createWorkspace(actor: AttentionActor, workspaceId: string) {
    const owner = this.actor(actor);
    id.parse(workspaceId);
    this.atomic(() => {
      this.db
        .prepare('INSERT INTO collaboration_workspace VALUES(?,?)')
        .run(this.workspaceKey(workspaceId), owner);
      this.db
        .prepare('INSERT INTO collaboration_member VALUES(?,?,?)')
        .run(this.workspaceKey(workspaceId), owner, 'owner');
    });
  }
  setMember(
    actor: AttentionActor,
    workspaceId: string,
    member: AttentionActor,
    role: CollaborationRole | null,
  ) {
    this.authorize(actor, workspaceId, 'manage');
    const key = this.actor(member),
      owner = this.db
        .prepare('SELECT owner FROM collaboration_workspace WHERE id=?')
        .get(this.workspaceKey(workspaceId));
    assert(key !== owner?.owner && role !== 'owner', 409, '不能通过成员接口更改所有者');
    if (role === null)
      this.db
        .prepare('DELETE FROM collaboration_member WHERE workspace=? AND actor=?')
        .run(this.workspaceKey(workspaceId), key);
    else
      this.db
        .prepare(
          'INSERT INTO collaboration_member VALUES(?,?,?) ON CONFLICT(workspace,actor) DO UPDATE SET role=excluded.role',
        )
        .run(this.workspaceKey(workspaceId), key, collaborationRoleSchema.parse(role));
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
        existing = this.db
          .prepare('SELECT target FROM collaboration_session WHERE scope=?')
          .get(key);
      if (existing)
        assert(existing.target === JSON.stringify(target), 409, '会话执行绑定不可静默更换');
      else
        this.db
          .prepare('INSERT INTO collaboration_session VALUES(?,?)')
          .run(key, JSON.stringify(target));
      this.migrate(scope);
    });
  }
  target(scope: CollaborationScope) {
    assert(scope.authorityId === this.authorityId, 403, '协作空间不属于此授权服务');
    const row = this.db
      .prepare('SELECT target FROM collaboration_session WHERE scope=?')
      .get(collaborationKey(scope));
    assert(row, 404, '共享会话尚未登记');
    return taskExecutionTargetSchema.parse(JSON.parse(String(row.target)));
  }
  private row(scope: CollaborationScope) {
    return this.db
      .prepare('SELECT snapshot,peer,revision,sequence FROM collaboration_document WHERE scope=?')
      .get(collaborationKey(scope)) as DocumentRow | undefined;
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
    this.db
      .prepare('UPDATE collaboration_document SET snapshot=?,revision=?,sequence=? WHERE scope=?')
      .run(replica.snapshot(), revision, row.sequence, collaborationKey(scope));
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
          this.db
            .prepare(
              'UPDATE collaboration_document SET snapshot=?,peer=?,revision=revision+1 WHERE scope=?',
            )
            .run(upgraded.snapshot, upgraded.peer, collaborationKey(scope));
        });
      return;
    }
    this.atomic(() => {
      const replica = new CollaborationReplica(scope);
      try {
        let sequence = 0;
        const exists = (name: string) =>
          !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
        if (exists('collaboration_operation')) {
          const operations = this.db
            .prepare('SELECT rowid,body FROM collaboration_operation WHERE scope=? ORDER BY rowid')
            .all(collaborationKey(scope));
          for (const row of operations) {
            const op = migrateCollaborationOperation(JSON.parse(String(row.body)));
            if (!op) continue;
            const old = exists('collaboration_event')
              ? this.db
                  .prepare(
                    "SELECT sequence FROM collaboration_event WHERE scope=? AND kind='operation' AND json_extract(body,'$.operationId')=? ORDER BY sequence LIMIT 1",
                  )
                  .get(collaborationKey(scope), op.operationId)
              : undefined;
            const accepted = old ? Number(old.sequence) : Number(row.rowid);
            replica.append(op, accepted);
            sequence = Math.max(sequence, accepted);
          }
        }
        if (exists('collaboration_task'))
          for (const row of this.db
            .prepare('SELECT state FROM collaboration_task WHERE scope=?')
            .all(collaborationKey(scope)))
            replica.publishExecution(taskStateSchema.parse(JSON.parse(String(row.state))));
        this.db
          .prepare('INSERT INTO collaboration_document VALUES(?,?,?,?,?)')
          .run(collaborationKey(scope), replica.snapshot(), replica.peerId, 1, sequence);
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
