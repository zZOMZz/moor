import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ZodError } from 'zod';
import { AppError, assert } from '../protocol';
import {
  INTERACTION_VERSION,
  questionRequestSchema,
  questionAnswerSchema,
  questionReceiptSchema,
  steerRequestSchema,
  steerReceiptSchema,
  validateQuestionAnswer,
  type QuestionRequest,
  type QuestionAnswer,
  type QuestionReceipt,
  type SteerRequest,
  type SteerReceipt,
} from '../interaction-protocol';
import type { AgentSession } from '../runtime/agent';
import type { ContentScope } from '../content-protocol';
import type { Journal } from './journal';

export type InteractionRun = { turnId: string; stopped: boolean; session?: AgentSession };
export type InteractionOwner = { userId: string; machineId: string; rootPath: string };
export type QuestionItem = {
  type: 'question';
  request: QuestionRequest;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  answer?: QuestionAnswer['answer'];
  operationId?: string;
};
export type SteerItem = {
  type: 'steer';
  operationId: string;
  expectedTurnId: string;
  prompt: string;
  status: 'pending' | 'delivered' | 'not-injected' | 'unknown';
  message?: string;
};
export type InteractionTurn = { id: string; role: string; finished?: boolean; items?: any[] };
export type InteractionDependencies<Run extends InteractionRun> = {
  journal: Journal;
  getRun(sessionId: string): Run | undefined;
  scopeCheck(scope: ContentScope, localProjectId?: string): InteractionOwner;
  serial<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
  // Synchronous, atomic transaction: write the original run's document and the
  // journal together. If run is undefined, execute only the journal write. A
  // failed transaction must restore the host's in-memory document as well.
  persist(
    sessionId: string,
    run: Run | undefined,
    edit: ((turn: InteractionTurn) => void) | undefined,
    write?: () => void,
  ): void;
};
type Pending<Run> = {
  request: QuestionRequest;
  run: Run;
  owner: InteractionOwner;
  promise: Promise<QuestionAnswer>;
  resolve(answer: QuestionAnswer): void;
};
const scopeOf = (value: ContentScope): ContentScope => ({
  workspaceId: value.workspaceId,
  localProjectId: value.localProjectId,
  sessionId: value.sessionId,
});
const journalScope = (scope: ContentScope, owner: InteractionOwner) =>
  JSON.stringify([scope.workspaceId, owner.userId, owner.machineId, owner.rootPath]);
export const cancelledQuestionAnswer = (request: QuestionRequest): QuestionAnswer => ({
  ...scopeOf(request),
  interactionVersion: INTERACTION_VERSION,
  expectedTurnId: request.expectedTurnId,
  requestId: request.requestId,
  operationId: randomUUID(),
  answer: { action: 'cancel' },
});

/** Restart projection only: it never resolves a native callback or schedules work. */
export function expireSessionInteractions(
  turn: InteractionTurn,
  reason: 'restart' | 'stopped' = 'restart',
) {
  let changed = false;
  for (const item of turn.items ?? []) {
    if (item?.type === 'question' && item.status === 'pending') {
      item.status = reason === 'restart' ? 'expired' : 'cancelled';
      item.answer = { action: 'cancel' };
      changed = true;
    } else if (item?.type === 'steer' && item.status === 'pending') {
      item.status = 'unknown';
      item.message =
        reason === 'restart'
          ? '执行服务已重启；追加指令结果未知，不会自动重新发送'
          : '活动回合已停止；追加指令结果需要查询原请求';
      changed = true;
    }
  }
  return changed;
}

