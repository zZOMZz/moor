import { createHash, randomUUID } from 'node:crypto';
export const hostHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const hostUuid = randomUUID;
