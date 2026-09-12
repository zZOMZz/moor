import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './accounts';
import { acquireRuntimeLock } from '../runtime/lock';

export const ACCOUNT_RECOVERY_SUCCESS = '账号密码已恢复；旧登录和配对码已失效。';
export const ACCOUNT_RECOVERY_FAILED =
  '账号恢复未完成；请停止中转，检查现有数据目录与标准输入后重试。';
export const ACCOUNT_RECOVERY_MAX_BYTES = 4096;
const requestSchema = z
  .object({
    email: z.string().email().max(200),
    password: z.string().min(12).max(1024),
  })
  .strict();

function directoryPath(directory: string) {
  const path = resolve(directory);
  if (!lstatSync(path).isDirectory()) throw new Error(ACCOUNT_RECOVERY_FAILED);
  return realpathSync(path);
}
function regularFile(path: string, optional = false) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error(ACCOUNT_RECOVERY_FAILED);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
/** The relay and operator command share an OS lock; old relay versions must also be stopped. */
export function acquireRelayAccountLock(directory: string) {
  const data = directoryPath(directory),
    file = join(data, 'accounts.sqlite');
  regularFile(file, true);
  for (const suffix of ['-wal', '-shm']) regularFile(file + suffix, true);
  const lockFile = file + '.relay-lock';
  regularFile(lockFile, true);
  return acquireRuntimeLock(lockFile);
}

/** Only the private server entrypoint calls this; there is no HTTP recovery route. */
export async function recoverAccount(input: {
  dataDirectory: string;
  stdin: AsyncIterable<Uint8Array | string>;
  stdout(value: string): void;
  stderr(value: string): void;
}): Promise<number> {
  let release: (() => void) | undefined, store: Store | undefined;
  try {
    const file = join(directoryPath(input.dataDirectory), 'accounts.sqlite');
    const original = regularFile(file)!;
    release = acquireRelayAccountLock(input.dataDirectory);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const value of input.stdin) {
      const bytes = Buffer.from(value);
      size += bytes.byteLength;
      if (size > ACCOUNT_RECOVERY_MAX_BYTES) throw new Error(ACCOUNT_RECOVERY_FAILED);
      chunks.push(bytes);
    }
    const request = requestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    );
    const current = regularFile(file)!;
    if (current.dev !== original.dev || current.ino !== original.ino)
      throw new Error(ACCOUNT_RECOVERY_FAILED);
    // Recheck SQLite sidecars after reading stdin, before opening the actual account store.
    for (const suffix of ['-wal', '-shm']) regularFile(file + suffix, true);
    store = new Store(file);
    await store.resetPassword(request.email, request.password);
    store.close();
    store = undefined;
    release();
    release = undefined;
    input.stdout(ACCOUNT_RECOVERY_SUCCESS + '\n');
    return 0;
  } catch {
    input.stderr(ACCOUNT_RECOVERY_FAILED + '\n');
    return 1;
  } finally {
    store?.close();
    release?.();
  }
}
