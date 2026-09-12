import { z } from 'zod';
import { id } from '../protocol';
import type { NotificationLocalState, NotificationLocalRecord } from './notification-storage';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  notificationPreferencesSchema,
  pushSubscriptionSchema,
  type NotificationPreferences,
  type MoorPushSubscription,
} from '../notification-protocol';
export const notificationSubscriptionViewSchema = z.object({
  id,
  enabled: z.boolean(),
  endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  preferences: notificationPreferencesSchema,
  disabledReason: z.string().max(500).optional(),
});
export const notificationStateSchema = z.object({
  configured: z.boolean(),
  publicKey: z.string().max(100).optional(),
  reason: z.string().max(500).optional(),
  subscriptions: z.array(notificationSubscriptionViewSchema).max(20),
});
export type NotificationSubscriptionView = z.infer<typeof notificationSubscriptionViewSchema>;
export type NotificationServerState = z.infer<typeof notificationStateSchema>;
export type BrowserPushSubscription = {
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
};
export type NotificationBrowser = {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  getSubscription(): Promise<BrowserPushSubscription | null>;
  subscribe(publicKey: Uint8Array<ArrayBuffer>): Promise<BrowserPushSubscription>;
  bind(
    owner?: string,
    preferences?: NotificationPreferences,
    expectedRevision?: number,
  ): Promise<void>;
  local(): Promise<NotificationLocalState>;
  remember(record: NotificationLocalRecord, expectedRevision?: number): Promise<void>;
  close(): Promise<void>;
};
export type NotificationDependencies = {
  browser: NotificationBrowser;
  request(path: string, body?: unknown): Promise<unknown>;
  current(): boolean;
  changed(): void;
};
export async function pushEndpointHash(endpoint: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function applicationKey(value?: string) {
  if (!value || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error('通知服务公钥无效。');
  const bytes = Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='),
    (char) => char.charCodeAt(0),
  );
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('通知服务公钥无效。');
  return bytes;
}
/** Explicit user actions only. Loading or reconnecting never calls subscribe. */
export class NotificationController {
  busy = false;
  state?: NotificationServerState;
  subscription?: NotificationSubscriptionView;
  preferences: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  error = '';
  localSubscribed = false;
  browserSubscribed = false;
  preferencesPending = false;
  pendingDisable: NotificationLocalRecord[] = [];
  get enabled() {
    return (
      this.localSubscribed &&
      this.subscription?.enabled === true &&
      !this.pendingDisable.some((row) => row.id === this.subscription?.id)
    );
  }
  constructor(
    readonly owner: string,
    private dependencies: NotificationDependencies,
  ) {}
  private current() {
    if (!this.dependencies.current()) throw new Error('通知设置所属账号已经改变，请重新打开设置。');
  }
  private async work(fn: () => Promise<void>) {
    this.current();
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.dependencies.changed();
    try {
      await fn();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      if (this.dependencies.current()) this.dependencies.changed();
    }
  }
  private async readState() {
    const local = await this.dependencies.browser.local();
    this.current();
    this.pendingDisable = local.records.filter(
      (row) => row.owner === this.owner && row.pendingDisable,
    );
    const state = notificationStateSchema.parse(
      await this.dependencies.request('/api/notifications'),
    );
    this.current();
    const browser = await this.dependencies.browser.getSubscription();
    this.current();
    const hash = browser
      ? await pushEndpointHash(pushSubscriptionSchema.parse(browser.toJSON()).endpoint)
      : undefined;
    this.current();
    this.browserSubscribed = Boolean(browser);
    this.state = state;
    this.subscription = state.subscriptions.find(
      (subscription) => subscription.endpointHash === hash,
    );
    this.localSubscribed = Boolean(
      hash && this.subscription && local.binding?.owner === this.owner,
    );
    if (local.binding?.owner === this.owner) {
      this.preferences = { ...local.binding.preferences };
      this.preferencesPending = Boolean(
        this.subscription &&
        JSON.stringify(this.subscription.preferences) !== JSON.stringify(local.binding.preferences),
      );
    } else {
      this.preferencesPending = false;
      if (this.subscription) this.preferences = { ...this.subscription.preferences };
    }
  }
  refresh() {
    return this.work(() => this.readState());
  }
  enable(preferences = this.preferences) {
    this.current();
    if (this.busy) return Promise.resolve();
    if (!this.state?.configured) {
      this.error = this.state?.reason || '服务器尚未配置推送通知。';
      this.dependencies.changed();
      return Promise.resolve();
    }
    const parsed = notificationPreferencesSchema.parse(preferences);
    const publicKey = applicationKey(this.state.publicKey);
    // Must occur synchronously inside the user's click, before storage/network
    // awaits; Safari rejects a permission request without user activation.
    const permission =
      this.dependencies.browser.permission() === 'granted'
        ? Promise.resolve('granted' as const)
        : this.dependencies.browser.requestPermission();
    void permission.catch(() => {});
    const startingRead = this.dependencies.browser.local();
    return this.work(async () => {
      const starting = await startingRead;
      this.current();
      if ((await permission) !== 'granted')
        throw new Error('通知权限未开启，请在浏览器或系统设置中允许后重试。');
      this.current();
      await this.dependencies.browser.exclusive(async () => {
        this.current();
        if ((await this.dependencies.browser.local()).revision !== starting.revision)
          throw new Error('通知设置已改变，旧的开启操作已取消。');
        let subscription = await this.dependencies.browser.getSubscription();
        this.current();
        subscription ??= await this.dependencies.browser.subscribe(publicKey);
        this.current();
        if ((await this.dependencies.browser.local()).revision !== starting.revision)
          throw new Error('通知设置已改变，旧的开启操作已取消。');
        this.current();
        const payload: MoorPushSubscription = pushSubscriptionSchema.parse(subscription.toJSON());
        const result = notificationSubscriptionViewSchema.parse(
          await this.dependencies.request('/api/notifications/subscriptions', {
            notificationVersion: 1,
            expectedOwner: this.owner,
            subscription: payload,
            preferences: parsed,
          }),
        );
        this.current();
        if (!result.enabled || result.endpointHash !== (await pushEndpointHash(payload.endpoint)))
          throw new Error('服务器尚未确认当前浏览器的通知订阅，请重新读取状态。');
        this.current();
        // Store the confirmed server record before binding the worker. If the
        // latter fails, this subscription remains visible for manual cleanup.
        await this.dependencies.browser.remember({
          owner: this.owner,
          id: result.id,
          endpointHash: result.endpointHash,
          pendingDisable: true,
        });
        this.current();
        await this.dependencies.browser.bind(this.owner, result.preferences, starting.revision);
        this.current();
        await this.dependencies.browser.remember(
          {
            owner: this.owner,
            id: result.id,
            endpointHash: result.endpointHash,
            pendingDisable: false,
          },
          starting.revision + 1,
        );
        this.current();
        this.subscription = result;
        this.localSubscribed = true;
        this.browserSubscribed = true;
        this.preferencesPending = false;
        this.pendingDisable = this.pendingDisable.filter((row) => row.id !== result.id);
        this.preferences = { ...result.preferences };
      });
    });
  }
  savePreferences(preferences: NotificationPreferences) {
    const parsed = notificationPreferencesSchema.parse(preferences);
    return this.work(() =>
      this.dependencies.browser.exclusive(async () => {
        this.current();
        if (!this.enabled || !this.subscription) throw new Error('请先在此浏览器开启通知。');
        const expected = this.subscription.id,
          expectedHash = this.subscription.endpointHash;
        // Stop excluded kinds locally before waiting for server confirmation.
        const starting = await this.dependencies.browser.local();
        this.current();
        await this.dependencies.browser.bind(this.owner, parsed, starting.revision);
        this.current();
        this.preferences = { ...parsed };
        this.preferencesPending = true;
        const result = notificationSubscriptionViewSchema.parse(
          await this.dependencies.request(
            `/api/notifications/subscriptions/${expected}/preferences`,
            {
              notificationVersion: 1,
              expectedOwner: this.owner,
              preferences: parsed,
            },
          ),
        );
        this.current();
        if (
          result.id !== expected ||
          result.endpointHash !== expectedHash ||
          !result.enabled ||
          JSON.stringify(result.preferences) !== JSON.stringify(parsed)
        )
          throw new Error('通知设置的确认与当前订阅不匹配。');
        this.subscription = result;
        this.preferences = { ...result.preferences };
        this.preferencesPending = false;
      }),
    );
  }
  disable(
    record: Pick<NotificationSubscriptionView, 'id' | 'endpointHash'> | undefined = this
      .subscription ?? (!this.browserSubscribed ? this.pendingDisable[0] : undefined),
  ) {
    return this.work(() =>
      this.dependencies.browser.exclusive(async () => {
        this.current();
        let failure: unknown;
        let local: NotificationLocalState | undefined;
        let ownBrowser: BrowserPushSubscription | null = null;
        let hash: string | undefined;
        try {
          local = await this.dependencies.browser.local();
        } catch (error) {
          failure = error;
        }
        this.current();
        try {
          ownBrowser = await this.dependencies.browser.getSubscription();
          if (ownBrowser)
            hash = await pushEndpointHash(
              pushSubscriptionSchema.parse(ownBrowser.toJSON()).endpoint,
            );
        } catch (error) {
          failure ??= error;
        }
        this.current();
        const localTarget =
          !record ||
          hash === record.endpointHash ||
          (!hash && local?.binding?.owner === this.owner) ||
          this.subscription?.id === record.id;
        if (record) {
          const pending = {
            owner: this.owner,
            id: record.id,
            endpointHash: record.endpointHash,
            pendingDisable: true,
          };
          this.pendingDisable = [
            ...this.pendingDisable.filter((row) => row.id !== record.id),
            pending,
          ];
          try {
            await this.dependencies.browser.remember(pending);
          } catch (error) {
            failure ??= error;
          }
        }
        this.current();
        if (localTarget) {
          try {
            await this.dependencies.browser.bind();
          } catch (error) {
            failure ??= error;
          }
          this.localSubscribed = false;
          try {
            await this.dependencies.browser.close();
          } catch (error) {
            failure ??= error;
          }
          try {
            if (ownBrowser && !(await ownBrowser.unsubscribe()))
              throw new Error('浏览器尚未确认停用通知。');
            this.browserSubscribed = false;
          } catch (error) {
            failure ??= error;
          }
        }
        this.current();
        if (record) {
          try {
            const result = await this.dependencies.request(
              `/api/notifications/subscriptions/${record.id}/remove`,
              { notificationVersion: 1, expectedOwner: this.owner },
            );
            this.current();
            if (
              !result ||
              typeof result !== 'object' ||
              !('removed' in result) ||
              result.removed !== true
            )
              throw new Error('服务器停用尚未确认。');
            await this.dependencies.browser.remember({
              owner: this.owner,
              id: record.id,
              endpointHash: record.endpointHash,
              pendingDisable: false,
            });
            this.pendingDisable = this.pendingDisable.filter((row) => row.id !== record.id);
            if (this.subscription?.id === record.id)
              this.subscription = { ...this.subscription, enabled: false };
            if (this.state)
              this.state = {
                ...this.state,
                subscriptions: this.state.subscriptions.map((row) =>
                  row.id === record.id ? { ...row, enabled: false } : row,
                ),
              };
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure)
          throw new Error('关闭尚未全部确认，待处理记录已保留；连接恢复后请手动重试关闭。');
      }),
    );
  }
}
