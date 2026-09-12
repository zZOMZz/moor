import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSettings } from '../src/runtime/mcp-settings';
import { RuntimeStore, type AttachmentScope } from '../src/runtime/store';
import { AppError } from '../src/protocol';
import { putMeta } from '../src/model';

const key = 'mcp-settings-v1';
const conflict = (error: unknown) => error instanceof AppError && error.status === 409;
const bad = (error: unknown) => error instanceof AppError && error.status === 400;
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-mcp-settings-'))),
    a = join(root, 'project-a'),
    b = join(root, 'project-b'),
    command = join(root, 'synthetic-mcp'),
    marker = join(root, 'must-not-execute');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(command, '#!/bin/sh\nprintf synthetic > ' + marker + '\n', { mode: 0o700 });
  const file = join(root, 'runtime.sqlite'),
    store = new RuntimeStore(file);
  const project = store.registerProject(a),
    otherProject = store.registerProject(b);
  let changes = 0;
  const service = new McpSettings(store, () => changes++);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const scope = (localProjectId = project, sessionId = 'synthetic-session'): AttachmentScope => ({
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId,
    sessionId,
  });
  const save = (extra = {}) => ({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic MCP',
    description: 'Synthetic registered service',
    projectIds: [project],
    connection: {
      transport: 'stdio',
      command,
      args: ['--token=synthetic-argument-secret'],
      env: { API_KEY: 'synthetic-env-secret' },
    },
    ...extra,
  });
  return {
    root,
    a,
    b,
    command,
    marker,
    file,
    store,
    service,
    project,
    otherProject,
    scope,
    save,
    changes: () => changes,
  };
}

test('local MCP registration defaults disabled and never launches, probes or publishes private configuration', async (t) => {
  const f = fixture(t),
    machine = Buffer.from(f.store.machine.exportFile()),
    meta = Buffer.from(f.store.meta.exportFile());
  const initial = f.service.read();
  assert.deepEqual(
    initial.projects,
    [
      { id: f.project, name: 'project-a' },
      { id: f.otherProject, name: 'project-b' },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(initial.revision, 0);
  const saved = await f.service.handle(f.save()),
    preset = saved.presets[0];
  assert.equal(preset.enabled, false);
  assert.deepEqual(f.service.catalog(f.scope()), []);
  assert.throws(() => f.service.authorize(f.scope(), [preset.versionId]), conflict);
  assert.ok(!JSON.stringify(saved).includes('synthetic-env-secret'));
  assert.deepEqual(preset.connection.transport === 'stdio' ? preset.connection.envNames : [], [
    'API_KEY',
  ]);
  await f.service.handle({ action: 'enabled', id: preset.id, expectedRevision: 1, enabled: true });
  const catalog = f.service.catalog(f.scope());
  assert.deepEqual(catalog, [
    {
      id: preset.versionId,
      name: preset.name,
      description: preset.description,
      transport: 'stdio',
    },
  ]);
  for (const privateValue of [
    f.command,
    'synthetic-argument-secret',
    'synthetic-env-secret',
    'API_KEY',
  ])
    assert.ok(!JSON.stringify(catalog).includes(privateValue));
  assert.deepEqual(Buffer.from(f.store.machine.exportFile()), machine);
  assert.deepEqual(Buffer.from(f.store.meta.exportFile()), meta);
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.changes(), 2);
});

test('authorization returns an exact private ACP snapshot and rejects mutated descriptors and scope', async (t) => {
  const f = fixture(t),
    saved = await f.service.handle(f.save({ enabled: true })),
    id = saved.presets[0].versionId;
  const scope = f.scope(),
    selected = [id],
    lease = f.service.authorize(scope, selected);
  assert.deepEqual(lease.servers, [
    {
      name: 'moor_mcp_' + id,
      command: f.command,
      args: ['--token=synthetic-argument-secret'],
      env: [{ name: 'API_KEY', value: 'synthetic-env-secret' }],
    },
  ]);
  assert.ok(!('type' in lease.servers[0]));
  for (const value of [
    f.command,
    '--token=synthetic-argument-secret',
    'synthetic-argument-secret',
    'synthetic-env-secret',
  ])
    assert.ok(lease.redact.includes(value));
  lease.assertCurrent();
  scope.sessionId = 'another-session';
  assert.throws(lease.assertCurrent, conflict);
  const changed = f.service.authorize(f.scope(), [id]);
  changed.servers[0].name = 'moor_tasks';
  assert.throws(changed.assertCurrent, conflict);
  assert.equal(f.service.authorize(f.scope(), [id]).servers[0].name, 'moor_mcp_' + id);
  const selection = [id],
    another = f.service.authorize(f.scope(), selection);
  selection.length = 0;
  assert.throws(another.assertCurrent, conflict);
  assert.equal(existsSync(f.marker), false);
});

test('configuration versions are immutable, CAS changes invalidate old leases, and history survives restart', async (t) => {
  const f = fixture(t),
    first = await f.service.handle(f.save({ enabled: true })),
    preset = first.presets[0];
  const lease = f.service.authorize(f.scope(), [preset.versionId]);
  const original = JSON.parse(Buffer.from(f.store.load(key)!).toString()).versions[0];
  const changed = await f.service.handle(
    f.save({ id: preset.id, expectedRevision: 1, name: 'Renamed MCP', enabled: true }),
  );
  assert.equal(changed.presets[0].id, preset.id);
  assert.notEqual(changed.presets[0].versionId, preset.versionId);
  assert.throws(lease.assertCurrent, conflict);
  assert.throws(() => f.service.authorize(f.scope(), [preset.versionId]), conflict);
  const privateState = JSON.parse(Buffer.from(f.store.load(key)!).toString());
  assert.deepEqual(privateState.versions[0], original);
  assert.equal(privateState.versions.length, 2);
  const other = new McpSettings(f.store);
  await assert.rejects(other.handle(f.save({ expectedRevision: 1 })), conflict);
  const reopened = new RuntimeStore(f.file);
  try {
    assert.deepEqual(new McpSettings(reopened).read(), changed);
  } finally {
    reopened.close();
  }
});

test('failed persistence rolls back revision, immutable versions and notification together', async (t) => {
  const f = fixture(t),
    saved = await f.service.handle(f.save({ enabled: true })),
    before = Buffer.from(f.store.load(key)!);
  const lease = f.service.authorize(f.scope(), [saved.presets[0].versionId]);
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_mcp BEFORE INSERT ON runtime_state WHEN NEW.key='mcp-settings-v1' BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END",
  );
  await assert.rejects(
    f.service.handle(
      f.save({
        id: saved.presets[0].id,
        expectedRevision: 1,
        name: 'Not committed',
        enabled: true,
      }),
    ),
    /synthetic persistence failure/,
  );
  assert.deepEqual(Buffer.from(f.store.load(key)!), before);
  assert.deepEqual(f.service.read(), saved);
  lease.assertCurrent();
  assert.equal(f.changes(), 1);
});