export class SessionInteractions<Run extends InteractionRun> {
  private pending = new Map<string, Pending<Run>>();
  private steering = new WeakSet<Run>();
  private uncertain = new WeakSet<Run>();
  private runScopes = new WeakMap<Run, { scope: ContentScope; owner: InteractionOwner }>();
  constructor(private dependencies: InteractionDependencies<Run>) {}
  private key(request: Pick<QuestionRequest, 'sessionId' | 'requestId'>) {
    return request.sessionId + '/' + request.requestId;
  }
  private owner(scope: ContentScope, localProjectId?: string) {
    return { ...this.dependencies.scopeCheck(scopeOf(scope), localProjectId) };
  }
  private lease(scope: ContentScope, owner: InteractionOwner, localProjectId?: string) {
    assert(
      isDeepStrictEqual(owner, this.owner(scope, localProjectId)),
      409,
      '交互请求的执行归属已变化',
    );
  }
  private active(scope: ContentScope & { expectedTurnId: string }) {
    const run = this.dependencies.getRun(scope.sessionId);
    assert(
      run && !run.stopped && run.turnId === scope.expectedTurnId,
      409,
      '交互请求的活动回合已失效',
    );
    return run;
  }
  private failure(error: unknown, operationId?: string): AppError {
    const rejected = !!operationId && !this.dependencies.journal.has(operationId);
    return new AppError(
      error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 502,
      error instanceof AppError
        ? error.message
        : error instanceof ZodError
          ? '交互请求格式无效'
          : '交互结果尚未确认，请手动查询原请求',
      rejected,
    );
  }

  async receiveQuestion(input: QuestionRequest): Promise<QuestionAnswer> {
    const request = questionRequestSchema.parse(input);
    let pending!: Pending<Run>;
    try {
      await this.dependencies.serial(request.sessionId, async () => {
        const owner = this.owner(request),
          run = this.active(request),
          key = this.key(request);
        const existing = this.pending.get(key);
        if (existing) {
          this.lease(request, existing.owner);
          assert(
            existing.run === run && isDeepStrictEqual(existing.request, request),
            409,
            '问答请求编号已使用',
          );
          pending = existing;
          return;
        }
        let resolve!: (answer: QuestionAnswer) => void;
        const promise = new Promise<QuestionAnswer>((done) => (resolve = done));
        this.dependencies.persist(request.sessionId, run, (turn) => {
          assert(
            turn.id === request.expectedTurnId && turn.role === 'assistant' && !turn.finished,
            409,
            '问答回合已失效',
          );
          const items = (turn.items ??= []);
          assert(
            !items.some(
              (item) => item?.type === 'question' && item.request?.requestId === request.requestId,
            ),
            409,
            '问答请求编号已使用',
          );
          items.push({ type: 'question', request, status: 'pending' } satisfies QuestionItem);
        });
        pending = { request, run, owner, promise, resolve };
        this.runScopes.set(run, { scope: scopeOf(request), owner });
        this.pending.set(key, pending);
      });
    } catch (error) {
      if (error instanceof AppError && [404, 409].includes(error.status))
        return cancelledQuestionAnswer(request);
      throw error;
    }
    // Do not hold the session serial lock while waiting for the user's answer.
    return pending.promise;
  }

  async answerQuestion(input: QuestionAnswer, localProjectId?: string): Promise<QuestionReceipt> {
    let answer: QuestionAnswer | undefined;
    try {
      answer = questionAnswerSchema.parse(input);
      const parsed = answer;
      return await this.dependencies.serial(parsed.sessionId, async () => {
        const owner = this.owner(parsed, localProjectId),
          journal = this.dependencies.journal,
          fingerprintScope = journalScope(parsed, owner),
          record = journal.lookup(fingerprintScope, parsed);
        if (record?.phase === 'accepted')
          return questionReceiptSchema.parse(JSON.parse(record.result));
        assert(!record, 409, '问答操作尚未完成，请查询原请求');
        const run = this.active(parsed),
          pending = this.pending.get(this.key(parsed));
        assert(pending && pending.run === run, 409, '问答请求已失效');
        this.lease(parsed, pending.owner, localProjectId);
        validateQuestionAnswer(pending.request, parsed);
        const receipt: QuestionReceipt = {
          ...scopeOf(parsed),
          interactionVersion: INTERACTION_VERSION,
          expectedTurnId: parsed.expectedTurnId,
          requestId: parsed.requestId,
          operationId: parsed.operationId,
          accepted: true,
          delivered: true,
        };
        this.dependencies.persist(
          parsed.sessionId,
          run,
          (turn) => {
            assert(
              turn.id === parsed.expectedTurnId && turn.role === 'assistant' && !turn.finished,
              409,
              '问答回合已失效',
            );
            const item: QuestionItem | undefined = turn.items?.find(
              (item) => item?.type === 'question' && item.request?.requestId === parsed.requestId,
            );
            assert(
              item?.status === 'pending' && isDeepStrictEqual(item.request, pending.request),
              409,
              '问答请求已失效',
            );
            item.status = parsed.answer.action === 'cancel' ? 'cancelled' : 'answered';
            item.answer = parsed.answer;
            item.operationId = parsed.operationId;
          },
          () => {
            journal.acceptQuestion(fingerprintScope, parsed, receipt);
          },
        );
        this.pending.delete(this.key(parsed));
        pending.resolve(parsed);
        return receipt;
      });
    } catch (error) {
      throw this.failure(error, answer?.operationId ?? input?.operationId);
    }
  }

