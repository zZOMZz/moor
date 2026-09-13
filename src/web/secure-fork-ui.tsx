import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SecureCliTarget } from '../cli/secure-operation';
import type { GitStateResult } from '../git-protocol';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { SessionForkPanel } from './session-fork-ui';
import { SecureForkController, type SecureForkDependencies } from './secure-fork';

export type SecureForkUiHandle = {
  open(target: SecureCliTarget, view: { sourceTitle: string; turnId?: string }): Promise<void>;
  close(): void;
  confirmResourceCleanup(
    target: SecureCliTarget,
    childId: string,
    result: GitStateResult,
    current: () => void,
  ): Promise<void>;
};
export type SecureForkUiProps = SecureForkDependencies & { reason?: string; busy?: boolean };
export const SecureForkUI = forwardRef<SecureForkUiHandle, SecureForkUiProps>(
  function SecureForkUI(props, ref) {
    const latest = useRef(props);
    latest.current = props;
    const controller = useMemo(
      () =>
        new SecureForkController({
          storage: props.storage,
          context: () => latest.current.context(),
          request: (...args) => latest.current.request(...args),
          beforeWrite: (...args) => latest.current.beforeWrite(...args),
          changed: (...args) => latest.current.changed?.(...args),
          openChild: (...args) => latest.current.openChild(...args),
          openWorkspace: (...args) => latest.current.openWorkspace(...args),
          uuid: () => latest.current.uuid?.() ?? crypto.randomUUID(),
        }),
      [props.storage],
    );
    const [, render] = useState(0),
      [seal, setSeal] = useState('');
    useLayoutEffect(() => controller.subscribe(() => render((value) => value + 1)), [controller]);
    const context = productCanonicalJson(props.context());
    useLayoutEffect(() => controller.sync(), [controller, context]);
    useEffect(() => () => controller.dispose(), [controller]);
    useImperativeHandle(
      ref,
      () => ({
        open: (target, view) => controller.open(target, view),
        close: () => controller.close(),
        confirmResourceCleanup: (...args) => controller.confirmResourceCleanup(...args),
      }),
      [controller],
    );
    const state = controller.state;
    if (!state) return null;
    const run = (work: () => Promise<unknown>) => {
        void work().catch(() => {});
      },
      review = state.review;
    const busy = !!props.busy || state.opening || state.working,
      onlineBusy = busy || !state.online;
    const originalRecords = [
      ...(state.controller.operation
        ? [{ id: '', target: state.target, fork: state.controller, ending: state.ending }]
        : []),
      ...state.recoveries,
    ];
    return (
      <SessionForkPanel
        key={productCanonicalJson([state.target, review.panel])}
        controller={state.controller}
        sourceTitle={state.sourceTitle}
        initialTurnId={state.initialTurnId}
        working={onlineBusy}
        reason={
          !state.online
            ? '执行电脑离线。仅显示本机原记录，连接后请手动继续。'
            : state.plan
              ? '请核对下方完整 Fork 方案，再最终确认。'
              : props.reason
        }
        retryDisabled={state.ending}
        createLabel="审阅 Fork 方案"
        pendingDescription="原 Fork 结果待确认。核查只读取原结果；手动重试是单独的执行动作，沿用原编号和正文。刷新与重连不会执行。"
        onClose={() => controller.close()}
        onRefresh={(turnId) => run(() => controller.refresh(review, turnId))}
        onCreate={(cutoff, directory) => run(() => controller.prepare(review, cutoff, directory))}
        onRetry={() => run(() => controller.retry(review))}
        onOpenChild={() => run(() => controller.openChild(review))}
        onOpenWorkspace={(id) => run(() => controller.openWorkspace(review, id))}
      >
        {state.error && state.error !== state.controller.error && <p role="alert">{state.error}</p>}
        {state.notice && <p role="status">{state.notice}</p>}
        {state.opening && <p role="status">正在读取原 Fork 记录与能力。</p>}
        {state.working && <p role="status">正在完成原 Fork 操作，请稍候。</p>}
        {state.plan && (
          <section aria-label="最终 Fork 审阅">
            <h3>确认原生会话副本</h3>
            <p>
              源会话 {state.target.sessionId} · Agent {state.plan.options.agent.name}
            </p>
            <p>
              历史截止：
              {state.plan.cutoff.kind === 'current'
                ? 'Agent 当前已保存的原生上下文'
                : `完成回合 ${state.plan.cutoff.turnId}`}
            </p>
            <p>
              目录：
              {state.plan.directory.kind === 'same-directory'
                ? '沿用源会话目录，两份会话共享文件'
                : '创建独立 Git 工作目录'}
            </p>
            {state.plan.directory.kind === 'worktree' && (
              <>
                <p>基线分支 {state.plan.directory.baseBranch}</p>
                <code className="git-oid">{state.plan.directory.expectedOid}</code>
                <p>新分支 {state.plan.directory.newBranch}</p>
              </>
            )}
            <details>
              <summary>完整执行范围与已审阅能力</summary>
              <pre>{JSON.stringify({ target: state.target, ...state.plan }, null, 2)}</pre>
            </details>
            <p>创建会话与目录，不发送指令。源草稿、附件、MCP 和标注不会转移或自动执行。</p>
            <button disabled={onlineBusy} onClick={() => run(() => controller.confirm(review))}>
              确认创建原生会话副本
            </button>
            <button disabled={busy} onClick={() => controller.cancelPlan(review)}>
              返回修改 Fork 方案
            </button>
          </section>
        )}
        {!!originalRecords.length && (
          <section aria-label="Fork 原操作记录">
            <h3>Fork 原操作与保留目录</h3>
            {originalRecords.map((entry) => {
              const operation = entry.fork.operation,
                receipt = entry.fork.receipt,
                atSource = entry.target.sessionId === state.target.sessionId;
              const confirmation = productCanonicalJson([
                review.panel,
                entry.target,
                operation,
                receipt,
                entry.ending,
              ]);
              return (
                <article key={entry.id || 'current'}>
                  <p>
                    源会话 {entry.target.sessionId} · 原映射版本 {entry.target.product!.revision}
                  </p>
                  {!atSource && (
                    <p>请通过会话的“Fork 来源”返回源会话，打开已确认的副本或管理保留目录。</p>
                  )}
                  {operation && (
                    <details>
                      <summary>原操作与完整范围</summary>
                      <pre>
                        {JSON.stringify({ target: entry.target, operation, receipt }, null, 2)}
                      </pre>
                    </details>
                  )}
                  {entry.ending && (
                    <p role="status">封存意图已保存，请核查或继续封存；不会改为重试 Fork。</p>
                  )}
                  {receipt?.phase === 'abandoned' && (
                    <p role="status">主机已确认结束原操作；已生成的目录仍保留，需另行明确清理。</p>
                  )}
                  {entry.fork.cleanup && (
                    <p role="status">
                      {entry.fork.cleanup.disposition === 'detached'
                        ? '主机已确认此子会话脱离共享目录；原目录仍保留。'
                        : '主机已确认此子会话的工作目录已清理。'}
                      会话与 Fork 来源记录保留。
                    </p>
                  )}
                  {operation && (entry.fork.pending || entry.ending) && (
                    <>
                      <button
                        disabled={onlineBusy}
                        onClick={() =>
                          run(() => controller.recover(review, 'inspect', entry.id || undefined))
                        }
                      >
                        核查原 Fork 结果
                      </button>
                      <label>
                        <input
                          type="checkbox"
                          disabled={onlineBusy}
                          checked={seal === confirmation}
                          onChange={(event) => setSeal(event.target.checked ? confirmation : '')}
                        />
                        结束此原 Fork 的恢复；已生成的目录不会自动删除
                      </label>
                      <button
                        disabled={onlineBusy || seal !== confirmation}
                        onClick={() =>
                          run(() => controller.recover(review, 'abandon', entry.id || undefined))
                        }
                      >
                        封存原 Fork 操作
                      </button>
                    </>
                  )}
                  {entry.id && atSource && receipt?.phase === 'accepted' && (
                    <button
                      disabled={onlineBusy}
                      onClick={() => run(() => controller.openChild(review, entry.id))}
                    >
                      打开原记录已确认的副本
                    </button>
                  )}
                  {entry.id &&
                    atSource &&
                    receipt?.execution?.mode === 'worktree' &&
                    !entry.fork.cleanup && (
                      <button
                        disabled={onlineBusy}
                        onClick={() =>
                          run(() =>
                            controller.openWorkspace(review, receipt.childSessionId, entry.id),
                          )
                        }
                      >
                        查看原记录保留的目录
                      </button>
                    )}
                  {entry.id &&
                    atSource &&
                    entry.fork.resources.map((resource) => (
                      <button
                        key={resource.receipt.childSessionId}
                        disabled={onlineBusy}
                        onClick={() =>
                          run(() =>
                            controller.openWorkspace(
                              review,
                              resource.receipt.childSessionId,
                              entry.id,
                            ),
                          )
                        }
                      >
                        查看此前保留目录 ·{' '}
                        {resource.receipt.execution?.branch || resource.receipt.childSessionId}
                      </button>
                    ))}
                </article>
              );
            })}
          </section>
        )}
      </SessionForkPanel>
    );
  },
);
