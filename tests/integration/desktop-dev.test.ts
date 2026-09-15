import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareDesktopDevApp } from '../../scripts/build/desktop-dev-app.mjs';
import { publishRuntime, desktopRuntimeGroups } from '../../scripts/build/desktop-runtime.mjs';
import {
  developmentClientPolicy,
  confirmDevelopmentServer,
  clientDocumentMatches,
  allowsClientResource,
} from '../../apps/desktop/src/main/client-policy.cjs';
import { watchHostRuntime } from '../../apps/desktop/src/main/dev-runtime.cjs';
import { isCurrentContentDocument } from '../../apps/desktop/src/main/content-authority.cjs';

test('desktop development preparation preserves data and existing program files', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'moor-desktop-dev-'));
  try {
    const first = await prepareDesktopDevApp({ repository });
    await writeFile(join(first.dataRoot, 'settings.json'), 'PRESERVED');
    await writeFile(join(first.appRoot, 'entry.cjs'), 'existing compiled entry');
    const second = await prepareDesktopDevApp({ repository });
    assert.deepEqual(first, second);
    assert.equal(await readFile(join(first.dataRoot, 'settings.json'), 'utf8'), 'PRESERVED');
    assert.equal(
      await readFile(join(first.appRoot, 'entry.cjs'), 'utf8'),
      'existing compiled entry',
    );
    await assert.rejects(prepareDesktopDevApp({ repository, developmentRoot: tmpdir() }));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

const input = {
  enabled: true,
  isPackaged: false,
  rendererUrl: 'http://127.0.0.1:5173',
  token: 'a'.repeat(64),
};

test('development policy requires a development build and exact loopback origin; packaged mode ignores env', () => {
  assert.equal(developmentClientPolicy({ ...input, isPackaged: true }), undefined);
  assert.equal(
    developmentClientPolicy({ ...input, enabled: false, rendererUrl: 'https://evil.test' }),
    undefined,
  );
  for (const rendererUrl of [
    'http://localhost:5173/',
    'http://127.0.0.1/',
    'http://127.0.0.1:5173/other',
    'http://127.0.0.1:5173/?x=1',
    'http://127.0.0.1:5173/#x',
    'http://user@127.0.0.1:5173/',
    'https://evil.test/',
    'file:///etc/passwd',
  ])
    assert.throws(() => developmentClientPolicy({ ...input, rendererUrl }));
  assert.throws(() => developmentClientPolicy({ ...input, token: '' }));
  const policy = developmentClientPolicy(input)!;
  assert.equal(policy.url, input.rendererUrl + '/');
  assert(Object.isFrozen(policy));
  assert(allowsClientResource(policy, policy.origin + '/src/app/desktop-entry.ts'));
  assert(allowsClientResource(policy, 'ws://127.0.0.1:5173/__moor_dev__/hmr?token=synthetic'));
  for (const url of [
    'http://127.0.0.1:5174/',
    'http://127.0.0.1:5173.evil.test/',
    'https://evil.test/',
    'file:///etc/passwd',
    'ws://127.0.0.1:5173/api/socket',
    'http://user@127.0.0.1:5173/',
  ])
    assert.equal(allowsClientResource(policy, url), false, url);
});

test('development server must confirm this run identity without redirects', async () => {
  const policy = developmentClientPolicy(input)!;
  await confirmDevelopmentServer(policy, async (url: unknown, options: any) => {
    assert.equal(String(url), policy.origin + '/__moor_dev__/identity');
    assert.equal(options.redirect, 'error');
    return new Response(input.token);
  });
  await assert.rejects(
    confirmDevelopmentServer(policy, async () => new Response('different server')),
  );
  await assert.rejects(
    confirmDevelopmentServer(policy, async () => new Response(input.token, { status: 404 })),
  );
});

test('development documents use the same current-window authority checks as production', () => {
  const policy = developmentClientPolicy(input)!;
  const frame = { url: policy.url, origin: policy.origin };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  const registered = { trustedClient: true, origin: '', window, clientPolicy: policy };
  assert(isCurrentContentDocument(registered, contents, frame));
  assert.equal(
    isCurrentContentDocument(registered, contents, { ...frame }),
    false,
    'child/replaced frame',
  );
  for (const patch of [
    { url: policy.url + 'other' },
    { origin: 'http://127.0.0.1:5174' },
    { url: policy.url + '?x=1' },
  ])
    assert.equal(clientDocumentMatches(registered, { ...frame, ...patch }), false);
  assert.equal(
    clientDocumentMatches({ trustedClient: true }, frame),
    false,
    'production never trusts localhost',
  );
});

test('runtime publication is independent of renderer/relay, retains last success on a failed build', async () => {
  assert(!JSON.stringify(desktopRuntimeGroups).includes('apps/web'));
  assert(!JSON.stringify(desktopRuntimeGroups).includes('apps/relay'));
  const directory = await mkdtemp(join(tmpdir(), 'moor-runtime-build-'));
  try {
    const path = join(directory, 'runtime/bridge.mjs'),
      revision = join(directory, 'host-revision.txt');
    await publishRuntime(
      { errors: [], outputFiles: [{ path, contents: Buffer.from('synthetic host') }] },
      revision,
    );
    const first = await readFile(revision, 'utf8');
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(
      await publishRuntime(
        { errors: [], outputFiles: [{ path, contents: Buffer.from('synthetic host') }] },
        revision,
      ),
      false,
      'unchanged watch rebuilds must not restart a process',
    );
    assert.equal(
      await publishRuntime({ errors: ['synthetic failure'], outputFiles: [] }, revision),
      false,
    );
    assert.equal(await readFile(path, 'utf8'), 'synthetic host');
    assert.equal(await readFile(revision, 'utf8'), first);
    await rm(path);
    assert.equal(
      await publishRuntime(
        { errors: [], outputFiles: [{ path, contents: Buffer.from('synthetic host') }] },
        revision,
      ),
      true,
      'a missing generated output is repaired',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('host reload watches only successful revision changes, coalesces duplicate filesystem signals', async () => {
  let value = 'a'.repeat(64),
    listener: any,
    restarts = 0,
    closed = false;
  const watcher = watchHostRuntime({
    directory: '/synthetic/app',
    fs: {
      readFileSync: () => value,
      watch: (_path: string, fn: any) => {
        listener = fn;
        return {
          close: () => {
            closed = true;
          },
        };
      },
    },
    restart: async () => {
      restarts++;
    },
    onError: () => assert.fail('unexpected reload error'),
  });
  listener('rename', 'host-revision.txt');
  value = 'b'.repeat(64);
  listener('change', 'client-revision.txt');
  assert.equal(restarts, 0);
  listener('rename', 'host-revision.txt');
  listener('change', 'host-revision.txt');
  assert.equal(restarts, 1);
  value = 'invalid';
  listener('change', 'host-revision.txt');
  assert.equal(restarts, 1);
  watcher.close();
  assert(closed);
});
