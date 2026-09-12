import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, token } from './accounts';
import { createGoogleOidcProvider } from './google-oidc';
import {
  ACCOUNT_RECOVERY_FAILED,
  acquireRelayAccountLock,
  recoverAccount,
} from './account-recovery';

class StartupError extends Error {}
function googleProvider(origin: string) {
  const clientId = process.env.MOOR_GOOGLE_CLIENT_ID,
    clientSecret = process.env.MOOR_GOOGLE_CLIENT_SECRET;
  if (!clientId && !clientSecret) return undefined;
  try {
    if (!clientId || !clientSecret) throw new Error();
    return createGoogleOidcProvider({
      clientId,
      clientSecret,
      redirectUri: new URL('/api/auth/google/callback', origin).href,
    });
  } catch {
    throw new StartupError('Google 登录配置无效，请核对客户端配置。');
  }
}
function serverOrigin(value: string) {
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error();
    return value;
  } catch {
    throw new StartupError('中转地址配置无效，请使用 HTTPS 或本机回环 HTTP 地址。');
  }
}
async function main() {
  const data = resolve(process.env.MOOR_DATA_DIR ?? process.env.PERSONAL_DATA_DIR ?? '.data');
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 1 || args[0] !== '--recover-account') {
      process.stderr.write(ACCOUNT_RECOVERY_FAILED + '\n');
      process.exitCode = 1;
      return;
    }
    process.exitCode = await recoverAccount({
      dataDirectory: data,
      stdin: process.stdin,
      stdout: (value) => process.stdout.write(value),
      stderr: (value) => process.stderr.write(value),
    });
    return;
  }
  const port = Number(process.env.PORT ?? 3078),
    host = process.env.HOST ?? '127.0.0.1';
  const origin = serverOrigin(
      process.env.MOOR_ORIGIN ?? process.env.PERSONAL_ORIGIN ?? `http://localhost:${port}`,
    ),
    provider = googleProvider(origin);
  const { createApp } = await import('./http');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  let release: () => void;
  try {
    release = acquireRelayAccountLock(data);
  } catch {
    throw new StartupError('中转数据目录正被使用或无法安全打开，请先停止已有进程。');
  }
  process.once('exit', release);
  let store: Store | undefined, app: ReturnType<typeof createApp> | undefined;
  try {
    const setupFile = join(data, 'setup-token');
    let setupToken = process.env.MOOR_SETUP_TOKEN ?? process.env.PERSONAL_SETUP_TOKEN;
    if (!setupToken) {
      try {
        setupToken = readFileSync(setupFile, 'utf8').trim();
      } catch {
        setupToken = token();
        writeFileSync(setupFile, setupToken + '\n', { mode: 0o600 });
      }
    }
    store = new Store(join(data, 'accounts.sqlite'));
    chmodSync(join(data, 'accounts.sqlite'), 0o600);
    const activeApp = (app = createApp(store, {
      origin,
      setupToken,
      publicDir: process.env.MOOR_PUBLIC_DIR ?? process.env.PERSONAL_PUBLIC_DIR,
      googleProvider: provider,
    }));
    await new Promise<void>((resolve, reject) => {
      activeApp.server.once('error', reject);
      activeApp.server.listen(port, host, resolve);
    });
    console.log(`Moor: ${origin}`);
    if (!store.hasAccount())
      console.log(
        (process.env.MOOR_SETUP_TOKEN ?? process.env.PERSONAL_SETUP_TOKEN)
          ? '使用配置中的初始化口令'
          : `初始化口令保存在 ${setupFile}`,
      );
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        void activeApp.close().then(() => {
          store!.close();
          release();
          process.exit(0);
        });
      });
  } catch (error) {
    await app?.close().catch(() => {});
    store?.close();
    release();
    throw error;
  }
}
void main().catch((error) => {
  process.stderr.write(
    (error instanceof StartupError ? error.message : '中转启动失败，请检查本机配置。') + '\n',
  );
  process.exitCode = 1;
});
