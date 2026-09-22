import { z } from 'zod';
import { id } from './protocol';

/** Native Host connection identity. It is constructed by the transport, never session content. */
export const connectionAuthoritySchema = z
  .object({
    serverOrigin: z.string().url().max(2048),
    ownerId: z.string().min(1).max(1000),
    deviceId: id,
  })
  .strict();
export type ConnectionAuthority = z.infer<typeof connectionAuthoritySchema>;
export type ConnectionAuthorityLease = ConnectionAuthority & { current(): void };

export const RETIRED_RECORDS_FEATURE = 'retired-session-records-v1';
export const RETIRED_SESSION_FEATURE = '此功能已退场；仅可读取原记录，不会执行或改写原状态。';
export const HOST_UPGRADE_REQUIRED = '请先升级执行电脑，再发送新的指令';