test('disable then re-enable cannot revive an old lease, removal retains history and unrelated changes preserve a lease', async (t) => {
  const f = fixture(t),
    saved = await f.service.handle(f.save({ enabled: true })),
    preset = saved.presets[0];
  const old = f.service.authorize(f.scope(), [preset.versionId]);
  await f.service.handle(
    f.save({ expectedRevision: 1, name: 'Unrelated MCP', projectIds: [f.otherProject] }),
  );
  old.assertCurrent();
  await f.service.handle({ action: 'enabled', id: preset.id, expectedRevision: 2, enabled: false });
  assert.throws(old.assertCurrent, conflict);
  await f.service.handle({ action: 'enabled', id: preset.id, expectedRevision: 3, enabled: true });
  assert.throws(old.assertCurrent, conflict);
  const current = f.service.authorize(f.scope(), [preset.versionId]);
  current.assertCurrent();
  await f.service.handle({ action: 'remove', id: preset.id, expectedRevision: 4 });
  assert.throws(current.assertCurrent, conflict);
  assert.deepEqual(f.service.catalog(f.scope()), []);
  const state = JSON.parse(Buffer.from(f.store.load(key)!).toString());
  assert.ok(state.versions.some((v: { id: string }) => v.id === preset.versionId));
  await assert.rejects(
    f.service.handle({ action: 'enabled', id: preset.id, expectedRevision: 5, enabled: true }),
  );
});

