import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { paint } from './ui';
import type { NotificationController, NotificationSubscriptionView } from './notifications';
import type { NotificationPreferences } from '../notification-protocol';
export type NotificationPanelProps = {
  controller?: NotificationController;
  reason?: string;
  onClose(): void;
  onRefresh(): void;
  onEnable(preferences: NotificationPreferences): void;
  onPreferences(preferences: NotificationPreferences): void;
  onDisable(record?: Pick<NotificationSubscriptionView, 'id' | 'endpointHash'>): void;
};
export function NotificationPanel(props: NotificationPanelProps) {
  const controller = props.controller;
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    completed: true,
    failed: true,
    approvals: true,
  });
  useEffect(() => {
    if (controller) setPreferences({ ...controller.preferences });
  }, [controller?.preferences]);
  const rows = new Map(
    (controller?.state?.subscriptions ?? [])
      .filter(
        (row) => row.enabled || controller?.pendingDisable.some((pending) => pending.id === row.id),
      )
      .map((row) => [row.id, row]),
  );
  for (const record of controller?.pendingDisable ?? [])
    if (!rows.has(record.id)) rows.set(record.id, { ...record, enabled: false, preferences });
  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog notification-panel">
          <div className="notification-heading">
            <Dialog.Title>通知设置</Dialog.Title>
            <button type="button" aria-label="关闭通知设置" onClick={props.onClose}>
              <X size={18} />
            </button>
          </div>
          <Dialog.Description>
            通知只提醒回合完成、失败或需要查看权限请求。点击提醒会重新读取会话，不会批准请求或发送指令。
          </Dialog.Description>
          {props.reason && <p role="status">{props.reason}</p>}
          {controller && (
            <>
              <p role="status">
                {controller.enabled
                  ? '此浏览器已开启通知。'
                  : controller.error
                    ? '通知设置尚待确认，请重新读取状态。'
                    : '此浏览器未开启通知。'}
                {controller.busy ? ' 正在确认…' : ''}
              </p>
              {controller.state?.reason && <p>{controller.state.reason}</p>}
              {controller.subscription?.disabledReason && (
                <p>订阅已停用：{controller.subscription.disabledReason}</p>
              )}
              <fieldset disabled={controller.busy || Boolean(props.reason)}>
                <legend>提醒类型</legend>
                {(
                  [
                    ['completed', '回合完成'],
                    ['failed', '回合失败'],
                    ['approvals', '需要查看权限请求'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={preferences[key]}
                      onChange={(event) =>
                        setPreferences((value) => ({ ...value, [key]: event.target.checked }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              {controller.preferencesPending && (
                <p role="status">当前选项已在本机生效，服务器尚未确认；请手动保存提醒类型。</p>
              )}
              {controller.error && <p role="alert">{controller.error}</p>}
              <div className="notification-actions">
                {controller.enabled ? (
                  <>
                    <button
                      disabled={controller.busy || Boolean(props.reason)}
                      onClick={() => props.onPreferences(preferences)}
                    >
                      保存提醒类型
                    </button>
                    <button disabled={controller.busy} onClick={() => props.onDisable()}>
                      关闭此浏览器通知
                    </button>
                  </>
                ) : (
                  <button
                    disabled={
                      controller.busy || !controller.state?.configured || Boolean(props.reason)
                    }
                    onClick={() => props.onEnable(preferences)}
                  >
                    在此浏览器开启通知
                  </button>
                )}
                {!controller.enabled && controller.browserSubscribed && (
                  <button disabled={controller.busy} onClick={() => props.onDisable()}>
                    清理此浏览器订阅
                  </button>
                )}
                <button disabled={controller.busy} onClick={props.onRefresh}>
                  重新读取状态
                </button>
              </div>
              {rows.size > 0 && (
                <div className="notification-records">
                  <h3>服务器订阅</h3>
                  <p>这里仅列出当前登录仍保留的服务器订阅。关闭记录不会开启通知。</p>
                  {[...rows.values()].map((row, index) => (
                    <div key={row.id}>
                      <span>
                        订阅 {index + 1}
                        {controller.subscription?.id === row.id ? ' · 此浏览器' : ''}
                        {controller.pendingDisable.some((pending) => pending.id === row.id)
                          ? ' · 停用待确认'
                          : row.enabled
                            ? ' · 服务器已开启'
                            : ' · 已关闭'}
                      </span>
                      <button disabled={controller.busy} onClick={() => props.onDisable(row)}>
                        {controller.pendingDisable.some((pending) => pending.id === row.id)
                          ? '重试关闭'
                          : '关闭订阅'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <p className="notification-footnote">
            iPhone 和 iPad
            需从主屏幕打开已安装的网页应用。系统省电、网络与通知权限可能延迟或阻止提醒；交付状态以重新读取的主机结果为准。
          </p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showNotificationPanel(props?: NotificationPanelProps) {
  paint('#notification-view', props ? <NotificationPanel {...props} /> : null);
}
