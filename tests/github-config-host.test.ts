import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeStore } from '../src/runtime/store';
import { DesktopGitHubSettings } from '../src/desktop/github-settings.cjs';

const entry = resolve('src/bridge/host-main.ts');
function fixture(t: { after(fn: () => unknown): void }) {
  const data = mkdtempSync(join(tmpdir(), 'moor-github-host-')),
    privatePath = join(data, 'private'),
    root = join(data, 'project');
  mkdirSync(root);
  mkdirSync(privatePath);
  const runtimeFile = join(privatePath, 'runtime.sqlite'),
    configFile = join(privatePath, 'bridge.json'),
    githubFile = join(privatePath, 'github-v1.json');
  const store = new RuntimeStore(runtimeFile),
    projectId = store.registerProject(root);
  store.close();
  const children: { process: ChildProcess; closed: Promise<unknown> }[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null)
        child.process.kill('SIGKILL');
      await child.closed;
    }
    rmSync(data, { recursive: true, force: true });
  });
  const args = ['--config', configFile, '--runtime-data', runtimeFile];
  const environment = { ...process.env, MOOR_RUNTIME_DATA: runtimeFile };
  async function cli(input: unknown, extra: string[] = []) {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', entry, ...args, '--github-config-stdin', ...extra],
        { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      closed = once(child, 'close');
    children.push({ process: child, closed });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes.toString();
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes.toString();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    const [code, signal] = await closed;
    return { code, signal, stdout, stderr, json: () => JSON.parse(stdout) };
  }
  function desktop() {
    const child = fork(
        entry,
        [...args, '--desktop', '--server', '', '--public-dir', resolve('src/web/public')],
        {
          env: environment,
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      ),
      closed = once(child, 'close');
    children.push({ process: child, closed });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (bytes) => {
      stdout += bytes.toString();
    });
    child.stderr?.on('data', (bytes) => {
      stderr += bytes.toString();
    });
    const messages: any[] = [],
      waiters = new Set<{
        predicate: (message: any) => boolean;
        resolve: (message: any) => void;
      }>();
    child.on('message', (message) => {
      messages.push(message);
      for (const waiter of waiters)
        if (waiter.predicate(message)) {
          waiters.delete(waiter);
          waiter.resolve(message);
        }
    });
    const wait = (predicate: (message: any) => boolean): Promise<any> => {
      const previous = messages.find(predicate);
      if (previous) return Promise.resolve(previous);
      return Promise.race([
        new Promise((resolve) => waiters.add({ predicate, resolve })),
        closed.then(() => {
          throw new Error('Synthetic host closed before expected IPC: ' + stderr);
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
        const response = wait(
          (message) => message.type === 'github-config-result' && message.requestId === requestId,
        );
        child.send({ type: 'github-config', requestId, action });
        return response;
      },
    };
  }
  return { runtimeFile, githubFile, projectId, cli, desktop };
}

test(
  'actual host CLI manages private GitHub tokens without echo and rejects oversized stdin or concurrent host ownership',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      initial = await f.cli({ action: 'read' });
    assert.equal(initial.code, 0, initial.stderr);
    assert.equal(initial.json().revision, 0);
    assert.equal(initial.json().projects[0].id, f.projectId);
    for (const conflict of [['--pair', 'synthetic-conflict'], ['--desktop']]) {
      const rejected = await f.cli({ action: 'read' }, conflict);
      assert.equal(rejected.code, 1);
      assert.match(rejected.json().error, /不能同时/);
    }
    const saved = await f.cli({
      action: 'credential-save',
      expectedRevision: 0,
      label: 'Synthetic CLI',
      token: 'synthetic_cli_private_token',
    });
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout.includes('synthetic_cli_private_token'), false);
    assert.equal(saved.stderr.includes('synthetic_cli_private_token'), false);
    assert.equal(statSync(f.githubFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(f.githubFile, 'utf8').includes('synthetic_cli_private_token'), true);
    const credentialId = saved.json().credentials[0].id,
      oversized = await f.cli(' '.repeat(16 * 1024 + 1));
    assert.equal(oversized.code, 1);
    assert.match(oversized.json().error, /请求过大/);
    const host = f.desktop();
    await host.wait((message) => message.type === 'local-ready');
    const locked = await f.cli({ action: 'credential-remove', expectedRevision: 1, credentialId });
    assert.equal(locked.code, 3);
    assert.equal(readFileSync(f.githubFile, 'utf8').includes('synthetic_cli_private_token'), true);
    host.child.kill('SIGTERM');
    const [code] = await host.closed;
    assert.equal(code, 0, host.output().stderr);
    const removed = await f.cli({ action: 'credential-remove', expectedRevision: 1, credentialId });
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(removed.json().credentials, []);
    assert.equal(readFileSync(f.githubFile, 'utf8').includes('synthetic_cli_private_token'), false);
  },
);

test(
  'actual desktop host IPC isolates configuration replies, rejects malformed inputs, and never replays writes across shutdown',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      host = f.desktop();
    await host.wait((message) => message.type === 'local-ready');
    const read = await host.request({ action: 'read' });
    assert.equal(read.ok, true);
    const saved = await host.request({
      action: 'credential-save',
      expectedRevision: 0,
      label: 'Synthetic IPC',
      token: 'synthetic_ipc_private_token',
    });
    assert.equal(saved.ok, true);
    assert.equal(JSON.stringify(saved).includes('synthetic_ipc_private_token'), false);
    const credentialId = saved.state.credentials[0].id,
      requestId = 'invalid-request';
    const invalid = await host.request({ action: 'read', token: 'synthetic_bad_input' }, requestId);
    assert.equal(invalid.ok, false);
    assert.equal(JSON.stringify(invalid).includes('synthetic_bad_input'), false);
    host.child.send({
      type: 'github-config',
      requestId: '../invalid',
      action: { action: 'credential-remove', expectedRevision: 1, credentialId },
    });
    const barrier = await host.request({ action: 'read' });
    assert.equal(barrier.state.credentials.length, 1);
    assert.equal(
      host.messages.some(
        (message) => message.type === 'github-config-result' && message.requestId === '../invalid',
      ),
      false,
    );
    let current = true;
    const controller = new DesktopGitHubSettings({ bridge: () => host.child });
    host.child.on('message', (message) => controller.receive(host.child, message));
    t.after(() => controller.close());
    const stale = controller.request({ action: 'read' }, () => current),
      rejection = assert.rejects(stale, /窗口已变化/);
    current = false;
    await rejection;
    assert.equal(host.output().stdout.includes('synthetic_ipc_private_token'), false);
    assert.equal(host.output().stderr.includes('synthetic_ipc_private_token'), false);
    host.child.kill('SIGTERM');
    const [code] = await host.closed;
    assert.equal(code, 0, host.output().stderr);
    const restart = f.desktop();
    await restart.wait((message) => message.type === 'local-ready');
    const restarted = await restart.request({ action: 'read' });
    assert.equal(restarted.state.revision, 1);
    assert.equal(restarted.state.credentials.length, 1);
    const removed = await restart.request({
      action: 'credential-remove',
      expectedRevision: 1,
      credentialId,
    });
    assert.equal(removed.ok, true);
    assert.equal(removed.state.credentials.length, 0);
    restart.child.kill('SIGTERM');
    await restart.closed;
    const store = new RuntimeStore(f.runtimeFile);
    try {
      assert.equal(store.journal.db.prepare('SELECT count(*) AS n FROM operation').get()!.n, 0);
      assert.equal(store.journal.db.prepare('SELECT count(*) AS n FROM agent_session').get()!.n, 0);
      assert.equal(store.journal.db.prepare('SELECT count(*) AS n FROM session').get()!.n, 0);
    } finally {
      store.close();
    }
  },
);
