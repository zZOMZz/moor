import { ECDH } from 'node:crypto';
import { assert } from '@moor/protocol/protocol';
import {
  pushSubscriptionSchema,
  type MoorPushSubscription,
} from '@moor/protocol/notification-protocol';
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
export function decodePushKey(value: string, length: number) {
  assert(/^[A-Za-z0-9_-]+$/u.test(value), 400, '推送密钥格式无效');
  const bytes = Buffer.from(value, 'base64url');
  assert(bytes.length === length && bytes.toString('base64url') === value, 400, '推送密钥无效');
  return bytes;
}
export function validatePushSubscription(input: unknown): MoorPushSubscription {
  const parsed = pushSubscriptionSchema.parse(input);
  const key = decodePushKey(parsed.keys.p256dh, 65);
  assert(key[0] === 4, 400, '推送公钥必须为 P-256 非压缩格式');
  try {
    ECDH.convertKey(key, 'prime256v1', undefined, undefined, 'uncompressed');
  } catch {
    assert(false, 400, '推送公钥不在 P-256 曲线上');
  }
  decodePushKey(parsed.keys.auth, 16);
  return { ...parsed, endpoint: validatePushEndpoint(parsed.endpoint) };
}
