import type {
  MoorPushSubscription,
  NotificationEnvelope,
  NotificationPreferences,
} from '@moor/protocol/notification-protocol';
export type WebPushState = { configured: boolean; publicKey?: string; reason?: string };
export type WebPushResult = {
  status: 'sent' | 'failed' | 'unknown' | 'expired';
  statusCode?: number;
};
export interface WebPushTransport {
  state: WebPushState;
  send(subscription: MoorPushSubscription, event: NotificationEnvelope): Promise<WebPushResult>;
  close?(): void;
}
export type SubscriptionRow = {
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
export interface PushRecords {
  atomic<T>(work: () => T): T;
  liveLogin(owner: string, loginHash: string, now: number): boolean;
  prune(now: number): void;
  subscriptions(owner: string, loginHash: string): SubscriptionRow[];
  endpoint(endpoint: string): SubscriptionRow | undefined;
  countSubscriptions(owner: string): number;
  replaceBrowserSubscription(owner: string, loginHash: string, id: string): void;
  saveSubscription(row: SubscriptionRow): void;
  subscription(
    owner: string,
    loginHash: string,
    id: string,
    enabledOnly?: boolean,
  ): SubscriptionRow | undefined;
  preferences(owner: string, loginHash: string, id: string, preferences: string): void;
  remove(owner: string, loginHash: string, id: string): void;
  revokeLogin(loginHash: string): void;
  interrupt(): void;
  fingerprint(owner: string, eventId: string): string | undefined;
  countEvents(owner: string): number;
  event(event: NotificationEnvelope, fingerprint: string): void;
  enabledSubscriptions(owner: string, limit: number): SubscriptionRow[];
  stage(owner: string, eventId: string, id: string, now: number): void;
  settle(
    owner: string,
    eventId: string,
    id: string,
    status: string,
    statusCode: number | null,
    now: number,
  ): void;
  expire(original: SubscriptionRow): void;
}
export type PushOptions = {
  now: () => number;
  transport: WebPushTransport;
  validateSubscription(input: unknown): MoorPushSubscription;
  authorize(event: NotificationEnvelope): boolean;
  hash(value: string): string;
};
