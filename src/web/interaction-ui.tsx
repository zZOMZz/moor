import { useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { QuestionAnswer, QuestionRequest } from '../interaction-protocol';
import type { SessionEventState } from '../runtime/session-events';
import { paint } from './ui';
import {
  answerFromDraft,
  informationHtml,
  questionStatus,
  questionDraftKey,
  type QuestionDraftValues,
  type QuestionItem,
  type PendingInteraction,
} from './interactions';

export type InteractionControlsProps = {
  questions: QuestionItem[];
  pending?: PendingInteraction;
  busy: boolean;
  reason: string;
  pendingMessage?: string;
  canDismiss: boolean;
  closedCount: number;
  onQuestion: (item: QuestionItem) => void;
  onInformation: () => void;
  onSteer: () => void;
  onRetry: () => void;
  onDismiss: () => void;
};
export function showInteractionControls(props: InteractionControlsProps | undefined) {
  paint('#interaction-controls', props ? <InteractionControls {...props} /> : null);
}
function InteractionControls(props: InteractionControlsProps) {
  return (
    <div className="interaction-controls">
      <div className="interaction-toolbar">
        <button type="button" onClick={props.onInformation}>
          命令、计划与用量
        </button>
        <button type="button" onClick={props.onSteer}>
          回合内追加
        </button>
        {props.questions.map((item) => (
          <button
            type="button"
            key={questionDraftKey(item.request)}
            onClick={() => props.onQuestion(item)}
          >
            回答问题 · {item.request.title ?? 'Agent 提问'}
          </button>
        ))}
      </div>
      {props.reason && <p className="muted">{props.reason}</p>}
      {props.pending && (
        <div className="interaction-outbox" role="status">
          <strong>
            {props.pending.kind === 'question' ? '问题回答' : '回合内追加'} · 结果待确认
          </strong>
          <p>{props.pendingMessage ?? '原请求已保存在此浏览器。刷新或重连不会自动重发。'}</p>
          <button type="button" disabled={props.busy || !!props.reason} onClick={props.onRetry}>
            {props.busy ? '正在确认…' : '手动重试原请求'}
          </button>
          {props.canDismiss && (
            <button type="button" disabled={props.busy} onClick={props.onDismiss}>
              关闭此待确认记录
            </button>
          )}
        </div>
      )}
      {props.closedCount > 0 && (
        <p className="muted">
          已关闭 {props.closedCount} 条本地交互记录；原请求及结果标记保留在“回合内追加”中。
        </p>
      )}
    </div>
  );
}
function InteractionDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog interaction-dialog">
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭" onClick={onClose}>
              <X />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export type QuestionPanelProps = {
  item: QuestionItem;
  values: QuestionDraftValues;
  active: boolean;
  busy: boolean;
  pending: boolean;
  reason: string;
  onClose: () => void;
  onDraft: (values: QuestionDraftValues) => Promise<void>;
  onAnswer: (answer: QuestionAnswer['answer']) => Promise<void>;
};
export function showQuestionPanel(props: QuestionPanelProps | undefined) {
  paint(
    '#interaction-view',
    props ? <QuestionPanel key={questionDraftKey(props.item.request)} {...props} /> : null,
  );
}
function QuestionPanel(props: QuestionPanelProps) {
  const [values, setValues] = useState(props.values),
    [error, setError] = useState('');
  const request = props.item.request;
  const editable = props.active && props.item.status === 'pending' && !props.pending && !props.busy;
  const visible = props.item.answer?.action === 'accept' ? props.item.answer.values : values;
  function change(id: string, value: QuestionDraftValues[string] | undefined) {
    const next = { ...values };
    if (value === undefined) delete next[id];
    else next[id] = value;
    setValues(next);
    setError('');
    void props.onDraft(next).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }
  async function answer(action: 'accept' | 'decline' | 'cancel') {
    setError('');
    try {
      await props.onAnswer(action === 'accept' ? answerFromDraft(request, values) : { action });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <InteractionDialog title={request.title ?? 'Agent 问题'} onClose={props.onClose}>
      <p className="interaction-message">{request.message}</p>
      {request.description && <p>{request.description}</p>}
      <p className="muted">
        {questionStatus[props.item.status]} · 此回答只匹配提问时的活动回合，与工具权限审批分别处理。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void answer('accept');
        }}
        noValidate
      >
        {request.fields.map((field, index) => {
          const id = 'agent-question-' + index,
            value = visible[field.id];
          return (
            <div className="question-field" key={field.id}>
              <label htmlFor={id}>
                {field.label}
                {field.required ? ' *' : '（可选）'}
              </label>
              {field.description && (
                <p id={id + '-description'} className="muted">
                  {field.description}
                </p>
              )}
              {field.kind === 'text' ? (
                <textarea
                  id={id}
                  aria-describedby={field.description ? id + '-description' : undefined}
                  disabled={!editable}
                  value={typeof value === 'string' ? value : ''}
                  maxLength={16000}
                  onChange={(e) => change(field.id, e.currentTarget.value)}
                  rows={3}
                />
              ) : field.kind === 'number' ? (
                <input
                  id={id}
                  type="number"
                  disabled={!editable}
                  min={field.minimum}
                  max={field.maximum}
                  step={field.integer ? 1 : 'any'}
                  value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                  onChange={(e) => change(field.id, e.currentTarget.value)}
                />
              ) : field.kind === 'boolean' ? (
                <select
                  id={id}
                  disabled={!editable}
                  value={value === true ? 'yes' : value === false ? 'no' : ''}
                  onChange={(e) =>
                    change(
                      field.id,
                      e.currentTarget.value === '' ? undefined : e.currentTarget.value === 'yes',
                    )
                  }
                >
                  <option value="">请选择</option>
                  <option value="yes">是</option>
                  <option value="no">否</option>
                </select>
              ) : field.kind === 'single-select' ? (
                <select
                  id={id}
                  disabled={!editable}
                  value={
                    typeof value === 'string' &&
                    field.options.some((option) => option.value === value)
                      ? String(field.options.findIndex((option) => option.value === value))
                      : ''
                  }
                  onChange={(e) =>
                    change(
                      field.id,
                      e.currentTarget.value === ''
                        ? undefined
                        : field.options[Number(e.currentTarget.value)]!.value,
                    )
                  }
                >
                  <option value="">请选择</option>
                  {field.options.map((option, i) => (
                    <option key={i} value={String(i)}>
                      {option.label}
                      {option.description ? ' — ' + option.description : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <fieldset disabled={!editable} id={id}>
                  <legend className="sr-only">{field.label}</legend>
                  {field.options.map((option, i) => (
                    <label className="question-choice" key={i}>
                      <input
                        type="checkbox"
                        checked={Array.isArray(value) && value.includes(option.value)}
                        onChange={(e) => {
                          const selected = Array.isArray(values[field.id])
                            ? (values[field.id] as string[])
                            : [];
                          change(
                            field.id,
                            e.currentTarget.checked
                              ? [...selected, option.value]
                              : selected.filter((v) => v !== option.value),
                          );
                        }}
                      />
                      <span>
                        {option.label}
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {field.kind === 'text' && (
                <small className="muted">
                  {field.minLength}–{field.maxLength} 个字符
                  {field.format ? ' · ' + field.format : ''}
                </small>
              )}
              {field.kind === 'number' && (
                <small className="muted">
                  {field.integer ? '整数' : '数值'} · {field.minimum}–{field.maximum}
                </small>
              )}
              {field.kind === 'multi-select' && (
                <small className="muted">
                  选择 {field.minItems}–{field.maxItems} 项
                </small>
              )}
            </div>
          );
        })}
        {error && (
          <p role="alert" className="interaction-warning">
            {error}
          </p>
        )}
        {(!props.active || props.item.status !== 'pending') && (
          <p className="muted">此问题已结束或不再属于当前活动回合，不能提交。</p>
        )}
        {props.reason && <p className="muted">{props.reason}</p>}
        {props.pending && (
          <p className="interaction-warning">
            原交互结果待确认，请先从会话中的待确认记录手动重试。
          </p>
        )}
        <div className="interaction-actions">
          <button type="submit" disabled={!editable || !!props.reason}>
            提交回答
          </button>
          <button
            type="button"
            disabled={!editable || !!props.reason}
            onClick={() => void answer('decline')}
          >
            拒绝回答
          </button>
          <button
            type="button"
            disabled={!editable || !!props.reason}
            onClick={() => void answer('cancel')}
          >
            取消此问题
          </button>
        </div>
      </form>
    </InteractionDialog>
  );
}
export type InformationPanelProps = {
  state: SessionEventState;
  canFill: boolean;
  onFill: (command: string) => Promise<void>;
  onClose: () => void;
};
export function showInformationPanel(props: InformationPanelProps) {
  paint('#interaction-view', <InformationPanel {...props} />);
}
function InformationPanel(props: InformationPanelProps) {
  const [error, setError] = useState('');
  return (
    <InteractionDialog title="Agent 命令、计划与用量" onClose={props.onClose}>
      <p className="muted">
        当前会话最近回合的实际运行时报告；离线显示已读历史。未提供的数据不可用。
      </p>
      <h3>可用命令</h3>
      <p className="muted">点击只会填入输入框。检查内容后，由你点击发送；不会自动执行。</p>
      <div className="agent-commands">
        {props.state.commands?.map((command) => (
          <button
            key={command.name}
            type="button"
            disabled={!props.canFill}
            onClick={() =>
              void props
                .onFill(command.name)
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            <strong>{command.name}</strong>
            <span>{command.description}</span>
            {command.input && <small>{command.input.hint}</small>}
          </button>
        )) ?? <p>Agent 尚未提供命令列表</p>}
        {props.state.commands?.length === 0 && <p>Agent 当前未提供可用命令</p>}
      </div>
      {error && <p role="alert">{error}</p>}
      <div dangerouslySetInnerHTML={{ __html: informationHtml(props.state) }} />
    </InteractionDialog>
  );
}
export type SteerPanelProps = {
  draft: string;
  reason: string;
  busy: boolean;
  pending?: PendingInteraction;
  closed: { operation: PendingInteraction; outcome: 'not-injected' | 'unknown'; message: string }[];
  onClose: () => void;
  onDraft: (value: string) => Promise<void>;
  onSubmit: (prompt: string) => Promise<void>;
};
export function showSteerPanel(props: SteerPanelProps) {
  paint('#interaction-view', <SteerPanel {...props} />);
}
function SteerPanel(props: SteerPanelProps) {
  const [draft, setDraft] = useState(props.draft),
    [error, setError] = useState('');
  return (
    <InteractionDialog title="追加到当前活动回合" onClose={props.onClose}>
      <p className="muted">
        追加仅面向提交时的活动回合。回合结束后，草稿不会转为新指令，也不会在重连后发送。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          void props
            .onSubmit(draft)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
        }}
      >
        <label htmlFor="steer-draft">追加说明</label>
        <textarea
          id="steer-draft"
          rows={5}
          maxLength={16000}
          disabled={props.busy || !!props.pending}
          value={draft}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setDraft(value);
            void props
              .onDraft(value)
              .catch((e) => setError(e instanceof Error ? e.message : String(e)));
          }}
        />
        {props.reason && <p className="interaction-warning">{props.reason}</p>}
        {props.pending && (
          <p className="interaction-warning">
            原交互结果待确认。关闭窗口后，可在会话中手动重试原请求。
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <button
          type="submit"
          disabled={!!props.reason || props.busy || !!props.pending || !draft.trim()}
        >
          追加到活动回合
        </button>
      </form>
      {props.closed.length > 0 && (
        <details className="interaction-closed">
          <summary>已关闭的本地交互记录 · {props.closed.length}</summary>
          {props.closed.map((record) => (
            <article key={record.operation.request.operationId}>
              <strong>{record.outcome === 'not-injected' ? '未进入活动回合' : '结果仍未知'}</strong>
              <p>{record.message}</p>
              <p>
                原操作：<code>{record.operation.request.operationId}</code>
              </p>
              <pre>
                {record.operation.kind === 'steer'
                  ? record.operation.request.prompt
                  : JSON.stringify(record.operation.request.answer, null, 2)}
              </pre>
            </article>
          ))}
        </details>
      )}
    </InteractionDialog>
  );
}
export function closeInteractionPanel() {
  paint('#interaction-view', null);
}
