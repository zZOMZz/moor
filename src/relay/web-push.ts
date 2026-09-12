import { createECDH, ECDH, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import webPush from 'web-push';
import { assert } from '../protocol';
import {
  NOTIFICATION_LIMITS,
  notificationEnvelopeSchema,
  pushSubscriptionSchema,
  type MoorPushSubscription,
  type NotificationEnvelope,
} from '../notification-protocol';

// Browser-issued production providers only. Endpoint paths are opaque. Never
// widen this into a caller-supplied HTTP destination or follow provider redirects.
export const PUSH_PROVIDERS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
export function validatePushEndpoint(input: string) {
  assert(input.length <= 2048 && !/[\x00-\x20\x7f\\]/u.test(input), 400, '推送地址无效');
  const url = new URL(input);
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      url.pathname !== '/' &&
      PUSH_PROVIDERS.has(url.hostname),
    400,
    '当前只支持 Chrome、Firefox 和 Safari 的标准推送服务地址',
  );
  return url.href;
}
function decodeKey(value: string, length: number) {
  assert(/^[A-Za-z0-9_-]+$/u.test(value), 400, '推送密钥格式无效');
  const bytes = Buffer.from(value, 'base64url');
  assert(bytes.length === length && bytes.toString('base64url') === value, 400, '推送密钥无效');
  return bytes;
}
export function validatePushSubscription(input: unknown): MoorPushSubscription {
  const parsed = pushSubscriptionSchema.parse(input);
  const key = decodeKey(parsed.keys.p256dh, 65);
  assert(key[0] === 4, 400, '推送公钥必须为 P-256 非压缩格式');
  try {
    ECDH.convertKey(key, 'prime256v1', undefined, undefined, 'uncompressed');
  } catch {
    assert(false, 400, '推送公钥不在 P-256 曲线上');
  }
  decodeKey(parsed.keys.auth, 16);
  return { ...parsed, endpoint: validatePushEndpoint(parsed.endpoint) };
}

export type WebPushState = { configured: boolean; publicKey?: string; reason?: string };
export type WebPushResult = {
  status: 'sent' | 'failed' | 'unknown' | 'expired';
  statusCode?: number;
};
export type WebPushTransport = {
  state: WebPushState;
  send(subscription: MoorPushSubscription, event: NotificationEnvelope): Promise<WebPushResult>;
  close?(): void;
};
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
    const publicBytes = decodeKey(publicKey, 65),
      privateBytes = decodeKey(privateKey, 32);
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
