import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { AppError, assert, mutationSchema, type Mutation } from '../protocol';
import type { AttachmentScope } from './store';
import type { HostWorkspace } from '../bridge/host-workspace';
import { metas, mirror } from '../model';
import { buildSessionTurn, readClientSession } from '../session-client';
import { resolveRunSelection } from '../run-config';
import {
  taskPlanSchema,
  taskAuthoritySchema,
  taskToolInputSchemas,
  taskReadSchema,
  taskActionSchema,
  validateTaskReadResult,
  validateTaskActionResult,
  type TaskPlan,
  type TaskAuthority,
  type TaskOrigin,
  type TaskToolName,
  type TaskRead,
  type TaskAction,
  type TaskGrantView,
  type TaskOperationView,
} from '../task-protocol';
import { gitActionSchema, type GitAction } from '../git-protocol';
import { sessionControlActionSchema, type SessionControlAction } from '../session-control-protocol';

export type { TaskAuthority, TaskOrigin } from '../task-protocol';
export type TaskGrantStatus = 'active' | 'expired' | 'interrupted' | 'canceled';
export type TaskSlotStatus =
  | 'reserved'
  | 'preparing'
  | 'ready'
  | 'running'
  | 'terminal'
  | 'unknown';
export type TaskOperationStatus = 'pending' | 'accepted' | 'rejected' | 'unknown' | 'abandoned';
export type TaskSlot = {
  taskId: string;
  childSessionId: string;
  branch: string;
  status: TaskSlotStatus;
  turnCount: number;
  latestUserTurnId?: string;
  latestAssistantTurnId?: string;
  lastOperationId?: string;
};
export type TaskGrant = {
  id: string;
  scope: AttachmentScope;
  authority: TaskAuthority;
  parentUserTurnId: string;
  parentAssistantTurnId: string;
  plan: TaskPlan;
  createdAt: number;
  expiresAt: number;
  status: TaskGrantStatus;
  slots: TaskSlot[];
};
type TaskWrite = {
  grantId: string;
  taskId: string;
  operationId: string;
} & (
  | { action: 'create' }
  | { action: 'send'; expectedUserTurnId: string | null; prompt?: string }
  | { action: 'cancel'; expectedAssistantTurnId: string }
  | { action: 'cleanup'; expectedExecutionRevision: number }
);
type NestedRequests = { git?: GitAction; control?: SessionControlAction; mutation?: Mutation };
export type TaskOperation = {
  request: TaskWrite;
  phase: TaskOperationStatus;
  nested: NestedRequests;
  reason?: string;
  userTurnId?: string;
  assistantTurnId?: string;
  previousUserTurnId?: string;
  previousAssistantTurnId?: string;
};
const scopeOnly = (s: AttachmentScope): AttachmentScope => ({
  workspaceId: s.workspaceId,
  userId: s.userId,
  machineId: s.machineId,
  localProjectId: s.localProjectId,
  sessionId: s.sessionId,
});
const key = (scope: AttachmentScope) => JSON.stringify(scopeOnly(scope));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const derivedId = (kind: string, id: string) => 'task_' + kind + '_' + digest(id).slice(0, 40);
const uncertain = '任务操作尚未确认，请在界面手动核查原编号；不会重复执行。';
function directoryIdentity(path: string) {
  try {
    const canonical = realpathSync(path),
      stat = lstatSync(path, { bigint: true });
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 409, '父任务目录身份不可验证');
    return { path, canonical, dev: stat.dev.toString(), ino: stat.ino.toString() };
  } catch {
    throw new AppError(409, '父任务目录身份不可验证');
  }
}