test('project replacement, registration change and project removal invalidate previously authorized leases', async (t) => {
  const f = fixture(t),
    saved = await f.service.handle(f.save({ enabled: true })),
    preset = saved.presets[0];
  const original = f.service.authorize(f.scope(), [preset.versionId]);
  renameSync(f.a, f.a + '-old');
  mkdirSync(f.a);
  assert.throws(original.assertCurrent, conflict);
  assert.deepEqual(f.service.catalog(f.scope()), []);
  assert.equal(f.service.read().presets[0].id, preset.id);
  await assert.rejects(
    f.service.handle({ action: 'enabled', id: preset.id, expectedRevision: 1, enabled: true }),
    conflict,
  );
  const changed = await f.service.handle(
    f.save({ expectedRevision: 1, id: preset.id, enabled: true }),
  );
  assert.notEqual(changed.presets[0].versionId, preset.versionId);
  const current = f.service.authorize(f.scope(), [changed.presets[0].versionId]);
  f.store.machine.set(['localProject', f.project], { id: f.project, name: 'moved', rootPath: f.b });
  assert.throws(current.assertCurrent, conflict);
  f.store.machine.delete(['localProject', f.project]);
  assert.throws(current.assertCurrent);
  assert.throws(() => f.service.catalog(f.scope()));
});

