import { createHash } from 'node:crypto';
import { assert, type Mutation } from '@moor/protocol/protocol';
import {
  collaborationScopeSchema,
  taskExecutionTargetSchema,
  type CollaborationScope,
  type TaskClaim,
  type TaskExecutionTarget,
  type TaskState,
} from '@moor/protocol/collaboration-protocol';
import { buildSessionTurn, readClientSession } from '@moor/session/session-operations';
import type { HostWorkspace } from './workspace';

type Awaitable<T> = T | Promise<T>;
export interface CollaborationExecutionQueue {
  claim(
    scope: CollaborationScope,
    target: TaskExecutionTarget,
    claimId: string,
  ): Awaitable<TaskClaim | undefined>;
  beginDispatch(claim: TaskClaim, command: Mutation): Awaitable<TaskState>;
  acceptExecution(claim: TaskClaim, receipt: unknown): Awaitable<TaskState>;
  settle(
    claim: TaskClaim,
    phase: 'completed' | 'failed' | 'interrupted' | 'blocked',
    detail?: Pick<TaskState, 'reason' | 'userTurnId' | 'assistantTurnId'>,
  ): Awaitable<TaskState>;
  interruptExecution(scope: CollaborationScope, target: TaskExecutionTarget): Awaitable<void>;
}

/** One authenticated execution binding consumes a durable queue. Sync itself never calls ACP. */
export class CollaborationExecutionPlane {
  #drain: Promise<void> | undefined;
  #closed = false;
  #wakeAgain = false;
  #scope: CollaborationScope;
  #target: TaskExecutionTarget;

  constructor(
    private readonly options: {
      host: HostWorkspace;
      queue: CollaborationExecutionQueue;
      scope: CollaborationScope;
      target: TaskExecutionTarget;
      /** Recheck the current authenticated execution binding before every new effect. */
      current(): void;
      uuid(): string;
      now(): number;
      reconcile?(): void;
    },
  ) {
    this.#scope = collaborationScopeSchema.parse(options.scope);
    this.#target = taskExecutionTargetSchema.parse(options.target);
    this.#current();
  }
  #current() {
    this.options.current();
    this.#hostCurrent();
  }
  #hostCurrent() {
    const workspace = this.options.host.workspace,
      target = this.#target;
    assert(!this.#closed && !this.options.host.closed, 409, '协作执行连接已关闭');
    assert(
      workspace.id === target.workspaceId &&
        workspace.machineId === target.machineId &&
        workspace.userId === target.userId &&
        target.sessionId === this.#scope.sessionId &&
        workspace.projects.some((project) => project.id === target.localProjectId),
      403,
      '协作任务不属于此执行主机或项目',
    );
  }
  /** Call on process startup only, before wake; uncertain previous work must not be replayed. */
  async recover() {
    this.#current();
    assert(
      !this.#drain && !this.options.host.active.has(this.#target.sessionId),
      409,
      '活动执行不能作为重启恢复',
    );
    await this.options.queue.interruptExecution(this.#scope, this.#target);
    this.#current();
  }
  /** Invoked by queue changes or Host idle signals, not by elapsed-time polling. */
  wake(): Promise<void> {
    if (this.#drain) {
      this.#wakeAgain = true;
      return this.#drain;
    }
    let failed = false;
    const drain = Promise.resolve()
      .then(async () => {
        do {
          this.#wakeAgain = false;
          await this.#run();
        } while (this.#wakeAgain && !this.#closed);
      })
      .catch((error) => {
        failed = true;
        throw error;
      })
      .finally(() => {
        if (this.#drain === drain) {
          this.#drain = undefined;
          // A wake can arrive after the loop's last condition but before this cleanup.
          if (!failed && this.#wakeAgain && !this.#closed) return this.wake();
        }
      });
    this.#drain = drain;
    return drain;
  }
  close() {
    this.#closed = true;
  }
  async #run() {
    for (;;) {
      this.#current();
      this.options.reconcile?.();
      const { host, queue } = this.options,
        target = this.#target;
      // A normal interactive turn also owns this session. Queue work waits for its idle signal.
      if (host.active.has(target.sessionId) || host.active.size >= 32) return;
      const claim = await queue.claim(this.#scope, target, this.options.uuid());
      if (!claim) return;
      let dispatched = false;
      let command: Mutation | undefined;
      try {
        this.#current();
        const read = await host.read(target.sessionId, undefined, target.localProjectId);
        this.#current();
        assert(read.agent && read.agent.id === target.agentId, 409, '会话 Agent 绑定已改变');
        const digest = createHash('sha256')
          .update(JSON.stringify([this.#scope, claim.intent.operationId]))
          .digest('hex');
        const userTurnId = 'intent-user:' + digest;
        command = buildSessionTurn({
          scope: target,
          read,
          agent: read.agent,
          prompt: claim.intent.input.prompt,
          selection: claim.intent.input.selection,
          operationId: 'intent:' + digest,
          turnId: userTurnId,
          peerId: '1',
          now: new Date(this.options.now()).toISOString(),
        });
        await queue.beginDispatch(claim, command);
        this.#current();
        dispatched = true;
        let receipt: unknown;
        try {
          receipt = await host.mutate(command, target.localProjectId);
        } catch (error) {
          // The local accept transaction is authoritative even if a post-commit callback failed.
          const accepted = host.store.journal.lookup(target.workspaceId, command);
          if (accepted?.phase !== 'accepted') throw error;
          receipt = JSON.parse(accepted.result);
        }
        await queue.acceptExecution(claim, receipt);
        const active = host.active.get(target.sessionId);
        if (active?.userTurnId === userTurnId) await active.done;
        // Accepted work records its local result even if its delivery connection disconnected.
        // The next claim still requires a current authenticated connection.
        this.#hostCurrent();
        const result = readClientSession(
          await host.read(target.sessionId, undefined, target.localProjectId),
          target,
        );
        const assistant = result.history.find(
          (turn) => turn.role === 'assistant' && turn.userTurnId === userTurnId,
        );
        assert(
          result.persisted !== false && !result.persistenceError && assistant?.finished,
          409,
          '执行结果尚未持久确认',
        );
        await queue.settle(claim, assistant.status === 'handled' ? 'completed' : 'failed', {
          userTurnId,
          assistantTurnId: assistant.id,
          ...(assistant.status === 'handled'
            ? {}
            : { reason: 'Agent 回合未正常结束，请查看原会话' }),
        });
      } catch (error) {
        // Keep uncertain dispatches terminal and visible; never generate a replacement operation.
        const known = command && host.store.journal.lookup(target.workspaceId, command);
        const phase = dispatched && known ? 'interrupted' : 'blocked';
        await queue.settle(claim, phase, {
          reason:
            phase === 'interrupted'
              ? '原执行结果未确认，请核查原会话；不会自动重放'
              : '任务未能通过当前执行条件，请检查授权、模型与会话状态',
        });
        if (phase === 'interrupted' || this.#closed || host.closed) return;
      }
    }
  }
}