/** Private authorization and intent records; constructors never dispatch work. */
export class TaskStore {
  private sequence = 0;
  readonly now: () => number;
  constructor(
    readonly db: DatabaseSync,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_grant(
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,parent_turn_id TEXT NOT NULL,record TEXT NOT NULL,
        UNIQUE(scope,parent_turn_id)
      );
      CREATE TABLE IF NOT EXISTS task_slot(
        child_session_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,task_id TEXT NOT NULL,record TEXT NOT NULL,
        UNIQUE(grant_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS task_operation(
        id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_revocation(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,grant_id TEXT NOT NULL);
    `);
    this.restartInvalidate();
  }
  transaction<T>(work: () => T): T {
    const name = 'task_store_' + ++this.sequence;
    this.db.exec('SAVEPOINT ' + name);
    try {
      const value = work();
      this.db.exec('RELEASE ' + name);
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK TO ' + name + '; RELEASE ' + name);
      throw error;
    }
  }
  restartInvalidate() {
    this.transaction(() => {
      this.db
        .exec(`UPDATE task_grant SET record=json_set(record,'$.status','interrupted') WHERE json_extract(record,'$.status')='active';
        UPDATE task_slot SET record=json_set(record,'$.status','unknown') WHERE json_extract(record,'$.status') IN ('preparing','running');
        UPDATE task_operation SET record=json_set(record,'$.phase','unknown') WHERE json_extract(record,'$.phase')='pending';`);
    });
  }
  prepareGrant(
    scope: AttachmentScope,
    parentUserTurnId: string,
    parentAssistantTurnId: string,
    input: TaskPlan,
    authority: TaskAuthority,
  ): TaskGrant {
    const plan = taskPlanSchema.parse(input),
      old = this.byParent(scope, parentAssistantTurnId);
    authority = taskAuthoritySchema.parse(authority);
    if (old) {
      assert(
        old.parentUserTurnId === parentUserTurnId &&
          isDeepStrictEqual(old.plan, plan) &&
          isDeepStrictEqual(old.authority, authority),
        409,
        '父回合已绑定不同任务授权',
      );
      return old;
    }
    assert(!this.origin(scope), 409, '子任务不能继续创建下一层任务');
    const now = this.now(),
      id = 'grant_' + randomUUID();
    const grant: TaskGrant = {
      id,
      scope: scopeOnly(scope),
      authority: structuredClone(authority),
      parentUserTurnId,
      parentAssistantTurnId,
      plan,
      createdAt: now,
      expiresAt: now + plan.timeoutMs,
      status: 'active',
      slots: plan.tasks.map((task) => ({
        taskId: task.taskId,
        childSessionId: 'task_session_' + randomUUID(),
        branch: 'moor/task-' + randomUUID(),
        status: 'reserved',
        turnCount: 0,
      })),
    };
    this.transaction(() => {
      const { slots, ...record } = grant;
      this.db
        .prepare('INSERT INTO task_grant VALUES(?,?,?,?)')
        .run(id, key(scope), parentAssistantTurnId, JSON.stringify(record));
      for (const slot of slots)
        this.db
          .prepare('INSERT INTO task_slot VALUES(?,?,?,?)')
          .run(slot.childSessionId, id, slot.taskId, JSON.stringify(slot));
    });
    return structuredClone(grant);
  }
  get(id: string): TaskGrant | undefined {
    const row = this.db.prepare('SELECT record FROM task_grant WHERE id=?').get(id);
    if (!row) return;
    const grant = JSON.parse(String(row.record)) as Omit<TaskGrant, 'slots'>;
    return {
      ...grant,
      slots: this.db
        .prepare('SELECT record FROM task_slot WHERE grant_id=? ORDER BY rowid')
        .all(id)
        .map((row) => JSON.parse(String(row.record)) as TaskSlot),
    };
  }
  grant(scope: AttachmentScope, id: string): TaskGrant {
    const grant = this.get(id);
    assert(grant && key(grant.scope) === key(scope), 404, '任务授权不属于当前会话范围');
    return grant;
  }
  byParent(scope: AttachmentScope, assistantTurnId: string) {
    const row = this.db
      .prepare('SELECT id FROM task_grant WHERE scope=? AND parent_turn_id=?')
      .get(key(scope), assistantTurnId);
    return row ? this.get(String(row.id)) : undefined;
  }
  list(scope: AttachmentScope) {
    return this.db
      .prepare('SELECT id FROM task_grant WHERE scope=? ORDER BY rowid DESC LIMIT 100')
      .all(key(scope))
      .map((row) => this.get(String(row.id))!);
  }
  origin(scope: AttachmentScope): TaskOrigin | undefined {
    const row = this.db
      .prepare('SELECT grant_id,task_id FROM task_slot WHERE child_session_id=?')
      .get(scope.sessionId);
    if (!row) return;
    const grant = this.get(String(row.grant_id))!;
    assert(
      key({ ...scope, sessionId: grant.scope.sessionId }) === key(grant.scope),
      404,
      '子任务会话不属于当前项目范围',
    );
    return {
      version: 1,
      grantId: grant.id,
      taskId: String(row.task_id),
      parentSessionId: grant.scope.sessionId,
      parentUserTurnId: grant.parentUserTurnId,
      parentAssistantTurnId: grant.parentAssistantTurnId,
      completion: grant.plan.tasks.find((task) => task.taskId === row.task_id)!.completion,
    };
  }
  invalidate(id: string, status: Exclude<TaskGrantStatus, 'active'>) {
    const grant = this.get(id);
    if (!grant || grant.status !== 'active') return;
    this.db
      .prepare("UPDATE task_grant SET record=json_set(record,'$.status',?) WHERE id=?")
      .run(status, id);
  }
  revoke(grant: TaskGrant, request: TaskAction) {
    const fingerprint = digest([key(grant.scope), grant.authority, request]);
    const previous = this.db
      .prepare('SELECT fingerprint FROM task_revocation WHERE id=?')
      .get(request.operationId);
    assert(!previous || previous.fingerprint === fingerprint, 409, '撤销编号对应不同任务授权');
    assert(
      !this.db.prepare('SELECT 1 FROM task_operation WHERE id=?').get(request.operationId),
      409,
      '撤销编号已被任务操作使用',
    );
    this.transaction(() => {
      if (!previous)
        this.db
          .prepare('INSERT INTO task_revocation VALUES(?,?,?)')
          .run(request.operationId, fingerprint, grant.id);
      this.invalidate(grant.id, 'canceled');
    });
  }
  slot(grant: TaskGrant, taskId: string) {
    const slot = grant.slots.find((item) => item.taskId === taskId);
    assert(slot, 404, '任务编号不在父回合明确授权的计划内');
    return slot;
  }
  putSlot(grantId: string, slot: TaskSlot) {
    const updated = this.db
      .prepare(
        'UPDATE task_slot SET record=? WHERE grant_id=? AND task_id=? AND child_session_id=?',
      )
      .run(JSON.stringify(slot), grantId, slot.taskId, slot.childSessionId);
    assert(updated.changes === 1, 409, '任务槽位已改变');
  }
  operation(grant: TaskGrant, request: TaskWrite): TaskOperation | undefined {
    const row = this.db.prepare('SELECT * FROM task_operation WHERE id=?').get(request.operationId);
    if (!row) return;
    assert(
      row.grant_id === grant.id &&
        row.task_id === request.taskId &&
        row.fingerprint === digest([key(grant.scope), grant.authority, request]),
      409,
      '重复编号对应不同任务请求',
    );
    return JSON.parse(String(row.record)) as TaskOperation;
  }
  operationById(grant: TaskGrant, operationId: string): TaskOperation | undefined {
    const row = this.db
      .prepare('SELECT record,grant_id FROM task_operation WHERE id=?')
      .get(operationId);
    if (!row) return;
    assert(row.grant_id === grant.id, 404, '操作不属于此任务授权');
    const operation = JSON.parse(String(row.record)) as TaskOperation;
    return this.operation(grant, operation.request);
  }
  operations(grant: TaskGrant) {
    return this.db
      .prepare('SELECT record FROM task_operation WHERE grant_id=? ORDER BY rowid DESC LIMIT 128')
      .all(grant.id)
      .map((row) => JSON.parse(String(row.record)) as TaskOperation);
  }
  stage(grant: TaskGrant, request: TaskWrite) {
    assert(!this.operation(grant, request), 409, '任务操作编号已使用');
    assert(this.operations(grant).length < 128, 409, '此任务授权已达到操作记录上限');
    assert(
      !this.db.prepare('SELECT 1 FROM task_revocation WHERE id=?').get(request.operationId),
      409,
      '任务编号已被撤销操作使用',
    );
    const operation: TaskOperation = {
      request: structuredClone(request),
      phase: 'pending',
      nested: {},
    };
    this.db
      .prepare('INSERT INTO task_operation VALUES(?,?,?,?,?)')
      .run(
        request.operationId,
        grant.id,
        request.taskId,
        digest([key(grant.scope), grant.authority, request]),
        JSON.stringify(operation),
      );
    return operation;
  }
  saveOperation(grant: TaskGrant, operation: TaskOperation) {
    assert(this.operation(grant, operation.request), 409, '任务操作没有原始记录');
    this.db
      .prepare('UPDATE task_operation SET record=? WHERE id=?')
      .run(JSON.stringify(operation), operation.request.operationId);
  }
  blocked(scope: AttachmentScope) {
    const origin = this.origin(scope);
    if (!origin) return false;
    const grant = this.get(origin.grantId)!,
      slot = this.slot(grant, origin.taskId);
    const op = slot.lastOperationId ? this.operationById(grant, slot.lastOperationId) : undefined;
    return (
      slot.status === 'reserved' ||
      slot.status === 'preparing' ||
      slot.status === 'unknown' ||
      op?.phase === 'unknown' ||
      op?.phase === 'pending'
    );
  }
}

type LiveGrant = { current(): TaskGrant; timer?: unknown };
export type TaskTools = {
  grantId: string;
  current(): void;
  assertCurrent(): void;
  promptContext: string;
  call(name: TaskToolName, args: unknown): Promise<unknown>;
};
export type SessionTaskOptions = {
  now?: () => number;
  schedule?: (callback: () => void, milliseconds: number) => unknown;
  cancelTimer?: (timer: unknown) => void;
};
/** Host-owned orchestration; every effect is preceded by a durable exact intent. */
export class SessionTaskManager {
  private closed = false;
  private live = new Map<string, LiveGrant>();
  private permits = new Map<
    string,
    { operationId: string; kind: 'git' | 'create' | 'mutation'; current(): void }
  >();
  private locks = new Map<string, Promise<unknown>>();
  private ending = new Map<string, Promise<void>>();
  private now: () => number;
  private schedule: NonNullable<SessionTaskOptions['schedule']>;
  private cancelTimer: NonNullable<SessionTaskOptions['cancelTimer']>;
  constructor(
    private host: HostWorkspace,
    options: SessionTaskOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        timer.unref();
        return timer;
      });
    this.cancelTimer =
      options.cancelTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }
  private get store() {
    return this.host.store.tasks;
  }
  private childScope(grant: TaskGrant, slot: TaskSlot): AttachmentScope {
    return { ...grant.scope, sessionId: slot.childSessionId };
  }
  validatePlan(scope: AttachmentScope, input: TaskPlan, authority: TaskAuthority) {
    const plan = taskPlanSchema.parse(input);
    taskAuthoritySchema.parse(authority);
    this.host.ensureConnected();
    assert(!this.store.origin(scope), 409, '子任务不能继续创建下一层任务');
    this.host.executionLease(scope, scope.localProjectId, true);
    assert(
      scope.userId === this.host.workspace.userId &&
        scope.machineId === this.host.workspace.machineId,
      403,
      '任务授权属于其他用户或执行电脑',
    );
    for (const task of plan.tasks) {
      const agent = this.host.workspace.agents.find((agent) => agent.id === task.agentId);
      assert(
        agent && this.host.store.agents.get(agent.id)?.machineId === scope.machineId,
        409,
        '任务选择的 Agent 版本不再可用于新会话',
      );
      try {
        resolveRunSelection(task.selection ?? {}, agent.runConfig);
      } catch {
        throw new AppError(409, '任务选择的模型或审批模式不可用');
      }
    }
    return plan;
  }
  activate(
    grantId: string,
    alive: () => void,
    options: { canDispatch?: () => void } = {},
  ): TaskTools {
    const grant = this.store.get(grantId);
    assert(
      grant && grant.status === 'active' && grant.expiresAt > this.now(),
      409,
      '任务授权已结束或过期',
    );
    assert(!this.live.has(grantId), 409, '任务授权已绑定执行回合');
    const lease = this.host.executionLease(grant.scope, grant.scope.localProjectId);
    const directories = [...new Set([lease.rootPath, lease.projectRoot])].map(directoryIdentity);
    const entry: LiveGrant = {
      current: () => {
        assert(this.live.get(grantId) === entry, 409, '任务工具已撤销');
        const current = this.store.grant(grant.scope, grantId);
        assert(
          current.status === 'active' && current.expiresAt > this.now(),
          409,
          '任务授权已结束或过期',
        );
        alive();
        this.host.ensureConnected();
        assert(
          isDeepStrictEqual(
            lease,
            this.host.executionLease(grant.scope, grant.scope.localProjectId),
          ),
          409,
          '父任务执行范围已变化',
        );
        assert(
          directories.every((identity) =>
            isDeepStrictEqual(identity, directoryIdentity(identity.path)),
          ),
          409,
          '父任务目录身份已变化',
        );
        return current;
      },
    };
    this.live.set(grantId, entry);
    entry.timer = this.schedule(() => {
      void this.end(grantId, 'expired').catch(() => {});
    }, grant.expiresAt - this.now());
    const current = () => {
      try {
        entry.current();
      } catch (error) {
        void this.end(grantId, this.now() >= grant.expiresAt ? 'expired' : 'canceled').catch(
          () => {},
        );
        throw error;
      }
    };
    return {
      grantId,
      current,
      assertCurrent: current,
      promptContext:
        'Moor 用户已明确授权以下单层子任务。只能使用这些槽位；先 create 再 send，第一次 send 使用固定说明。未知操作必须让用户核查原编号，不得换编号绕过。终态不等于完成条件已验收。\n' +
        JSON.stringify({
          grantId,
          plan: grant.plan,
          tasks: grant.slots.map((slot) => ({
            taskId: slot.taskId,
            childSessionId: slot.childSessionId,
          })),
        }),
      call: async (name, args) => {
        try {
          current();
          options.canDispatch?.();
          const input = taskToolInputSchemas[name].parse(args);
          assert(input.grantId === grantId, 403, '工具只能操作当前父回合授权');
          if (name === 'moor_task_read') return await this.readChild(input as never);
          if (name === 'moor_task_wait') return await this.waitChild(input as never);
          const action =
            name === 'moor_task_create' ? 'create' : name === 'moor_task_send' ? 'send' : 'cancel';
          return await this.write({ ...input, action } as TaskWrite);
        } catch (error) {
          try {
            current();
          } catch {
            await this.end(grantId, this.now() >= grant.expiresAt ? 'expired' : 'canceled');
          }
          throw error instanceof AppError
            ? error
            : new AppError(409, '任务操作未完成，请读取任务状态');
        }
      },
    };
  }
  private current(id: string) {
    const live = this.live.get(id);
    assert(live, 409, '任务工具已撤销');
    return live.current();
  }
  private allows(sessionId: string, operationId: string, kind: 'git' | 'create' | 'mutation') {
    const permit = this.permits.get(sessionId);
    if (permit?.operationId === operationId && permit.kind === kind) {
      try {
        permit.current();
        return true;
      } catch {
        return false;
      }
    }
    const row = this.host.store.journal.db
      .prepare('SELECT grant_id FROM task_slot WHERE child_session_id=?')
      .get(sessionId);
    if (!row) return true;
    const grant = this.store.get(String(row.grant_id))!;
    return !this.store.blocked({ ...grant.scope, sessionId });
  }
  allowsMutation(sessionId: string, operationId: string) {
    return this.allows(sessionId, operationId, 'mutation');
  }
  allowsCreate(sessionId: string, operationId: string) {
    return this.allows(sessionId, operationId, 'create');
  }
  allowsGit(sessionId: string, operationId: string) {
    return this.allows(sessionId, operationId, 'git');
  }
  private async permit<T>(
    scope: AttachmentScope,
    operationId: string,
    kind: 'git' | 'create' | 'mutation',
    current: () => void,
    work: () => Promise<T>,
  ) {
    assert(!this.permits.has(scope.sessionId), 409, '子任务正在处理另一操作');
    const permit = { operationId, kind, current };
    this.permits.set(scope.sessionId, permit);
    try {
      current();
      return await work();
    } finally {
      if (this.permits.get(scope.sessionId) === permit) this.permits.delete(scope.sessionId);
    }
  }
  private async serial<T>(id: string, work: () => Promise<T>) {
    const promise = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.locks.get(id) === promise) this.locks.delete(id);
    }
  }
  private synchronize(grant: TaskGrant, slot: TaskSlot) {
    if (!slot.latestUserTurnId) return slot;
    const scope = this.childScope(grant, slot);
    this.host.attachmentScope(scope, scope.localProjectId);
    const active = this.host.active.get(slot.childSessionId),
      doc =
        active?.doc ??
        this.host.settlementFailures.get(slot.childSessionId) ??
        this.host.store.doc(slot.childSessionId),
      view = mirror(doc, slot.childSessionId);
    try {
      const turn = view
        .getState()
        .history.find(
          (turn) => turn.role === 'assistant' && turn.userTurnId === slot.latestUserTurnId,
        );
      if (turn) {
        slot.latestAssistantTurnId = turn.id;
        if (slot.status === 'running' && turn.finished) slot.status = 'terminal';
        this.store.putSlot(grant.id, slot);
      }
    } finally {
      view.dispose();
      if (!active && !this.host.settlementFailures.has(slot.childSessionId)) doc.free();
    }
    return slot;
  }
  private checkParallel(grant: TaskGrant, except: string) {
    const running = grant.slots.filter((slot) => {
      if (slot.taskId === except) return false;
      const active = this.host.active.get(slot.childSessionId);
      const ownActive = !!slot.latestUserTurnId && active?.userTurnId === slot.latestUserTurnId;
      const ownUnsaved =
        !!slot.latestUserTurnId &&
        this.host.settlementFailures.has(slot.childSessionId) &&
        metas(this.host.meta)['session-' + slot.childSessionId]?.latestUserMsgId ===
          slot.latestUserTurnId;
      return (
        ownActive ||
        ownUnsaved ||
        ['preparing', 'running', 'unknown'].includes(this.synchronize(grant, slot).status)
      );
    }).length;
    assert(running < grant.plan.maxParallel, 409, '已达到此授权的并行任务上限');
  }
  private operationView(operation: TaskOperation, slot?: TaskSlot): TaskOperationView {
    return {
      operationId: operation.request.operationId,
      taskId: operation.request.taskId,
      kind: operation.request.action,
      state: operation.phase,
      ...(operation.userTurnId ? { userTurnId: operation.userTurnId } : {}),
      ...(operation.assistantTurnId ? { assistantTurnId: operation.assistantTurnId } : {}),
      ...(operation.reason ? { message: operation.reason } : {}),
    };
  }
  private async write(request: TaskWrite) {
    return this.serial(request.grantId + '/' + request.taskId, async () => {
      const grant = this.current(request.grantId),
        slot = this.synchronize(grant, this.store.slot(grant, request.taskId)),
        previous = this.store.operation(grant, request);
      if (previous) return this.operationView(previous, slot);
      const old = slot.lastOperationId
        ? this.store.operationById(grant, slot.lastOperationId)
        : undefined;
      assert(!old || !['pending', 'unknown'].includes(old.phase), 409, uncertain);
      const spec = grant.plan.tasks.find((task) => task.taskId === slot.taskId)!,
        scope = this.childScope(grant, slot);
      if (request.action === 'create') {
        assert(slot.status === 'reserved', 409, '该子任务槽位已创建或需要核查');
        this.checkParallel(grant, slot.taskId);
      } else {
        assert(
          ['ready', 'running', 'terminal'].includes(slot.status),
          409,
          '请先确认子任务会话创建',
        );
        this.host.checkProject(scope.sessionId, scope.localProjectId);
      }
      if (request.action === 'send') {
        assert(
          !this.host.active.has(scope.sessionId) &&
            !this.host.settlementFailures.has(scope.sessionId),
          409,
          '请等待子任务当前回合完整保存',
        );
        assert(slot.turnCount < grant.plan.maxTurnsPerTask, 409, '已用完此子任务的授权回合预算');
        assert(
          (metas(this.host.meta)['session-' + scope.sessionId]?.latestUserMsgId ?? null) ===
            request.expectedUserTurnId &&
            (slot.latestUserTurnId ?? null) === request.expectedUserTurnId,
          409,
          '子任务历史已变化，不能追加到其他用户回合',
        );
        assert(!slot.latestUserTurnId || !!request.prompt, 400, '后续任务回合需要明确的有限指令');
        this.checkParallel(grant, slot.taskId);
      }
      if (request.action === 'cancel') {
        const active = this.host.active.get(scope.sessionId);
        assert(
          active &&
            !active.stopped &&
            active.turnId === request.expectedAssistantTurnId &&
            active.userTurnId === slot.latestUserTurnId &&
            active.turnId === slot.latestAssistantTurnId,
          409,
          '只能取消本授权发出的精确活动回合',
        );
      }
      const operation = this.store.transaction(() => {
        this.current(grant.id);
        const operation = this.store.stage(grant, request);
        slot.lastOperationId = request.operationId;
        if (request.action === 'create') slot.status = 'preparing';
        if (request.action === 'send') {
          operation.previousUserTurnId = slot.latestUserTurnId;
          operation.previousAssistantTurnId = slot.latestAssistantTurnId;
          this.store.saveOperation(grant, operation);
          slot.status = 'running';
        }
        this.store.putSlot(grant.id, slot);
        return operation;
      });
      const current = () => {
        this.current(grant.id);
        this.host.attachmentScope(scope, scope.localProjectId);
      };
      try {
        if (request.action === 'create') {
          operation.nested.git = {
            gitVersion: 1,
            workspaceId: scope.workspaceId,
            localProjectId: scope.localProjectId,
            sessionId: scope.sessionId,
            operationId: derivedId('git', request.operationId),
            action: 'prepare',
            expectedRevision: 0,
            baseBranch: spec.baseBranch,
            expectedOid: spec.expectedOid,
            newBranch: slot.branch,
          };
          this.store.saveOperation(grant, operation);
          const git = await this.permit(
            scope,
            operation.nested.git.operationId,
            'git',
            current,
            () => this.host.executionManager.action(operation.nested.git!, scope.localProjectId),
          );
          current();
          assert(git.phase === 'accepted', 409, '子任务目录尚未确认');
          operation.nested.control = {
            ...scope,
            controlVersion: 1,
            operationId: derivedId('create', request.operationId),
            action: 'create',
            agentId: spec.agentId,
            title: spec.title,
          };
          this.store.saveOperation(grant, operation);
          const created = await this.permit(
            scope,
            operation.nested.control.operationId,
            'create',
            current,
            () => this.host.controlManager.control(operation.nested.control!, scope.localProjectId),
          );
          current();
          assert(created.status === 'accepted', 409, '子任务创建尚未确认');
          slot.status = 'ready';
        } else if (request.action === 'send') {
          const raw = await this.host.read(scope.sessionId, undefined, scope.localProjectId);
          current();
          assert(raw.agent?.id === spec.agentId, 409, '子任务固定 Agent 已变化');
          const userTurnId = derivedId('user', request.operationId);
          operation.userTurnId = userTurnId;
          operation.nested.mutation = buildSessionTurn({
            scope,
            read: raw,
            agent: raw.agent,
            prompt: !slot.latestUserTurnId ? spec.instruction : request.prompt!,
            selection: spec.selection,
            operationId: derivedId('send', request.operationId),
            turnId: userTurnId,
            peerId: digest(['peer', request.operationId]).slice(0, 16),
            now: new Date(this.now()).toISOString(),
          });
          assert(
            operation.nested.mutation.expectedTurnId === request.expectedUserTurnId,
            409,
            '子任务历史已变化',
          );
          this.store.transaction(() => {
            current();
            slot.latestUserTurnId = userTurnId;
            slot.latestAssistantTurnId = undefined;
            slot.turnCount++;
            this.store.saveOperation(grant, operation);
            this.store.putSlot(grant.id, slot);
          });
          await this.permit(scope, operation.nested.mutation.operationId, 'mutation', current, () =>
            this.host.mutate(operation.nested.mutation!, scope.localProjectId),
          );
          // Persist acceptance even if authority ended during the await; exact
          // cleanup below must still know which child turn this grant started.
          this.synchronize(grant, slot);
          operation.assistantTurnId = slot.latestAssistantTurnId;
        } else if (request.action === 'cancel') {
          operation.userTurnId = slot.latestUserTurnId;
          operation.assistantTurnId = request.expectedAssistantTurnId;
          operation.nested.control = {
            ...scope,
            controlVersion: 1,
            operationId: derivedId('cancel', request.operationId),
            action: 'stop',
            turnId: request.expectedAssistantTurnId,
          };
          this.store.saveOperation(grant, operation);
          const stopped = await this.host.controlManager.control(
            operation.nested.control,
            scope.localProjectId,
          );
          assert(
            stopped.status === 'accepted' || stopped.status === 'interrupted',
            409,
            '子任务停止结果尚未确认',
          );
          this.synchronize(grant, slot);
        }
        operation.phase = 'accepted';
        this.store.transaction(() => {
          this.store.saveOperation(grant, operation);
          this.store.putSlot(grant.id, slot);
        });
      } catch {
        if (this.closed) throw new AppError(409, '任务执行服务已关闭，原操作需手动核查');
        operation.phase = 'unknown';
        operation.reason = uncertain;
        slot.status = 'unknown';
        this.store.transaction(() => {
          this.store.saveOperation(grant, operation);
          this.store.putSlot(grant.id, slot);
        });
      }
      try {
        current();
      } catch {
        await this.end(grant.id, this.now() >= grant.expiresAt ? 'expired' : 'canceled');
      }
      return this.operationView(operation, slot);
    });
  }
  private async readChild(input: {
    grantId: string;
    taskId: string;
    offset?: number;
    limit?: number;
  }) {
    const grant = this.current(input.grantId),
      slot = this.synchronize(grant, this.store.slot(grant, input.taskId)),
      scope = this.childScope(grant, slot);
    if (slot.status === 'reserved' || !metas(this.host.meta)['session-' + slot.childSessionId])
      return {
        taskId: slot.taskId,
        childSessionId: slot.childSessionId,
        status: slot.status,
        history: [],
        total: 0,
        goalVerified: false,
      };
    const read = readClientSession(
      await this.host.read(slot.childSessionId, undefined, scope.localProjectId),
      scope,
    );
    this.current(grant.id);
    const offset = input.offset ?? 0,
      limit = input.limit ?? 10;
    assert(offset <= read.history.length, 409, '子任务历史分页已变化');
    let bodyTruncated = false;
    const candidates = read.history.slice(offset, offset + limit).map((turn) => {
      let text = '';
      for (const raw of turn.items ?? []) {
        const item =
          raw && typeof raw === 'object'
            ? (raw as { text?: unknown; type?: unknown; message?: unknown })
            : {};
        const value =
          typeof item.text === 'string'
            ? item.text
            : item.type === 'system_notice' && typeof item.message === 'string'
              ? item.message
              : '';
        if (!value) continue;
        const remaining = 16000 - text.length;
        if (!remaining) {
          bodyTruncated = true;
          continue;
        }
        if (value.length + (text ? 1 : 0) > remaining) bodyTruncated = true;
        text += (text ? '\n' : '') + value.slice(0, Math.max(0, remaining - (text ? 1 : 0)));
      }
      return {
        id: turn.id,
        role: turn.role,
        status: turn.status,
        finished: turn.finished,
        text,
      };
    });
    const history: typeof candidates = [];
    const result = {
      taskId: slot.taskId,
      childSessionId: slot.childSessionId,
      status: slot.status,
      history,
      offset,
      total: read.history.length,
      truncated: true,
      goalVerified: false,
    };
    for (const candidate of candidates) {
      // MCP embeds this JSON as a text block, so account for the second layer
      // of JSON escaping rather than relying only on UTF-8 text length.
      if (
        Buffer.byteLength(
          JSON.stringify(JSON.stringify({ ...result, history: [...history, candidate] })),
        ) >
        1024 * 1024 - 2048
      )
        break;
      history.push(candidate);
    }
    result.truncated = bodyTruncated || offset + history.length < read.history.length;
    return result;
  }
  private async waitChild(input: {
    grantId: string;
    taskId: string;
    expectedUserTurnId: string;
    timeoutMs: number;
  }) {
    const grant = this.current(input.grantId),
      slot = this.synchronize(grant, this.store.slot(grant, input.taskId));
    assert(slot.latestUserTurnId === input.expectedUserTurnId, 409, '等待目标不是本授权发出的回合');
    const run = this.host.active.get(slot.childSessionId);
    if (run?.userTurnId === input.expectedUserTurnId && !run.stopped) {
      let timer: unknown;
      try {
        await Promise.race([
          run.done,
          new Promise<void>((resolve) => {
            timer = this.schedule(resolve, input.timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) this.cancelTimer(timer);
      }
    }
    this.current(grant.id);
    return this.readChild({ grantId: grant.id, taskId: slot.taskId });
  }
  private projection(grant: TaskGrant): TaskGrantView {
    const operations = this.store.operations(grant);
    const tasks = grant.slots.map((slot) => {
      this.synchronize(grant, slot);
      let terminal: 'success' | 'failed' | 'canceled' | 'interrupted' | undefined;
      if (slot.status === 'terminal' && slot.latestAssistantTurnId) {
        const doc =
            this.host.active.get(slot.childSessionId)?.doc ??
            this.host.store.doc(slot.childSessionId),
          view = mirror(doc, slot.childSessionId);
        try {
          const turn = view
            .getState()
            .history.find((turn) => turn.id === slot.latestAssistantTurnId);
          terminal =
            turn?.status === 'handled'
              ? 'success'
              : turn?.status === 'canceled'
                ? 'canceled'
                : turn?.status === 'failed'
                  ? 'failed'
                  : 'interrupted';
        } finally {
          view.dispose();
        }
      }
      const spec = grant.plan.tasks.find((task) => task.taskId === slot.taskId)!;
      const metadata = metas(this.host.meta)['session-' + slot.childSessionId];
      return {
        taskId: slot.taskId,
        childSessionId: slot.childSessionId,
        title: spec.title,
        agentId: spec.agentId,
        completion: spec.completion,
        status: slot.status,
        turnsUsed: slot.turnCount,
        goalVerified: false as const,
        sessionCreated:
          metadata?.id === slot.childSessionId &&
          metadata.userId === grant.scope.userId &&
          metadata.machineId === grant.scope.machineId &&
          (metadata.project as { localProjectId?: string } | undefined)?.localProjectId ===
            grant.scope.localProjectId &&
          this.host.store.attachmentScopeMatches(this.childScope(grant, slot)),
        ...(slot.latestUserTurnId ? { userTurnId: slot.latestUserTurnId } : {}),
        ...(slot.latestAssistantTurnId ? { assistantTurnId: slot.latestAssistantTurnId } : {}),
        ...(slot.lastOperationId ? { lastOperationId: slot.lastOperationId } : {}),
        execution: this.host.store.executions.info(this.childScope(grant, slot)),
        ...(terminal ? { terminal } : {}),
      };
    });
    return {
      grantId: grant.id,
      parentSessionId: grant.scope.sessionId,
      parentUserTurnId: grant.parentUserTurnId,
      parentAssistantTurnId: grant.parentAssistantTurnId,
      state: grant.status,
      createdAt: new Date(grant.createdAt).toISOString(),
      expiresAt: new Date(grant.expiresAt).toISOString(),
      plan: grant.plan,
      tasks,
      operations: operations.map((op) =>
        this.operationView(
          op,
          grant.slots.find((slot) => slot.taskId === op.request.taskId),
        ),
      ),
    };
  }
  private readScope(input: TaskRead | TaskAction) {
    this.host.ensureConnected();
    this.host.checkProject(input.sessionId, input.localProjectId);
    return this.host.attachmentScope(input, input.localProjectId);
  }
  read(input: TaskRead, project?: string) {
    const request = taskReadSchema.parse(input);
    assert(!project || request.localProjectId === project, 403, '任务读取项目不匹配');
    const scope = this.readScope(request),
      grants = request.grantId
        ? [this.store.grant(scope, request.grantId)]
        : this.store.list(scope);
    const projected: TaskGrantView[] = [];
    for (const grant of grants.slice(0, 20)) {
      const next = this.projection(grant);
      if (
        Buffer.byteLength(
          JSON.stringify({
            ...request,
            confirmed: true,
            grants: [...projected, next],
            truncated: true,
          }),
        ) >
        1024 * 1024 - 1024
      )
        break;
      projected.push(next);
    }
    return validateTaskReadResult(
      {
        ...request,
        confirmed: true,
        grants: projected,
        truncated: projected.length < grants.length,
      },
      request,
    );
  }
  private knownJournal(grant: TaskGrant, operation: TaskOperation, kind: keyof NestedRequests) {
    const saved = operation.nested[kind];
    if (!saved) return undefined;
    const request =
      kind === 'git'
        ? gitActionSchema.parse(saved)
        : kind === 'control'
          ? sessionControlActionSchema.parse(saved)
          : mutationSchema.parse(saved);
    const scope = this.childScope(grant, this.store.slot(grant, operation.request.taskId));
    const journalScope =
      kind === 'git'
        ? JSON.stringify([
            scope.workspaceId,
            scope.userId,
            scope.machineId,
            scope.localProjectId,
            scope.sessionId,
          ])
        : scope.workspaceId;
    return this.host.store.journal.lookup(journalScope, request);
  }
  private async inspect(grant: TaskGrant, operation: TaskOperation, current: () => void) {
    if (['accepted', 'rejected', 'abandoned'].includes(operation.phase)) return operation;
    const slot = this.store.slot(grant, operation.request.taskId),
      scope = this.childScope(grant, slot);
    const git = this.knownJournal(grant, operation, 'git');
    if (git && ['git-staged', 'git-unknown'].includes(git.phase)) {
      // Existing Git intent recovery only inspects its frozen target. A missing
      // journal is never passed here, so manual inspection cannot create it.
      await this.permit(scope, operation.nested.git!.operationId, 'git', current, () =>
        this.host.executionManager.action(operation.nested.git!, scope.localProjectId),
      );
      current();
    }
    const originalControl = this.knownJournal(grant, operation, 'control');
    if (originalControl?.phase === 'control-stopping') {
      await this.host.controlManager.recover(
        {
          ...scope,
          controlVersion: 1,
          action: 'inspect',
          request: { kind: 'control', value: operation.nested.control! },
        },
        scope.localProjectId,
      );
      current();
    }
    const gitAfter = this.knownJournal(grant, operation, 'git'),
      control = this.knownJournal(grant, operation, 'control'),
      mutation = this.knownJournal(grant, operation, 'mutation');
    if (
      operation.request.action === 'create' &&
      gitAfter?.phase === 'git-accepted' &&
      control?.phase === 'control-accepted'
    ) {
      operation.phase = 'accepted';
      slot.status = 'ready';
    } else if (operation.request.action === 'cleanup' && gitAfter?.phase === 'git-accepted') {
      operation.phase = 'accepted';
      slot.status = 'terminal';
    } else if (operation.request.action === 'send' && mutation?.phase === 'accepted') {
      operation.phase = 'accepted';
      slot.status = 'running';
      this.synchronize(grant, slot);
      operation.assistantTurnId = slot.latestAssistantTurnId;
    } else if (
      operation.request.action === 'cancel' &&
      control &&
      ['control-accepted', 'control-interrupted'].includes(control.phase)
    ) {
      operation.phase = 'accepted';
      slot.status = 'running';
      this.synchronize(grant, slot);
    } else if (gitAfter?.phase === 'git-rejected') {
      operation.phase = 'rejected';
      slot.status =
        operation.request.action === 'cleanup' &&
        metas(this.host.meta)['session-' + slot.childSessionId]
          ? 'ready'
          : 'reserved';
    } else {
      operation.phase = 'unknown';
      slot.status = 'unknown';
      operation.reason = uncertain;
    }
    if (operation.phase !== 'unknown') delete operation.reason;
    this.store.transaction(() => {
      current();
      this.store.saveOperation(grant, operation);
      this.store.putSlot(grant.id, slot);
    });
    return operation;
  }
  async action(input: TaskAction, project?: string) {
    const request = taskActionSchema.parse(input);
    assert(!project || project === request.localProjectId, 403, '任务操作项目不匹配');
    const scope = this.readScope(request),
      grant = this.store.grant(scope, request.grantId);
    const current = () => {
      assert(key(this.readScope(request)) === key(scope), 409, '任务恢复范围已变化');
    };
    if (request.action === 'revoke') {
      this.store.revoke(grant, request);
      await this.end(grant.id, 'canceled');
      current();
      return validateTaskActionResult(
        { ...request, confirmed: true, grant: this.projection(this.store.grant(scope, grant.id)) },
        request,
      );
    }
    const operation = this.store.operationById(grant, request.operationId);
    if (request.action === 'cleanup') return this.cleanup(request, grant, current);
    assert(operation, 404, '任务操作编号不存在');
    assert(
      !this.locks.has(grant.id + '/' + operation.request.taskId),
      409,
      '原任务操作仍在收尾，请稍后核查',
    );
    return this.serial(grant.id + '/' + operation.request.taskId, async () => {
      current();
      const recovered = await this.inspect(grant, operation, current);
      if (request.action === 'abandon' && recovered.phase === 'unknown') {
        const slot = this.store.slot(grant, recovered.request.taskId),
          child = this.childScope(grant, slot);
        const git = this.knownJournal(grant, recovered, 'git');
        assert(
          !git || ['git-accepted', 'git-rejected'].includes(git.phase),
          409,
          '工作目录仍未确认，不能封存后绕过',
        );
        const control = this.knownJournal(grant, recovered, 'control'),
          mutation = this.knownJournal(grant, recovered, 'mutation');
        assert(!control || control.phase === 'operation-abandoned', 409, '原会话操作仍需确认');
        assert(!mutation || mutation.phase === 'operation-abandoned', 409, '原发送操作仍需确认');
        if (recovered.nested.mutation && !mutation)
          await this.host.controlManager.recover(
            {
              ...child,
              controlVersion: 1,
              action: 'abandon',
              request: { kind: 'mutation', value: recovered.nested.mutation },
            },
            child.localProjectId,
          );
        if (recovered.nested.control && !control)
          await this.host.controlManager.recover(
            {
              ...child,
              controlVersion: 1,
              action: 'abandon',
              request: { kind: 'control', value: recovered.nested.control },
            },
            child.localProjectId,
          );
        current();
        recovered.phase = 'abandoned';
        delete recovered.reason;
        if (recovered.request.action === 'send') {
          slot.latestUserTurnId = recovered.previousUserTurnId;
          slot.latestAssistantTurnId = recovered.previousAssistantTurnId;
        }
        slot.status = metas(this.host.meta)['session-' + slot.childSessionId]
          ? slot.latestUserTurnId
            ? 'terminal'
            : 'ready'
          : 'reserved';
        this.store.transaction(() => {
          this.store.saveOperation(grant, recovered);
          this.store.putSlot(grant.id, slot);
        });
      }
      return validateTaskActionResult(
        {
          ...request,
          confirmed: true,
          grant: this.projection(this.store.grant(scope, grant.id)),
          operation: this.operationView(
            recovered,
            this.store.slot(this.store.get(grant.id)!, recovered.request.taskId),
          ),
        },
        request,
      );
    });
  }
  private async cleanup(request: TaskAction, grant: TaskGrant, current: () => void) {
    assert(
      request.taskId && request.expectedExecutionRevision !== undefined,
      400,
      '清理需要精确任务和执行目录版本',
    );
    assert(grant.status !== 'active', 409, '请先撤销父任务授权再清理工作目录');
    const slot = this.store.slot(grant, request.taskId),
      scope = this.childScope(grant, slot);
    assert(!this.locks.has(grant.id + '/' + slot.taskId), 409, '任务操作仍在收尾');
    const action: TaskWrite = {
      grantId: grant.id,
      taskId: slot.taskId,
      operationId: request.operationId,
      action: 'cleanup',
      expectedExecutionRevision: request.expectedExecutionRevision,
    };
    return this.serial(grant.id + '/' + slot.taskId, async () => {
      current();
      let operation = this.store.operation(grant, action);
      if (operation) operation = await this.inspect(grant, operation, current);
      else {
        assert(
          !this.store
            .operations(grant)
            .some(
              (operation) =>
                operation.request.taskId === slot.taskId &&
                ['pending', 'unknown'].includes(operation.phase),
            ),
          409,
          uncertain,
        );
        const execution = this.host.store.executions.info(scope);
        assert(
          execution.status === 'ready' &&
            execution.mode === 'worktree' &&
            execution.executionId &&
            execution.revision === request.expectedExecutionRevision,
          409,
          '任务执行目录版本尚未确认',
        );
        const gitState = await this.host.executionManager.read(
          {
            gitVersion: 1,
            workspaceId: scope.workspaceId,
            localProjectId: scope.localProjectId,
            sessionId: scope.sessionId,
          },
          scope.localProjectId,
        );
        current();
        assert(
          gitState.canRemove && gitState.execution.revision === execution.revision,
          409,
          '任务目录有未保存修改或仍在使用，不能清理',
        );
        operation = this.store.transaction(() => {
          const operation = this.store.stage(grant, action);
          operation.nested.git = {
            gitVersion: 1,
            workspaceId: scope.workspaceId,
            localProjectId: scope.localProjectId,
            sessionId: scope.sessionId,
            action: 'remove',
            operationId: derivedId('cleanup', request.operationId),
            expectedRevision: execution.revision,
            executionId: execution.executionId!,
            expectedStateVersion: gitState.repository.version,
          };
          slot.lastOperationId = request.operationId;
          this.store.saveOperation(grant, operation);
          this.store.putSlot(grant.id, slot);
          return operation;
        });
        try {
          const result = await this.permit(
            scope,
            operation.nested.git!.operationId,
            'git',
            current,
            () => this.host.executionManager.action(operation!.nested.git!, scope.localProjectId),
          );
          current();
          operation.phase =
            result.phase === 'accepted'
              ? 'accepted'
              : result.phase === 'rejected'
                ? 'rejected'
                : 'unknown';
          if (operation.phase === 'accepted') slot.status = 'terminal';
          if (operation.phase === 'unknown') slot.status = 'unknown';
        } catch {
          if (this.closed) throw new AppError(409, '任务执行服务已关闭，原操作需手动核查');
          operation.phase = 'unknown';
          slot.status = 'unknown';
        }
        this.store.transaction(() => {
          this.store.saveOperation(grant, operation!);
          this.store.putSlot(grant.id, slot);
        });
      }
      return validateTaskActionResult(
        {
          ...request,
          confirmed: true,
          grant: this.projection(this.store.get(grant.id)!),
          operation: this.operationView(operation, slot),
        },
        request,
      );
    });
  }
  private end(grantId: string, reason: Exclude<TaskGrantStatus, 'active'>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const live = this.live.get(grantId);
    this.live.delete(grantId);
    if (live?.timer !== undefined) this.cancelTimer(live.timer);
    if (this.ending.has(grantId)) return this.ending.get(grantId)!;
    // Revoke in memory before any SQLite write or await; failure cannot leave
    // an executable tool handle behind.
    let persistenceError: unknown;
    try {
      this.store.invalidate(grantId, reason);
    } catch (error) {
      persistenceError = error;
    }
    const work = (async () => {
      const grant = this.store.get(grantId);
      if (grant)
        await Promise.allSettled(
          grant.slots.map(async (slot) => {
            if (!slot.latestUserTurnId) return;
            const active = this.host.active.get(slot.childSessionId);
            if (
              !active ||
              active.stopped ||
              active.userTurnId !== slot.latestUserTurnId ||
              (slot.latestAssistantTurnId && active.turnId !== slot.latestAssistantTurnId)
            )
              return;
            await this.host.cancelTaskTurn(
              this.childScope(grant, slot),
              active.turnId,
              slot.latestUserTurnId,
            );
          }),
        );
      if (persistenceError) throw persistenceError;
    })();
    this.ending.set(grantId, work);
    void work
      .finally(() => {
        if (this.ending.get(grantId) === work) this.ending.delete(grantId);
      })
      .catch(() => {});
    return work;
  }
  async endParent(
    scope: AttachmentScope,
    assistantTurnId: string,
    reason: 'canceled' | 'interrupted' = 'canceled',
  ) {
    const grant = this.store.byParent(scope, assistantTurnId);
    if (grant) await this.end(grant.id, reason);
  }
  invalidateUnavailable() {
    for (const [id, live] of this.live) {
      try {
        live.current();
      } catch {
        void this.end(
          id,
          this.now() >= this.store.get(id)!.expiresAt ? 'expired' : 'canceled',
        ).catch(() => {});
      }
    }
  }
  close() {
    this.closed = true;
    const grants = [...this.live];
    this.live.clear();
    this.permits.clear();
    for (const [id, live] of grants) {
      if (live.timer !== undefined) this.cancelTimer(live.timer);
      try {
        this.store.invalidate(id, 'interrupted');
      } catch {
        /* Memory authority is already gone; Host must still close all Agents. */
      }
    }
  }
}
