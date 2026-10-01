import type { DatabaseSync } from 'node:sqlite';
import type { NotificationEnvelope } from '@moor/protocol/notification-protocol';
import type { PushRecords, SubscriptionRow } from '../../features/notifications/ports';
export class SqlitePushRecords implements PushRecords {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
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

  atomic<T>(work: () => T): T {
    this.database.exec('SAVEPOINT moor_push_write');
    try {
      const r = work();
      this.database.exec('RELEASE moor_push_write');
      return r;
    } catch (error) {
      this.database.exec('ROLLBACK TO moor_push_write; RELEASE moor_push_write');
      throw error;
    }
  }
  liveLogin(owner: string, loginHash: string, now: number) {
    return !!this.database
      .prepare('SELECT 1 FROM login WHERE token=? AND owner=? AND expires>?')
      .get(loginHash, owner, now);
  }
  prune(now: number) {
    this.database
      .prepare(
        'DELETE FROM push_delivery WHERE EXISTS(SELECT 1 FROM push_event e WHERE e.owner=push_delivery.owner AND e.event_id=push_delivery.event_id AND e.expires_at<=?)',
      )
      .run(now);
    this.database.prepare('DELETE FROM push_event WHERE expires_at<=?').run(now);
    this.database
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='登录已过期' WHERE enabled=1 AND NOT EXISTS(SELECT 1 FROM login WHERE token=login_hash AND owner=push_subscription.owner AND expires>?)",
      )
      .run(now);
    this.database
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='订阅已过期' WHERE enabled=1 AND expires IS NOT NULL AND expires<=?",
      )
      .run(now);
  }
  subscriptions(owner: string, loginHash: string) {
    return this.database
      .prepare('SELECT * FROM push_subscription WHERE owner=? AND login_hash=? ORDER BY id')
      .all(owner, loginHash) as SubscriptionRow[];
  }
  endpoint(endpoint: string) {
    return this.database
      .prepare('SELECT * FROM push_subscription WHERE endpoint=?')
      .get(endpoint) as SubscriptionRow | undefined;
  }
  countSubscriptions(owner: string) {
    return Number(
      this.database.prepare('SELECT count(*) AS n FROM push_subscription WHERE owner=?').get(owner)
        ?.n,
    );
  }
  replaceBrowserSubscription(owner: string, loginHash: string, id: string) {
    this.database
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='当前浏览器已更换订阅' WHERE owner=? AND login_hash=? AND id<>?",
      )
      .run(owner, loginHash, id);
  }
  saveSubscription(r: SubscriptionRow) {
    this.database
      .prepare(
        'INSERT INTO push_subscription VALUES(?,?,?,?,?,?,1,NULL,?) ON CONFLICT(id) DO UPDATE SET login_hash=excluded.login_hash,subscription=excluded.subscription,preferences=excluded.preferences,enabled=1,disabled_reason=NULL,expires=excluded.expires WHERE push_subscription.owner=excluded.owner',
      )
      .run(r.id, r.owner, r.login_hash, r.endpoint, r.subscription, r.preferences, r.expires);
  }
  subscription(owner: string, loginHash: string, id: string, enabledOnly = false) {
    return this.database
      .prepare(
        'SELECT * FROM push_subscription WHERE id=? AND owner=? AND login_hash=?' +
          (enabledOnly ? ' AND enabled=1' : ''),
      )
      .get(id, owner, loginHash) as SubscriptionRow | undefined;
  }
  preferences(owner: string, loginHash: string, id: string, p: string) {
    this.database
      .prepare('UPDATE push_subscription SET preferences=? WHERE id=? AND owner=? AND login_hash=?')
      .run(p, id, owner, loginHash);
  }
  remove(owner: string, loginHash: string, id: string) {
    this.database
      .prepare('DELETE FROM push_subscription WHERE id=? AND owner=? AND login_hash=?')
      .run(id, owner, loginHash);
  }
  revokeLogin(loginHash: string) {
    this.database
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='已退出登录' WHERE login_hash=?",
      )
      .run(loginHash);
  }
  interrupt() {
    this.database.exec("UPDATE push_delivery SET status='unknown' WHERE status='staged'");
  }
  fingerprint(owner: string, eventId: string) {
    const row = this.database
      .prepare('SELECT fingerprint FROM push_event WHERE owner=? AND event_id=?')
      .get(owner, eventId);
    return row ? String(row.fingerprint) : undefined;
  }
  countEvents(owner: string) {
    return Number(
      this.database.prepare('SELECT count(*) AS n FROM push_event WHERE owner=?').get(owner)?.n,
    );
  }
  event(e: NotificationEnvelope, fp: string) {
    this.database
      .prepare('INSERT INTO push_event VALUES(?,?,?,?,?,?,?)')
      .run(e.owner, e.eventId, fp, e.deviceId, e.kind, e.createdAt, e.expiresAt);
  }
  enabledSubscriptions(owner: string, limit: number) {
    return this.database
      .prepare('SELECT * FROM push_subscription WHERE owner=? AND enabled=1 ORDER BY id LIMIT ?')
      .all(owner, limit) as SubscriptionRow[];
  }
  stage(owner: string, eventId: string, id: string, now: number) {
    this.database
      .prepare("INSERT INTO push_delivery VALUES(?,?,?,'staged',NULL,?)")
      .run(owner, eventId, id, now);
  }
  settle(
    owner: string,
    eventId: string,
    id: string,
    status: string,
    code: number | null,
    now: number,
  ) {
    this.database
      .prepare(
        'UPDATE push_delivery SET status=?,status_code=?,updated_at=? WHERE owner=? AND event_id=? AND subscription_id=?',
      )
      .run(status, code, now, owner, eventId, id);
  }
  expire(r: SubscriptionRow) {
    this.database
      .prepare(
        "UPDATE push_subscription SET enabled=0,disabled_reason='推送服务报告订阅已失效' WHERE id=? AND owner=? AND login_hash=? AND subscription=?",
      )
      .run(r.id, r.owner, r.login_hash, r.subscription);
  }
}
