import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assert, id } from '@moor/protocol/protocol';
import {
  taskPlanSchema,
  taskAuthoritySchema,
  taskGrantViewSchema,
  taskOperationViewSchema,
  taskActionSchema,
  type TaskAction,
  type TaskOrigin,
  type TaskGrantView,
} from '@moor/protocol/task-protocol';
import type { AttachmentScope } from './store';

const scopeSchema = z
  .object({ workspaceId: id, userId: z.string(), machineId: id, localProjectId: id, sessionId: id })
  .strict();
const slotSchema = z
  .object({
    taskId: id,
    childSessionId: id,
    branch: z.string(),
    status: z.enum(['reserved', 'preparing', 'ready', 'running', 'terminal', 'unknown']),
    turnCount: z.number().int().nonnegative(),
    latestUserTurnId: id.optional(),
    latestAssistantTurnId: id.optional(),
    lastOperationId: id.optional(),
  })
  .strict();
const grantSchema = z
  .object({
    id,
    scope: scopeSchema,
    authority: taskAuthoritySchema,
    parentUserTurnId: id,
    parentAssistantTurnId: id,
    plan: taskPlanSchema,
    createdAt: z.number(),
    expiresAt: z.number(),
    status: z.enum(['active', 'expired', 'interrupted', 'canceled']),
  })
  .strict();
const requestSchema = z
  .object({
    grantId: id,
    taskId: id,
    operationId: id,
    action: z.enum(['create', 'send', 'cancel', 'cleanup']),
  })
  .passthrough();
const operationSchema = z
  .object({
    request: requestSchema,
    phase: z.enum(['pending', 'accepted', 'rejected', 'unknown', 'abandoned']),
    nested: z.object({}).passthrough(),
    reason: z.string().optional(),
    userTurnId: id.optional(),
    assistantTurnId: id.optional(),
    previousUserTurnId: id.optional(),
    previousAssistantTurnId: id.optional(),
  })
  .strict();
type Grant = z.infer<typeof grantSchema> & { slots: z.infer<typeof slotSchema>[] };
const key = (scope: AttachmentScope) =>
  JSON.stringify({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    machineId: scope.machineId,
    localProjectId: scope.localProjectId,
    sessionId: scope.sessionId,
  });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function json(raw: unknown) {
  assert(
    typeof raw === 'string' && Buffer.byteLength(raw) <= 2 * 1024 * 1024,
    409,
    '旧任务记录超过只读限制或不可验证',
  );
  return JSON.parse(raw);
}

