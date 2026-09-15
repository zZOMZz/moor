import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { SecureCliTarget } from '@moor/client/secure-operation';
import { productCanonicalJson } from '@moor/client/encrypted-product';
import { GitWorkspacePanel } from './git-workspace-ui';
import {
  SecureGitController,
  type SecureGitDependencies,
  type SecureGitOpenOptions,
  type SecureGitState,
} from './secure-git';

export type SecureGitUiHandle = {
  open(target: SecureCliTarget, options?: SecureGitOpenOptions): Promise<void>;
  close(): void;
};
function RecoveryPanel({
  state,
  controller,
  run,
}: {
  state: SecureGitState;
  controller: SecureGitController;
  run(task: () => Promise<unknown>): void;
}) {
  const [consent, setConsent] = useState('');
  const busy = state.working || !state.online;
  const latest = useRef({ consent, busy });
  latest.current = { consent, busy };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && controller.close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog git-workspace-panel">
          <Dialog.Title>原项目映射的 Git 记录</Dialog.Title>
          <Dialog.Description>
            保留原项目、副本版本与目录请求。核查不会重新创建或清理目录；封存不能撤销已经执行的操作。
          </Dialog.Description>
          <button onClick={() => controller.close()}>关闭原 Git 记录</button>
          <button
            disabled={state.working}
            onClick={() => run(() => controller.show(state.review, 'read'))}
          >
            当前工作目录
          </button>
          <button
            disabled={state.working}
            onClick={() => run(() => controller.refresh(state.review))}
          >
            重新读取本机原 Git 记录
          </button>
          {state.error && <p role="alert">{state.error}</p>}
          {!state.online && <p role="status">执行电脑离线；原记录可查看，连接后请手动核查。</p>}
          {!state.recoveries.length && <p>此会话没有其他项目映射的 Git 操作记录。</p>}
          {state.recoveries.map((entry) => {
            const request = entry.pending?.request,
              key = productCanonicalJson([entry.id, request]);
            return (
              <section key={entry.id}>
                <h3>
                  原目录操作 · {entry.target.product!.projectId} · {entry.target.product!.replicaId}{' '}
                  · 版本 {entry.target.product!.revision}
                </h3>
                <details>
                  <summary>原 Git 执行范围</summary>
                  <pre className="github-body">{JSON.stringify(entry.target, null, 2)}</pre>
                </details>
                {entry.error && <p role="alert">{entry.error}</p>}
                {request && (
                  <>
                    <p>
                      操作 {request.operationId} · {request.action}
                    </p>
                    <details>
                      <summary>已保存的原目录请求</summary>
                      <pre className="github-body">{JSON.stringify(request, null, 2)}</pre>
                    </details>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(() => controller.recover(state.review, 'inspect', entry.id))
                      }
                    >
                      核查此原 Git 操作
                    </button>
                    <label>
                      <input
                        type="checkbox"
                        checked={consent === key}
                        disabled={busy}
                        onChange={(event) => setConsent(event.target.checked ? key : '')}
                      />
                      我确认封存此原目录请求；已经执行的操作不会撤销
                    </label>
                    <button
                      disabled={busy || consent !== key}
                      onClick={() => {
                        if (!latest.current.busy && latest.current.consent === key)
                          run(() => controller.recover(state.review, 'abandon', entry.id));
                      }}
                    >
                      封存此原 Git 操作
                    </button>
                  </>
                )}
                {entry.receipt && (
                  <p role="status">
                    原操作 {entry.receipt.operationId} ·{' '}
                    {
                      {
                        accepted: '主机已确认',
                        rejected: '主机已拒绝',
                        unknown: '结果仍未知',
                        abandoned: '原请求已封存',
                      }[entry.receipt.phase]
                    }{' '}
                    · {entry.receipt.message}
                  </p>
                )}
                {entry.state && (
                  <details>
                    <summary>原目录最后读取的状态</summary>
                    <pre className="github-body">{JSON.stringify(entry.state, null, 2)}</pre>
                  </details>
                )}
              </section>
            );
          })}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export const SecureGitUI = forwardRef<
  SecureGitUiHandle,
  SecureGitDependencies & { busy?: boolean }
