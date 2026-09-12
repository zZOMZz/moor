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
import WebSocket from 'ws';
import { RuntimeStore } from '../src/runtime/store';

const entry = resolve('src/bridge/host-main.ts'),
  privateLabel = 'SYNTHETIC_PRIVATE_MCP_PRESET',
  envSecret = 'synthetic-mcp-env-value',
  headerSecret = 'synthetic-mcp-header-value',
  privateUrl = 'https://mcp.synthetic.invalid/private-endpoint';
function fixture(t: { after(fn: () => unknown): void }) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'moor-mcp-config-host-'))),
    root = join(data, 'project'),
    marker = join(data, 'must-not-execute'),
    command = join(data, 'synthetic-mcp');
  mkdirSync(root);
  writeFileSync(command, '#!/bin/sh\nprintf synthetic > ' + marker + '\n', { mode: 0o700 });
  const privatePath = join(data, 'private');
  mkdirSync(privatePath);
  const runtimeFile = join(privatePath, 'runtime.sqlite'),
    configFile = join(privatePath, 'bridge.json');
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
    action: 'save',
    expectedRevision: 0,
    name: privateLabel,
    description: 'Synthetic configured MCP metadata',
    projectIds: [projectId],
    connection: { transport: 'stdio', command, args: [], env: { SYNTHETIC_API_KEY: envSecret } },
    ...extra,
  });
  async function cli(input: unknown, extra: string[] = []) {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', entry, ...args, '--mcp-config-stdin', ...extra],
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
          throw new Error('Synthetic MCP host closed before IPC: ' + stderr);
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
        const waiting = wait((m) => m.type === 'mcp-config-result' && m.requestId === requestId);
        child.send({ type: 'mcp-config', requestId, action });
        return waiting;
      },
    };
  }
  return {
    data,
    root,
    command,
    marker,
    runtimeFile,
    configFile,
    projectId,
    save,
    cli,
    desktop,
  };
}

