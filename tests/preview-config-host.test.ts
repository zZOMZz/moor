import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../src/runtime/store';
import { captureProjectSnapshot, enumerateProjectFiles } from '../src/runtime/project-snapshot';
import { readProjectFileBytes } from '../src/runtime/project-files';

const entry = resolve('src/bridge/host-main.ts'),
  privateLabel = 'SYNTHETIC_PRIVATE_PREVIEW_SERVICE';
function fixture(t: { after(fn: () => unknown): void }, insideProject = false) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'moor-preview-host-'))),
    root = join(data, 'project');
  mkdirSync(root);
  const privatePath = join(insideProject ? root : data, 'private');
  mkdirSync(privatePath);
  const runtimeFile = join(privatePath, 'runtime.sqlite'),
    configFile = join(privatePath, 'bridge.json'),
    previewFile = join(privatePath, 'preview-v1.json');
  const store = new RuntimeStore(runtimeFile),
    projectId = store.registerProject(root);
  store.close();
  const children: { child: ChildProcess; closed: Promise<any> }[] = [];
  t.after(async () => {
    for (const p of children) {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
      await p.closed;
    }
    rmSync(data, { recursive: true, force: true });
  });
  const args = ['--config', configFile, '--runtime-data', runtimeFile],
    env = { ...process.env, MOOR_RUNTIME_DATA: runtimeFile };
  const save = (extra: Record<string, unknown> = {}) => ({
    action: 'service-save',
    expectedRevision: 0,
    localProjectId: projectId,
    executionId: 'shared',
    label: privateLabel,
    address: '127.0.0.1',
    port: 5173,
    startPath: '/',
    enabled: true,
    ...extra,
  });
  async function cli(input: unknown, extra: string[] = []) {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', entry, ...args, '--preview-config-stdin', ...extra],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      closed = once(child, 'close');
    children.push({ child, closed });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    const [code] = await closed;
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  }
  function desktop() {
    const child = fork(
        entry,
        [...args, '--desktop', '--server', '', '--public-dir', resolve('src/web/public')],
        { env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      ),
      closed = once(child, 'close');
    children.push({ child, closed });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr?.on('data', (bytes) => {
      stderr += bytes;
    });
    const messages: any[] = [],
      waiters = new Set<{ predicate(message: any): boolean; resolve(message: any): void }>();
    child.on('message', (message) => {
      messages.push(message);
      for (const waiter of waiters)
        if (waiter.predicate(message)) {
          waiters.delete(waiter);
          waiter.resolve(message);
        }
    });
    const wait = (predicate: (message: any) => boolean): Promise<any> => {
      const prior = messages.find(predicate);
      if (prior) return Promise.resolve(prior);
      return Promise.race([
        new Promise((resolve) => waiters.add({ predicate, resolve })),
        closed.then(() => {
          throw new Error('Synthetic preview host closed before IPC: ' + stderr);
        }),
      ]);
    };
    return {
      child,
      closed,
      messages,
      wait,
      output: () => ({ stdout, stderr }),
      async request(action: unknown, requestId: string = randomUUID()) {
        const waiting = wait(
          (m) => m.type === 'preview-config-result' && m.requestId === requestId,
        );
        child.send({ type: 'preview-config', requestId, action });
        return waiting;
      },
    };
  }
  return { data, root, runtimeFile, configFile, previewFile, projectId, save, cli, desktop };
}

test(
  'actual preview CLI persists explicit local enable and rejects raw destinations, oversized input and active runtime ownership',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const read = await f.cli({ action: 'read' });
    assert.equal(read.code, 0, read.stderr);
    assert.equal(read.json().targets[0].localProjectId, f.projectId);
    assert.equal(read.json().targets[0].executionId, 'shared');
    for (const flags of [['--desktop'], ['--pair', 'synthetic'], ['--github-config-stdin']]) {
      const invalid = await f.cli({ action: 'read' }, flags);
      assert.equal(invalid.code, 1);
      assert.match(invalid.json().error, /不能同时/);
      assert.equal(existsSync(f.previewFile), false);
    }
    for (const action of [
      f.save({ url: 'http://example.invalid' }),
      f.save({ address: 'localhost' }),
      f.save({ rootPath: '/synthetic/outside' }),
    ]) {
      const invalid = await f.cli(action);
      assert.equal(invalid.code, 1);
      assert.match(invalid.json().error, /请求无效/);
    }
    const large = await f.cli(' '.repeat(16 * 1024 + 1));
    assert.equal(large.code, 1);
    assert.match(large.json().error, /请求过大/);
    const saved = await f.cli(f.save());
    assert.equal(saved.code, 0, saved.stderr);
    const id = saved.json().services[0].id;
    assert.equal(saved.json().services[0].enabled, true);
    assert.equal(statSync(f.previewFile).mode & 0o777, 0o600);
    const before = readFileSync(f.previewFile, 'utf8');
    const host = f.desktop();
    await host.wait((m) => m.type === 'local-ready');
    const locked = await f.cli({ action: 'service-remove', expectedRevision: 1, id });
    assert.equal(locked.code, 3);
    assert.equal(readFileSync(f.previewFile, 'utf8'), before);
    host.child.kill('SIGTERM');
    const [code] = await host.closed;
    assert.equal(code, 0, host.output().stderr);
    const disabled = await f.cli({
      action: 'service-enabled',
      expectedRevision: 1,
      id,
      enabled: false,
    });
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(disabled.json().services[0].enabled, false);
    const restored = await f.cli({ action: 'read' });
    assert.equal(restored.json().revision, 2);
    const runtime = new RuntimeStore(f.runtimeFile);
    try {
      assert.equal(runtime.journal.db.prepare('SELECT count(*) AS n FROM operation').get()!.n, 0);
      assert.equal(
        runtime.journal.db.prepare('SELECT count(*) AS n FROM agent_session').get()!.n,
        0,
      );
      assert.equal(runtime.journal.db.prepare('SELECT count(*) AS n FROM session').get()!.n, 0);
    } finally {
      runtime.close();
    }
  },
);

