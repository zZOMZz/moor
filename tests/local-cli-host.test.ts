import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
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
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../src/runtime/store';
import {
  readLocalCliConnection,
  localCliChallenge,
  verifyLocalCliProof,
} from '../src/bridge/local-cli-connection';

function fixture(t: TestContext, insideProject = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-local-cli-host-'))),
    project = join(root, 'project');
  mkdirSync(project, { mode: 0o700 });
  const privateRoot = join(insideProject ? project : root, 'private');
  mkdirSync(privateRoot, { mode: 0o700 });
  const runtimeFile = join(privateRoot, 'runtime.sqlite'),
    config = join(privateRoot, 'bridge.json'),
    file = config + '.cli.json';
  const store = new RuntimeStore(runtimeFile),
    projectId = store.registerProject(project);
  const identity = {
    runtimeWorkspaceId: store.workspace.id,
    machineId: store.workspace.machineId,
    userId: store.workspace.userId,
  };
  store.close();
  const children: { child: ChildProcess; closed: Promise<any> }[] = [];
  t.after(async () => {
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null)
        item.child.kill('SIGKILL');
      await item.closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  function start(flags = ['--local']) {
    const child = fork(
        resolve('src/bridge/host-main.ts'),
        [
          '--config',
          config,
          '--runtime-data',
          runtimeFile,
          '--public-dir',
          resolve('src/web/public'),
          ...flags,
        ],
        {
          execArgv: ['--import', 'tsx'],
          env: { ...process.env, MOOR_RUNTIME_DATA: runtimeFile },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      ),
      closed = once(child, 'close');
    children.push({ child, closed });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const messages: any[] = [],
      waiters = new Set<{ predicate(m: any): boolean; resolve(m: any): void }>();
    child.on('message', (message) => {
      messages.push(message);
      for (const waiter of waiters)
        if (waiter.predicate(message)) {
          waiters.delete(waiter);
          waiter.resolve(message);
        }
    });
    const wait = (predicate: (m: any) => boolean): Promise<any> => {
      const old = messages.find(predicate);
      if (old) return Promise.resolve(old);
      return Promise.race([
        new Promise((resolve) => waiters.add({ predicate, resolve })),
        closed.then(() => {
          throw new Error('Synthetic local host closed before ready: ' + stderr);
        }),
      ]);
    };
    return {
      child,
      closed,
      wait,
      messages,
      output: () => ({ stdout, stderr }),
      async stop() {
        child.kill('SIGTERM');
        assert.equal((await closed)[0], 0, stderr);
      },
    };
  }
  return { root, project, projectId, runtimeFile, config, file, identity, start };
}
const headers = (connection: ReturnType<typeof readLocalCliConnection>['connection']) => ({
  Cookie: 'personal=' + connection.secret,
  'X-Moor-Instance': connection.instanceId,
});

test(
  'actual headless local host discovers a scoped private connection without pairing, rejects old credentials after restart and starts no Agent',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      host = f.start();
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    const lease = readLocalCliConnection(f.file),
      connection = lease.connection;
    assert.deepEqual(
      {
        runtimeWorkspaceId: connection.runtimeWorkspaceId,
        machineId: connection.machineId,
        userId: connection.userId,
      },
      f.identity,
    );
    assert.equal(connection.ownerId, 'local-desktop');
    assert.equal(connection.deviceId, 'local-machine');
    assert.equal(statSync(f.file).mode & 0o777, 0o600);
    assert.equal(
      host.messages.some((m) => m.type === 'local-ready'),
      false,
    );
    const probe = await fetch(connection.origin + '/api/local-instance');
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { instanceId: connection.instanceId });
    const challenge = localCliChallenge();
    const proof = await fetch(connection.origin + '/api/local-instance?challenge=' + challenge);
    assert.equal(proof.status, 200);
    verifyLocalCliProof(connection, challenge, await proof.json());
    const me = await fetch(connection.origin + '/api/me', { headers: headers(connection) });
    assert.equal(me.status, 200);
    const workspaces = await fetch(connection.origin + '/api/workspaces', {
      headers: headers(connection),
    });
    assert.equal(workspaces.status, 200);
    assert.doesNotMatch(await workspaces.text(), new RegExp(connection.secret));
    const mismatched = await fetch(connection.origin + '/api/workspaces', {
      headers: { ...headers(connection), 'X-Moor-Instance': 'other-instance' },
    });
    assert.equal(mismatched.status, 409);
    assert.equal(host.output().stdout.includes(connection.secret), false);
    assert.equal(host.output().stderr.includes(connection.secret), false);
    const duplicate = f.start();
    assert.equal((await duplicate.closed)[0], 3);
    lease.assertCurrent();
    await host.stop();
    assert.equal(existsSync(f.file), false);
    assert.throws(() => lease.assertCurrent());
    const restarted = f.start();
    await restarted.wait((m) => m.type === 'health' && m.local === 'ready');
    const next = readLocalCliConnection(f.file).connection;
    assert.notEqual(next.instanceId, connection.instanceId);
    assert.notEqual(next.secret, connection.secret);
    const old = await fetch(next.origin + '/api/workspaces', {
      headers: { Cookie: 'personal=' + connection.secret, 'X-Moor-Instance': next.instanceId },
    });
    assert.equal(old.status, 401);
    const current = await fetch(next.origin + '/api/workspaces', { headers: headers(next) });
    assert.equal(current.status, 200);
    await restarted.stop();
    const runtime = new RuntimeStore(f.runtimeFile);
    try {
      for (const table of ['session', 'agent_session', 'operation'])
        assert.equal(runtime.journal.db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n, 0);
    } finally {
      runtime.close();
    }
  },
);

