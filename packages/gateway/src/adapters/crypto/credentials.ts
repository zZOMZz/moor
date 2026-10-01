import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { CredentialPort } from '../../features/accounts/ports';
const derive = promisify(scrypt);
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const nodeCredentials: CredentialPort = {
  token,
  uuid: randomUUID,
  hash,
  derive: async (password, salt) => (await derive(password, salt, 64)) as Uint8Array,
  equal: timingSafeEqual,
};
