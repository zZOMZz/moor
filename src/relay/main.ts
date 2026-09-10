import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, token } from './accounts';
import { createApp } from './http';
const data = resolve(process.env.MOOR_DATA_DIR ?? process.env.PERSONAL_DATA_DIR ?? '.data');
mkdirSync(data, { recursive: true, mode: 0o700 });
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
const port = Number(process.env.PORT ?? 3078),
  host = process.env.HOST ?? '127.0.0.1';
const origin = process.env.MOOR_ORIGIN ?? process.env.PERSONAL_ORIGIN ?? `http://localhost:${port}`;
const store = new Store(join(data, 'accounts.sqlite'));
chmodSync(join(data, 'accounts.sqlite'), 0o600);
const app = createApp(store, {
  origin,
  setupToken,
  publicDir: process.env.MOOR_PUBLIC_DIR ?? process.env.PERSONAL_PUBLIC_DIR,
});
app.server.listen(port, host, () => {
  console.log(`Moor: ${origin}`);
  if (!store.hasAccount())
    console.log(
      (process.env.MOOR_SETUP_TOKEN ?? process.env.PERSONAL_SETUP_TOKEN)
        ? '使用配置中的初始化口令'
        : `初始化口令保存在 ${setupFile}`,
    );
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
