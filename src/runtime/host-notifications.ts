import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  NOTIFICATION_LIMITS,
  hostNotificationEventSchema,
  notificationIdentity,
  notificationScopeSchema,
  type HostNotificationEvent,
  type NotificationScope,
} from '../notification-protocol';

const channelSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_:-]+$/u);
const eventIdSchema = z.string().regex(/^notification_[a-f0-9]{64}$/u);
const scopeValues = (scope: NotificationScope) => [
  scope.userId,
  scope.machineId,
  scope.workspaceId,
  scope.localProjectId,
  scope.sessionId,
  scope.turnId,
];
const where =
  'user_id=? AND machine_id=? AND workspace_id=? AND project_id=? AND session_id=? AND turn_id=?';
export const notificationEventId = (
  input: NotificationScope & { kind: HostNotificationEvent['kind']; requestId?: string },
) => 'notification_' + createHash('sha256').update(notificationIdentity(input)).digest('hex');

/** Host-local metadata outbox. Transports cannot write or execute session content. */
export class HostNotifications {
  readonly now: () => number;
  constructor(
    private db: DatabaseSync,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_event(
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,request_id TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notification_scope ON notification_event(user_id,machine_id,workspace_id,project_id,session_id,turn_id);
      CREATE INDEX IF NOT EXISTS notification_pending ON notification_event(state,created_at,id);
      CREATE TABLE IF NOT EXISTS notification_delivery(
        event_id TEXT NOT NULL,channel TEXT NOT NULL,state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(event_id,channel)
      );
      CREATE TABLE IF NOT EXISTS notification_diagnostics(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),overflow_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO notification_diagnostics(singleton) VALUES(1);
    `);
    this.trim();
  }
  record(
    scope: NotificationScope,
    kind: HostNotificationEvent['kind'],
    requestId?: string,
  ): HostNotificationEvent {
    const parsedScope = notificationScopeSchema.parse(scope);
    const createdAt = this.now();
    const candidate = hostNotificationEventSchema.parse({
      ...parsedScope,
      notificationVersion: 1,
      eventId: notificationEventId({ ...parsedScope, kind, ...(requestId ? { requestId } : {}) }),
      kind,
      ...(requestId !== undefined ? { requestId } : {}),
      createdAt,
      expiresAt:
        createdAt +
        (kind === 'approval-required'
          ? NOTIFICATION_LIMITS.approvalTtl
          : NOTIFICATION_LIMITS.terminalTtl),
    });
    const previous = this.get(candidate.eventId);
    // A settled turn has one immutable outcome; retries cannot refresh its TTL,
    // change a previous terminal event, or revive a resolved approval.
    if (previous) return previous;
    this.db
      .prepare(
        'INSERT INTO notification_event(id,user_id,machine_id,workspace_id,project_id,session_id,turn_id,kind,request_id,created_at,expires_at,event) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        candidate.eventId,
        ...scopeValues(parsedScope),
        kind,
        requestId ?? null,
        createdAt,
        candidate.expiresAt,
        JSON.stringify(candidate),
      );
    this.trim();
    return candidate;
  }
  private trim() {
    this.db
      .prepare(
        "UPDATE notification_event SET state='expired' WHERE state='active' AND expires_at<=?",
      )
      .run(this.now());
    // Keep tombstones so an old retry cannot resurrect an event evicted from the
    // bounded delivery queue. The indexed active set is at most 1001 per insert.
    const { changes } = this.db
      .prepare(
        `UPDATE notification_event SET state='overflow' WHERE id IN (
          SELECT id FROM notification_event WHERE state='active'
          ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?
        )`,
      )
      .run(NOTIFICATION_LIMITS.events);
    if (changes)
      this.db
        .prepare(
          'UPDATE notification_diagnostics SET overflow_count=overflow_count+? WHERE singleton=1',
        )
        .run(changes);
  }
  diagnostics() {
    return {
      active: Number(
        this.db.prepare("SELECT count(*) AS n FROM notification_event WHERE state='active'").get()!
          .n,
      ),
      overflow: Number(
        this.db
          .prepare('SELECT overflow_count FROM notification_diagnostics WHERE singleton=1')
          .get()!.overflow_count,
      ),
    };
  }
  get(eventId: string, activeOnly = false): HostNotificationEvent | undefined {
    const row = this.db
      .prepare(
        'SELECT event FROM notification_event WHERE id=?' +
          (activeOnly ? " AND state='active' AND expires_at>?" : ''),
      )
      .get(eventIdSchema.parse(eventId), ...(activeOnly ? [this.now()] : []));
    if (!row) return;
    const event = hostNotificationEventSchema.parse(JSON.parse(String(row.event)));
    if (event.eventId !== notificationEventId(event)) throw new Error('通知身份校验失败');
    return event;
  }
  resolveApprovals(scope: NotificationScope, requestId?: string) {
    const parsed = notificationScopeSchema.parse(scope);
    if (requestId !== undefined)
      z.string()
        .min(1)
        .max(160)
        .regex(/^[A-Za-z0-9_:-]+$/u)
        .parse(requestId);
    this.db
      .prepare(
        `UPDATE notification_event SET state='resolved' WHERE ${where} AND kind='approval-required' AND state='active'${requestId === undefined ? '' : ' AND request_id=?'}`,
      )
      .run(...scopeValues(parsed), ...(requestId === undefined ? [] : [requestId]));
  }
  /** Native callbacks do not survive process restart. */
  resolveAllApprovals() {
    this.db
      .prepare(
        "UPDATE notification_event SET state='resolved' WHERE kind='approval-required' AND state='active'",
      )
      .run();
  }
  discard(eventId: string) {
    this.db
      .prepare("UPDATE notification_event SET state='resolved' WHERE id=? AND state='active'")
      .run(eventIdSchema.parse(eventId));
  }
  pending(channel: string, limit = 100): HostNotificationEvent[] {
    channelSchema.parse(channel);
    z.number().int().min(1).max(NOTIFICATION_LIMITS.events).parse(limit);
    const now = this.now();
    this.db
      .prepare(
        "UPDATE notification_event SET state='expired' WHERE state='active' AND expires_at<=?",
      )
      .run(now);
    return this.db
      .prepare(
        `SELECT e.event FROM notification_event e LEFT JOIN notification_delivery d ON d.event_id=e.id AND d.channel=?
      WHERE e.state='active' AND e.expires_at>? AND (d.state IS NULL OR d.state='pending') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
      ORDER BY e.created_at,e.id LIMIT ?`,
      )
      .all(channel, now, now, limit)
      .map((row) => {
        const event = hostNotificationEventSchema.parse(JSON.parse(String(row.event)));
        if (event.eventId !== notificationEventId(event)) throw new Error('通知身份校验失败');
        return event;
      });
  }
  acknowledge(channel: string, eventId: string, state: 'submitted' | 'suppressed') {
    channelSchema.parse(channel);
    eventIdSchema.parse(eventId);
    z.enum(['submitted', 'suppressed']).parse(state);
    this.db
      .prepare(
        `INSERT INTO notification_delivery(event_id,channel,state)
      SELECT id,?,? FROM notification_event WHERE id=? AND state='active' AND expires_at>?
      ON CONFLICT(event_id,channel) DO UPDATE SET state=excluded.state WHERE notification_delivery.state='pending'`,
      )
      .run(channel, state, eventId, this.now());
  }
  retry(channel: string, eventId: string, delayMs = 2000) {
    channelSchema.parse(channel);
    eventIdSchema.parse(eventId);
    z.number()
      .int()
      .min(0)
      .max(60 * 60 * 1000)
      .parse(delayMs);
    this.db
      .prepare(
        `INSERT INTO notification_delivery(event_id,channel,state,attempts,next_attempt_at)
      SELECT id,?,'pending',1,? FROM notification_event WHERE id=? AND state='active' AND expires_at>?
      ON CONFLICT(event_id,channel) DO UPDATE SET attempts=notification_delivery.attempts+1,next_attempt_at=excluded.next_attempt_at WHERE notification_delivery.state='pending'`,
      )
      .run(channel, this.now() + delayMs, eventId, this.now());
  }
}
