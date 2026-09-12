import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { assert, id } from '../protocol';
import {
  NOTIFICATION_LIMITS,
  notificationEnvelopeSchema,
  notificationPreferencesSchema,
  notificationWanted,
  pushSubscriptionRequestSchema,
  type NotificationEnvelope,
  type NotificationPreferences,
} from '../notification-protocol';
import {
  createWebPushTransport,
  validatePushSubscription,
  type WebPushTransport,
} from './web-push';

type SubscriptionRow = {
  id: string;
  owner: string;
  login_hash: string;
  endpoint: string;
  subscription: string;
  preferences: string;
  enabled: number;
  disabled_reason: string | null;
  expires: number | null;
};
export type PushSubscriptionView = {
  id: string;
  endpointHash: string;
  enabled: boolean;
  preferences: NotificationPreferences;
  disabledReason?: string;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const view = (row: SubscriptionRow): PushSubscriptionView => ({
  id: row.id,
  endpointHash: hash(row.endpoint),
  enabled: !!row.enabled,
  preferences: notificationPreferencesSchema.parse(JSON.parse(row.preferences)),
  ...(row.disabled_reason ? { disabledReason: row.disabled_reason } : {}),
});
export class RelayNotifications {
  private now: () => number;
  private transport: WebPushTransport;
  private authorize: (event: NotificationEnvelope) => boolean;
  private closed = false;
  private inFlight = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private db: DatabaseSync,
    options: {
      now?: () => number;
      transport?: WebPushTransport;
      authorize: (event: NotificationEnvelope) => boolean;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? createWebPushTransport();
    this.authorize = options.authorize;
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscription(
        id TEXT PRIMARY KEY,owner TEXT NOT NULL,login_hash TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,subscription TEXT NOT NULL,preferences TEXT NOT NULL,
        enabled INTEGER NOT NULL,disabled_reason TEXT,expires INTEGER
      );
      CREATE INDEX IF NOT EXISTS push_subscription_owner ON push_subscription(owner,login_hash);
      CREATE TABLE IF NOT EXISTS push_event(
        owner TEXT NOT NULL,event_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
        device_id TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        PRIMARY KEY(owner,event_id)
      );
      CREATE TABLE IF NOT EXISTS push_delivery(
        owner TEXT NOT NULL,event_id TEXT NOT NULL,subscription_id TEXT NOT NULL,
        status TEXT NOT NULL,status_code INTEGER,updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner,event_id,subscription_id)
      );
      UPDATE push_delivery SET status='unknown' WHERE status='staged';
    `);
  }
  private live(owner: string, loginHash: string) {
    return !!this.db
      .prepare('SELECT 1 FROM login WHERE token=? AND owner=? AND expires>?')
      .get(loginHash, owner, this.now());
  }
  private login(owner: string, loginHash: string) {
    assert(!this.closed, 503, '通知服务已关闭');
    assert(/^[a-f0-9]{64}$/u.test(loginHash) && this.live(owner, loginHash), 401, '请先登录');
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT moor_push_write');
    try {
      const value = fn();
      this.db.exec('RELEASE moor_push_write');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK TO moor_push_write; RELEASE moor_push_write');
      throw error;
    }
  }
  private prune() {
    this.db
      .prepare(
        'DELETE FROM push_delivery WHERE EXISTS(SELECT 1 FROM push_event e WHERE e.owner=push_delivery.owner AND e.event_id=push_delivery.event_id AND e.expires_at<=?)',
      )
      .run(this.now());
    this.db.prepare('DELETE FROM push_event WHERE expires_at<=?').run(this.now());
    this.db
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='登录已过期' WHERE enabled=1 AND NOT EXISTS(SELECT 1 FROM login WHERE token=login_hash AND owner=push_subscription.owner AND expires>?)",
      )
      .run(this.now());
    this.db
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='订阅已过期' WHERE enabled=1 AND expires IS NOT NULL AND expires<=?",
      )
      .run(this.now());
  }
  state(owner: string, loginHash: string) {
    this.login(owner, loginHash);
    this.prune();
    return {
      notificationVersion: 1 as const,
      ...this.transport.state,
      subscriptions: (
        this.db
          .prepare('SELECT * FROM push_subscription WHERE owner=? AND login_hash=? ORDER BY id')
          .all(owner, loginHash) as SubscriptionRow[]
      ).map(view),
    };
  }
  subscribe(owner: string, loginHash: string, input: unknown): PushSubscriptionView {
    this.login(owner, loginHash);
    assert(this.transport.state.configured, 409, this.transport.state.reason ?? '推送未配置');
    const parsed = pushSubscriptionRequestSchema.parse(input),
      subscription = validatePushSubscription(parsed.subscription),
      subscriptionId = 'push_' + hash(subscription.endpoint);
    assert(parsed.expectedOwner === owner, 409, '通知账号已变化，请重新打开通知设置');
    assert(
      subscription.expirationTime == null || subscription.expirationTime > this.now(),
      409,
      '推送订阅已过期，请重新启用通知',
    );
    return this.transaction(() => {
      this.prune();
      const existing = this.db
        .prepare('SELECT * FROM push_subscription WHERE endpoint=?')
        .get(subscription.endpoint) as SubscriptionRow | undefined;
      assert(!existing || existing.owner === owner, 409, '此推送订阅已经绑定其他账号');
      if (!existing)
        assert(
          Number(
            this.db.prepare('SELECT count(*) AS n FROM push_subscription WHERE owner=?').get(owner)
              ?.n,
          ) < NOTIFICATION_LIMITS.subscriptions,
          409,
          '推送订阅达到上限，请先移除旧订阅',
        );
      this.db
        .prepare(
          "UPDATE push_subscription SET enabled=0,disabled_reason='当前浏览器已更换订阅' WHERE owner=? AND login_hash=? AND id<>?",
        )
        .run(owner, loginHash, subscriptionId);
      this.db
        .prepare(
          `INSERT INTO push_subscription VALUES(?,?,?,?,?,?,1,NULL,?) ON CONFLICT(id) DO UPDATE SET
           login_hash=excluded.login_hash,subscription=excluded.subscription,preferences=excluded.preferences,
           enabled=1,disabled_reason=NULL,expires=excluded.expires WHERE push_subscription.owner=excluded.owner`,
        )
        .run(
          subscriptionId,
          owner,
          loginHash,
          subscription.endpoint,
          JSON.stringify(subscription),
          JSON.stringify(parsed.preferences),
          subscription.expirationTime ?? null,
        );
      return this.subscription(owner, loginHash, subscriptionId);
    });
  }
  private row(owner: string, loginHash: string, subscriptionId: string) {
    this.login(owner, loginHash);
    id.parse(subscriptionId);
    const row = this.db
      .prepare('SELECT * FROM push_subscription WHERE id=? AND owner=? AND login_hash=?')
      .get(subscriptionId, owner, loginHash) as SubscriptionRow | undefined;
    assert(row, 404, '当前浏览器的推送订阅不可用');
    return row;
  }
  private subscription(owner: string, loginHash: string, subscriptionId: string) {
    return view(this.row(owner, loginHash, subscriptionId));
  }
  update(owner: string, loginHash: string, subscriptionId: string, input: unknown) {
    this.row(owner, loginHash, subscriptionId);
    const preferences = notificationPreferencesSchema.parse(input);
    this.db
      .prepare('UPDATE push_subscription SET preferences=? WHERE id=? AND owner=? AND login_hash=?')
      .run(JSON.stringify(preferences), subscriptionId, owner, loginHash);
    return this.subscription(owner, loginHash, subscriptionId);
  }
  remove(owner: string, loginHash: string, subscriptionId: string) {
    this.login(owner, loginHash);
    id.parse(subscriptionId);
    this.db
      .prepare('DELETE FROM push_subscription WHERE id=? AND owner=? AND login_hash=?')
      .run(subscriptionId, owner, loginHash);
    return { removed: true as const };
  }
  // Call within the same transaction that deletes login(token). No network call.
  revokeLogin(loginHash: string) {
    this.db
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='已退出登录' WHERE login_hash=?",
      )
      .run(loginHash);
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
    this.db.exec("UPDATE push_delivery SET status='unknown' WHERE status='staged'");
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
    const fingerprint = hash(JSON.stringify(identity));
    assert(
      Buffer.byteLength(JSON.stringify(event)) < NOTIFICATION_LIMITS.payloadBytes,
      413,
      '通知标识过长',
    );
    if (!this.transport.state.configured || !this.allowed(event, isCurrent))
      return { staged: 0, sent: 0, failed: 0, unknown: 0 };
    const subscriptions = this.transaction(() => {
      this.prune();
      const previous = this.db
        .prepare('SELECT fingerprint FROM push_event WHERE owner=? AND event_id=?')
        .get(event.owner, event.eventId);
      if (previous) {
        assert(previous.fingerprint === fingerprint, 409, '通知编号与原事件不匹配');
        return [];
      }
      assert(
        Number(
          this.db.prepare('SELECT count(*) AS n FROM push_event WHERE owner=?').get(event.owner)?.n,
        ) < NOTIFICATION_LIMITS.events,
        429,
        '未过期通知达到上限',
      );
      this.db
        .prepare('INSERT INTO push_event VALUES(?,?,?,?,?,?,?)')
        .run(
          event.owner,
          event.eventId,
          fingerprint,
          event.deviceId,
          event.kind,
          event.createdAt,
          event.expiresAt,
        );
      const rows = this.db
        .prepare('SELECT * FROM push_subscription WHERE owner=? AND enabled=1 ORDER BY id LIMIT ?')
        .all(event.owner, NOTIFICATION_LIMITS.subscriptions) as SubscriptionRow[];
      const selected = rows.filter(
        (row) =>
          this.live(row.owner, row.login_hash) &&
          notificationWanted(JSON.parse(row.preferences), event),
      );
      for (const row of selected)
        this.db
          .prepare("INSERT INTO push_delivery VALUES(?,?,?,'staged',NULL,?)")
          .run(event.owner, event.eventId, row.id, this.now());
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
            const current = this.db
              .prepare(
                'SELECT * FROM push_subscription WHERE id=? AND owner=? AND login_hash=? AND enabled=1',
              )
              .get(original.id, original.owner, original.login_hash) as SubscriptionRow | undefined;
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
              this.db
                .prepare(
                  'UPDATE push_delivery SET status=?,status_code=?,updated_at=? WHERE owner=? AND event_id=? AND subscription_id=?',
                )
                .run(
                  status,
                  outcome.statusCode ?? null,
                  this.now(),
                  event.owner,
                  event.eventId,
                  original.id,
                );
              if (outcome.status === 'expired')
                this.db
                  .prepare(
                    "UPDATE push_subscription SET enabled=0,disabled_reason='推送服务报告订阅已失效' WHERE id=? AND owner=? AND login_hash=? AND subscription=?",
                  )
                  .run(original.id, original.owner, original.login_hash, original.subscription);
            });
          } finally {
            this.release();
          }
        }),
      );
    return result;
  }
}
