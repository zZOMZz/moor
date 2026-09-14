import { useRef, useState } from 'react';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';
import { workspaceInteractionSnapshot } from './workspace-interactions';
import {
  emptyInteractionSaved,
  questionDefaults,
  questionDraftKey,
  questionStatus,
  steerStatus,
} from './interactions';
import { QuestionPanel, SteerPanel } from './interaction-ui';

export function WorkspaceInteractionUI({
  controller,
  state,
  busy,
  run,
  onDirty,
}: {
  controller: WorkspaceController;
  state: WorkspaceClientState;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
  onDirty(value: boolean): void;
}) {
  const [panel, setPanel] = useState<{ question: string } | { steer: string } | null>(null);
  const [error, setError] = useState('');
  const dirty = useRef(false),
    savingVersion = useRef(0);
  const snapshot = workspaceInteractionSnapshot(state);
  const saved =
    state.ledger?.interactions?.[state.sessionId ?? '']?.value ?? emptyInteractionSaved();
  const canDismiss =
    saved.pending &&
    (snapshot.finished.includes(saved.pending.request.expectedTurnId) ||
      (saved.pending.kind === 'steer' &&
        snapshot.steers.some(
          (item) =>
            item.operationId === saved.pending!.request.operationId &&
            item.expectedTurnId === saved.pending!.request.expectedTurnId &&
            item.status === 'not-injected',
        )));
  const reason = state.offline ? '执行电脑离线，草稿仍可编辑；重连不会自动提交。' : '';
  const draft = async (task: () => Promise<void>) => {
    const version = ++savingVersion.current;
    dirty.current = true;
    onDirty(true);
    try {
      await task();
      if (savingVersion.current === version) {
        dirty.current = false;
        onDirty(false);
        setError('');
      }
    } catch (error) {
      setError('交互草稿尚未保存。当前输入保留在面板中，可重新读取已保存草稿。');
      throw error;
    }
  };
  const perform = (task: () => Promise<unknown>) =>
    new Promise<void>((resolve, reject) => {
      const accepted = run(async () => {
        try {
          await task();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      if (!accepted) reject(Error('另一项操作尚未结束，请稍后重试。'));
    });
  const close = () => {
    if (!busy && !dirty.current) setPanel(null);
  };
  const question =
    panel &&
    'question' in panel &&
    snapshot.questions.find((item) => questionDraftKey(item.request) === panel.question);
  return (
    <section className="workspace-interactions" aria-label="会话问答与追加">
      <button
        hidden={!snapshot.activeId && !saved.steerDraft && !saved.pending}
        type="button"
        disabled={busy}
        onClick={() => setPanel({ steer: snapshot.activeId ?? '' })}
      >
        回合内追加
      </button>
      {snapshot.questions.map((item) => (
        <button
          type="button"
          key={questionDraftKey(item.request)}
          disabled={busy}
          onClick={() => setPanel({ question: questionDraftKey(item.request) })}
        >
          {questionStatus[item.status]} · {item.request.title ?? 'Agent 问题'}
        </button>
      ))}
      {!!snapshot.steers.length && (
        <details>
          <summary>追加记录 · {snapshot.steers.length}</summary>
          {snapshot.steers.map((item) => (
            <p key={item.operationId}>
              {steerStatus[item.status]} · {item.prompt}
            </p>
          ))}
        </details>
      )}
      {saved.pending && (
        <div role="status">
          <p>交互结果待确认。原请求已保存在本机，重连不会自动重发。</p>
          <button
            type="button"
            disabled={busy || state.offline}
            onClick={() => run(() => controller.retryInteraction())}
          >
            重试原交互
          </button>
          <button
            type="button"
            disabled={busy || state.offline || !canDismiss}
            onClick={() => run(() => controller.dismissInteraction())}
          >
            关闭原交互记录
          </button>
        </div>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await controller.reloadDraft();
                dirty.current = false;
                savingVersion.current++;
                onDirty(false);
                setPanel(null);
                setError('');
              })
            }
          >
            重新读取交互草稿
          </button>
        </div>
      )}
      {question && (
        <QuestionPanel
          key={questionDraftKey(question.request)}
          item={question}
          values={
            saved.drafts[questionDraftKey(question.request)] ?? questionDefaults(question.request)
          }
          active={snapshot.activeId === question.request.expectedTurnId}
          busy={busy}
          pending={!!saved.pending}
          reason={reason || (snapshot.capabilities?.questions ? '' : '当前运行时不能回答此问题。')}
          onClose={close}
          onDraft={(values) => draft(() => controller.saveQuestionDraft(question.request, values))}
          onAnswer={(answer) => perform(() => controller.answerQuestion(question.request, answer))}
        />
      )}
      {panel && 'steer' in panel && (
        <SteerPanel
          draft={saved.steerDraft}
          reason={
            reason ||
            (snapshot.activeId !== panel.steer || !panel.steer
              ? '原回合已结束或改变，草稿不会转为新指令。'
              : !snapshot.capabilities?.steer
                ? snapshot.capabilities?.steerUnavailableReason || '当前运行时不支持回合内追加。'
                : '')
          }
          busy={busy}
          pending={saved.pending}
          closed={saved.closed}
          onClose={close}
          onDraft={(prompt) => draft(() => controller.saveSteerDraft(prompt))}
          onSubmit={(prompt) => perform(() => controller.steer(panel.steer, prompt))}
        />
      )}
    </section>
  );
}
