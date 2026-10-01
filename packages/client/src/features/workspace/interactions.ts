import {
  questionRequestSchema,
  QUESTIONS_FEATURE,
  STEER_FEATURE,
  type QuestionAnswer,
  type QuestionRequest,
} from '@moor/protocol/interaction-protocol';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import {
  emptyInteractionSaved,
  InteractionController,
  interactionKey,
  interactionSavedSchema,
  type QuestionDraftValues,
} from '../interactions/interactions';
import { workspaceInteractionSnapshot } from '../interactions/workspace-interactions';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
import { Context, same } from './model';
import type { WorkspaceSessionsService } from './sessions';
/** Capabilities consumed by interactions use cases; supplied only by the workspace composition root. */
export interface WorkspaceInteractionsPorts {
  store: Pick<
    WorkspacePersistence,
    | 'exclusiveOperation'
    | 'read'
    | 'saveInteraction'
    | 'forkBlocked'
    | 'githubBlocked'
    | 'attentionBlocked'
    | 'clearDraft'
  >;
  context: Pick<WorkspaceContextService, 'uuid' | 'execute' | 'command' | 'context' | 'value'>;
  drafts: Pick<WorkspaceDraftsService, 'reloadLedger' | 'flushDraft' | 'draftInput'>;
  sessions: Pick<WorkspaceSessionsService, 'refreshSession'>;
}
export class WorkspaceInteractionsService {
  constructor(readonly ports: WorkspaceInteractionsPorts) {}
  interactionWrites: Promise<void> = Promise.resolve();
  async withInteractions<T>(
    context: Context,
    task: (controller: InteractionController) => Promise<T>,
  ) {
    const sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    const target = { ...context.scope.target, sessionId },
      key = interactionKey(target);
    return this.ports.store.exclusiveOperation(
      context.scope,
      'interaction:' + sessionId,
      context.current,
      async () => {
        const ledger = await this.ports.store.read(
          context.scope,
          context.current,
          context.sessionId ?? [],
        );
        let document = ledger.interactions?.[sessionId] ?? {
          revision: 0,
          value: emptyInteractionSaved(),
        };
        const interaction = new InteractionController(target, {
          uuid: () => this.ports.context.uuid(),
          read: async <V>(requested: string) => {
            context.current();
            if (requested !== key) throw Error('交互缓存范围不匹配。');
            return structuredClone(document.value) as V;
          },
          write: async (requested, raw) => {
            if (requested !== key) throw Error('交互缓存范围不匹配。');
            document = await this.ports.store.saveInteraction(
              context.scope,
              sessionId,
              document.revision,
              interactionSavedSchema.parse(raw),
              context.current,
            );
            await this.ports.drafts.reloadLedger(context);
          },
          request: async (method, raw) => {
            return this.ports.context.execute(
              context,
              this.ports.context.command(context.scope, method, raw),
            );
          },
        });
        await interaction.load();
        return task(interaction);
      },
    );
  }
  async saveInteraction(task: (controller: InteractionController) => Promise<void>) {
    const context = this.ports.context.context();
    await this.ports.drafts.flushDraft();
    context.current();
    const work = this.interactionWrites.then(() =>
      this.withInteractions(context, (controller) => {
        if (controller.pending)
          throw Error('原交互尚未确认，当前输入未保存，请先核查或重新读取草稿。');
        return task(controller);
      }),
    );
    this.interactionWrites = work;
    return work;
  }
  saveQuestionDraft(input: QuestionRequest, values: QuestionDraftValues) {
    const request = questionRequestSchema.parse(input),
      snapshot = structuredClone(values);
    return this.saveInteraction((controller) => controller.saveQuestionDraft(request, snapshot));
  }
  saveSteerDraft(prompt: string) {
    return this.saveInteraction((controller) => controller.saveSteerDraft(prompt));
  }
  async freshInteraction(context: Context, kind: 'question' | 'steer') {
    await this.ports.sessions.refreshSession();
    context.current();
    const session = this.ports.context.value.session,
      ledger = await this.ports.store.read(context.scope, context.current, context.sessionId ?? []);
    if (
      !session ||
      session.persisted === false ||
      session.persistenceError ||
      session.meta.isArchived
    )
      throw Error('请先恢复会话并取得主机持久化确认。');
    if (
      ledger.operations.some(
        (item) => item.status === 'pending' && item.original.value.sessionId === context.sessionId,
      ) ||
      ledger.git?.[context.sessionId!]?.pending ||
      this.ports.store.forkBlocked(ledger, context.sessionId!) ||
      this.ports.store.githubBlocked(ledger, context.sessionId!) ||
      this.ports.store.attentionBlocked(ledger, context.sessionId!)
    )
      throw Error('请先核查此会话的原操作。');
    const snapshot = workspaceInteractionSnapshot(this.ports.context.value);
    if (!snapshot.activeId) throw Error('原活动回合已结束；交互草稿不会转为新指令。');
    if (
      !context.project.runtime.features?.includes(
        kind === 'question' ? QUESTIONS_FEATURE : STEER_FEATURE,
      ) ||
      snapshot.capabilities?.[kind === 'question' ? 'questions' : 'steer'] !== true
    )
      throw Error(
        kind === 'steer'
          ? snapshot.capabilities?.steerUnavailableReason || '当前运行时不支持回合内追加。'
          : '当前运行时不支持问题回答。',
      );
    return snapshot;
  }
  async answerQuestion(input: QuestionRequest, answer: QuestionAnswer['answer']) {
    const request = questionRequestSchema.parse(input),
      reviewed = structuredClone(answer);
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    return this.withInteractions(context, async (controller) => {
      const snapshot = await this.freshInteraction(context, 'question');
      const item = snapshot.questions.find(
        (item) => item.status === 'pending' && same(item.request, request),
      );
      if (!item || snapshot.activeId !== request.expectedTurnId)
        throw Error('问题或原活动回合已改变，请重新读取并审阅。');
      await controller.answer(request, reviewed, {
        ...context.scope.target,
        sessionId: context.sessionId!,
      });
      await this.ports.sessions.refreshSession();
    });
  }
  async steer(expectedTurnId: string, prompt: string) {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    return this.withInteractions(context, async (controller) => {
      const snapshot = await this.freshInteraction(context, 'steer');
      if (snapshot.activeId !== expectedTurnId)
        throw Error('原回合已结束或改变，追加草稿不会转为新指令。');
      await controller.steer(expectedTurnId, prompt, {
        ...context.scope.target,
        sessionId: context.sessionId!,
      });
      try {
        await this.ports.sessions.refreshSession();
      } catch (cause) {
        throw new Error('追加已送达，但会话尚未重新同步；请勿重复提交。', { cause });
      }
    });
  }
  async steerDraft(expectedTurnId: string, reviewedPrompt: string) {
    const context = this.ports.context.context(),
      sessionId = context.sessionId,
      input = this.ports.drafts.draftInput,
      originalDraft = this.ports.context.value.draft;
    if (!sessionId || !originalDraft) throw Error('请先打开会话。');
    if (typeof reviewedPrompt !== 'string' || !reviewedPrompt.trim())
      throw Error('请填写要追加的正文。');
    if (reviewedPrompt.length > 16000) throw Error('追加正文最多 16000 个字符，请缩短后重试。');
    if ((input?.text ?? originalDraft.text) !== reviewedPrompt)
      throw Error('主输入草稿已改变，请重新确认要追加的正文。');
    if (this.ports.context.value.offline || this.ports.context.value.sessionLoad.status !== 'ready')
      throw Error('请先同步当前会话；草稿不会在重连后自动追加。');
    if (this.ports.context.value.ledger?.attachments?.[sessionId]?.items.length)
      throw Error('回合内追加不能携带附件；附件和正文均保留在草稿中。');

    await this.ports.drafts.flushDraft();
    context.current();
    // The input object carries the revision written for the click-time input,
    // including a write already in flight. Never adopt a newer equal-text draft.
    const revision = input ? input.committed?.revision : originalDraft.revision;
    let delivered = false;
    try {
      await this.withInteractions(context, async (controller) => {
        if (controller.steerDraft) throw Error('“回合内追加”面板中还有独立草稿，请先处理该草稿。');
        const snapshot = await this.freshInteraction(context, 'steer');
        if (snapshot.activeId !== expectedTurnId)
          throw Error('原回合已结束或改变，主输入草稿不会转为新指令。');
        const ledger = await this.ports.store.read(context.scope, context.current, sessionId);
        if (ledger.attachments?.[sessionId]?.items.length)
          throw Error('附件草稿已改变，回合内追加不能携带附件；正文仍保留。');
        await controller.steer(
          expectedTurnId,
          reviewedPrompt,
          { ...context.scope.target, sessionId },
          () => {
            delivered = true;
          },
        );
      });
    } catch (error) {
      if (!delivered) throw error;
      return {
        delivered: true as const,
        draftCleared: false,
        warning: '已追加到原活动回合，但本机确认状态未能更新；主输入草稿未清理，请核查原交互。',
      };
    }

    let draftCleared = false,
      warning: string | undefined;
    try {
      context.current();
      // Persist subsequent typing before the revision CAS. It cannot replace
      // the reviewed prompt, and the CAS cannot clear that later input.
      await this.ports.drafts.flushDraft();
      context.current();
      if (revision !== undefined) {
        const draft = await this.ports.store.clearDraft(
          context.scope,
          sessionId,
          revision,
          context.current,
        );
        draftCleared = draft.revision === revision + 1 && draft.text === '';
      }
      await this.ports.drafts.reloadLedger(context);
    } catch {
      warning = '已追加到原活动回合，但本机草稿状态未能更新；请勿重复追加同一正文。';
    }
    try {
      context.current();
      await this.ports.sessions.refreshSession();
      context.current();
    } catch {
      warning ??= '已追加到原活动回合，会话尚未重新同步；请勿重复追加同一正文。';
    }
    return { delivered: true as const, draftCleared, ...(warning ? { warning } : {}) };
  }
  async retryInteraction() {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    return this.withInteractions(context, async (controller) => {
      await controller.retry({ ...context.scope.target, sessionId: context.sessionId! });
      await this.ports.sessions.refreshSession();
    });
  }
  async dismissInteraction() {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    return this.withInteractions(context, async (controller) => {
      await this.ports.sessions.refreshSession();
      context.current();
      const pending = controller.pending,
        snapshot = workspaceInteractionSnapshot(this.ports.context.value);
      if (
        !pending ||
        !this.ports.context.value.session?.persisted ||
        this.ports.context.value.session.persistenceError
      )
        throw Error('原交互尚不可关闭。');
      const notInjected =
        pending.kind === 'steer' &&
        snapshot.steers.some(
          (item) =>
            item.operationId === pending.request.operationId &&
            item.expectedTurnId === pending.request.expectedTurnId &&
            item.status === 'not-injected',
        );
      if (!notInjected && !snapshot.finished.includes(pending.request.expectedTurnId))
        throw Error('原回合尚未结束，请先重试原请求核查结果。');
      await controller.dismiss(
        notInjected ? 'not-injected' : 'unknown',
        notInjected
          ? '主机确认原追加未进入活动回合。'
          : '原回合已结束；关闭本机记录不代表原交互送达成功。',
      );
    });
  }
}