test('cross-project, machine, user, workspace and existing session identities are rejected', async (t) => {
  const f = fixture(t),
    saved = await f.service.handle(f.save({ enabled: true })),
    selected = [saved.presets[0].versionId];
  assert.deepEqual(f.service.catalog(f.scope(f.otherProject)), []);
  assert.throws(
    () => f.service.authorize(f.scope(f.otherProject), selected),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  for (const field of ['workspaceId', 'userId', 'machineId'] as const) {
    const scope = { ...f.scope(), [field]: 'foreign' };
    assert.throws(() => f.service.catalog(scope));
    assert.throws(() => f.service.authorize(scope, selected));
  }
  const reserved = f.scope(f.otherProject);
  f.store.reserveAttachmentScope(reserved);
  assert.throws(() => f.service.authorize(f.scope(), selected));
  const existing = f.scope(f.project, 'existing');
  putMeta(f.store.meta, 'session-existing', {
    id: 'existing',
    userId: existing.userId,
    machineId: existing.machineId,
    project: { kind: 'local', localProjectId: f.otherProject },
  });
  assert.throws(() => f.service.authorize(existing, selected));
  const fresh = f.scope(f.project, 'fresh'),
    lease = f.service.authorize(fresh, selected);
  putMeta(f.store.meta, 'session-fresh', {
    id: 'fresh',
    userId: fresh.userId,
    machineId: fresh.machineId,
    project: { kind: 'local', localProjectId: f.project },
  });
  lease.assertCurrent();
  f.store.workspace.userId = 'other-user';
  assert.throws(lease.assertCurrent, conflict);
  assert.throws(() => new McpSettings(f.store).read(), conflict);
});

test('omitted private values preserve credentials, explicit empty maps clear them, and transport changes do not transfer them', async (t) => {
  const f = fixture(t),
    first = await f.service.handle(f.save({ enabled: true })),
    preset = first.presets[0];
  const edited = await f.service.handle(
    f.save({
      id: preset.id,
      expectedRevision: 1,
      enabled: true,
      connection: { transport: 'stdio', command: f.command, args: ['--changed'] },
    }),
  );
  const server = f.service.authorize(f.scope(), [edited.presets[0].versionId]).servers[0];
  assert.ok('env' in server);
  assert.deepEqual(server.env, [{ name: 'API_KEY', value: 'synthetic-env-secret' }]);
  const cleared = await f.service.handle(
    f.save({
      id: preset.id,
      expectedRevision: 2,
      enabled: true,
      connection: { transport: 'stdio', command: f.command, args: ['--changed'], env: {} },
    }),
  );
  const clearedServer = f.service.authorize(f.scope(), [cleared.presets[0].versionId]).servers[0];
  assert.ok('env' in clearedServer);
  assert.deepEqual(clearedServer.env, []);
  const http = await f.service.handle(
    f.save({
      id: preset.id,
      expectedRevision: 3,
      enabled: true,
      connection: {
        transport: 'http',
        url: 'https://synthetic.invalid/private-mcp',
        headers: { Authorization: 'Bearer synthetic-header-secret' },
      },
    }),
  );
  assert.ok(!JSON.stringify(http).includes('synthetic-header-secret'));
  const kept = await f.service.handle(
    f.save({
      id: preset.id,
      expectedRevision: 4,
      enabled: true,
      connection: { transport: 'http', url: 'https://synthetic.invalid/changed-mcp' },
    }),
  );
  const lease = f.service.authorize(f.scope(), [kept.presets[0].versionId]);
  assert.ok('headers' in lease.servers[0]);
  assert.deepEqual(lease.servers[0].headers, [
    { name: 'Authorization', value: 'Bearer synthetic-header-secret' },
  ]);
  assert.ok(
    lease.redact.includes('synthetic-header-secret') &&
      lease.redact.includes('https://synthetic.invalid/changed-mcp'),
  );
  const sse = await f.service.handle(
    f.save({
      id: preset.id,
      expectedRevision: 5,
      enabled: true,
      connection: { transport: 'sse', url: 'http://127.0.0.1:43210/mcp' },
    }),
  );
  const final = f.service.authorize(f.scope(), [sse.presets[0].versionId]).servers[0];
  assert.ok('headers' in final);
  assert.deepEqual(final.headers, []);
  assert.equal(final.type, 'sse');
  assert.equal(existsSync(f.marker), false);
});

test('strict local actions reject launch injection, unsafe URLs and headers, invalid files, overlarge payloads and duplicate selection', async (t) => {
  const f = fixture(t),
    link = join(f.root, 'link'),
    plain = join(f.root, 'plain');
  symlinkSync(f.command, link);
  writeFileSync(plain, 'synthetic', { mode: 0o600 });
  for (const connection of [
    { transport: 'stdio', command: 'relative', args: [] },
    { transport: 'stdio', command: link, args: [] },
    { transport: 'stdio', command: f.a, args: [] },
    { transport: 'stdio', command: plain, args: [] },
    { transport: 'stdio', command: f.command, args: ['\0'] },
    { transport: 'stdio', command: f.command, args: [], shell: true },
    ...[
      'http://example.test/mcp',
      'https://user:secret@example.test/mcp',
      'https://example.test/mcp?key=secret',
      'https://example.test/mcp#fragment',
      'file:///private/mcp',
    ].map((url) => ({ transport: 'http', url })),
    { transport: 'http', url: 'https://synthetic.invalid/mcp', headers: { Host: 'other' } },
    {
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      headers: { Authorization: 'secret', authorization: 'another' },
    },
    {
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      headers: { Authorization: 'secret\r\nHost: invalid' },
    },
  ])
    await assert.rejects(f.service.handle(f.save({ connection })), bad);
  for (const extra of [
    { projectIds: [] },
    { projectIds: [f.project, f.project] },
    { description: 'x'.repeat(2001) },
    { command: f.command },
    {
      connection: {
        transport: 'stdio',
        command: f.command,
        args: Array(17).fill('x'.repeat(4096)),
      },
    },
  ])
    await assert.rejects(f.service.handle(f.save(extra)), bad);
  const saved = await f.service.handle(f.save({ enabled: true })),
    selected = saved.presets[0].versionId;
  assert.throws(() => f.service.authorize(f.scope(), [selected, selected]), bad);
  assert.throws(
    () =>
      f.service.authorize(
        f.scope(),
        Array.from({ length: 9 }, (_, i) => 'server_' + i),
      ),
    bad,
  );
  assert.equal(existsSync(f.marker), false);
});

test('active presets and retained version limits cannot be bypassed with new ids or edits', async (t) => {
  const f = fixture(t);
  await f.service.handle(f.save());
  const initial = JSON.parse(Buffer.from(f.store.load(key)!).toString());
  const version = initial.versions[0],
    preset = initial.presets[0];
  const many = structuredClone(initial);
  many.versions = Array.from({ length: 100 }, (_, i) => ({
    ...version,
    id: 'mcpv_' + i.toString(16).padStart(32, '0'),
    presetId: 'synthetic_' + i,
  }));
  many.presets = many.versions.map((v: { id: string; presetId: string }) => ({
    ...preset,
    id: v.presetId,
    versionId: v.id,
  }));
  f.store.save(key, Buffer.from(JSON.stringify(many)));
  await assert.rejects(f.service.handle(f.save({ expectedRevision: 1 })), conflict);
  assert.equal(f.service.read().presets.length, 100);
  const history = structuredClone(initial);
  history.versions = Array.from({ length: 500 }, (_, i) => ({
    ...version,
    id: 'mcpv_' + i.toString(16).padStart(32, '0'),
  }));
  history.presets[0].versionId = history.versions[499].id;
  f.store.save(key, Buffer.from(JSON.stringify(history)));
  await assert.rejects(
    f.service.handle(
      f.save({ id: preset.id, expectedRevision: 1, name: 'Cannot create version 501' }),
    ),
    conflict,
  );
  assert.equal(JSON.parse(Buffer.from(f.store.load(key)!).toString()).versions.length, 500);
});