  /** Call during stop/finalization even if run.stopped is already true. */
  cancelPending(sessionId: string, run: Run): { persisted: boolean } {
    const pending = [...this.pending.values()].filter(
      (question) => question.run === run && question.request.sessionId === sessionId,
    );
    let persisted = true;
    try {
      if (
        (pending.length || this.steering.has(run) || this.uncertain.has(run)) &&
        this.dependencies.getRun(sessionId) === run
      ) {
        const lease = this.runScopes.get(run);
        if (lease) this.lease(lease.scope, lease.owner);
        this.dependencies.persist(sessionId, run, (turn) => {
          if (turn.id !== run.turnId) return;
          for (const item of turn.items ?? [])
            if (
              item?.type === 'question' &&
              item.status === 'pending' &&
              pending.some((question) => question.request.requestId === item.request?.requestId)
            ) {
              item.status = 'cancelled';
              item.answer = { action: 'cancel' };
            }
          for (const item of turn.items ?? [])
            if (
              item?.type === 'steer' &&
              item.status === 'pending' &&
              item.expectedTurnId === run.turnId
            ) {
              item.status = 'unknown';
              item.message = '活动回合已停止；追加指令结果需要查询原请求';
            }
        });
      }
    } catch {
      persisted = false;
    } finally {
      for (const question of pending) {
        this.pending.delete(this.key(question.request));
        question.resolve(cancelledQuestionAnswer(question.request));
      }
    }
    return { persisted };
  }