test(
  'actual desktop host IPC blocks its own service port, never probes the registered endpoint, and keeps preview configuration outside relay data',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end('Synthetic preview');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert(address && typeof address === 'object');
    const host = f.desktop(),
      ready = await host.wait((m) => m.type === 'local-ready'),
      ownPort = Number(new URL(ready.origin).port);
    const state = await host.request({ action: 'read' });
    assert.equal(state.ok, true);
    for (const address of ['127.0.0.1', '::1']) {
      const denied = await host.request(f.save({ address, port: ownPort }));
      assert.equal(denied.ok, false);
      assert.match(denied.error, /Moor 自身/);
    }
    const saved = await host.request(f.save({ port: address.port }));
    assert.equal(saved.ok, true);
    const id = saved.state.services[0].id;
    assert.equal(saved.state.services[0].current, true);
    assert.equal(saved.state.services[0].enabled, true);
    assert.equal(requests, 0, 'registering a service must not fetch or scan it');
    host.child.send({
      type: 'preview-config',
      requestId: '../invalid',
      action: { action: 'service-remove', id, expectedRevision: 1 },
    });
    const barrier = await host.request({ action: 'read' });
    assert.equal(barrier.state.revision, 1);
    assert.equal(
      host.messages.some((m) => m.type === 'preview-config-result' && m.requestId === '../invalid'),
      false,
    );
    const malformed = await host.request({ action: 'read', rawUrl: 'http://127.0.0.1:80' });
    assert.equal(malformed.ok, false);
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    for (const path of ['/api/workspaces', '/api/devices']) {
      const response = await fetch(ready.origin + path, {
        headers: { Cookie: 'personal=' + ready.secret },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.text()).includes(privateLabel), false);
    }
    const forbidden = await fetch(ready.origin + '/api/preview-config', {
      method: 'POST',
      headers: {
        Cookie: 'personal=' + ready.secret,
        Origin: ready.origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'read' }),
    });
    assert.equal(forbidden.status, 404);
    assert.equal(host.output().stdout.includes(privateLabel), false);
    assert.equal(host.output().stderr.includes(privateLabel), false);
    host.child.kill('SIGTERM');
    await host.closed;
    for (const file of [f.runtimeFile, f.configFile + '.catalog.sqlite'])
      assert.equal(readFileSync(file).includes(Buffer.from(privateLabel)), false);
    const restarted = f.desktop();
    await restarted.wait((m) => m.type === 'local-ready');
    const restored = await restarted.request({ action: 'read' });
    assert.equal(restored.state.revision, 1);
    assert.equal(requests, 0, 'host restart must not open saved preview services');
    const disabled = await restarted.request({
      action: 'service-enabled',
      id,
      expectedRevision: 1,
      enabled: false,
    });
    assert.equal(disabled.ok, true);
    const removed = await restarted.request({ action: 'service-remove', id, expectedRevision: 2 });
    assert.equal(removed.ok, true);
    assert.equal(removed.state.services.length, 0);
    restarted.child.kill('SIGTERM');
    await restarted.closed;
  },
);

test(
  'real host configuration refuses project-local storage and reserved preview records remain absent from files and frozen snapshots',
  { timeout: 15000 },
  async (t) => {
    const unsafe = fixture(t, true);
    const rejected = await unsafe.cli(unsafe.save());
    assert.equal(rejected.code, 1);
    assert.match(rejected.json().error, /项目目录外/);
    assert.equal(existsSync(unsafe.previewFile), false);
    const f = fixture(t),
      saved = await f.cli(f.save());
    assert.equal(saved.code, 0, saved.stderr);
    const bytes = readFileSync(f.previewFile);
    mkdirSync(join(f.root, 'nested'));
    writeFileSync(join(f.root, 'ordinary.txt'), 'Visible synthetic content');
    for (const path of [
      'preview-v1.json',
      'nested/PREVIEW-V1.JSON',
      'nested/preview-v1.json.tmp-old',
    ]) {
      writeFileSync(join(f.root, path), bytes, { mode: 0o600 });
      await assert.rejects(readProjectFileBytes(f.root, path), /主机私有配置/);
    }
    const tree = await enumerateProjectFiles(f.root),
      snapshot = await captureProjectSnapshot(f.root);
    assert.equal(
      tree.entries.some((e) => e.path.toLowerCase().includes('preview-v1.json')),
      false,
    );
    assert.equal(
      snapshot.files.some((e) => e.path.toLowerCase().includes('preview-v1.json')),
      false,
    );
    assert.equal(JSON.stringify(snapshot).includes(privateLabel), false);
    assert.ok(
      snapshot.files.some(
        (e) => e.path === 'ordinary.txt' && e.text === 'Visible synthetic content',
      ),
    );
  },
);
