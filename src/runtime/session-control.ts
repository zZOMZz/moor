import { isDeepStrictEqual } from 'node:util';
import { assert } from '../protocol';
import { Flock, LoroDoc, metas, mirror, putMeta } from '../model';
import type { HostWorkspace } from '../bridge/host-workspace';
import {
  sessionControlActionSchema,
  sessionOperationSchema,
  validateSessionControlReceipt,
  type SessionControlAction,
  type SessionControlScope,
  type SessionOriginalOperation,
  type SessionControlReceipt,
  type SessionOperation,
  type SessionOperationResult,
} from '../session-control-protocol';

const envelope = (scope: SessionControlScope) => ({
  controlVersion: 1 as const,
  workspaceId: scope.workspaceId,
  userId: scope.userId,
  machineId: scope.machineId,
  localProjectId: scope.localProjectId,
  sessionId: scope.sessionId,
  confirmed: true as const,
});
function receipt(
  scope: SessionControlScope,
  original: SessionOriginalOperation,
  status: SessionControlReceipt['status'],
): SessionControlReceipt {
  return {
    ...envelope(scope),
    operationId: original.value.operationId,
    kind: original.kind === 'control' ? original.value.action : original.kind,
    status,
  };
}

/** Durable session lifecycle operations. This manager never opens an Agent. */
export class SessionControlManager {
  constructor(private host: HostWorkspace) {}
  private context(scope: SessionControlScope, project?: string) {
    const lease = structuredClone(this.host.projectRootLease(scope, project));
    const current = () => {
      this.host.ensureConnected();
      assert(
        scope.userId === this.host.workspace.userId &&
          scope.machineId === this.host.workspace.machineId,
        403,
        '会话操作属于其他用户或执行电脑',
      );
      assert(
        isDeepStrictEqual(lease, this.host.projectRootLease(scope, project)),
        409,
        '会话操作范围已变化',
      );
    };
    current();
    return { lease, current };
  }
  private existing(scope: SessionControlScope, original: SessionOriginalOperation) {
    const row = this.host.store.journal.lookup(scope.workspaceId, original.value);
    if (!row) return;
    if (original.kind === 'control') {
      assert(
        [
          'control-accepted',
          'control-stopping',
          'control-interrupted',
          'operation-abandoned',
        ].includes(row.phase),
        409,
        '原会话操作状态不可验证',
      );
      return validateSessionControlReceipt(JSON.parse(row.result), scope, original);
    }
    if (row.phase === 'accepted') return receipt(scope, original, 'accepted');
    assert(row.phase === 'operation-abandoned', 409, '原操作尚无可确认结果，不能重新派发');
    return receipt(scope, original, 'abandoned');
  }
  private insert(
    scope: SessionControlScope,
    original: SessionOriginalOperation,
    phase: string,
    result: unknown,
  ) {
    const journal = this.host.store.journal;
    journal.db
      .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,?,?)')
      .run(
        original.value.operationId,
        journal.fingerprint(scope.workspaceId, original.value),
        phase,
        original.kind === 'control' && original.value.action === 'stop'
          ? original.value.turnId
          : null,
        JSON.stringify(result),
      );
  }
  private settleStop(scope: SessionControlScope, original: SessionOriginalOperation) {
    assert(original.kind === 'control' && original.value.action === 'stop', 400, '停止操作无效');
    const turnId = original.value.turnId;
    if (this.host.active.get(scope.sessionId)?.turnId === turnId)
      return receipt(scope, original, 'stopping');
    const view = mirror(this.host.store.doc(scope.sessionId), scope.sessionId);
    const turn = view.getState().history.find((item) => item.id === turnId);
    const terminal = turn?.role === 'assistant' && turn.finished;
    const status = turn?.status === 'canceled' ? 'accepted' : 'interrupted';
    view.dispose();
    if (!terminal) return receipt(scope, original, 'stopping');
    const result = receipt(scope, original, status);
    this.host.store.journal.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=? AND phase=?')
      .run(
        status === 'accepted' ? 'control-accepted' : 'control-interrupted',
        JSON.stringify(result),
        original.value.operationId,
        'control-stopping',
      );
    return result;
  }
  async control(input: SessionControlAction, project?: string): Promise<SessionControlReceipt> {
    const action = sessionControlActionSchema.parse(input),
      context = this.context(action, project);
    const original: SessionOriginalOperation = { kind: 'control', value: action };
    return this.host.serial(action.sessionId, async () => {
      context.current();
      const known = this.existing(action, original);
      if (known) return known.status === 'stopping' ? this.settleStop(action, original) : known;
      if (action.action === 'create') {
        assert(
          this.host.taskManager.allowsCreate(action.sessionId, action.operationId),
          409,
          '协作子任务槽位只允许原授权创建',
        );
        assert(
          !this.host.forkManager.busy.has(action.sessionId) &&
            !this.host.store.forks.blocked(action.sessionId) &&
            !this.host.executionManager.busy.has(action.sessionId),
          409,
          '请先确认此会话的目录或 Fork 操作',
        );
        assert(
          !metas(this.host.meta)['session-' + action.sessionId] &&
            !this.host.store.journal.db
              .prepare('SELECT 1 FROM session WHERE id=?')
              .get(action.sessionId) &&
            !this.host.store.agents.bySession(action.sessionId),
          409,
          '会话编号已存在',
        );
        const execution = this.host.executionLease(action, project, true);
        const agent = this.host.store.agents.get(action.agentId);
        assert(
          agent &&
            this.host.workspace.agents.some((item) => item.id === agent.id) &&
            agent.machineId === action.machineId,
          409,
          '请选择当前可用于新会话的 Agent 版本',
        );
        const doc = new LoroDoc(),
          view = mirror(doc, action.sessionId);
        view.setState((state) => {
          state.session.id = action.sessionId;
        });
        view.dispose();
        doc.commit();
        const next = Flock.fromFile(this.host.meta.exportFile()),
          now = new Date().toISOString();
        const taskOrigin = this.host.store.tasks.origin(context.lease);
        putMeta(next, 'session-' + action.sessionId, {
          id: action.sessionId,
          machineId: action.machineId,
          userId: action.userId,
          createdAt: now,
          lastMessageAt: Date.parse(now),
          title: action.title ?? '新会话',
          titleSource: 'user',
          cliType: agent.cliType,
          agentType: agent.agentType,
          agentConfigId: agent.id,
          status: { type: 'idle' },
          isArchived: false,
          isPinned: false,
          metadataRevision: 0,
          project: { kind: 'local', localProjectId: action.localProjectId },
          ...(taskOrigin ? { taskOrigin } : {}),
        });
        const result = receipt(action, original, 'accepted'),
          previous = this.host.store.meta;
        try {
          this.host.store.transaction(() => {
            context.current();
            assert(
              isDeepStrictEqual(execution, this.host.executionLease(action, project, true)),
              409,
              '会话目录已变化',
            );
            this.host.store.reserveAttachmentScope(context.lease);
            this.host.store.agents.bind(context.lease, agent);
            this.host.store.meta = next;
            this.host.store.persist(action.sessionId, doc);
            this.insert(action, original, 'control-accepted', result);
          });
        } catch (error) {
          this.host.store.meta = previous;
          throw error;
        }
        this.host.sessionChanged(action.sessionId);
        return result;
      }
      this.host.checkProject(action.sessionId, action.localProjectId);
      const run = this.host.active.get(action.sessionId);
      assert(
        run && !run.stopped && run.turnId === action.turnId,
        409,
        '该活动回合已结束，请重新读取',
      );
      this.host.store.transaction(() => {
        context.current();
        this.insert(action, original, 'control-stopping', receipt(action, original, 'stopping'));
      });
      // The original intent is durable before cancellation. An uncertain stop is
      // never dispatched again; recovery only examines the original turn.
      try {
        await this.host.cancelLocked(action.sessionId, action.turnId, action.localProjectId);
      } catch {
        /* Keep the exact intent for manual confirmation. */
      }
      context.current();
      return this.settleStop(action, original);
    });
  }
  async recover(input: SessionOperation, project?: string): Promise<SessionOperationResult> {
    const request = sessionOperationSchema.parse(input),
      context = this.context(request, project);
    return this.host.serial(request.sessionId, async () => {
      context.current();
      const original = request.request;
      // A CLI mutation always follows a separately confirmed empty creation.
      // This also prevents a guessed scope from sealing an unrelated new draft.
      if (original.kind !== 'control' || original.value.action === 'stop')
        this.host.checkProject(request.sessionId, request.localProjectId);
      let known = this.existing(request, original);
      if (known?.status === 'stopping') known = this.settleStop(request, original);
      const base = {
        ...envelope(request),
        action: request.action,
        operationId: original.value.operationId,
      };
      if (known) return { ...base, found: true, receipt: known };
      if (request.action === 'inspect') return { ...base, found: false };
      const result = receipt(request, original, 'abandoned');
      this.host.store.transaction(() => {
        context.current();
        this.host.store.reserveAttachmentScope(context.lease);
        this.insert(
          request,
          original,
          'operation-abandoned',
          original.kind === 'control'
            ? result
            : {
                accepted: false,
                delivered: false,
                abandoned: true,
                operationId: original.value.operationId,
              },
        );
      });
      return { ...base, found: true, receipt: result };
    });
  }
}