  async steer(input: SteerRequest, localProjectId?: string): Promise<SteerReceipt> {
    let request: SteerRequest | undefined;
    try {
      request = steerRequestSchema.parse(input);
      const parsed = request,
        journal = this.dependencies.journal;
      const staged = await this.dependencies.serial(parsed.sessionId, async () => {
        const owner = this.owner(parsed, localProjectId),
          fingerprintScope = journalScope(parsed, owner),
          record = journal.lookup(fingerprintScope, parsed);
        if (record?.phase === 'accepted')
          return {
            type: 'receipt' as const,
            receipt: steerReceiptSchema.parse(JSON.parse(record.result)),
          };
        if (record)
          throw new AppError(
            record.phase === 'steer-rejected' ? 409 : 504,
            record.phase === 'steer-rejected'
              ? '追加指令未进入活动回合，请手动作为新的指令发送'
              : '追加指令结果未知；原请求不会再次发送，请查询回合或停止任务',
          );
        const run = this.active(parsed),
          session = run.session;
        assert(
          session?.interactionCapabilities?.steer && session.steer,
          409,
          session?.interactionCapabilities?.steerUnavailableReason ?? '当前 Agent 不支持追加指令',
        );
        assert(
          !this.steering.has(run) && !this.uncertain.has(run),
          409,
          '上一条追加指令尚未确认，请先查询或停止当前回合',
        );
        this.dependencies.persist(
          parsed.sessionId,
          run,
          (turn) => {
            assert(
              turn.id === parsed.expectedTurnId && turn.role === 'assistant' && !turn.finished,
              409,
              '追加指令回合已失效',
            );
            (turn.items ??= []).push({
              type: 'steer',
              operationId: parsed.operationId,
              expectedTurnId: parsed.expectedTurnId,
              prompt: parsed.prompt,
              status: 'pending',
            } satisfies SteerItem);
          },
          () => journal.stageSteer(fingerprintScope, parsed),
        );
        this.steering.add(run);
        this.runScopes.set(run, { scope: scopeOf(parsed), owner });
        return {
          type: 'dispatch' as const,
          owner,
          fingerprintScope,
          run,
          session,
          nativeId: session.id,
        };
      });
      if (staged.type === 'receipt') return staged.receipt;
      const { owner, fingerprintScope, run, session, nativeId } = staged;
      const settle = (
        status: SteerItem['status'],
        phase: 'accepted' | 'steer-unknown' | 'steer-rejected',
        result: SteerReceipt | { message: string },
      ) => {
        const current =
          this.dependencies.getRun(parsed.sessionId) === run &&
          run.session === session &&
          session.id === nativeId
            ? run
            : undefined;
        this.dependencies.persist(
          parsed.sessionId,
          current,
          current
            ? (turn) => {
                assert(turn.id === parsed.expectedTurnId, 409, '原追加指令回合已变化');
                const item: SteerItem | undefined = turn.items?.find(
                  (item) =>
                    item?.type === 'steer' &&
                    item.operationId === parsed.operationId &&
                    item.expectedTurnId === parsed.expectedTurnId,
                );
                if (item) {
                  item.status = status;
                  if ('message' in result) item.message = result.message;
                }
              }
            : undefined,
          () => {
            journal.settleSteer(fingerprintScope, parsed, phase, result);
          },
        );
      };
      try {
        this.lease(parsed, owner, localProjectId);
        if (
          this.dependencies.getRun(parsed.sessionId) !== run ||
          run.stopped ||
          run.session !== session ||
          session.id !== nativeId
        ) {
          settle('not-injected', 'steer-rejected', {
            message: '回合在追加指令发送前已经停止或变化',
          });
          throw new AppError(409, '回合在追加指令发送前已经停止或变化');
        }
        let outcome;
        try {
          outcome = await session.steer!({
            expectedTurnId: parsed.expectedTurnId,
            prompt: parsed.prompt,
          });
        } catch {
          await this.dependencies.serial(parsed.sessionId, async () => {
            this.lease(parsed, owner, localProjectId);
            this.uncertain.add(run);
            settle('unknown', 'steer-unknown', {
              message: 'Agent 尚未确认追加结果，原请求不会再次发送',
            });
          });
          throw new AppError(504, '追加指令结果未知；原请求不会再次发送，请查询回合或停止任务');
        }
        return await this.dependencies.serial(parsed.sessionId, async () => {
          this.lease(parsed, owner, localProjectId);
          if (outcome.outcome === 'promptRequired') {
            settle('not-injected', 'steer-rejected', {
              message: '追加指令未进入活动回合，请手动作为新的指令发送',
            });
            throw new AppError(409, '追加指令未进入活动回合，请手动作为新的指令发送');
          }
          assert(outcome.outcome === 'injected', 502, 'Agent 追加指令确认无效');
          const receipt: SteerReceipt = {
            ...scopeOf(parsed),
            operationId: parsed.operationId,
            expectedTurnId: parsed.expectedTurnId,
            accepted: true,
            delivered: true,
            activityBound: true,
          };
          settle('delivered', 'accepted', receipt);
          return receipt;
        });
      } finally {
        if (journal.lookup(fingerprintScope, parsed)?.phase === 'steer-staged')
          this.uncertain.add(run);
        this.steering.delete(run);
      }
    } catch (error) {
      throw this.failure(error, request?.operationId ?? input?.operationId);
    }
  }
}
