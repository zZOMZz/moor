import { DEFAULT_NOTIFICATION_PREFERENCES, pushSubscriptionSchema } from '../notification-protocol';
import { deadline } from './deadline';
import { notificationLocal, rememberNotification } from './notification-storage';
import { pushEndpointHash, type NotificationBrowser } from './notifications';
export function browserNotificationReason() {
  if (!globalThis.isSecureContext) return '通知需要 HTTPS 安全连接。';
  if (!('Notification' in globalThis) || !('PushManager' in globalThis) || !navigator.serviceWorker)
    return '此浏览器尚不支持网页推送；iPhone 和 iPad 请先添加到主屏幕，再从主屏幕打开。';
  if (!navigator.locks) return '此浏览器暂不支持通知设置，请更新浏览器后重试。';
  return '';
}
async function registration(create = false) {
  if (!navigator.serviceWorker) return undefined;
  let current = await navigator.serviceWorker.getRegistration('/');
  if (!current && create) current = await navigator.serviceWorker.register('/sw.js');
  if (current && !current.active)
    return deadline(navigator.serviceWorker.ready, 10000, '后台通知组件尚未就绪，请重试。');
  return current;
}
async function sendBinding(
  owner?: string,
  preferences = DEFAULT_NOTIFICATION_PREFERENCES,
  expectedRevision?: number,
) {
  // An explicit disable must be durable even if the worker cannot acknowledge.
  const state = owner
    ? await notificationLocal()
    : await notificationLocal((state) => {
        if (expectedRevision !== undefined && state.revision !== expectedRevision)
          throw new Error('通知设置已改变，请重试关闭。');
        return { ...state, revision: state.revision + 1, binding: undefined };
      });
  if (owner && expectedRevision !== undefined && state.revision !== expectedRevision)
    throw new Error('通知设置已改变，旧的开启操作已取消。');
  const current = await registration(Boolean(owner));
  if (!current?.active) {
    if (owner) throw new Error('后台通知组件尚未就绪。');
    return;
  }
  const channel = new MessageChannel();
  try {
    await deadline(
      new Promise<void>((resolve, reject) => {
        channel.port1.onmessage = (event) =>
          event.data?.ok === true ? resolve() : reject(new Error('后台通知设置未获确认。'));
        current.active!.postMessage(
          {
            type: 'moor:notification-binding',
            expectedRevision: owner ? (expectedRevision ?? state.revision) : state.revision,
            ...(owner ? { owner, preferences } : {}),
          },
          [channel.port2],
        );
      }),
      10000,
      '后台通知设置确认超时。',
    );
  } catch (cause) {
    if (owner) {
      // A missing ACK is not success. Invalidate this attempt before releasing
      // the page lock, including a worker still waiting for its identity read.
      await notificationLocal((latest) => {
        if (
          latest.revision !== state.revision &&
          !(latest.revision === state.revision + 1 && latest.binding?.owner === owner)
        )
          return latest;
        return { ...latest, revision: latest.revision + 1, binding: undefined };
      }).catch(() => {});
      for (const item of await current.getNotifications().catch(() => [])) item.close();
    }
    throw cause;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('此浏览器暂不支持通知设置，请更新浏览器后重试。');
  return navigator.locks.request('moor-notifications-v1', { mode: 'exclusive' }, work);
}
export const notificationBrowser: NotificationBrowser = {
  exclusive,
  permission: () => ('Notification' in globalThis ? Notification.permission : 'denied'),
  requestPermission: () => Notification.requestPermission(),
  getSubscription: async () => (await registration())?.pushManager.getSubscription() ?? null,
  subscribe: async (publicKey) => {
    const current = await registration(true);
    if (!current) throw new Error('后台通知组件不可用。');
    return current.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
  },
  bind: sendBinding,
  local: notificationLocal,
  remember: rememberNotification,
  close: async () => {
    for (const item of (await (await registration())?.getNotifications()) ?? []) item.close();
  },
};
/** Local revocation does not depend on successful logout/server reachability. */
export function clearLocalNotifications(expectedRevision?: number) {
  return exclusive(() => clearLocalNotificationsLocked(expectedRevision));
}
async function clearLocalNotificationsLocked(expectedRevision?: number) {
  let failure: unknown,
    revision: number | undefined,
    stale = false;
  try {
    const state = await notificationLocal((current) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        stale = true;
        return current;
      }
      return {
        ...current,
        revision: current.revision + 1,
        binding: undefined,
        records: current.records.map((record) =>
          record.owner === current.binding?.owner ? { ...record, pendingDisable: true } : record,
        ),
      };
    });
    if (stale) return;
    revision = state.revision;
  } catch (error) {
    failure = error;
  }
  // Every cleanup step is independent. A failed browser API must not leave the
  // durable binding active, nor prevent closing already visible reminders.
  let browser: Awaited<ReturnType<NotificationBrowser['getSubscription']>>;
  try {
    browser = await notificationBrowser.getSubscription();
    if (browser) {
      const hash = await pushEndpointHash(pushSubscriptionSchema.parse(browser.toJSON()).endpoint);
      await notificationLocal((current) => ({
        ...current,
        records: current.records.map((record) =>
          record.endpointHash === hash ? { ...record, pendingDisable: true } : record,
        ),
      }));
    }
  } catch (error) {
    failure ??= error;
  }
  try {
    await sendBinding(undefined, DEFAULT_NOTIFICATION_PREFERENCES, revision);
  } catch (error) {
    failure ??= error;
  }
  let rebound = false;
  try {
    rebound = Boolean((await notificationLocal()).binding);
  } catch (error) {
    failure ??= error;
  }
  if (!rebound) {
    try {
      await notificationBrowser.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (browser! && !(await browser.unsubscribe()))
        throw new Error('浏览器尚未确认停用通知，请重新打开通知设置后重试。');
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
export async function reconcileNotificationAccount(owner?: string) {
  const state = await notificationLocal();
  if (
    (state.binding && state.binding.owner !== owner) ||
    (!state.binding && (await notificationBrowser.getSubscription()))
  )
    await clearLocalNotifications(state.revision);
}
