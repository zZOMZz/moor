import { createECDH, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import webPush from 'web-push';
import { assert } from '@moor/protocol/protocol';
import {
  NOTIFICATION_LIMITS,
  notificationEnvelopeSchema,
} from '@moor/protocol/notification-protocol';
import {
  decodePushKey,
  validatePushEndpoint,
  validatePushSubscription,
  type WebPushResult,
  type WebPushState,
  type WebPushTransport,
} from '@moor/gateway/notifications';
export {
  PUSH_PROVIDERS,
  validatePushEndpoint,
  validatePushSubscription,
} from '@moor/gateway/notifications';
export type { WebPushResult, WebPushState, WebPushTransport };

export type WebPushRequest = {
  endpoint: string;
  method: string;
  headers: Record<string, string | number>;
  body: Buffer;
};
type WireDependencies = {
  signal?: AbortSignal;
  request?: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  // Tests inject deterministic timer callbacks; no sleeps or real push accounts.
  schedule?: (callback: () => void, milliseconds: number) => () => void;
};
const schedule = (callback: () => void, milliseconds: number) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
export function sendPushRequest(
  details: WebPushRequest,
  dependencies: WireDependencies = {},
): Promise<WebPushResult> {
  const url = new URL(validatePushEndpoint(details.endpoint));
  assert(details.method === 'POST' && details.body.length <= 4096, 400, '推送请求无效');
  return new Promise((resolve) => {
    let settled = false;
    let clear = () => {};
    let request: ClientRequest | undefined;
    const abort = () => {
      finish({ status: 'unknown' });
      request?.destroy();
    };
    const finish = (result: WebPushResult) => {
      if (settled) return;
      settled = true;
      clear();
      dependencies.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    if (dependencies.signal?.aborted) {
      finish({ status: 'failed' });
      return;
    }
    dependencies.signal?.addEventListener('abort', abort, { once: true });
    try {
      request = (dependencies.request ?? httpsRequest)(
        url,
        {
          method: 'POST',
          headers: details.headers,
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: 8192,
        },
        (response) => {
          const code = response.statusCode ?? 0;
          // A provider's response body may contain endpoint details. Neither
          // retain nor log it; no response is followed as a redirect.
          response.destroy();
          finish({
            status:
              code >= 200 && code < 300
                ? 'sent'
                : code === 404 || code === 410
                  ? 'expired'
                  : code >= 300 && code < 500
                    ? 'failed'
                    : 'unknown',
            ...(code ? { statusCode: code } : {}),
          });
        },
      );
      request.on('error', () => finish({ status: 'unknown' }));
      clear = (dependencies.schedule ?? schedule)(() => {
        finish({ status: 'unknown' });
        request?.destroy();
      }, 8000);
      if (settled) clear();
      request.end(details.body);
    } catch {
      finish({ status: 'unknown' });
      request?.destroy();
    }
  });
}

export function createWebPushTransport(
  environment: Record<string, string | undefined> = process.env,
  dependencies: WireDependencies & { now?: () => number } = {},
): WebPushTransport {
  const publicKey = environment.MOOR_WEB_PUSH_PUBLIC_KEY,
    privateKey = environment.MOOR_WEB_PUSH_PRIVATE_KEY,
    subject = environment.MOOR_WEB_PUSH_SUBJECT;
  const disabled = (reason: string): WebPushTransport => ({
    state: { configured: false, reason },
    async send() {
      return { status: 'failed' };
    },
  });
  if (!publicKey && !privateKey && !subject) return disabled('中转尚未配置 Web Push');
  try {
    assert(publicKey && privateKey && subject && subject.length <= 2048, 400, '配置不完整');
    const publicBytes = decodePushKey(publicKey, 65),
      privateBytes = decodePushKey(privateKey, 32);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    assert(timingSafeEqual(ecdh.getPublicKey(), publicBytes), 400, '密钥不匹配');
    const contact = new URL(subject);
    assert(
      ['mailto:', 'https:'].includes(contact.protocol) &&
        !contact.username &&
        !contact.password &&
        !contact.hash &&
        (contact.protocol === 'mailto:' ? contact.pathname.includes('@') : !!contact.hostname),
      400,
      '联系地址无效',
    );
  } catch {
    return disabled('Web Push 配置无效，请检查 VAPID 密钥和联系地址');
  }
  const now = dependencies.now ?? Date.now;
  const controller = new AbortController();
  return {
    state: { configured: true, publicKey },
    close() {
      controller.abort();
    },
    async send(input, event) {
      try {
        const subscription = validatePushSubscription(input),
          envelope = notificationEnvelopeSchema.parse(event),
          payload = JSON.stringify(envelope);
        assert(Buffer.byteLength(payload) < NOTIFICATION_LIMITS.payloadBytes, 413, '通知标识过长');
        if (controller.signal.aborted || envelope.expiresAt <= now()) return { status: 'failed' };
        const details = webPush.generateRequestDetails(subscription, payload, {
          contentEncoding: 'aes128gcm',
          TTL: Math.max(0, Math.floor((envelope.expiresAt - now()) / 1000)),
          urgency: envelope.kind === 'approval-required' ? 'high' : 'normal',
          vapidDetails: { publicKey: publicKey!, privateKey: privateKey!, subject: subject! },
        });
        return await sendPushRequest(details, { ...dependencies, signal: controller.signal });
      } catch {
        return { status: 'failed' };
      }
    },
  };
}