>(function SecureGitUI(props, ref) {
  const latest = useRef(props);
  latest.current = props;
  const controller = useMemo(
    () =>
      new SecureGitController({
        context: () => latest.current.context(),
        storage: props.storage,
        request: (...args) => latest.current.request(...args),
        resourceRequest: (...args) => {
          if (!latest.current.resourceRequest) throw Error('尚未提供 Fork 资源验证入口。');
          return latest.current.resourceRequest(...args);
        },
        beforeWrite: (...args) => latest.current.beforeWrite(...args),
        beforeResourceWrite: (...args) => {
          if (!latest.current.beforeResourceWrite) throw Error('尚未提供 Fork 资源写入验证入口。');
          return latest.current.beforeResourceWrite(...args);
        },
        changed: (...args) => latest.current.changed?.(...args),
        onPrepared: (...args) => latest.current.onPrepared?.(...args),
        onRefresh: (...args) => latest.current.onRefresh?.(...args),
        onNewSession: (...args) => latest.current.onNewSession?.(...args),
        onWrite: (...args) => latest.current.onWrite?.(...args),
        uuid: () => latest.current.uuid?.() ?? crypto.randomUUID(),
      }),
    [props.storage],
  );
  const [, render] = useState(0);
  useLayoutEffect(() => controller.subscribe(() => render((value) => value + 1)), [controller]);
  const contextKey = productCanonicalJson(props.context());
  useLayoutEffect(() => controller.sync(), [controller, contextKey]);
  useEffect(() => () => controller.dispose(), [controller]);
  useImperativeHandle(
    ref,
    () => ({
      open: (target, options) => controller.open(target, options),
      close: () => controller.close(),
    }),
    [controller],
  );
  const currentState = controller.state;
  if (!currentState) return null;
  const state = { ...currentState, working: currentState.working || props.busy === true };
  const run = (task: () => Promise<unknown>) => {
    if (latest.current.busy) return;
    void task().catch(() => {});
  };
  const key = productCanonicalJson([state.target, state.review.panel, state.mode]);
  const resourceFinished = Boolean(
    state.options.resource &&
    state.git.execution?.status === 'removed' &&
    !state.git.pending &&
    !state.recoveries.some((entry) => entry.pending),
  );
  if (state.mode === 'recovery' && !resourceFinished)
    return <RecoveryPanel key={key} state={state} controller={controller} run={run} />;
  return (
    <GitWorkspacePanel
      key={key}
      controller={state.git}
      newSession={state.options.newSession}
      reason={
        state.opening
          ? '正在恢复原 Git 记录并核对主机目录…'
          : resourceFinished
            ? '此 Fork 保留目录已确认结束，资源操作已完成。请关闭此面板返回会话。'
            : props.busy
              ? '当前会话操作或草稿保存中，请完成后操作 Git。'
              : !state.online
                ? '执行电脑离线；原记录可查看，连接后请手动操作。'
                : undefined
      }
      location={
        <>
          <p>
            {state.options.resource
              ? `Fork 子会话资源 ${state.target.sessionId}`
              : `会话 ${state.target.sessionId}`}{' '}
            · 执行电脑 {state.target.hostDeviceId}
          </p>
          <details>
            <summary>本次 Git 执行范围</summary>
            <pre className="github-body">{JSON.stringify(state.target, null, 2)}</pre>
          </details>
          {state.options.resource && (
            <details>
              <summary>Fork 原资源来源</summary>
              <pre className="github-body">{JSON.stringify(state.options.resource, null, 2)}</pre>
            </details>
          )}
        </>
      }
      confirmationKey={productCanonicalJson([state.target, state.git.state, state.git.execution])}
      navigationDisabled={state.working || resourceFinished}
      onClose={() => controller.close()}
      onRefresh={() => run(() => controller.refresh(state.review))}
      onPrepare={(branch, oid, name) =>
        run(() => controller.prepare(state.review, branch, oid, name))
      }
      onRemove={() => run(() => controller.remove(state.review))}
      onDetach={() => run(() => controller.detach(state.review))}
      onRetry={() => run(() => controller.recover(state.review, 'inspect'))}
      onInspect={() => run(() => controller.recover(state.review, 'inspect'))}
      onAbandon={() => run(() => controller.recover(state.review, 'abandon'))}
      onRecovery={
        state.recoveries.length && !resourceFinished
          ? () => run(() => controller.show(state.review, 'recovery'))
          : undefined
      }
      onNewDraft={() => run(() => controller.navigate(state.review, 'new-session'))}
      onWrite={
        !state.options.resource && props.onWrite
          ? () => run(() => controller.navigate(state.review, 'write'))
          : undefined
      }
    />
  );
});
