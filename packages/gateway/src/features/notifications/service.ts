import { utf8 } from '@moor/protocol/binary';
import {
  NOTIFICATION_LIMITS,
  notificationEnvelopeSchema,
  notificationPreferencesSchema,
  notificationWanted,
  pushSubscriptionRequestSchema,
  type MoorPushSubscription,
  type NotificationEnvelope,
} from '@moor/protocol/notification-protocol';
import { assert, id } from '@moor/protocol/protocol';
import type {
  PushOptions,
  PushRecords,
  PushSubscriptionView,
  SubscriptionRow,
  WebPushTransport,
} from './ports';
export class RelayNotificationService {
  private now: () => number;
  private transport: WebPushTransport;
  private validateSubscription: (input: unknown) => MoorPushSubscription;
  private authorize: (event: NotificationEnvelope) => boolean;
  private closed = false;
  private inFlight = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private readonly records: PushRecords,
    private readonly options: PushOptions,
  ) {
    this.now = options.now;
    this.transport = options.transport;
    this.validateSubscription = options.validateSubscription;
    this.authorize = options.authorize;
  }

  private hash(value: string) {
    return this.options.hash(value);
  }
  private view(row: SubscriptionRow): PushSubscriptionView {
    return {
      id: row.id,
      endpointHash: this.hash(row.endpoint),
      enabled: !!row.enabled,
      preferences: notificationPreferencesSchema.parse(JSON.parse(row.preferences)),
      ...(row.disabled_reason ? { disabledReason: row.disabled_reason } : {}),
    };
  }
  private live(owner: string, loginHash: string) {
    return !!this.records.liveLogin(owner, loginHash, this.now());
  }
  private login(owner: string, loginHash: string) {
    assert(!this.closed, 503, '通知服务已关闭');
    assert(/^[a-f0-9]{64}$/u.test(loginHash) && this.live(owner, loginHash), 401, '请先登录');
  }
  private transaction<T>(work: () => T): T {
    return this.records.atomic(work);
  }
  private prune() {
    this.records.prune(this.now());
  }
  state(owner: string, loginHash: string) {
    this.login(owner, loginHash);
    this.prune();
    return {
      notificationVersion: 1 as const,
      ...this.transport.state,
      subscriptions: (this.records.subscriptions(owner, loginHash) as SubscriptionRow[]).map(
        (row) => this.view(row),
      ),
    };
  }
  subscribe(owner: string, loginHash: string, input: unknown): PushSubscriptionView {
    this.login(owner, loginHash);
    assert(this.transport.state.configured, 409, this.transport.state.reason ?? '推送未配置');
    const parsed = pushSubscriptionRequestSchema.parse(input),
      subscription = this.validateSubscription(parsed.subscription),
      subscriptionId = 'push_' + this.hash(subscription.endpoint);
    assert(parsed.expectedOwner === owner, 409, '通知账号已变化，请重新打开通知设置');
    assert(
      subscription.expirationTime == null || subscription.expirationTime > this.now(),
      409,
      '推送订阅已过期，请重新启用通知',
    );
    return this.transaction(() => {
      this.prune();
      const existing = this.records.endpoint(subscription.endpoint) as SubscriptionRow | undefined;
      assert(!existing || existing.owner === owner, 409, '此推送订阅已经绑定其他账号');
      if (!existing)
        assert(
          Number({ n: this.records.countSubscriptions(owner) }?.n) <
            NOTIFICATION_LIMITS.subscriptions,
          409,
          '推送订阅达到上限，请先移除旧订阅',
        );
      this.records.replaceBrowserSubscription(owner, loginHash, subscriptionId);
      this.records.saveSubscription({
        id: subscriptionId,
        owner,
        login_hash: loginHash,
        endpoint: subscription.endpoint,
        subscription: JSON.stringify(subscription),
        preferences: JSON.stringify(parsed.preferences),
        enabled: 1,
        disabled_reason: null,
        expires: subscription.expirationTime ?? null,
      });
      return this.subscription(owner, loginHash, subscriptionId);
    });
  }
  private row(owner: string, loginHash: string, subscriptionId: string) {
    this.login(owner, loginHash);
    id.parse(subscriptionId);
    const row = this.records.subscription(owner, loginHash, subscriptionId) as
      | SubscriptionRow
      | undefined;
    assert(row, 404, '当前浏览器的推送订阅不可用');
    return row;
  }
  private subscription(owner: string, loginHash: string, subscriptionId: string) {
    return this.view(this.row(owner, loginHash, subscriptionId));
  }
  update(owner: string, loginHash: string, subscriptionId: string, input: unknown) {
    this.row(owner, loginHash, subscriptionId);
    const preferences = notificationPreferencesSchema.parse(input);
    this.records.preferences(owner, loginHash, subscriptionId, JSON.stringify(preferences));
    return this.subscription(owner, loginHash, subscriptionId);
  }
  remove(owner: string, loginHash: string, subscriptionId: string) {
    this.login(owner, loginHash);
    id.parse(subscriptionId);
    this.records.remove(owner, loginHash, subscriptionId);
    return { removed: true as const };
  }
  // Call within the same transaction that deletes login(token). No network call.
  revokeLogin(loginHash: string) {
    this.records.revokeLogin(loginHash);
  }
  private allowed(event: NotificationEnvelope, isCurrent: () => boolean) {
    try {
      return (
        !this.closed &&
        event.expiresAt > this.now() &&
        event.createdAt <= this.now() + 60000 &&
        isCurrent() &&
        this.authorize(event)
      );
    } catch {
      return false;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.records.interrupt();
    this.transport.close?.();
  }
  private async acquire() {
    if (this.inFlight < 4) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }
  async deliver(input: NotificationEnvelope, isCurrent: () => boolean = () => true) {
    const event = notificationEnvelopeSchema.parse(input);
    const { catalogWorkspaceId: _catalogWorkspaceId, replicaId: _replicaId, ...identity } = event;
    // Product organization routes may move; execution identity and the original
    // event remain immutable. A regrouped duplicate never sends a second push.
    const fingerprint = this.hash(JSON.stringify(identity));
    assert(
      utf8(JSON.stringify(event)).byteLength < NOTIFICATION_LIMITS.payloadBytes,
      413,
      '通知标识过长',
    );
    if (!this.transport.state.configured || !this.allowed(event, isCurrent))
      return { staged: 0, sent: 0, failed: 0, unknown: 0 };
    const subscriptions = this.transaction(() => {
      this.prune();
      const previous = ((fingerprint) => (fingerprint === undefined ? undefined : { fingerprint }))(
        this.records.fingerprint(event.owner, event.eventId),
      );
      if (previous) {
        assert(previous.fingerprint === fingerprint, 409, '通知编号与原事件不匹配');
        return [];
      }
      assert(
        Number({ n: this.records.countEvents(event.owner) }?.n) < NOTIFICATION_LIMITS.events,
        429,
        '未过期通知达到上限',
      );
      this.records.event(event, fingerprint);
      const rows = this.records.enabledSubscriptions(
        event.owner,
        NOTIFICATION_LIMITS.subscriptions,
      ) as SubscriptionRow[];
      const selected = rows.filter(
        (row) =>
          this.live(row.owner, row.login_hash) &&
          notificationWanted(JSON.parse(row.preferences), event),
      );
      for (const row of selected)
        this.records.stage(event.owner, event.eventId, row.id, this.now());
      return selected;
    });
    const result = { staged: subscriptions.length, sent: 0, failed: 0, unknown: 0 };
    // A bounded wave keeps slow providers from serially delaying every browser.
    for (let offset = 0; offset < subscriptions.length; offset += 4)
      await Promise.all(
        subscriptions.slice(offset, offset + 4).map(async (original) => {
          await this.acquire();
          try {
            if (this.closed) {
              result.unknown++;
              return;
            }
            const current = this.records.subscription(
              original.owner,
              original.login_hash,
              original.id,
              true,
            ) as SubscriptionRow | undefined;
            let outcome: Awaited<ReturnType<WebPushTransport['send']>> = { status: 'failed' };
            if (
              current &&
              current.subscription === original.subscription &&
              this.live(current.owner, current.login_hash) &&
              this.allowed(event, isCurrent) &&
              notificationWanted(JSON.parse(current.preferences), event)
            ) {
              try {
                outcome = await this.transport.send(JSON.parse(current.subscription), event);
              } catch {
                outcome = { status: 'unknown' };
              }
            }
            const status = outcome.status === 'expired' ? 'failed' : outcome.status;
            result[status]++;
            if (this.closed) return;
            this.transaction(() => {
              this.records.settle(
                event.owner,
                event.eventId,
                original.id,
                status,
                outcome.statusCode ?? null,
                this.now(),
              );
              if (outcome.status === 'expired') this.records.expire(original);
            });
          } finally {
            this.release();
          }
        }),
      );
    return result;
  }
}
