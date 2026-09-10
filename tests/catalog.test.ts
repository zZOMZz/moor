import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, hash } from '../src/relay/accounts';
import { projectSourceSchema } from '../src/catalog';
import type { RuntimeWorkspace } from '../src/protocol';
import { catalogSessionList, filterCatalogSessions } from '../src/web/navigation';

const runtime = (machineId: string): RuntimeWorkspace => ({
  id: 'lw_same',
  name: 'Moor host',
  machineId,
  userId: 'synthetic-user',
  projects: [{ id: 'same-local-id', name: 'moor', rootPath: '/synthetic/moor' }],
  agents: [],
});
async function fixture(file = ':memory:') {
  const store = new Store(file);
  const login = await store.setup('synthetic@example.com', 'synthetic-password-only');
  const owner = store.owner(login);
  const a = store.redeem(store.pair(owner), 'Mac A');
  const b = store.redeem(store.pair(owner), 'Mac B');
  store.bind(store.device(owner, a.id), 'machine-a', [runtime('machine-a')]);
  store.bind(store.device(owner, b.id), 'machine-b', [runtime('machine-b')]);
  const live = (id: string) => [runtime(id === a.id ? 'machine-a' : 'machine-b')];
  return { store, owner, a, b, live };
}
test('one product workspace contains two hosts; identical local ids, names and paths do not merge projects', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  let spaces = f.store.catalog.list(f.owner, f.live);
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].hosts.length, 2);
  assert.equal(spaces[0].projects.length, 2);
  assert.equal(new Set(spaces[0].replicas.map((r) => r.id)).size, 2);
  f.store.bind(f.store.device(f.owner, f.a.id), 'machine-a', [runtime('machine-a')]);
  spaces = f.store.catalog.list(f.owner, f.live);
  assert.equal(spaces[0].replicas.length, 2, 'repeated hello is idempotent');
  const [a, b] = spaces[0].replicas;
  f.store.catalog.assign(f.owner, spaces[0].id, b.id, a.projectId);
  const space = f.store.catalog.list(f.owner, f.live)[0];
  assert.equal(new Set(space.replicas.map((r) => r.projectId)).size, 1);
  const list = space.hosts.flatMap((h, i) =>
    catalogSessionList(
      [
        {
          id: 'same-session-id',
          title: 'Fix timeout',
          lastMessageAt: i + 1,
          project: { localProjectId: 'same-local-id' },
        },
      ],
      space,
      h.id,
    ),
  );
  assert.equal(filterCatalogSessions(list, space, 'moor fix', a.projectId).length, 2);
  assert.equal(filterCatalogSessions(list, space, 'Mac B', a.projectId).length, 1);
  assert.notEqual(
    list[0].replicaId,
    list[1].replicaId,
    'session id alone must never select an execution host',
  );
});
test('topology survives restart and offline hosts; local paths, agents and session bodies are not persisted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'accounts.sqlite');
  const f = await fixture(file);
  const before = f.store.catalog.list(f.owner, f.live)[0];
  f.store.catalog.rename(f.owner, before.id, '个人开发');
  f.store.catalog.assign(f.owner, before.id, before.replicas[1].id, before.projects[0].id);
  f.store.close();
  const restored = new Store(file);
  t.after(() => restored.close());
  const after = restored.catalog.list(f.owner, () => [])[0];
  assert.equal(after.id, before.id);
  assert.equal(after.name, '个人开发');
  assert.equal(after.hosts.length, 2);
  assert.ok(after.hosts.every((h) => !h.online));
  assert.ok(after.replicas.every((r) => !r.available && r.rootPath === undefined));
  assert.equal(after.replicas[1].projectId, before.projects[0].id);
  for (const table of ['workspace', 'host_binding', 'project', 'project_replica']) {
    const rows = JSON.stringify(restored.db.prepare(`SELECT * FROM ${table}`).all());
    assert.doesNotMatch(rows, /rootPath|\/synthetic\/moor|history|metaBundle|snapshot|agentConfig/);
  }
});
test('moving a host splits shared projects and preserves its immutable runtime replica identity', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const first = f.store.catalog.list(f.owner, f.live)[0];
  f.store.catalog.assign(f.owner, first.id, first.replicas[1].id, first.replicas[0].projectId);
  const target = f.store.catalog.create(f.owner, '研究');
  const moved = first.hosts[1],
    replica = first.replicas[1];
  f.store.catalog.moveHost(f.owner, first.id, moved.id, target.id);
  assert.throws(() => f.store.catalog.replica(f.owner, first.id, replica.id));
  const r = f.store.catalog.replica(f.owner, target.id, replica.id);
  assert.equal(r.local_id, replica.localProjectId);
  assert.equal(r.host.device_id, moved.deviceId);
  assert.equal(r.host.runtime_id, moved.runtimeWorkspaceId);
  f.store.bind(f.store.device(f.owner, f.b.id), 'machine-b', [runtime('machine-b')]);
  const spaces = f.store.catalog.list(f.owner, f.live);
  assert.equal(
    spaces.find((w) => w.id === target.id)!.hosts.length,
    1,
    'hello must not undo manual organization',
  );
  assert.equal(spaces.find((w) => w.id === first.id)!.hosts.length, 1);
  assert.throws(() => f.store.catalog.assign(f.owner, target.id, r.id, first.projects[0].id));
  assert.throws(() => f.store.catalog.binding('another-account', target.id, moved.id));
  f.store.revoke(f.owner, moved.deviceId);
  assert.throws(() => f.store.catalog.replica(f.owner, target.id, r.id));
  assert.equal(
    f.store.catalog.list(f.owner, f.live).find((w) => w.id === target.id)!.hosts.length,
    0,
  );
});
test('new pairing targets the selected product workspace and local sources remain optional', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const space = f.store.catalog.create(f.owner, '研究');
  const device = f.store.redeem(f.store.pair(f.owner, space.id), 'Mac C');
  f.store.bind(f.store.device(f.owner, device.id), 'machine-c', [runtime('machine-c')]);
  assert.equal(
    f.store.catalog.list(f.owner, () => []).find((w) => w.id === space.id)!.hosts[0].deviceId,
    device.id,
  );
  assert.throws(() => f.store.pair('another-account', space.id));
  const project = f.store.catalog.createProject(f.owner, space.id, 'remote', {
    kind: 'git',
    provider: 'gitlab',
    url: 'https://gitlab.example.com/team/repo.git',
  });
  assert.equal(
    f.store.catalog
      .list(f.owner, () => [])
      .find((w) => w.id === space.id)!
      .replicas.some((r) => r.projectId === project.id),
    false,
    'declaring a repository does not clone or execute it',
  );
  for (const url of [
    'https://user:secret@example.com/repo',
    'https://example.com/repo?token=secret',
    'file:///tmp/repo',
    'https://example.com/repo#secret',
  ])
    assert.equal(
      projectSourceSchema.safeParse({ kind: 'git', provider: 'github', url }).success,
      false,
    );
});
test('existing relay schema and pair codes migrate in place without resetting credentials', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'old.sqlite'),
    old = new DatabaseSync(file);
  old.exec(`CREATE TABLE account(id TEXT PRIMARY KEY,email TEXT UNIQUE,salt TEXT,password BLOB);
    CREATE TABLE login(token TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
    CREATE TABLE pair(code TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
    CREATE TABLE device(id TEXT PRIMARY KEY,owner TEXT,name TEXT,token TEXT UNIQUE,revoked INTEGER DEFAULT 0,machine_id TEXT,catalog TEXT DEFAULT '[]');`);
  old
    .prepare('INSERT INTO account VALUES(?,?,?,?)')
    .run('legacy-owner', 'legacy@example.com', 'unchanged-salt', new Uint8Array([1, 2, 3]));
  old.prepare('INSERT INTO login VALUES(?,?,?)').run(hash('legacy-login'), 'legacy-owner', 5000);
  old.prepare('INSERT INTO pair VALUES(?,?,?)').run(hash('legacy-pair'), 'legacy-owner', 5000);
  old
    .prepare('INSERT INTO device(id,owner,name,token,machine_id) VALUES(?,?,?,?,?)')
    .run(
      'legacy-device',
      'legacy-owner',
      'Legacy Mac',
      hash('legacy-device-token'),
      'legacy-machine',
    );
  old.close();
  const store = new Store(file, () => 1000);
  t.after(() => store.close());
  assert.equal(store.owner('legacy-login'), 'legacy-owner');
  assert.equal(store.deviceToken('legacy-device-token').machine_id, 'legacy-machine');
  const redeemed = store.redeem('legacy-pair', 'New Mac');
  assert.equal(store.device('legacy-owner', redeemed.id).name, 'New Mac');
  store.bind(store.device('legacy-owner', 'legacy-device'), 'legacy-machine', [
    runtime('legacy-machine'),
  ]);
  assert.equal(store.catalog.list('legacy-owner', () => [])[0].hosts[0].deviceId, 'legacy-device');
  assert.equal(
    store.db.prepare('SELECT salt FROM account WHERE id=?').get('legacy-owner')!.salt,
    'unchanged-salt',
  );
});
