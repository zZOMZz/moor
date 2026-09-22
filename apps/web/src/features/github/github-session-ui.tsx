import { productCanonicalJson } from '@moor/protocol/canonical-json';
import { GithubPanel } from './github-ui';
import { GithubWritePanel } from './github-write-ui';
import type { GithubSessionController, GithubSessionState } from './github-session';
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