function assertNoExecution(file: string) {
  const store = new RuntimeStore(file);
  try {
    for (const table of ['operation', 'agent_session', 'session'])
      assert.equal(store.journal.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0);
    const raw = store.load('mcp-settings-v1');
    assert.ok(raw);
    return JSON.parse(Buffer.from(raw).toString('utf8'));
  } finally {
    store.close();
  }
}
function assertPrivateValuesAbsent(value: unknown) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(serialized.includes(envSecret), false);
  assert.equal(serialized.includes(headerSecret), false);
}
test(
  'actual MCP CLI enforces exclusive modes, a 64 KiB stdin boundary, private values, CAS and the live runtime lock',
  { timeout: 25000 },
  async (t) => {
    const f = fixture(t);
    const initial = await f.cli({ action: 'read' });
    assert.equal(initial.code, 0, initial.stderr);
    assert.deepEqual(initial.json(), {
      revision: 0,
      projects: [{ id: f.projectId, name: 'project' }],
      presets: [],
    });
    for (const extra of [
      ['--desktop'],
      ['--local'],
      ['--pair', 'synthetic'],
      ['--agent-config-stdin'],
      ['--skills-config-stdin'],
      ['--preview-config-stdin'],
      ['--github-config-stdin'],
    ]) {
      const rejected = await f.cli(f.save(), extra);
      assert.equal(rejected.code, 1);
      assert.match(rejected.json().error, /不能同时/);
    }
    const exact = JSON.stringify({ action: 'read' }).padEnd(64 * 1024, ' ');
    assert.equal(
      (await f.cli(exact)).code,
      0,
      'exactly 64 KiB of valid JSON and whitespace is allowed',
    );
    const oversized = await f.cli(exact + ' ');
    assert.equal(oversized.code, 1);
    assert.match(oversized.json().error, /请求过大/);
    for (const invalid of [
      f.save({ expectedRevision: -1 }),
      f.save({ enabled: 'true' }),
      f.save({ projectIds: ['missing-project'] }),
      { action: 'read', env: { SYNTHETIC_API_KEY: envSecret } },
    ]) {
      const rejected = await f.cli(invalid);
      assert.equal(rejected.code, 1);
      assertPrivateValuesAbsent(rejected.stdout + rejected.stderr);
    }
    const saved = await f.cli(f.save());
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.json().revision, 1);
    const preset = saved.json().presets[0];
    assert.equal(preset.enabled, false);
    assert.deepEqual(preset.connection, {
      transport: 'stdio',
      command: f.command,
      args: [],
      envNames: ['SYNTHETIC_API_KEY'],
    });
    assertPrivateValuesAbsent(saved.stdout + saved.stderr);
    assert.equal(statSync(f.runtimeFile).mode & 0o777, 0o600);
    const stale = await f.cli({
      action: 'enabled',
      id: preset.id,
      expectedRevision: 0,
      enabled: true,
    });
    assert.equal(stale.code, 1);
    assert.match(stale.json().error, /已改变/);
    const host = f.desktop();
    await host.wait((m) => m.type === 'local-ready');
    const locked = await f.cli({ action: 'remove', expectedRevision: 1, id: preset.id });
    assert.equal(locked.code, 3);
    const current = await host.request({ action: 'read' });
    assert.equal(current.state.revision, 1);
    assert.equal(current.state.presets[0].id, preset.id);
    host.child.kill('SIGTERM');
    assert.equal((await host.closed)[0], 0, host.output().stderr);
    const http = await f.cli(
      f.save({
        expectedRevision: 1,
        name: 'Synthetic HTTP',
        connection: {
          transport: 'http',
          url: privateUrl,
          headers: { Authorization: 'Bearer ' + headerSecret },
        },
      }),
    );
    assert.equal(http.code, 0, http.stderr);
    assert.deepEqual(http.json().presets[1].connection, {
      transport: 'http',
      url: privateUrl,
      headerNames: ['Authorization'],
    });
    assertPrivateValuesAbsent(http.stdout + http.stderr);
    const enabled = await f.cli({
      action: 'enabled',
      expectedRevision: 2,
      id: preset.id,
      enabled: true,
    });
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.equal(enabled.json().presets[0].versionId, preset.versionId);
    const restored = await f.cli({ action: 'read' });
    assert.equal(restored.json().revision, 3);
    assertPrivateValuesAbsent(restored.stdout + restored.stderr);
    const raw = assertNoExecution(f.runtimeFile);
    assert.equal(raw.versions[0].connection.env.SYNTHETIC_API_KEY, envSecret);
    assert.equal(raw.versions[1].connection.headers.Authorization, 'Bearer ' + headerSecret);
    assert.equal(existsSync(f.marker), false);
  },
);

