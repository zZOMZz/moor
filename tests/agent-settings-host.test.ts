import test, { type TestContext } from 'node:test';
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
import type { Workspace } from '../src/catalog';

const entry = resolve('src/bridge/host-main.ts');
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-agent-settings-host-'))),
    privatePath = join(root, 'private'),
    project = join(root, 'project');
  mkdirSync(privatePath);
  mkdirSync(project);
  const runtimeFile = join(privatePath, 'runtime.sqlite'),
    configFile = join(privatePath, 'bridge.json'),
    script = join(root, 'synthetic-private-acp.mjs'),
    log = join(root, 'aggregate.log');
  writeFileSync(
    script,
    `import {appendFileSync} from 'node:fs'; import readline from 'node:readline';
const log=process.argv[2];appendFileSync(log,'open\\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method)return;appendFileSync(log,m.method+'\\n');
if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,agentCapabilities:{loadSession:true,promptCapabilities:{image:false,audio:false,embeddedContext:false}},agentInfo:{name:'Synthetic',version:'1'},authMethods:[]});
else if(m.method==='session/new')send(m.id,{sessionId:'synthetic-private-native'});
else if(m.method==='session/prompt'||m.method==='session/load')process.exit(11);
else send(m.id,{});});\n`,
  );
  const runtime = new RuntimeStore(runtimeFile);
  runtime.registerProject(project);
  runtime.close();
  const children: { child: ChildProcess; closed: Promise<any> }[] = [];
  t.after(async () => {
    for (const p of children) {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
      await p.closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const args = ['--config', configFile, '--runtime-data', runtimeFile],
    env = { ...process.env, MOOR_RUNTIME_DATA: runtimeFile };
  const save = (extra = {}) => ({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic private ACP',
    command: realpathSync(process.execPath),
    args: [script, log],
    ...extra,
  });
  async function cli(input: unknown, extra: string[] = []) {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', entry, ...args, '--agent-config-stdin', ...extra],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      closed = once(child, 'close');
    children.push({ child, closed });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (value) => {
      stdout += value;
    });
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    const [code] = await closed;
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  }
  function desktop() {
    const child = fork(
        entry,
        [
          ...args,
          '--desktop',
          '--server',
          '',
          '--public-dir',
          resolve('src/web/public'),
          '--builtin-agent',
          'claude',
        ],
        { env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      ),
      closed = once(child, 'close');
    children.push({ child, closed });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (value) => {
      stdout += value;
    });
    child.stderr?.on('data', (value) => {
      stderr += value;
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
    const wait = (predicate: (message: any) => boolean): Promise<any> => {
      const prior = messages.find(predicate);
      if (prior) return Promise.resolve(prior);
      return Promise.race([
        new Promise((resolve) => waiters.add({ predicate, resolve })),
        closed.then(() => {
          throw new Error('Synthetic host ended before IPC: ' + stderr);
        }),
      ]);
    };
    return {
      child,
      closed,
      messages,
      wait,
      output: () => ({ stdout, stderr }),
      async request(action: unknown) {
        const requestId = randomUUID(),
          response = wait((m) => m.type === 'agent-config-result' && m.requestId === requestId);
        child.send({ type: 'agent-config', requestId, action });
        return response;
      },
    };
  }
  return { root, runtimeFile, configFile, script, log, save, cli, desktop };
}

test(
  'actual Agent CLI keeps launch settings private and disabled, enforces exclusive flags and limits, and checks only when explicitly asked',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    assert.deepEqual((await f.cli({ action: 'read' })).json(), { revision: 0, presets: [] });
    for (const flags of [
      ['--desktop'],
      ['--pair', 'synthetic'],
      ['--github-config-stdin'],
      ['--preview-config-stdin'],
      ['--skills-config-stdin'],
    ]) {
      const rejected = await f.cli({ action: 'read' }, flags);
      assert.equal(rejected.code, 1);
      assert.match(rejected.json().error, /不能同时/);
      assert.equal(existsSync(f.configFile), false);
    }
    const oversize = await f.cli(' '.repeat(64 * 1024 + 1));
    assert.equal(oversize.code, 1);
    assert.match(oversize.json().error, /请求过大/);
    const invalid = await f.cli(f.save({ command: 'sh -c something' }));
    assert.equal(invalid.code, 1);
    assert.match(invalid.json().error, /绝对路径/);
    const first = await f.cli(f.save());
    assert.equal(first.code, 0, first.stderr);
    const preset = first.json().presets[0];
    assert.equal(preset.enabled, false);
    assert.equal(preset.command, realpathSync(process.execPath));
    assert.deepEqual(preset.args, [f.script, f.log]);
    assert.equal(existsSync(f.log), false);
    assert.equal(statSync(f.runtimeFile).mode & 0o777, 0o600);
    const checked = await f.cli({
      action: 'check',
      expectedRevision: 1,
      id: preset.id,
      versionId: preset.versionId,
    });
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(checked.json().presets[0].checked.ok, true);
    assert.equal(checked.json().presets[0].enabled, false);
    assert.equal(
      readFileSync(f.log, 'utf8')
        .split('\n')
        .filter((v) => v === 'open').length,
      1,
    );
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /session\/(prompt|load)/);
    const before = readFileSync(f.log, 'utf8');
    assert.equal((await f.cli({ action: 'read' })).json().revision, 2);
    assert.equal(readFileSync(f.log, 'utf8'), before);
    const store = new RuntimeStore(f.runtimeFile);
    try {
      for (const table of ['session', 'agent_session'])
        assert.equal(store.journal.db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n, 0);
    } finally {
      store.close();
    }
  },
);

test(
  'actual private Agent IPC serializes CAS, rejects bad request IDs and remote configuration, and startup flags do not revive removed builtin presets',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const builtin = await f.cli({ action: 'builtin', expectedRevision: 0, agentType: 'claude' });
    assert.equal(builtin.code, 0, builtin.stderr);
    const host = f.desktop(),
      ready = await host.wait((m) => m.type === 'local-ready');
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    const read = await host.request({ action: 'read' });
    assert.equal(read.state.presets[0].enabled, false);
    const locked = await f.cli(f.save({ expectedRevision: 1 }));
    assert.equal(locked.code, 3);
    const saved = await host.request(f.save({ expectedRevision: 1, enabled: true }));
    assert.equal(saved.ok, true);
    const custom = saved.state.presets.find((p: any) => p.cliType === 'custom');
    const [one, two] = await Promise.all([
      host.request({ action: 'enabled', expectedRevision: 2, id: custom.id, enabled: false }),
      host.request({ action: 'enabled', expectedRevision: 2, id: custom.id, enabled: true }),
    ]);
    assert.equal([one, two].filter((r) => r.ok).length, 1);
    host.child.send({
      type: 'agent-config',
      requestId: '../invalid',
      action: { action: 'remove', expectedRevision: 3, id: custom.id },
    });
    const barrier = await host.request({ action: 'read' });
    assert.equal(barrier.state.revision, 3);
    assert.equal(
      host.messages.some((m) => m.requestId === '../invalid'),
      false,
    );
    const catalogue = await fetch(ready.origin + '/api/workspaces', {
      headers: { Cookie: 'personal=' + ready.secret },
    });
    assert.equal(catalogue.status, 200);
    assert.equal((await catalogue.text()).includes(f.script), false);
    const remote = await fetch(ready.origin + '/api/agent-config', {
      method: 'POST',
      headers: {
        Cookie: 'personal=' + ready.secret,
        Origin: ready.origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'read' }),
    });
    assert.equal(remote.status, 404);
    const removed = await host.request({
      action: 'remove',
      expectedRevision: 3,
      id: 'personal-claude',
    });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(f.log), false);
    assert.equal(host.output().stdout.includes(f.script), false);
    assert.equal(host.output().stderr.includes(f.script), false);
    host.child.kill('SIGTERM');
    assert.equal((await host.closed)[0], 0, host.output().stderr);
    assert.equal(
      readFileSync(f.configFile + '.catalog.sqlite').includes(Buffer.from(f.script)),
      false,
    );
    const restarted = f.desktop();
    await restarted.wait((m) => m.type === 'health' && m.local === 'ready');
    const restored = await restarted.request({ action: 'read' });
    assert.equal(restored.state.revision, 4);
    assert.equal(
      restored.state.presets.some((p: any) => p.id === 'personal-claude'),
      false,
    );
    assert.equal(existsSync(f.log), false);
    restarted.child.kill('SIGTERM');
    assert.equal((await restarted.closed)[0], 0, restarted.output().stderr);
  },
);

