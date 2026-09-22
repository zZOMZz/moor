import { assert, id, mutationSchema, type Mutation } from '@moor/protocol/protocol';
import { mutationReceiptSchema } from '@moor/protocol/session-responses';
import {
  collaborationKey,
  migrateCollaborationOperation,
  taskExecutionTargetSchema,
  taskStateSchema,
  type CollaborationScope,
  type TaskExecutionTarget,
  type TaskIntent,
  type TaskPhase,
  type TaskState,
  type TaskClaim,
} from '@moor/protocol/collaboration-protocol';
import type { CollaborationStore } from '@moor/sync/store';
type TaskRow = { intent: string; state: string; claim: string | null; command: string | null };

/** Private execution ledger. Its public projection is written to TaskDoc in the same transaction. */
export class CollaborationExecutionStore {
  readonly db;
  constructor(
    readonly state: CollaborationStore,
    private readonly now = state.now,
  ) {
    this.db = state.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_execution(scope TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, intent TEXT NOT NULL, state TEXT NOT NULL, claim TEXT, command TEXT, PRIMARY KEY(scope,id));
      CREATE INDEX IF NOT EXISTS collaboration_execution_order ON collaboration_execution(scope,sequence);
      CREATE INDEX IF NOT EXISTS collaboration_execution_phase ON collaboration_execution(scope,json_extract(state,'$.phase'),sequence);
      CREATE TABLE IF NOT EXISTS collaboration_reconciled(scope TEXT PRIMARY KEY, through INTEGER NOT NULL);
    `);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='collaboration_task'").get())
      this.db.exec(
        'INSERT OR IGNORE INTO collaboration_execution SELECT scope,id,sequence,intent,state,claim,command FROM collaboration_task',
      );
  }
  through(scope: CollaborationScope) {
    return Number(
      this.db
        .prepare('SELECT through FROM collaboration_reconciled WHERE scope=?')
        .get(collaborationKey(scope))?.through ?? 0,
    );
  }
  reconciled(scope: CollaborationScope, through: number) {
    this.db
      .prepare(
        'INSERT INTO collaboration_reconciled VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET through=excluded.through',
      )
      .run(collaborationKey(scope), through);
  }
  enqueue(intent: TaskIntent, sequence: number) {
    return this.state.atomic(() => this.enqueueLocked(intent, sequence));
  }
  private enqueueLocked(intent: TaskIntent, sequence: number) {
    const key = collaborationKey(intent.scope);
    const existing = this.db
      .prepare('SELECT intent FROM collaboration_execution WHERE scope=? AND id=?')
      .get(key, intent.operationId);
    if (existing) {
      assert(
        JSON.stringify(migrateCollaborationOperation(JSON.parse(String(existing.intent)))) ===
          JSON.stringify(intent),
        409,
        '任务意图与原执行记录不匹配',
      );
      return;
    }
    let blocked = false;
    try {
      this.state.authorize(intent.author.actor, intent.scope.workspaceId, 'submit');
      assert(intent.authorization.expiresAt > this.now(), 409, '执行授权已经过期');
    } catch {
      blocked = true;
    }
    const state = taskStateSchema.parse({
      taskId: intent.operationId,
      scope: intent.scope,
      sequence,
      revision: 1,
      updatedAt: this.now(),
      phase: blocked ? 'blocked' : 'queued',
      ...(blocked ? { reason: '提交者权限已撤销或执行授权已过期' } : {}),
    });
    this.db
      .prepare('INSERT INTO collaboration_execution VALUES(?,?,?,?,?,NULL,NULL)')
      .run(key, intent.operationId, sequence, JSON.stringify(intent), JSON.stringify(state));
    this.state.publishExecution(state);
  }
  withdraw(scope: CollaborationScope, taskId: string) {
    return this.state.atomic(() => this.withdrawLocked(scope, taskId));
  }
  private withdrawLocked(scope: CollaborationScope, taskId: string) {
    const row = this.db
      .prepare('SELECT state FROM collaboration_execution WHERE scope=? AND id=?')
      .get(collaborationKey(scope), taskId);
    assert(row, 409, '撤回意图的原任务尚未受理');
    const state = taskStateSchema.parse(JSON.parse(String(row.state)));
    if (['queued', 'claimed', 'blocked'].includes(state.phase))
      this.transition(scope, taskId, 'cancelled');
  }
  private task(scope: CollaborationScope, taskId: string): TaskRow {
    const row = this.db
      .prepare(
        'SELECT intent,state,claim,command FROM collaboration_execution WHERE scope=? AND id=?',
      )
      .get(collaborationKey(scope), taskId);
    assert(row, 404, '共享任务不存在');
    return row as TaskRow;
  }
  private transition(
    scope: CollaborationScope,
    taskId: string,
    phase: TaskPhase,
    extra: Partial<TaskState> = {},
  ) {
    const previous = taskStateSchema.parse(JSON.parse(this.task(scope, taskId).state));
    const state = taskStateSchema.parse({
      ...previous,
      ...extra,
      phase,
      revision: previous.revision + 1,
      updatedAt: this.now(),
    });
    this.db
      .prepare('UPDATE collaboration_execution SET state=? WHERE scope=? AND id=?')
      .run(JSON.stringify(state), collaborationKey(scope), taskId);
    this.state.publishExecution(state);
    return state;
  }
  /** Caller supplies a target authenticated by its Host connection, never by a viewer request. */
  claim(
    scope: CollaborationScope,
    execution: TaskExecutionTarget,
    claimId: string,
  ): TaskClaim | undefined {
    const target = this.state.target(scope);
    assert(
      JSON.stringify(target) === JSON.stringify(taskExecutionTargetSchema.parse(execution)),
      403,
      '执行主机与任务绑定不匹配',
    );
    id.parse(claimId);
    return this.state.atomic(() => {
      const key = collaborationKey(scope);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM collaboration_execution WHERE scope=? AND json_extract(state,'$.phase') IN ('claimed','dispatching','accepted','running') LIMIT 1",
          )
          .get(key)
      )
        return;
      const next = this.db.prepare(
        "SELECT intent,state FROM collaboration_execution WHERE scope=? AND json_extract(state,'$.phase')='queued' ORDER BY sequence LIMIT 1",
      );
      for (;;) {
        const row = next.get(key);
        if (!row) return;
        taskStateSchema.parse(JSON.parse(String(row.state)));
        const intent = migrateCollaborationOperation(JSON.parse(String(row.intent))) as TaskIntent;
        try {
          this.state.authorize(intent.author.actor, scope.workspaceId, 'submit');
          assert(intent.authorization.expiresAt > this.now(), 409, '执行授权已经过期');
        } catch {
          this.transition(scope, intent.operationId, 'blocked', {
            reason: '提交者权限已撤销或执行授权已过期',
          });
          continue;
        }
        this.db
          .prepare('UPDATE collaboration_execution SET claim=? WHERE scope=? AND id=?')
          .run(claimId, collaborationKey(scope), intent.operationId);
        return { intent, claimId, state: this.transition(scope, intent.operationId, 'claimed') };
      }
    });
  }
  private assertClaim(claim: TaskClaim) {
    const row = this.task(claim.intent.scope, claim.intent.operationId);
    assert(
      row.claim === claim.claimId &&
        JSON.stringify(migrateCollaborationOperation(JSON.parse(row.intent))) ===
          JSON.stringify(claim.intent),
      409,
      '任务认领已经失效',
    );
    return { row, state: taskStateSchema.parse(JSON.parse(row.state)) };
  }
  beginDispatch(claim: TaskClaim, raw: Mutation) {
    const command = mutationSchema.parse(raw),
      target = claim.intent.target;
    return this.state.atomic(() => {
      const { state } = this.assertClaim(claim);
      assert(state.phase === 'claimed', 409, '任务已经派发或撤回');
      this.state.authorize(claim.intent.author.actor, claim.intent.scope.workspaceId, 'submit');
      assert(claim.intent.authorization.expiresAt > this.now(), 409, '执行授权已经过期');
      assert(
        command.kind === 'turn' &&
          command.sessionId === target.sessionId &&
          command.workspaceId === target.workspaceId,
        400,
        '执行命令与任务范围不匹配',
      );
      this.db
        .prepare('UPDATE collaboration_execution SET command=? WHERE scope=? AND id=?')
        .run(
          JSON.stringify(command),
          collaborationKey(claim.intent.scope),
          claim.intent.operationId,
        );
      return this.transition(claim.intent.scope, claim.intent.operationId, 'dispatching', {
        executionOperationId: command.operationId,
      });
    });
  }
  acceptExecution(claim: TaskClaim, rawReceipt: unknown) {
    const receipt = mutationReceiptSchema.parse(rawReceipt);
    return this.state.atomic(() => {
      const { row, state } = this.assertClaim(claim);
      assert(state.phase === 'dispatching' && row.command, 409, '任务不处于派发确认阶段');
      const command = mutationSchema.parse(JSON.parse(row.command));
      assert(
        receipt.accepted && receipt.operationId === command.operationId,
        409,
        '主机回执与原任务执行命令不匹配',
      );
      return this.transition(claim.intent.scope, claim.intent.operationId, 'accepted');
    });
  }
  settle(
    claim: TaskClaim,
    phase: 'completed' | 'failed' | 'interrupted' | 'blocked',
    detail: Pick<TaskState, 'reason' | 'userTurnId' | 'assistantTurnId'> = {},
  ) {
    return this.state.atomic(() => {
      const { state } = this.assertClaim(claim);
      if (['completed', 'failed', 'interrupted', 'blocked', 'cancelled'].includes(state.phase))
        return state;
      assert(
        ['claimed', 'dispatching', 'accepted', 'running'].includes(state.phase),
        409,
        '任务已经结束',
      );
      return this.transition(claim.intent.scope, claim.intent.operationId, phase, detail);
    });
  }
  /** Host startup supplies its exact binding. Started or uncertain work is never replayed. */
  interruptExecution(scope: CollaborationScope, execution: TaskExecutionTarget) {
    assert(
      JSON.stringify(this.state.target(scope)) ===
        JSON.stringify(taskExecutionTargetSchema.parse(execution)),
      403,
      '执行主机范围不匹配',
    );
    this.state.atomic(() => {
      const rows = this.db
        .prepare(
          "SELECT id,state FROM collaboration_execution WHERE scope=? AND json_extract(state,'$.phase') IN ('claimed','dispatching','accepted','running')",
        )
        .all(collaborationKey(scope));
      for (const row of rows) {
        const state = taskStateSchema.parse(JSON.parse(String(row.state)));
        if (['claimed', 'dispatching', 'accepted', 'running'].includes(state.phase))
          this.transition(scope, String(row.id), 'interrupted', {
            reason: '执行主机已重启，请核查原回合；不会自动重放',
          });
      }
    });
  }
}
