import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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

const entry = resolve('src/bridge/host-main.ts'),
  privateLabel = 'SYNTHETIC_PRIVATE_SKILLS_SOURCE';
function fixture(t: { after(fn: () => unknown): void }, insideProject = false) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'moor-skills-host-'))),
    root = join(data, 'project'),
    sourceRoot = join(data, 'synthetic-skills');
  mkdirSync(root);
  mkdirSync(sourceRoot);
  const privatePath = join(insideProject ? root : data, 'private');
  mkdirSync(privatePath);
  const runtimeFile = join(privatePath, 'runtime.sqlite'),
    configFile = join(privatePath, 'bridge.json'),
    skillsFile = join(privatePath, 'skills-v1.json');
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
    action: 'source-save',
    expectedRevision: 0,
    label: privateLabel,
    rootPath: sourceRoot,
    ...extra,
  });
  async function cli(input: unknown, extra: string[] = []) {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', entry, ...args, '--skills-config-stdin', ...extra],
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
          throw new Error('Synthetic skills host closed before IPC: ' + stderr);
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
        const waiting = wait((m) => m.type === 'skills-config-result' && m.requestId === requestId);
        child.send({ type: 'skills-config', requestId, action });
        return waiting;
      },
    };
  }
  return {
    data,
    root,
    sourceRoot,
    runtimeFile,
    configFile,
    skillsFile,
    projectId,
    save,
    cli,
    desktop,
  };
}

test(
  'actual Skills CLI saves private roots disabled, enforces bounded stdin and exclusive flags, and cannot write while the host owns the runtime',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const read = await f.cli({ action: 'read' });
    assert.equal(read.code, 0, read.stderr);
    assert.deepEqual(read.json(), { revision: 0, sources: [] });
    for (const flags of [
      ['--desktop'],
      ['--pair', 'synthetic'],
      ['--preview-config-stdin'],
      ['--github-config-stdin'],
    ]) {
      const result = await f.cli({ action: 'read' }, flags);
      assert.equal(result.code, 1);
      assert.match(result.json().error, /不能同时/);
      assert.equal(existsSync(f.skillsFile), false);
    }
    for (const action of [
      f.save({ rootPath: 'relative' }),
      f.save({ command: 'not-an-action' }),
      f.save({ enabled: 'true' }),
    ]) {
      const result = await f.cli(action);
      assert.equal(result.code, 1);
      assert.match(result.json().error, /请求无效/);
    }
    const oversized = await f.cli(' '.repeat(16 * 1024 + 1));
    assert.equal(oversized.code, 1);
    assert.match(oversized.json().error, /请求过大/);
    const saved = await f.cli(f.save());
    assert.equal(saved.code, 0, saved.stderr);
    const id = saved.json().sources[0].id;
    assert.equal(saved.json().sources[0].enabled, false);
    assert.equal(statSync(f.skillsFile).mode & 0o777, 0o600);
    const before = readFileSync(f.skillsFile, 'utf8'),
      host = f.desktop();
    await host.wait((m) => m.type === 'local-ready');
    const denied = await f.cli({ action: 'source-remove', expectedRevision: 1, id });
    assert.equal(denied.code, 3);
    assert.equal(readFileSync(f.skillsFile, 'utf8'), before);
    host.child.kill('SIGTERM');
    assert.equal((await host.closed)[0], 0, host.output().stderr);
    const enabled = await f.cli({
      action: 'source-enabled',
      expectedRevision: 1,
      id,
      enabled: true,
    });
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.equal(enabled.json().sources[0].enabled, true);
    const restored = await f.cli({ action: 'read' });
    assert.equal(restored.json().revision, 2);
    const removed = await f.cli({ action: 'source-remove', expectedRevision: 2, id });
    assert.equal(removed.code, 0, removed.stderr);
    const runtime = new RuntimeStore(f.runtimeFile);
    try {
      for (const table of ['operation', 'agent_session', 'session'])
        assert.equal(runtime.journal.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0);
    } finally {
      runtime.close();
    }
  },
);

test(
  'actual Skills desktop host IPC rejects malformed IDs, keeps global paths out of relay state, and does not replay saved configuration on restart',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const host = f.desktop(),
      ready = await host.wait((m) => m.type === 'local-ready');
    assert.equal((await host.request({ action: 'read' })).ok, true);
    const saved = await host.request(f.save({ enabled: true }));
    assert.equal(saved.ok, true);
    const id = saved.state.sources[0].id;
    assert.equal(saved.state.sources[0].rootPath, f.sourceRoot);
    host.child.send({
      type: 'skills-config',
      requestId: '../invalid',
      action: { action: 'source-remove', expectedRevision: 1, id },
    });
    const barrier = await host.request({ action: 'read' });
    assert.equal(barrier.state.revision, 1);
    assert.equal(
      host.messages.some((m) => m.type === 'skills-config-result' && m.requestId === '../invalid'),
      false,
    );
    const privateSource = await host.request(f.save({ expectedRevision: 1, rootPath: f.data }));
    assert.equal(privateSource.ok, false);
    assert.match(privateSource.error, /私有数据目录/);
    const invalid = await host.request({ action: 'read', command: 'not-an-action' });
    assert.equal(invalid.ok, false);
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    for (const path of ['/api/workspaces', '/api/devices']) {
      const response = await fetch(ready.origin + path, {
        headers: { Cookie: 'personal=' + ready.secret },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes(privateLabel), false);
      assert.equal(body.includes(f.sourceRoot), false);
    }
    const remote = await fetch(ready.origin + '/api/skills-config', {
      method: 'POST',
      headers: {
        Cookie: 'personal=' + ready.secret,
        Origin: ready.origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'read' }),
    });
    assert.equal(remote.status, 404);
    assert.equal(host.output().stdout.includes(f.sourceRoot), false);
    assert.equal(host.output().stderr.includes(f.sourceRoot), false);
    host.child.kill('SIGTERM');
    await host.closed;
    for (const file of [f.runtimeFile, f.configFile + '.catalog.sqlite']) {
      assert.equal(readFileSync(file).includes(Buffer.from(privateLabel)), false);
      assert.equal(readFileSync(file).includes(Buffer.from(f.sourceRoot)), false);
    }
    const restarted = f.desktop();
    await restarted.wait((m) => m.type === 'local-ready');
    const restored = await restarted.request({ action: 'read' });
    assert.equal(restored.state.revision, 1);
    assert.equal(restored.state.sources[0].id, id);
    assert.equal(
      (
        await restarted.request({
          action: 'source-enabled',
          expectedRevision: 1,
          id,
          enabled: false,
        })
      ).ok,
      true,
    );
    assert.equal(
      (await restarted.request({ action: 'source-remove', expectedRevision: 2, id })).ok,
      true,
    );
    restarted.child.kill('SIGTERM');
    await restarted.closed;
  },
);
