import {
  type HostNotificationEvent,
  type NotificationScope,
} from '@moor/protocol/notification-protocol';

export interface NotificationPersistence {
  readonly now: () => number;
  record(
    scope: NotificationScope,
    kind: HostNotificationEvent['kind'],
    requestId?: string,
  ): HostNotificationEvent;
  diagnostics(): {
    active: number;
    overflow: number;
  };
  get(eventId: string, activeOnly?: boolean): HostNotificationEvent | undefined;
  resolveApprovals(scope: NotificationScope, requestId?: string): void;
  resolveAllApprovals(): void;
  discard(eventId: string): void;
  pending(channel: string, limit?: number): HostNotificationEvent[];
  acknowledge(channel: string, eventId: string, state: 'submitted' | 'suppressed'): void;
  retry(channel: string, eventId: string, delayMs?: number): void;
}