test(
  'actual desktop retains its private IPC credential while the CLI login is independent and revocable',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      host = f.start(['--desktop', '--server', '']);
    const native = await host.wait((m) => m.type === 'local-ready');
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    const connection = readLocalCliConnection(f.file).connection;
    assert.equal(native.origin, connection.origin);
    assert.notEqual(native.secret, connection.secret);
    const logout = await fetch(connection.origin + '/api/logout', {
      method: 'POST',
      headers: {
        ...headers(connection),
        Origin: connection.origin,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.equal(
      (await fetch(connection.origin + '/api/local-instance?challenge=' + localCliChallenge()))
        .status,
      404,
    );
    assert.equal(
      (await fetch(connection.origin + '/api/workspaces', { headers: headers(connection) })).status,
      401,
    );
    assert.equal(
      (
        await fetch(connection.origin + '/api/workspaces', {
          headers: { Cookie: 'personal=' + native.secret },
        })
      ).status,
      200,
    );
    assert.equal(
      host.messages.some((m) => m.secret === connection.secret),
      false,
    );
    await host.stop();
    assert.equal(existsSync(f.file), false);
  },
);

test(
  'headless flags reject conflicting modes before pairing and refuse a connection directory inside the registered project',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    for (const flags of [
      ['--local', '--desktop'],
      ['--local', '--pair', 'synthetic'],
      ['--local', '--server', 'https://example.invalid'],
      ['--local', '--agent-config-stdin'],
      ['--local', '--skills-config-stdin'],
      ['--local', '--preview-config-stdin'],
      ['--local', '--github-config-stdin'],
    ]) {
      const host = f.start(flags);
      assert.equal((await host.closed)[0], 1);
      assert.match(host.output().stdout, /不能同时/);
      assert.equal(existsSync(f.config), false);
      assert.equal(existsSync(f.file), false);
    }
    const unsafe = fixture(t, true),
      denied = unsafe.start();
    assert.equal((await denied.closed)[0], 1);
    assert.equal(existsSync(unsafe.file), false);
    assert.equal(existsSync(unsafe.config + '.catalog.sqlite'), false);
  },
);

test(
  'a crashed host descriptor cannot authenticate after a fresh headless instance replaces it',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      host = f.start();
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    const old = readLocalCliConnection(f.file);
    const earlierChallenge = localCliChallenge();
    const earlierProof = (await (
      await fetch(old.connection.origin + '/api/local-instance?challenge=' + earlierChallenge)
    ).json()) as { proof: string };
    host.child.kill('SIGKILL');
    await host.closed;
    assert.equal(existsSync(f.file), true);
    let leakedCookie = false,
      leakedBody = false;
    const impostor = createServer((request, response) => {
      leakedCookie ||= !!request.headers.cookie;
      request.on('data', () => {
        leakedBody = true;
      });
      const challenge = new URL(request.url!, old.connection.origin).searchParams.get('challenge');
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          instanceId: old.connection.instanceId,
          challenge,
          proof: earlierProof.proof,
        }),
      );
    });
    impostor.listen(Number(new URL(old.connection.origin).port), '127.0.0.1');
    await once(impostor, 'listening');
    try {
      const challenge = localCliChallenge();
      await assert.rejects(async () => {
        const response = await fetch(
          old.connection.origin + '/api/local-instance?challenge=' + challenge,
        );
        verifyLocalCliProof(old.connection, challenge, await response.json());
        await fetch(old.connection.origin + '/api/workspaces', {
          method: 'POST',
          headers: headers(old.connection),
          body: 'must-not-be-sent',
        });
      }, /身份未确认/);
      assert.equal(leakedCookie, false);
      assert.equal(leakedBody, false);
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
    const restarted = f.start();
    await restarted.wait((m) => m.type === 'health' && m.local === 'ready');
    const current = readLocalCliConnection(f.file).connection;
    assert.notEqual(current.instanceId, old.connection.instanceId);
    assert.throws(() => old.assertCurrent());
    assert.equal(
      (
        await fetch(current.origin + '/api/workspaces', {
          headers: {
            Cookie: 'personal=' + old.connection.secret,
            'X-Moor-Instance': current.instanceId,
          },
        })
      ).status,
      401,
    );
    await restarted.stop();
    assert.equal(existsSync(f.file), false);
  },
);