test(
  'actual host-main awaits role reads and persists accepted and sealed operations across restart without launching an Agent',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const savedAgent = await f.cli(f.save({ enabled: true }));
    assert.equal(savedAgent.code, 0, savedAgent.stderr);
    const agentId = savedAgent.json().presets[0].versionId;
    const host = f.desktop(),
      ready = await host.wait((message) => message.type === 'local-ready');
    await host.wait((message) => message.type === 'health' && message.local === 'ready');
    async function client(ready: any) {
      const headers = {
        Cookie: 'personal=' + ready.secret,
        Origin: ready.origin,
        'Content-Type': 'application/json',
      };
      const spaces: Workspace[] = await (
        await fetch(ready.origin + '/api/workspaces', { headers })
      ).json();
      const space = spaces[0]!,
        replica = space.replicas[0]!,
        runtime = space.hosts.find((host) => host.id === replica.hostId)!;
      const path = ready.origin + `/api/workspaces/${space.id}/replicas/${replica.id}/roles/`;
      return {
        scope: {
          rolesVersion: 1,
          workspaceId: runtime.runtimeWorkspaceId,
          localProjectId: replica.localProjectId,
          sessionId: 'roles-cli-draft',
        },
        async request(kind: 'read' | 'action', body: unknown) {
          const response = await fetch(path + kind, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
          const value = await response.json();
          assert.equal(response.status, 200, JSON.stringify(value));
          assert.equal(response.headers.get('cache-control'), 'no-store');
          return value;
        },
      };
    }
    const api = await client(ready);
    assert.deepEqual(await api.request('read', api.scope), {
      ...api.scope,
      confirmed: true,
      catalogRevision: 0,
      roles: [],
    });
    const request = {
      ...api.scope,
      action: 'save',
      operationId: randomUUID(),
      expectedRevision: 0,
      name: 'Real RPC role',
      agentId,
      selection: {},
      instructions: 'SYNTHETIC_ROLE_RPC_BODY',
    };
    const accepted = await api.request('action', request);
    assert.equal(accepted.accepted, true);
    assert.equal(
      (await api.request('read', api.scope)).roles[0].instructions,
      request.instructions,
    );
    const neverArrived = {
      ...request,
      operationId: randomUUID(),
      expectedRevision: 1,
      instructions: 'SYNTHETIC_SEALED_NEVER_BODY',
    };
    const sealed = await api.request('action', { action: 'abandon', request: neverArrived });
    assert.equal(sealed.accepted, false);
    assert.equal(sealed.abandoned, true);
    assert.deepEqual(await api.request('action', neverArrived), sealed);
    assert.equal((await api.request('read', api.scope)).roles.length, 1);
    assert.equal(existsSync(f.log), false);
    host.child.kill('SIGTERM');
    assert.equal((await host.closed)[0], 0, host.output().stderr);
    const restarted = f.desktop(),
      nextReady = await restarted.wait((message) => message.type === 'local-ready');
    await restarted.wait((message) => message.type === 'health' && message.local === 'ready');
    const next = await client(nextReady);
    assert.deepEqual(next.scope, api.scope);
    assert.deepEqual(await next.request('action', request), accepted);
    assert.deepEqual(
      (await next.request('action', { action: 'inspect', request: neverArrived })).receipt,
      sealed,
    );
    assert.equal((await next.request('read', next.scope)).catalogRevision, 1);
    assert.equal(existsSync(f.log), false);
    restarted.child.kill('SIGTERM');
    assert.equal((await restarted.closed)[0], 0, restarted.output().stderr);
    const relayBytes = readFileSync(f.configFile + '.catalog.sqlite');
    assert.equal(relayBytes.includes(Buffer.from(request.instructions)), false);
    assert.equal(relayBytes.includes(Buffer.from(f.script)), false);
    assert.equal(
      readFileSync(f.runtimeFile).includes(Buffer.from(neverArrived.instructions)),
      false,
    );
  },
);
