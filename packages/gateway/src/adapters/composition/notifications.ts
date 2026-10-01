import type { DatabaseSync } from 'node:sqlite';
import type { NotificationEnvelope } from '@moor/protocol/notification-protocol';
import { RelayNotificationService } from '../../features/notifications/service';
import type { PushOptions } from '../../features/notifications/ports';
import { SqlitePushRecords } from '../persistence/push';
import { validatePushSubscription } from '../crypto/push-subscription';
import { hash } from '../crypto/credentials';
export function createRelayNotifications(
  database: DatabaseSync,
  options: Partial<PushOptions> & { authorize(event: NotificationEnvelope): boolean },
) {
  return new RelayNotificationService(new SqlitePushRecords(database), {
    now: options.now ?? Date.now,
    hash: options.hash ?? hash,
    validateSubscription: options.validateSubscription ?? validatePushSubscription,
    authorize: options.authorize,
    transport: options.transport ?? {
      state: { configured: false, reason: '此入口未配置推送服务' },
      async send() {
        return { status: 'failed' };
      },
    },
  });
}
