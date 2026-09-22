import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { CLIENT_URL } from '../../apps/desktop/src/main/client-assets.cjs';

for (const redirected of [false, true])
  test(`desktop startup preserves retired data without a cleanup prerequisite (${redirected ? 'redirected' : 'regular'} partitions)`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'moor-retired-client-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const data = join(root, 'data');
    const partitions = join(redirected ? root : data, 'Partitions');
    await mkdir(data);
    await mkdir(partitions);
    if (redirected) await symlink(partitions, join(data, 'Partitions'));
    const retired = ['personal-local', 'personal-remote'];
    for (const name of retired) {
      await mkdir(join(partitions, name));
      await writeFile(
        join(partitions, name, 'synthetic-draft-and-operation'),
        JSON.stringify({ draft: name, operationId: `original-${name}`, state: 'unknown' }),
      );
    }
    await writeFile(join(data, 'settings.json'), JSON.stringify({ projects: [], agents: [] }));

    const localRequire = createRequire(resolve('apps/desktop/src/main/main.cjs'));
    const opened: string[] = [];
    const usedPartitions: string[] = [];
    const errors: unknown[] = [];
    let hostStarts = 0;
    let quitCount = 0;
    let ready!: () => void;
    let pageLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => (pageLoaded = resolve));
    const application = Object.assign(new EventEmitter(), {
      setName() {},
      setPath() {},
      getPath: () => data,
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then: (callback: () => void) => (ready = callback) }),
      quit: () => quitCount++,
    });
    const electron = {
      app: application,
      protocol: { registerSchemesAsPrivileged() {} },
      nativeTheme: { themeSource: 'system' },
      ipcMain: { handle() {} },
      Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu() {} },
      Notification: { isSupported: () => false },
      dialog: {
        showErrorBox: (...value: unknown[]) => errors.push(value),
        showMessageBox: async (value: unknown) => errors.push(value),
      },
      session: {
        fromPartition: (name: string) => {
          usedPartitions.push(name);
          return {};
        },
      },
    };
    const process = Object.assign(new EventEmitter(), {
      env: { MOOR_DESKTOP_DATA_DIR: data },
      execPath: '/synthetic/electron',
    });
    const context = {
      __dirname: resolve('apps/desktop/src/main'),
      process,
      Buffer,
      URL,
      structuredClone,
      setTimeout,
      clearTimeout,
      require: (name: string) => {
        if (name === 'electron') return electron;
        if (name === './recovery.cjs')
          return {
            ProcessRecovery: class {
              start() {
                hostStarts++;
              }
              stop() {}
            },
          };
        if (name === './client-window.cjs')
          return {
            CLIENT_PARTITION: 'persist:moor-secure-client-v1',
            prepareClientSession: async () => {},
            createClientWindow: ({ registry }: { registry: Map<unknown, unknown> }) => {
              const window = Object.assign(new EventEmitter(), {
                isDestroyed: () => false,
                webContents: { send() {} },
              });
              registry.set(window.webContents, { window, trustedClient: true });
              return window;
            },
          };
        if (name === './page-loader.cjs')
          return {
            loadPage: (_window: unknown, url: string) => {
              opened.push(url);
              pageLoaded();
            },
          };
        return localRequire(name);
      },
    };

    runInNewContext(await readFile(resolve('apps/desktop/src/main/main.cjs'), 'utf8'), context);
    ready();
    assert.equal(quitCount, 0);
    assert.equal(hostStarts, 1);
    await loaded;
    assert.deepEqual(errors, []);
    assert.deepEqual(opened, [CLIENT_URL]);
    assert(usedPartitions.every((name) => name === 'persist:moor-secure-client-v1'));
    for (const name of retired)
      assert.deepEqual(
        JSON.parse(await readFile(join(partitions, name, 'synthetic-draft-and-operation'), 'utf8')),
        { draft: name, operationId: `original-${name}`, state: 'unknown' },
      );
    if (redirected) assert((await lstat(join(data, 'Partitions'))).isSymbolicLink());
    application.emit('before-quit');
  });
