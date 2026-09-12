import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire as createPackageRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const entryPath = resolve('src/desktop/entry.cjs');
const nativeRequire = createPackageRequire(entryPath);

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moor-desktop-entry-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'moor-preview-private');
  await mkdir(data, { mode: 0o700 });
  return { directory, data, nonce: randomUUID(), source: await readFile(entryPath, 'utf8') };
}

function select(source: string, env: Record<string, string>, workerError = false) {
  const loaded: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  const exited = {};
  try {
    runInNewContext(source, {
      require(name: string) {
        if (name.startsWith('node:')) return nativeRequire(name);
        loaded.push(name);
        if (workerError && name.includes('preview-renderer')) throw new Error('private detail');
        return {};
      },
      process: {
        env,
        getuid: process.getuid?.bind(process),
        stderr: { write: (message: string) => errors.push(message) },
        exit(code: number) {
          exitCode = code;
          throw exited;
        },
      },
    });
  } catch (error) {
    if (error !== exited) throw error;
  }
  return { loaded, errors, exitCode };
}

test('desktop fixed entry routes normal startup and a valid private worker without loading the other module', async (t) => {
  const { source, data, nonce } = await fixture(t);
  assert.deepEqual(select(source, {}).loaded, ['./main.cjs']);
  assert.deepEqual(select(source, { MOOR_PREVIEW_DATA: data, MOOR_PREVIEW_NONCE: nonce }), {
    loaded: ['./runtime/preview-renderer.cjs'],
    errors: [],
    exitCode: undefined,
  });
  const failed = select(source, { MOOR_PREVIEW_DATA: data, MOOR_PREVIEW_NONCE: nonce }, true);
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.loaded, ['./runtime/preview-renderer.cjs']);
  assert.equal(failed.errors.join('').includes('private detail'), false);
});

test('desktop fixed entry fails closed on incomplete, malformed, shared or symlinked preview data', async (t) => {
  const { source, directory, data, nonce } = await fixture(t);
  const file = join(directory, 'file');
  await writeFile(file, 'synthetic');
  const link = join(directory, 'link');
  await symlink(data, link);
  const publicData = join(directory, 'public');
  await mkdir(publicData, { mode: 0o755 });
  await chmod(publicData, 0o755);
  const invalid: Record<string, string>[] = [
    { MOOR_PREVIEW_DATA: data },
    { MOOR_PREVIEW_NONCE: nonce },
    { MOOR_PREVIEW_DATA: '', MOOR_PREVIEW_NONCE: nonce },
    { MOOR_PREVIEW_DATA: data, MOOR_PREVIEW_NONCE: '' },
    { MOOR_PREVIEW_DATA: data, MOOR_PREVIEW_NONCE: 'not-a-nonce' },
    { MOOR_PREVIEW_DATA: 'relative', MOOR_PREVIEW_NONCE: nonce },
    { MOOR_PREVIEW_DATA: file, MOOR_PREVIEW_NONCE: nonce },
    { MOOR_PREVIEW_DATA: link, MOOR_PREVIEW_NONCE: nonce },
    { MOOR_PREVIEW_DATA: publicData, MOOR_PREVIEW_NONCE: nonce },
    { MOOR_PREVIEW_DATA: join(directory, 'missing'), MOOR_PREVIEW_NONCE: nonce },
  ];
  for (const env of invalid) {
    const result = select(source, env);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.loaded, []);
    assert.equal(result.errors.join('').includes(directory), false);
  }
});

// This copies only the pinned Electron distribution into a disposable application
// bundle. Both application modules are synthetic; Moor main and user data are never
// loaded. Opt in with MOOR_TEST_ELECTRON_PREVIEW=1 on a graphical macOS host.
test(
  'real packaged Electron ignores worker argv but fixed package entry selects only the private worker',
  { skip: process.platform !== 'darwin' || process.env.MOOR_TEST_ELECTRON_PREVIEW !== '1' },
  async (t) => {
    const { directory, data, nonce } = await fixture(t);
    const originalBinary = nativeRequire('electron') as string;
    const originalBundle = resolve(dirname(originalBinary), '../..');
    const copiedBundle = join(directory, 'Synthetic Preview.app');
    await promisify(execFile)('/bin/cp', ['-cR', originalBundle, copiedBundle]);
    const resources = join(copiedBundle, 'Contents/Resources/app');
    const runtime = join(resources, 'runtime');
    await mkdir(runtime, { recursive: true });
    await copyFile(entryPath, join(resources, 'entry.cjs'));
    for (const [name, loaded] of [
      ['main.cjs', 'main'],
      ['runtime/preview-renderer.cjs', 'worker'],
    ]) {
      await writeFile(
        join(resources, name!),
        `const { app } = require('electron');
app.setPath('userData', process.env.MOOR_ENTRY_TEST_DATA);
require('node:fs').writeFileSync(process.env.MOOR_ENTRY_TEST_MARKER, JSON.stringify({
 loaded: ${JSON.stringify(loaded)}, appPath: app.getAppPath(), defaultApp: !!process.defaultApp,
 argv: process.argv.slice(1)
}));
app.exit(0);
`,
      );
    }
    const binary = join(copiedBundle, 'Contents/MacOS/Electron');
    const worker = join(runtime, 'preview-renderer.cjs');
    const baseEnvironment: Record<string, string> = {
      HOME: directory,
      TMPDIR: directory,
      MOOR_ENTRY_TEST_DATA: data,
    };
    for (const name of ['PATH', 'LANG', 'LC_ALL']) {
      if (process.env[name]) baseEnvironment[name] = process.env[name]!;
    }
    const run = async (main: string, env: Record<string, string>, argv: string[] = [worker]) => {
      await writeFile(
        join(resources, 'package.json'),
        JSON.stringify({ name: 'synthetic-preview', main }),
      );
      const marker = join(directory, `marker-${randomUUID()}.json`);
      const child = spawn(binary, argv, {
        env: { ...baseEnvironment, ...env, MOOR_ENTRY_TEST_MARKER: marker },
        cwd: directory,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (value: string) => {
        stderr = (stderr + value).slice(-16_384);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      ).finally(() => clearTimeout(timer));
      let result:
        | { loaded: string; appPath: string; defaultApp: boolean; argv: string[] }
        | undefined;
      try {
        result = JSON.parse(await readFile(marker, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { ...closed, result, stderr };
    };
    const privateEnvironment = { MOOR_PREVIEW_NONCE: nonce, MOOR_PREVIEW_DATA: data };
    const old = await run('main.cjs', privateEnvironment);
    assert.equal(old.code, 0, JSON.stringify(old));
    assert.equal(old.result?.appPath, resources);
    assert.equal(old.result?.defaultApp, false);
    assert.equal(old.result?.loaded, 'main');
    assert.ok(old.result?.argv.includes(worker));

    const selected = await run('entry.cjs', privateEnvironment);
    assert.equal(selected.code, 0, selected.stderr);
    assert.equal(selected.result?.appPath, resources);
    assert.equal(selected.result?.loaded, 'worker');
    const normal = await run('entry.cjs', {}, []);
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(normal.result?.loaded, 'main');
    const invalid = await run('entry.cjs', { MOOR_PREVIEW_NONCE: nonce });
    assert.equal(invalid.code, 1, invalid.stderr);
    assert.equal(invalid.result, undefined);
    assert.match(invalid.stderr, /Invalid private preview process configuration/);
  },
);
