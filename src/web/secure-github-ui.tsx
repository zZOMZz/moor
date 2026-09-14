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
import type { SecureCliTarget } from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { GithubPanel } from './github-ui';
import { GithubWritePanel } from './github-write-ui';
import {
  SecureGithubController,
  type GithubSessionController,
  type GithubSessionState,
  type SecureGithubDependencies,
  type SecureGithubMode,
  type SecureGithubState,
} from './secure-github';

export type SecureGithubUiHandle = {
  open(target: SecureCliTarget, mode?: SecureGithubMode): Promise<void>;
  close(): void;
};
function RecoveryPanel({
  state,
  controller,
  run,
}: {
  state: SecureGithubState;
  controller: SecureGithubController;
  run(action: () => Promise<unknown>): void;
}) {
  const [confirmed, setConfirmed] = useState(''),
    [page, setPage] = useState(1);
  const busy = state.working || !state.online;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && controller.close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog github-write-panel">
          <div className="github-heading">
            <Dialog.Title>原项目映射的 GitHub 记录</Dialog.Title>
            <button onClick={() => controller.close()}>关闭原记录</button>
          </div>
          <Dialog.Description>
            这些草稿和待确认请求保留原项目、副本与版本。核查不会再次发布；封存也不能撤销已经执行的远端操作。
          </Dialog.Description>
          <button
            disabled={state.working}
            onClick={() => run(() => controller.show(state.review, 'read'))}
          >
            当前仓库与会话上下文
          </button>
          <button
            disabled={state.working}
            onClick={() => run(() => controller.show(state.review, 'write'))}
          >
            当前项目的写入草稿
          </button>
          <button
            disabled={state.working}
            onClick={() => run(() => controller.refresh(state.review))}
          >
            重新读取本机原记录
          </button>
          {!state.online && <p role="status">执行电脑离线；本机原记录可查看，连接后请手动核查。</p>}
          {state.error && <p role="alert">{state.error}</p>}
          {!state.recoveries.length && <p>当前会话没有其他项目映射的 GitHub 记录。</p>}
          <label>
            原操作核查页码
            <input
              type="number"
              min={1}
              max={100}
              value={page}
              disabled={busy}
              onChange={(event) => setPage(Number(event.target.value))}
            />
          </label>
          {state.recoveries.map((entry) => {
            const request = entry.pending?.request || entry.binding?.request;
            const confirmation = productCanonicalJson([entry.id, request]);
            return (
              <section key={entry.id}>
                <h3>原{entry.binding ? '会话绑定' : '写入'}记录</h3>
                <p>
                  项目 {entry.target.product!.projectId} · 副本 {entry.target.product!.replicaId} ·
                  版本 {entry.target.product!.revision}
                </p>
                <details>
                  <summary>原执行范围</summary>
                  <pre className="github-body">{JSON.stringify(entry.target, null, 2)}</pre>
                </details>
                {entry.error && <p role="alert">{entry.error}</p>}
                {request && (
                  <>
                    <p>
                      操作 {request.operationId} · {request.action}
                    </p>
                    <details>
                      <summary>已保存的原请求</summary>
                      <pre className="github-body">{JSON.stringify(request, null, 2)}</pre>
                    </details>
                    {entry.pending && (
                      <button
                        disabled={busy || !Number.isInteger(page) || page < 1 || page > 100}
                        onClick={() =>
                          run(() => controller.recover(state.review, entry.id, 'inspect', page))
                        }
                      >
                        核查此原写入结果
                      </button>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={confirmed === confirmation}
                        onChange={(event) => setConfirmed(event.target.checked ? confirmation : '')}
                      />
                      结束此原操作核查；远端结果仍可能未知
                    </label>
                    <button
                      disabled={busy || confirmed !== confirmation}
                      onClick={() =>
                        run(() => controller.recover(state.review, entry.id, 'abandon'))
                      }
                    >
                      封存此原操作
                    </button>
                  </>
                )}
                {entry.receipt && (
                  <p role="status">
                    主机原回执：{entry.receipt.phase} · {entry.receipt.message}
                    {entry.receipt.released ? ' · 已结束本机核查' : ''}
                  </p>
                )}
                {!!Object.keys(entry.drafts || {}).length && (
                  <details>
                    <summary>查看保留在原映射的手工草稿</summary>
                    <p>原草稿只在此查看，不会自动转移到当前项目或重新发布。</p>
                    <pre className="github-body">{JSON.stringify(entry.drafts, null, 2)}</pre>
                  </details>
                )}
                {!request && !Object.keys(entry.drafts || {}).length && !entry.receipt && (
                  <p>原操作已确认或封存。</p>
                )}
              </section>
            );
          })}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const SecureGithubUI = forwardRef<SecureGithubUiHandle, SecureGithubDependencies>(
  function SecureGithubUI(props, ref) {
    const latest = useRef(props);
    latest.current = props;
    const controller = useMemo(
      () =>
        new SecureGithubController({
          context: () => latest.current.context(),
          storage: props.storage,
          request: (...args) => latest.current.request(...args),
          appendInstruction: (...args) => latest.current.appendInstruction(...args),
          beforeWrite: (...args) => latest.current.beforeWrite(...args),
          changed: (...args) => latest.current.changed?.(...args),
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
        open: (target, mode) => controller.open(target, mode),
        close: () => controller.close(),
      }),
      [controller],
    );
    const state = controller.state;
    if (!state) return null;
    const run = (action: () => Promise<unknown>) => {
      void action().catch(() => {});
    };
    const key = productCanonicalJson([state.target, state.review.panel, state.mode]);
    const recovery = state.recoveries.length
      ? () => run(() => controller.show(state.review, 'recovery'))
      : undefined;
    if (state.mode === 'recovery')
      return <RecoveryPanel key={key} state={state} controller={controller} run={run} />;
    return (
      <GithubSessionPanel
        state={state}
        controller={controller}
        location={state.target.hostDeviceId}
        recovery={recovery}
      />
    );
  },
);

/** The same read/write panels serve every transport; recovery labels belong to the caller. */
export function GithubSessionPanel<T>({
  state,
  controller,
  location,
  recovery,
}: {
  state: GithubSessionState<T>;
  controller: GithubSessionController<T>;
  location: string;
  recovery?: () => void;
}) {
  const run = (action: () => Promise<unknown>) => {
    void action().catch(() => {});
  };
  const close = () => controller.close();
  const key = productCanonicalJson([state.target, state.review.panel, state.mode]);
  const reason = state.opening
    ? '正在恢复 GitHub 本机记录并核对主机内容…'
    : !state.online
      ? '执行电脑离线，手工草稿已保留；连接后请手动操作。'
      : undefined;
  if (state.mode === 'read')
    return (
      <GithubPanel
        key={key}
        controller={state.read}
        reason={reason}
        canAdd={!!state.read.detail}
        adding={state.adding}
        onClose={close}
        onRefresh={() => run(() => controller.refresh(state.review))}
        onBranches={(page) => run(() => controller.branches(state.review, page))}
        onList={(view, status, page) =>
          run(() => controller.list(state.review, view, status, page))
        }
        onItem={(kind, number) => run(() => controller.item(state.review, kind, number))}
        onComments={(page) => run(() => controller.comments(state.review, page))}
        onChecks={(page) => run(() => controller.checks(state.review, page))}
        onClear={() => {
          try {
            controller.clear(state.review);
          } catch {}
        }}
        onBind={(branch) => run(() => controller.bind(state.review, branch))}
        onUnbind={() => run(() => controller.unbind(state.review))}
        onRetry={() => run(() => controller.retryBinding(state.review))}
        onAbandon={() => run(() => controller.abandonBinding(state.review))}
        onAdd={() => run(() => controller.add(state.review))}
        allowOfflineDrafts
        navigationDisabled={state.working || state.saving}
        onWrite={() => run(() => controller.show(state.review, 'write'))}
        onRecovery={recovery}
      />
    );
  return (
    <GithubWritePanel
      key={key}
      controller={state.write}
      canReviewDraft={state.online && !state.saving && !state.working}
      navigationDisabled={state.working || state.saving}
      reason={reason || (state.saving ? '手工草稿保存中，请保存完成后审阅。' : undefined)}
      location={location}
      onClose={close}
      onRead={() => run(() => controller.show(state.review, 'read'))}
      onRecovery={recovery}
      onRefresh={() => run(() => controller.refresh(state.review))}
      onBranches={(page) => run(() => controller.branches(state.review, page))}
      onPull={(view, page) => run(() => controller.pull(state.review, view, page))}
      onCommit={(paths) => run(() => controller.commitPreview(state.review, paths))}
      onPush={() => run(() => controller.pushPreview(state.review))}
      onCreate={async (kind, values) => {
        try {
          return await controller.createDraft(state.review, kind, values);
        } catch {
          return undefined;
        }
      }}
      onDraft={(draft) => {
        const displayed = state.write.drafts[draft.id];
        if (displayed) run(() => controller.saveDraft(state.review, displayed, draft));
      }}
      onRemove={(id) => run(() => controller.removeDraft(state.review, id))}
      onPrepare={(id) => run(() => controller.prepare(state.review, id))}
      onConfirm={() => run(() => controller.confirm(state.review))}
      onCancelReview={() => {
        try {
          controller.cancelReview(state.review);
        } catch {}
      }}
      onInspect={(page) => run(() => controller.inspect(state.review, page))}
      onAbandon={() => run(() => controller.abandon(state.review))}
    />
  );
}
