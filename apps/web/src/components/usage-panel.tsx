import { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { AccountUsage } from '@moor/protocol/agent-usage';
import { sessionEventSchema } from '@moor/protocol/session-events';

export function latestContextUsage(history: readonly { items?: unknown[] | null }[]) {
  for (let i = history.length - 1; i >= 0; i--)
    for (const item of [...(history[i]?.items ?? [])].reverse()) {
      if (!item || typeof item !== 'object' || (item as any).type !== 'session_event') continue;
      const result = sessionEventSchema.safeParse((item as any).event);
      if (result.success && result.data.kind === 'context-usage') return result.data;
    }
  return undefined;
}
const percent = (value: number) => Math.min(100, Math.max(0, value));
const count = (n: number) =>
  n >= 10000
    ? `${(n / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })} 万`
    : n.toLocaleString();
export function resetLabel(seconds: number | null | undefined, now: number) {
  if (seconds == null) return '重置时间未提供';
  const minutes = Math.ceil((seconds * 1000 - now) / 60000);
  if (minutes <= 0) return '已到重置时间，等待更新';
  if (minutes >= 1440) return `${Math.ceil(minutes / 1440)} 天后重置`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置`;
  return `${minutes} 分钟后重置`;
}
export function UsagePanel({
  context,
  usage,
  loading,
  onRead,
  now: suppliedNow,
}: {
  context?: { used: number; size: number };
  usage?: AccountUsage;
  loading?: boolean;
  onRead?(): void;
  now?: number;
}) {
  const [open, setOpen] = useState(false),
    [clock, setClock] = useState(Date.now);
  const now = suppliedNow ?? clock;
  const read = useRef(onRead);
  read.current = onRead;
  useEffect(() => {
    const focus = () => {
      if (document.visibilityState !== 'hidden') read.current?.();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, []);
  useEffect(() => {
    if (!open || suppliedNow !== undefined) return;
    setClock(Date.now());
    const tick = setInterval(() => setClock(Date.now()), 60000);
    return () => clearInterval(tick);
  }, [open, suppliedNow]);
  const used =
    context && context.size > 0 ? percent((context.used / context.size) * 100) : undefined;
  const status = {
    unknown: '暂无额度数据',
    unsupported: '当前 Agent 未提供套餐额度',
    'signed-out': '请先在执行电脑登录 Agent',
    failed: '额度更新失败，显示最近数据',
    ready: usage?.buckets.some((b) => b.primary || b.secondary) ? '' : '当前账号未报告额度窗口',
  }[usage?.status ?? 'unknown'];
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) onRead?.();
      }}
    >
      <Popover.Trigger
        className="usage-trigger"
        aria-label={`上下文与账号额度${used === undefined ? '' : `，上下文已用 ${Math.round(used)}%`}`}
        title="上下文与账号额度"
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            opacity=".25"
            strokeWidth="2.5"
          />
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            pathLength="100"
            strokeDasharray={`${used ?? 0} 100`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span>{used === undefined ? '—' : `${Math.round(used)}%`}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="popup-positioner">
          <Popover.Popup className="menu-popup usage-panel">
            <Popover.Title className="usage-line">
              <span>上下文</span>
              <span>{used === undefined ? '暂无数据' : `已用 ${Math.round(used)}%`}</span>
            </Popover.Title>
            {used !== undefined && (
              <>
                <progress max={100} value={used} aria-label="上下文已用比例" />
                <p className="usage-detail">
                  {count(context!.used)} / {count(context!.size)} tokens
                </p>
              </>
            )}
            <div className="usage-account">
              <p>账号额度</p>
              {usage?.buckets.map((bucket) => (
                <section key={bucket.id}>
                  <div className="usage-bucket">
                    {bucket.name ?? bucket.id}
                    {bucket.model && <span> · {bucket.model}</span>}
                  </div>
                  {[bucket.primary, bucket.secondary].flatMap((window, index) => {
                    if (!window) return [];
                    const duration = window.windowDurationMins;
                    const label =
                      duration === 10080
                        ? '每周窗口'
                        : duration === 300
                          ? '5 小时窗口'
                          : duration
                            ? `${duration >= 60 && duration % 60 === 0 ? `${duration / 60} 小时` : `${duration} 分钟`}窗口`
                            : `额度窗口 ${index + 1}`;
                    const left = percent(100 - window.usedPercent);
                    return (
                      <div className="usage-window" key={index}>
                        <div className="usage-line">
                          <span>{label}</span>
                          <span>剩余 {Math.round(left)}%</span>
                        </div>
                        <progress max={100} value={left} aria-label={`${label}剩余比例`} />
                        <p
                          className="usage-detail"
                          title={
                            window.resetsAt == null
                              ? undefined
                              : new Date(window.resetsAt * 1000).toLocaleString()
                          }
                        >
                          {resetLabel(window.resetsAt, now)}
                          {window.resetsAt != null && (
                            <time dateTime={new Date(window.resetsAt * 1000).toISOString()}>
                              {' '}
                              ·{' '}
                              {new Date(window.resetsAt * 1000).toLocaleString([], {
                                month: 'numeric',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </time>
                          )}
                        </p>
                      </div>
                    );
                  })}
                </section>
              ))}
              {(loading || status) && (
                <p className="usage-detail" role="status">
                  {loading ? '正在读取额度…' : status}
                </p>
              )}
              {usage?.observedAt !== undefined && (
                <p className="usage-detail">
                  更新于{' '}
                  {new Date(usage.observedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
