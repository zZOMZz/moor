import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  NOTIFICATION_LIMITS,
  hostNotificationEventSchema,
  type HostNotificationEvent,
} from '../notification-protocol';

export interface NotificationHost {
  pendingNotifications(channel: string, limit?: number): HostNotificationEvent[];
  isNotificationCurrent(event: HostNotificationEvent): boolean;
  acknowledgeNotification(
    channel: string,
    eventId: string,
    state: 'submitted' | 'suppressed',
  ): void;
  retryNotification(channel: string, eventId: string, delayMs?: number): void;
}
type Kind = 'native' | 'relay';
type Timer = ReturnType<typeof setTimeout>;
type Channel = {
  generation: object;
  kind: Kind;
  send(event: HostNotificationEvent): boolean;
  flights: Map<string, Flight>;
};
type Flight = {
  host: NotificationHost;
  event: HostNotificationEvent;
  timer?: Timer;
};
const ackSchema = z
  .object({
    type: z.literal('notification-ack'),
    eventId: z.string().regex(/^notification_[a-f0-9]{64}$/u),
    status: z.enum(['shown', 'failed', 'ignored', 'handled', 'rejected', 'retry']),
  })
  .strict();
const channelSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_:-]+$/u);
export const NOTIFICATION_DISPATCH_LIMITS = {
  channels: 8,
  hosts: 16,
  perChannel: 8,
  acknowledgementMs: 15000,
  retryMs: 2000,
} as const;

export function relayNotificationChannel(deviceId: string, origin: string) {
  const hash = createHash('sha256').update(new URL(origin).origin).digest('hex');
  return channelSchema.parse(`relay:${deviceId}:${hash}`);
}

/** Metadata-only delivery. Generation tokens must be the actual socket/IPC owner. */
export class NotificationDispatcher {
  private channels = new Map<string, Channel>();
  private closed = false;
  private draining = false;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly clear: typeof clearTimeout;
  private failures = 0;
  constructor(
    private options: {
      hosts(): Iterable<NotificationHost>;
      now?: () => number;
      setTimeout?: typeof setTimeout;
      clearTimeout?: typeof clearTimeout;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? setTimeout;
    this.clear = options.clearTimeout ?? clearTimeout;
  }
  connect(id: string, generation: object, kind: Kind, send: Channel['send']) {
    channelSchema.parse(id);
    if (this.closed) return;
    const previous = this.channels.get(id);
    if (previous?.generation === generation) return;
    if (previous) this.disconnect(id, previous.generation);
    if (this.channels.size >= NOTIFICATION_DISPATCH_LIMITS.channels) return;
    this.channels.set(id, { generation, kind, send, flights: new Map() });
    this.drain();
  }
  disconnect(id: string, generation: object) {
    const channel = this.channels.get(id);
    if (!channel || channel.generation !== generation) return;
    this.channels.delete(id);
    for (const flight of channel.flights.values()) {
      this.clear(flight.timer);
      this.attempt(() =>
        flight.host.retryNotification(
          id,
          flight.event.eventId,
          NOTIFICATION_DISPATCH_LIMITS.retryMs,
        ),
      );
    }
    channel.flights.clear();
  }
  private attempt<T>(operation: () => T): T | undefined {
    try {
      return operation();
    } catch {
      this.failures++;
      return;
    }
  }
  private current(flight: Flight) {
    return (
      flight.event.expiresAt > this.now() &&
      this.attempt(() => flight.host.isNotificationCurrent(flight.event)) === true
    );
  }
  drain() {
    if (this.closed || this.draining) return;
    this.draining = true;
    try {
      for (const [id, channel] of this.channels) {
        let visited = 0;
        for (const host of this.options.hosts()) {
          if (++visited > NOTIFICATION_DISPATCH_LIMITS.hosts) break;
          if (channel.flights.size >= NOTIFICATION_DISPATCH_LIMITS.perChannel) break;
          const events =
            this.attempt(() =>
              host.pendingNotifications(id, NOTIFICATION_DISPATCH_LIMITS.perChannel * 2),
            ) ?? [];
          for (const candidate of events) {
            if (this.closed || this.channels.get(id) !== channel) break;
            if (channel.flights.size >= NOTIFICATION_DISPATCH_LIMITS.perChannel) break;
            if (channel.flights.has(candidate.eventId)) continue;
            const parsed = hostNotificationEventSchema.safeParse(candidate);
            if (!parsed.success) {
              this.failures++;
              continue;
            }
            const flight: Flight = { host, event: parsed.data };
            if (!this.current(flight)) continue;
            if (
              Buffer.byteLength(JSON.stringify(flight.event), 'utf8') >
              NOTIFICATION_LIMITS.payloadBytes
            ) {
              this.attempt(() =>
                host.acknowledgeNotification(id, flight.event.eventId, 'suppressed'),
              );
              continue;
            }
            // Register first: even a synchronous test transport can acknowledge.
            channel.flights.set(flight.event.eventId, flight);
            flight.timer = this.schedule(() => {
              if (
                this.closed ||
                this.channels.get(id) !== channel ||
                channel.flights.get(flight.event.eventId) !== flight
              )
                return;
              channel.flights.delete(flight.event.eventId);
              this.attempt(() =>
                host.retryNotification(
                  id,
                  flight.event.eventId,
                  NOTIFICATION_DISPATCH_LIMITS.retryMs,
                ),
              );
            }, NOTIFICATION_DISPATCH_LIMITS.acknowledgementMs);
            // A sender receives a copy and cannot change the persisted scope used
            // to validate its acknowledgement or a later retry.
            const sent = this.attempt(() => channel.send({ ...flight.event }));
            if (sent !== true && channel.flights.get(flight.event.eventId) === flight) {
              channel.flights.delete(flight.event.eventId);
              this.clear(flight.timer);
              this.attempt(() =>
                host.retryNotification(
                  id,
                  flight.event.eventId,
                  NOTIFICATION_DISPATCH_LIMITS.retryMs,
                ),
              );
            }
          }
        }
      }
    } catch {
      this.failures++;
    } finally {
      this.draining = false;
    }
  }
  acknowledge(id: string, generation: object, input: unknown): boolean {
    if (this.closed) return false;
    const parsed = ackSchema.safeParse(input),
      channel = this.channels.get(id);
    if (!parsed.success || !channel || channel.generation !== generation) return false;
    const { eventId, status } = parsed.data;
    if (
      !(
        channel.kind === 'native'
          ? ['shown', 'failed', 'ignored']
          : ['handled', 'rejected', 'retry']
      ).includes(status)
    )
      return false;
    const flight = channel.flights.get(eventId);
    if (!flight) return false;
    channel.flights.delete(eventId);
    this.clear(flight.timer);
    if (!this.current(flight)) {
      this.attempt(() => flight.host.acknowledgeNotification(id, eventId, 'suppressed'));
      return false;
    }
    if (status === 'retry')
      this.attempt(() =>
        flight.host.retryNotification(id, eventId, NOTIFICATION_DISPATCH_LIMITS.retryMs),
      );
    else
      this.attempt(() =>
        flight.host.acknowledgeNotification(
          id,
          eventId,
          status === 'shown' || status === 'handled' ? 'submitted' : 'suppressed',
        ),
      );
    return true;
  }
  diagnostics() {
    return {
      channels: this.channels.size,
      inFlight: [...this.channels.values()].reduce((n, channel) => n + channel.flights.size, 0),
      failures: this.failures,
    };
  }
  close() {
    this.closed = true;
    for (const channel of this.channels.values())
      for (const flight of channel.flights.values()) this.clear(flight.timer);
    this.channels.clear();
  }
}