test(
  'actual MCP host IPC invalidates only metadata, rejects malformed requests and restarts enabled presets without launching them',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t),
      host = f.desktop();
    const ready = await host.wait((m) => m.type === 'local-ready');
    await host.wait((m) => m.type === 'health' && m.local === 'ready');
    const headers = {
      Cookie: 'personal=' + ready.secret,
      Origin: ready.origin,
      'Content-Type': 'application/json',
    };
    const workspacesResponse = await fetch(ready.origin + '/api/workspaces', { headers });
    assert.equal(workspacesResponse.status, 200);
    const workspaces = (await workspacesResponse.json()) as any[],
      workspace = workspaces[0],
      replica = workspace.replicas.find((r: any) => r.localProjectId === f.projectId),
      binding = workspace.hosts.find((h: any) => h.id === replica.hostId);
    assert.ok(binding);
    const viewer = new WebSocket(ready.origin.replace('http:', 'ws:') + '/events', { headers });
    const socketMessages: unknown[] = [];
    viewer.on('message', (data) => socketMessages.push(JSON.parse(String(data))));
    t.after(() => viewer.terminate());
    await once(viewer, 'open');
    const event = once(viewer, 'message');
    const saved = await host.request(f.save({ enabled: true }));
    assert.equal(saved.ok, true);
    assert.equal(saved.state.revision, 1);
    const preset = saved.state.presets[0];
    assert.equal(preset.enabled, true);
    assertPrivateValuesAbsent(saved);
    assert.deepEqual(JSON.parse(String((await event)[0])), {
      type: 'changed',
      deviceId: binding.deviceId,
      workspaceId: binding.runtimeWorkspaceId,
      room: { scope: 'mcp' },
    });
    const readBody = {
      mcpVersion: 1,
      workspaceId: binding.runtimeWorkspaceId,
      localProjectId: f.projectId,
      sessionId: 'synthetic-uncreated-session',
    };
    const readCatalog = async () => {
      const response = await fetch(
        ready.origin + `/api/workspaces/${workspace.id}/replicas/${replica.id}/mcp/read`,
        { method: 'POST', headers, body: JSON.stringify(readBody) },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<any>;
    };
    const catalog = await readCatalog();
    assert.deepEqual(catalog, {
      ...readBody,
      confirmed: true,
      catalogRevision: 1,
      servers: [
        {
          id: preset.versionId,
          name: privateLabel,
          description: 'Synthetic configured MCP metadata',
          transport: 'stdio',
        },
      ],
    });
    assertPrivateValuesAbsent(catalog);
    assert.equal(JSON.stringify(catalog).includes(f.command), false);
    assert.equal(JSON.stringify(catalog).includes('SYNTHETIC_API_KEY'), false);
    host.child.send({
      type: 'mcp-config',
      requestId: '../invalid',
      action: { action: 'remove', expectedRevision: 1, id: preset.id },
    });
    const barrier = await host.request({ action: 'read' });
    assert.equal(barrier.state.revision, 1);
    assert.equal(
      host.messages.some((m) => m.type === 'mcp-config-result' && m.requestId === '../invalid'),
      false,
    );
    for (const action of [
      { action: 'read', headers: { Authorization: headerSecret } },
      { action: 'remove', expectedRevision: 0, id: preset.id },
      { action: 'read', padding: envSecret.repeat(6554) },
    ]) {
      const rejected = await host.request(action);
      assert.equal(rejected.ok, false);
      assertPrivateValuesAbsent(rejected);
    }
    const disabledEvent = once(viewer, 'message');
    const disabled = await host.request({
      action: 'enabled',
      expectedRevision: 1,
      id: preset.id,
      enabled: false,
    });
    assert.equal(disabled.ok, true);
    assert.equal(JSON.parse(String((await disabledEvent)[0])).room.scope, 'mcp');
    assert.deepEqual((await readCatalog()).servers, []);
    assert.equal(
      (await host.request({ action: 'enabled', expectedRevision: 2, id: preset.id, enabled: true }))
        .ok,
      true,
    );
    for (const path of ['/api/workspaces', '/api/devices']) {
      const response = await fetch(ready.origin + path, { headers }),
        body = await response.text();
      assert.equal(response.status, 200);
      for (const value of [privateLabel, f.command, envSecret, headerSecret, privateUrl])
        assert.equal(body.includes(value), false);
    }
    const remote = await fetch(ready.origin + '/api/mcp-config', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'read' }),
    });
    assert.equal(remote.status, 404);
    assertPrivateValuesAbsent(host.messages);
    assertPrivateValuesAbsent(host.output());
    assertPrivateValuesAbsent(socketMessages);
    assert.equal(JSON.stringify(socketMessages).includes(privateLabel), false);
    assert.equal(existsSync(f.marker), false);
    viewer.terminate();
    host.child.kill('SIGTERM');
    assert.equal((await host.closed)[0], 0, host.output().stderr);
    const catalogFile = f.configFile + '.catalog.sqlite';
    for (const value of [privateLabel, f.command, envSecret, headerSecret, privateUrl])
      assert.equal(readFileSync(catalogFile).includes(Buffer.from(value)), false);
    const restarted = f.desktop();
    await restarted.wait((m) => m.type === 'local-ready');
    await restarted.wait((m) => m.type === 'health' && m.local === 'ready');
    const restored = await restarted.request({ action: 'read' });
    assert.equal(restored.state.revision, 3);
    assert.equal(restored.state.presets[0].id, preset.id);
    assert.equal(restored.state.presets[0].versionId, preset.versionId);
    assert.equal(restored.state.presets[0].enabled, true);
    assertPrivateValuesAbsent(restored);
    assert.equal(existsSync(f.marker), false);
    const removed = await restarted.request({
      action: 'remove',
      expectedRevision: 3,
      id: preset.id,
    });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.state.presets, []);
    restarted.child.kill('SIGTERM');
    assert.equal((await restarted.closed)[0], 0, restarted.output().stderr);
    assertNoExecution(f.runtimeFile);
    assert.equal(existsSync(f.marker), false);
  },
);
