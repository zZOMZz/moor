import {
  ArrowLeft,
  CheckCheck,
  CircleCheck,
  CirclePause,
  Inbox,
  Laptop,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { AttentionItem } from '../attention';
import { useLayoutEffect, useRef } from 'react';
import {
  attentionCategory,
  attentionGroups,
  attentionPending,
  type AttentionController,
  type AttentionRoute,
} from './attention';

const labels = ['等待审批', '失败与中断', '需要继续', '待检查'];
const historyLabels = ['审批记录', '异常记录', '检查记录', '检查记录'];
const date = (timestamp: number | null | undefined) =>
  timestamp
    ? new Date(timestamp).toLocaleString([], {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '时间未知';
const causeLabels: Record<string, string> = {
  agent_returned: '执行结束',
  execution_failed: '执行失败',
  host_stopped: '主机停止',
  host_restarted: '主机重启中断',
  user_canceled: '用户已停止',
  unknown: '结束原因未知',
};
function status(item: AttentionItem) {
  if (item.kind === 'permission')
    return item.lifecycle === 'active'
      ? '等待审批'
      : item.lifecycle === 'resolved'
        ? '已回应'
        : '请求已失效';
  return item.disposition === 'checked'
    ? '检查完成'
    : item.disposition === 'continued'
      ? '已继续'
      : item.disposition === 'needs_followup'
        ? '需要继续'
        : '待检查';
}
function textExcerpt(turn: unknown) {
  if (!turn || typeof turn !== 'object') return '此回合没有可显示的正文。';
  const value = turn as { items?: unknown[]; inputConfig?: { prompt?: unknown } };
  const text =
    (value.items ?? [])
      .flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const candidate = item as { text?: unknown; content?: unknown };
        return typeof candidate.text === 'string'
          ? [candidate.text]
          : typeof candidate.content === 'string'
            ? [candidate.content]
            : [];
      })
      .join('\n\n') ||
    (typeof value.inputConfig?.prompt === 'string'
      ? value.inputConfig.prompt
      : '此回合没有可显示的正文。');
  return text.length > 24000 ? text.slice(0, 24000) + '\n…请打开原会话阅读完整内容。' : text;
}
function ItemIcon({ item }: { item: AttentionItem }) {
  return !attentionPending(item) ? (
    <CheckCheck />
  ) : item.kind === 'permission' ? (
    <ShieldCheck />
  ) : attentionCategory(item) === 1 ? (
    <CirclePause />
  ) : (
    <CircleCheck />
  );
}
export function AttentionWorkbench({
  controller,
  onOpenSession,
}: {
  controller: AttentionController;
  onOpenSession: (route: AttentionRoute, sessionId: string, turnId?: string) => Promise<void>;
}) {
  const state = controller.state,
    context = state.context,
    detail = state.detail,
    target = controller.target();
  const act = (work: () => Promise<unknown>) => {
    void work().catch((cause) => controller.report(cause));
  };
  const groups = attentionGroups(state.lists, state.projectFilter, state.hostFilter);
  const covered = state.lists.filter((list) => list.page && !list.cached).length;
  const available = controller.canWrite() && state.detailFresh && !state.busy && !state.pending;
  const selectedGroup = state.lists
    .find((list) => list.target.replicaId === state.selected?.replicaId)
    ?.page?.sessions.find((group) => group.sessionId === state.selected?.sessionId);
  const rootRef = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const listScroll = useRef(0);
  const selectedRow = useRef('');
  const wasDetailOpen = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current,
      scroller = root?.closest<HTMLElement>('#attention-view');
    if (!root || !scroller || root.getBoundingClientRect().width > 590) return;
    if (state.detailOpen) {
      scroller.scrollTop = 0;
      detailHeading.current?.focus({ preventScroll: true });
    } else if (wasDetailOpen.current) {
      scroller.scrollTop = listScroll.current;
      const row = [...root.querySelectorAll<HTMLButtonElement>('[data-attention-row]')].find(
        (button) => button.dataset.attentionRow === selectedRow.current,
      );
      (row ?? listHeading.current)?.focus({ preventScroll: true });
    }
    wasDetailOpen.current = state.detailOpen;
  }, [state.detailOpen, detail?.item.itemId]);
  return (
    <div ref={rootRef} className={`attention-workbench ${state.detailOpen ? 'detail-open' : ''}`}>
      <header className="attention-heading">
        <h1 ref={listHeading} tabIndex={-1}>
          待我处理
        </h1>
        <p>
          {context?.workspaceName ?? '工作区'} ·{' '}
          {context?.actor.kind === 'local' ? '本机工作区' : '我的所有电脑'}
        </p>
      </header>
      <div className="attention-toolbar">
        <div className="attention-tabs" role="group" aria-label="事项状态">
          <button
            type="button"
            aria-pressed={state.view === 'pending'}
            onClick={() => act(() => controller.setView('pending'))}
          >
            待我处理
          </button>
          <button
            type="button"
            aria-pressed={state.view === 'processed'}
            onClick={() => act(() => controller.setView('processed'))}
          >
            已处理
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新待办"
          onClick={() => act(() => controller.refresh())}
        >
          <RefreshCw />
        </button>
      </div>
      <div className="attention-filters">
        <label>
          项目
          <select
            aria-label="待办项目筛选"
            value={state.projectFilter}
            onChange={(e) => controller.filter(e.target.value, state.hostFilter)}
          >
            <option value="">全部项目</option>
            {[
              ...new Map(context?.targets.map((t) => [t.projectId, t.projectName]) ?? []).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          电脑
          <select
            aria-label="待办电脑筛选"
            value={state.hostFilter}
            onChange={(e) => controller.filter(state.projectFilter, e.target.value)}
          >
            <option value="">全部电脑</option>
            {[
              ...new Map(
                context?.targets.map((t) => [t.executionDeviceId, t.hostName]) ?? [],
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="attention-coverage" role="status">
        {state.lists.some((list) => list.loading) ? '正在读取待办… ' : ''}
        已同步 {covered}/{state.lists.length} 个项目副本
        {state.lists.some((list) => list.cached && list.page) ? ' · 部分内容来自缓存' : ''}
        {state.lists.some((list) => !list.page && !list.loading) ? ' · 部分待办状态未知' : ''}
        {controller.total() !== undefined ? ` · 当前分类 ${controller.total()} 个会话` : ''}
      </p>
      {state.error && (
        <p className="attention-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="attention-columns">
        <section className="attention-list" aria-label="待办会话列表">
          {labels.map((label, category) => {
            const rows = groups.filter((row) => row.category === category);
            return rows.length ? (
              <section className="attention-group" key={category}>
                <h2>
                  {state.view === 'processed' ? historyLabels[category] : label}
                  <span>已加载 {rows.length} 个会话</span>
                </h2>
                {rows.map(({ group, target: rowTarget, cached }) => {
                  const first = [...group.items].sort(
                    (a, b) => attentionCategory(a) - attentionCategory(b),
                  )[0];
                  if (!first) return null;
                  return (
                    <button
                      type="button"
                      className="attention-row"
                      data-attention-row={JSON.stringify([rowTarget.replicaId, group.sessionId])}
                      key={JSON.stringify([rowTarget.replicaId, group.sessionId])}
                      aria-current={
                        state.selected?.replicaId === rowTarget.replicaId &&
                        state.selected.sessionId === group.sessionId
                          ? 'true'
                          : undefined
                      }
                      onClick={() => {
                        listScroll.current =
                          rootRef.current?.closest<HTMLElement>('#attention-view')?.scrollTop ?? 0;
                        selectedRow.current = JSON.stringify([
                          rowTarget.replicaId,
                          group.sessionId,
                        ]);
                        act(() =>
                          controller.open({
                            replicaId: rowTarget.replicaId,
                            sessionId: group.sessionId,
                            itemId: first.itemId,
                          }),
                        );
                      }}
                    >
                      <span className="attention-row-title">
                        <ItemIcon item={first} />
                        <span>{group.title || '会话'}</span>
                      </span>
                      <small>
                        {rowTarget.projectName} · {rowTarget.hostName}
                      </small>
                      <span className="attention-row-summary">
                        {first.summary || status(first)}
                      </span>
                      <small>
                        {status(first)}
                        {group.itemCount > 1 ? ` · 另有 ${group.itemCount - 1} 项` : ''}
                        {group.isArchived ? ' · 会话已归档' : ''}
                      </small>
                      <small>
                        {date(first.occurredAt)}
                        {cached ? ' · 缓存' : ''}
                        {first.seenRevision < first.eventRevision ? ' · 未查看' : ''}
                      </small>
                    </button>
                  );
                })}
              </section>
            ) : null;
          })}
          {!groups.length && (
            <div className="attention-empty">
              <Inbox />
              <p>
                {state.lists.some((list) => list.loading)
                  ? '正在读取…'
                  : state.lists.every((list) => !!list.page)
                    ? '当前没有符合条件的事项。'
                    : '等待执行电脑连接，不能确定是否有待办。'}
              </p>
            </div>
          )}
          {state.lists.map((list) => (
            <div className="attention-source-state" key={list.target.replicaId}>
              {list.error && (
                <p>
                  {list.target.projectName} · {list.target.hostName}：{list.error}
                  {list.cached && list.syncedAt ? ` 最后同步 ${date(list.syncedAt)}` : ''}
                </p>
              )}
              {list.page?.nextCursor && (
                <button
                  type="button"
                  disabled={list.loading || !context?.connected || !list.target.online}
                  onClick={() => act(() => controller.more(list.target.replicaId))}
                >
                  加载更多 · {list.target.projectName} / {list.target.hostName}
                </button>
              )}
            </div>
          ))}
        </section>
        <section className="attention-detail" aria-label="待办事项详情">
          <button type="button" className="attention-back" onClick={() => controller.back()}>
            <ArrowLeft />
            返回列表
          </button>
          {!detail ? (
            <p className="attention-empty">
              {state.detailLoading
                ? '正在读取事项…'
                : state.selected
                  ? '当前设备尚未缓存详情，请连接主机后刷新。'
                  : '选择一个事项，查看原始请求或执行结果。'}
            </p>
          ) : (
            <>
              <p className="attention-detail-status">
                <ItemIcon item={detail.item} />
                {status(detail.item)}
                {!state.detailFresh ? ' · 缓存内容' : ''}
              </p>
              <h2 ref={detailHeading} tabIndex={-1}>
                {detail.title || '会话'}
              </h2>
              <p>{detail.item.summary}</p>
              <dl className="attention-facts">
                <dt>执行电脑</dt>
                <dd>
                  {target?.hostName} · {controller.canWrite() ? '在线' : '不可用'}
                </dd>
                <dt>项目</dt>
                <dd>{target?.projectName}</dd>
                <dt>产生时间</dt>
                <dd>{date(detail.item.occurredAt)}</dd>
                <dt>执行事实</dt>
                <dd>
                  {detail.item.kind === 'permission'
                    ? status(detail.item)
                    : causeLabels[detail.item.cause ?? 'unknown']}
                  {detail.isArchived ? ' · 会话已归档' : ''}
                </dd>
              </dl>
              {target && (
                <button
                  type="button"
                  className="attention-text-button"
                  onClick={() =>
                    act(() =>
                      onOpenSession(target, detail.item.sessionId, detail.item.assistantTurnId),
                    )
                  }
                >
                  打开原会话
                </button>
              )}
              {target && detail.item.followupUserTurnId && (
                <button
                  type="button"
                  className="attention-text-button"
                  onClick={() =>
                    act(() =>
                      onOpenSession(target, detail.item.sessionId, detail.item.followupUserTurnId),
                    )
                  }
                >
                  打开后续回合
                </button>
              )}
              {selectedGroup && selectedGroup.items.length > 1 && (
                <div className="attention-item-picker" role="group" aria-label="此会话的事项">
                  {selectedGroup.items.map((item, index) => (
                    <button
                      key={item.itemId}
                      type="button"
                      aria-pressed={item.itemId === detail.item.itemId}
                      onClick={() =>
                        act(() =>
                          controller.open({
                            replicaId: target!.replicaId,
                            sessionId: item.sessionId,
                            itemId: item.itemId,
                          }),
                        )
                      }
                    >
                      {index + 1} · {status(item)}
                    </button>
                  ))}
                </div>
              )}
              {selectedGroup?.nextItemsCursor && (
                <button
                  type="button"
                  disabled={!controller.canWrite() || state.busy}
                  onClick={() => act(() => controller.moreItems())}
                >
                  加载更多事项（已加载 {selectedGroup.items.length}/{selectedGroup.itemCount}）
                </button>
              )}
              <section className="attention-context">
                <h3>{detail.item.kind === 'permission' ? '原始审批请求' : '对应回合'}</h3>
                {detail.item.kind === 'permission' ? (
                  <>
                    <pre>
                      {JSON.stringify(
                        detail.permission?.toolCall ?? '该请求已不再活动，请查看原会话。',
                        null,
                        2,
                      )}
                    </pre>
                    <small>仅对本次活动回合和原请求有效。</small>
                    <details>
                      <summary>请求标识</summary>
                      <code>{detail.item.requestId}</code>
                    </details>
                  </>
                ) : (
                  <>
                    <details>
                      <summary>用户输入 · 原回合</summary>
                      <pre>{textExcerpt(detail.userTurn)}</pre>
                    </details>
                    <details open>
                      <summary>Agent 回复 · 原回合</summary>
                      <pre>{textExcerpt(detail.turn)}</pre>
                    </details>
                    <small>内容摘录自对应回合；执行结束不代表结果已验收。</small>
                  </>
                )}
              </section>
              {state.pending ? (
                <div className="attention-receipt" role="status">
                  <p>
                    {state.busy ? '正在等待主机确认…' : '结果待确认。原决定已保留，请手动重试。'}
                  </p>
                  <button
                    type="button"
                    disabled={
                      state.busy ||
                      !controller.canWrite(state.pending.operation.kind === 'continue')
                    }
                    onClick={() => act(() => controller.retry())}
                  >
                    重试确认
                  </button>
                </div>
              ) : (
                <>
                  {detail.item.kind === 'permission' &&
                    detail.permission &&
                    detail.item.lifecycle === 'active' && (
                      <div className="attention-actions">
                        {detail.permission.options.map((option) => (
                          <button
                            type="button"
                            key={option.optionId}
                            disabled={!available}
                            onClick={() => act(() => controller.permission(option.optionId))}
                          >
                            {option.name}
                          </button>
                        ))}
                        <button
                          type="button"
                          disabled={!available}
                          onClick={() => act(() => controller.permission(null))}
                        >
                          取消请求
                        </button>
                      </div>
                    )}
                  {detail.item.kind === 'outcome' && (
                    <div className="attention-actions">
                      {attentionPending(detail.item) ? (
                        <>
                          <button
                            type="button"
                            disabled={!available}
                            onClick={() => act(() => controller.disposition('checked'))}
                          >
                            检查完成
                          </button>
                          <button
                            type="button"
                            disabled={state.busy}
                            onClick={() => act(() => controller.createDraft())}
                          >
                            需要继续
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={!available}
                          onClick={() => act(() => controller.disposition('pending'))}
                        >
                          重新处理
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
              {!controller.canWrite() && (
                <p className="attention-help">离线可读缓存、写本机草稿；连接恢复后不会自动提交。</p>
              )}
              {state.seenPending && (
                <div className="attention-help" role="status">
                  <p>已查看标记尚待确认，不影响审批和处理。</p>
                  <button
                    type="button"
                    disabled={state.seenBusy || !controller.canWrite()}
                    onClick={() => act(() => controller.retrySeen())}
                  >
                    重试已查看标记
                  </button>
                </div>
              )}
              {state.notice && (
                <p className="attention-receipt" role="status">
                  {state.notice}
                </p>
              )}
              {state.draft && (
                <section className="attention-draft">
                  <label htmlFor="attention-draft">继续草稿</label>
                  <p className="attention-help">
                    <Laptop />
                    仅此设备 · 尚未发送
                  </p>
                  <textarea
                    id="attention-draft"
                    readOnly={state.busy || state.pending?.operation.kind === 'continue'}
                    value={state.draft.text}
                    onChange={(e) => controller.editDraft(e.target.value)}
                  />
                  {state.draft.insertion && (
                    <div className="attention-draft-insertion">
                      <p>原会话已有草稿，已保留原文。以下补充内容可手动合并：</p>
                      <pre>{state.draft.insertion}</pre>
                      <button type="button" onClick={() => controller.mergeDraft()}>
                        合并到草稿末尾
                      </button>
                    </div>
                  )}
                  <p className="attention-help">
                    {state.draft.saved
                      ? state.draft.shared
                        ? '草稿已保存；同账号设备只共享“需要继续”状态。'
                        : '草稿已保存；共享标记尚未提交。'
                      : '保存成功后，再向主机提交“需要继续”状态。'}
                  </p>
                  <div className="attention-actions">
                    <button
                      type="button"
                      disabled={state.busy}
                      onClick={() => act(() => controller.saveDraft())}
                    >
                      保存草稿
                    </button>
                    {state.draft.saved && !state.draft.shared && (
                      <button
                        type="button"
                        disabled={!available}
                        onClick={() => act(() => controller.disposition('needs_followup'))}
                      >
                        提交需要继续
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={
                        !available ||
                        !controller.canWrite(true) ||
                        !state.draft.saved ||
                        !state.draft.text.trim() ||
                        detail.isArchived
                      }
                      onClick={() => act(() => controller.sendContinue())}
                    >
                      发送后续要求
                    </button>
                  </div>
                  {detail.isArchived && (
                    <p className="attention-help">请先打开原会话恢复，再发送后续要求。</p>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