/** No DDL, restart invalidation, execution permit or state transition. */
export class RetiredTaskRecords {
  constructor(private readonly db: DatabaseSync) {}
  private table(name: string) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }
  get(grantId: string): Grant | undefined {
    if (!this.table('task_grant')) return;
    const row = this.db
      .prepare('SELECT record,scope,parent_turn_id FROM task_grant WHERE id=?')
      .get(grantId);
    if (!row) return;
    const raw = json(row.record);
    const grant = grantSchema.parse(raw);
    // Historical fingerprints used JSON.stringify, so retain validated field order.
    grant.authority = raw.authority;
    assert(
      grant.id === grantId &&
        row.scope === key(grant.scope) &&
        row.parent_turn_id === grant.parentAssistantTurnId &&
        this.table('task_slot'),
      409,
      '旧任务授权身份不可验证',
    );
    const slots = this.db
      .prepare(
        'SELECT child_session_id,task_id,record FROM task_slot WHERE grant_id=? ORDER BY rowid LIMIT 9',
      )
      .all(grantId)
      .map((row) => {
        const slot = slotSchema.parse(json(row.record));
        assert(
          slot.childSessionId === row.child_session_id &&
            slot.taskId === row.task_id &&
            grant.plan.tasks.some((task) => task.taskId === slot.taskId),
          409,
          '旧任务槽位身份不可验证',
        );
        return slot;
      });
    assert(
      slots.length === grant.plan.tasks.length &&
        new Set(slots.map((slot) => slot.taskId)).size === slots.length,
      409,
      '旧任务槽位不完整',
    );
    return { ...grant, slots };
  }
  grant(scope: AttachmentScope, grantId: string) {
    const grant = this.get(grantId);
    assert(grant && key(grant.scope) === key(scope), 404, '旧任务授权不属于当前会话');
    return grant;
  }
  list(scope: AttachmentScope) {
    if (!this.table('task_grant')) return [];
    return this.db
      .prepare('SELECT id FROM task_grant WHERE scope=? ORDER BY rowid DESC LIMIT 21')
      .all(key(scope))
      .map((row) => this.grant(scope, id.parse(row.id)));
  }
  operations(grant: Grant) {
    if (!this.table('task_operation')) return [];
    return this.db
      .prepare(
        'SELECT id,task_id,fingerprint,record FROM task_operation WHERE grant_id=? ORDER BY rowid DESC LIMIT 129',
      )
      .all(grant.id)
      .map((row) => {
        const raw = json(row.record);
        const operation = operationSchema.parse(raw);
        assert(
          operation.request.operationId === row.id &&
            operation.request.grantId === grant.id &&
            operation.request.taskId === row.task_id &&
            grant.slots.some((slot) => slot.taskId === row.task_id) &&
            row.fingerprint === digest([key(grant.scope), grant.authority, raw.request]),
          409,
          '旧任务原操作身份不可验证',
        );
        return operation;
      });
  }
  operation(grant: Grant, operationId: string) {
    const all = this.operations(grant);
    assert(all.length <= 128, 409, '旧任务操作数量超过只读限制');
    const operation = all.find((value) => value.request.operationId === operationId);
    if (!operation && this.table('task_operation'))
      assert(
        !this.db.prepare('SELECT 1 FROM task_operation WHERE id=?').get(operationId),
        404,
        '原操作不属于此任务授权',
      );
    return operation;
  }
  hasRevocation(grant: Grant, request: TaskAction) {
    if (!this.table('task_revocation')) return false;
    const row = this.db
      .prepare('SELECT grant_id,fingerprint FROM task_revocation WHERE id=?')
      .get(request.operationId);
    if (!row) return false;
    const original = taskActionSchema.parse({ ...request, action: 'revoke' });
    assert(
      row.grant_id === grant.id &&
        row.fingerprint === digest([key(grant.scope), grant.authority, original]) &&
        grant.status !== 'active',
      409,
      '旧撤销原操作或授权状态不可验证',
    );
    return true;
  }
  origin(scope: AttachmentScope): TaskOrigin | undefined {
    if (!this.table('task_slot')) return;
    const row = this.db
      .prepare('SELECT grant_id,task_id FROM task_slot WHERE child_session_id=?')
      .get(scope.sessionId);
    if (!row) return;
    const grant = this.get(id.parse(row.grant_id));
    assert(
      grant && key({ ...scope, sessionId: grant.scope.sessionId }) === key(grant.scope),
      404,
      '旧子任务不属于当前项目',
    );
    const task = grant.plan.tasks.find((task) => task.taskId === row.task_id);
    assert(task, 409, '旧子任务来源不完整');
    return {
      version: 1,
      grantId: grant.id,
      taskId: task.taskId,
      parentSessionId: grant.scope.sessionId,
      parentUserTurnId: grant.parentUserTurnId,
      parentAssistantTurnId: grant.parentAssistantTurnId,
      completion: task.completion,
    };
  }
  allows(sessionId: string) {
    if (!this.table('task_slot')) return true;
    const row = this.db
      .prepare('SELECT grant_id FROM task_slot WHERE child_session_id=?')
      .get(sessionId);
    if (!row) return true;
    const grant = this.get(id.parse(row.grant_id));
    const slot = grant?.slots.find((slot) => slot.childSessionId === sessionId);
    assert(grant && slot, 409, '旧任务槽位不可验证，不能覆盖');
    if (['reserved', 'preparing', 'running', 'unknown'].includes(slot.status)) return false;
    const operations = this.operations(grant);
    assert(operations.length <= 128, 409, '旧任务操作数量超过只读限制');
    if (
      slot.lastOperationId &&
      !operations.some(
        (operation) =>
          operation.request.operationId === slot.lastOperationId &&
          operation.request.taskId === slot.taskId,
      )
    )
      return false;
    return !operations.some(
      (operation) =>
        operation.request.taskId === slot.taskId &&
        ['pending', 'unknown'].includes(operation.phase),
    );
  }
  view(grant: Grant, sessionExists: (sessionId: string) => boolean): TaskGrantView {
    const operations = this.operations(grant);
    assert(operations.length <= 128, 409, '旧任务操作数量超过只读限制');
    return taskGrantViewSchema.parse({
      grantId: grant.id,
      parentSessionId: grant.scope.sessionId,
      parentUserTurnId: grant.parentUserTurnId,
      parentAssistantTurnId: grant.parentAssistantTurnId,
      state: grant.status,
      createdAt: new Date(grant.createdAt).toISOString(),
      expiresAt: new Date(grant.expiresAt).toISOString(),
      plan: grant.plan,
      tasks: grant.slots.map((slot) => {
        const spec = grant.plan.tasks.find((task) => task.taskId === slot.taskId)!;
        return {
          taskId: slot.taskId,
          childSessionId: slot.childSessionId,
          sessionCreated: sessionExists(slot.childSessionId),
          title: spec.title,
          agentId: spec.agentId,
          completion: spec.completion,
          status: slot.status,
          turnsUsed: slot.turnCount,
          goalVerified: false,
          ...(slot.latestUserTurnId ? { userTurnId: slot.latestUserTurnId } : {}),
          ...(slot.latestAssistantTurnId ? { assistantTurnId: slot.latestAssistantTurnId } : {}),
          ...(slot.lastOperationId ? { lastOperationId: slot.lastOperationId } : {}),
        };
      }),
      operations: operations.map((operation) => this.operationView(operation)),
    });
  }
  operationView(operation: z.infer<typeof operationSchema>) {
    return taskOperationViewSchema.parse({
      operationId: operation.request.operationId,
      taskId: operation.request.taskId,
      kind: operation.request.action,
      state: operation.phase,
      ...(operation.userTurnId ? { userTurnId: operation.userTurnId } : {}),
      ...(operation.assistantTurnId ? { assistantTurnId: operation.assistantTurnId } : {}),
      ...(operation.reason ? { message: '历史任务记录保留，仅供核查。' } : {}),
    });
  }
}