test(
  'failed local startup revokes bootstrap credentials and releases storage before a later successful start',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      blocker = createServer();
    blocker.listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const address = blocker.address();
    assert(address && typeof address === 'object');
    writeFileSync(f.config + '.local-port', String(address.port), { mode: 0o600 });
    try {
      const host = f.start();
      assert.equal((await host.closed)[0], 1);
      assert.equal(existsSync(f.file), false);
      assert.match(host.output().stderr, /本机连接启动失败/);
      const catalog = new DatabaseSync(f.config + '.catalog.sqlite');
      try {
        assert.equal(catalog.prepare('SELECT count(*) AS n FROM login').get()?.n, 0);
      } finally {
        catalog.close();
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    const restarted = f.start();
    await restarted.wait((m) => m.type === 'health' && m.local === 'ready');
    readLocalCliConnection(f.file).assertCurrent();
    await restarted.stop();
    assert.equal(existsSync(f.file), false);
  },
);

test(
  'legacy desktop storage inside a project keeps native UI usable but emits an explicit CLI migration notice without publishing a credential',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t, true),
      host = f.start(['--desktop', '--server', '']);
    const native = await host.wait((m) => m.type === 'local-ready');
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    assert.equal(
      host.messages.some((m) => m.type === 'cli-unavailable'),
      true,
    );
    assert.match(host.output().stderr, /本机 CLI 不可用/);
    assert.equal(existsSync(f.file), false);
    const response = await fetch(native.origin + '/api/workspaces', {
      headers: { Cookie: 'personal=' + native.secret },
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await fetch(native.origin + '/api/local-instance?challenge=' + localCliChallenge())).status,
      404,
    );
    assert.equal(host.output().stderr.includes(native.secret), false);
    await host.stop();
  },
);
