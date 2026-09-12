import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL } from '../src/protocol';
import { SKILLS_FEATURE } from '../src/skills-protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';

const text = 'SYNTHETIC_SKILL_PRIVATE_BODY\n中文 !`never execute` <script>text only</script>';
const version = 'sha256:' + createHash('sha256').update(text).digest('hex');
const catalogVersion = 'sha256:' + 'a'.repeat(64);
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const relay = await syntheticRelay();
  const controls: { transform?: (value: any) => unknown; hold?: () => Promise<void> } = {};
  for (const host of relay.hosts) {
    host.runtime.features!.push(SKILLS_FEATURE);
    host.responses.set('skills-read', async (message) => {
      const { params: p } = message;
      const base = {
        skillsVersion: 1,
        workspaceId: p.workspaceId,
        localProjectId: p.localProjectId,
        sessionId: p.sessionId,
        catalogVersion,
        executionRevision: 0,
        confirmed: true,
        view: p.view,
      };
      const source = {
        id: 'project-agents',
        label: '.agents/skills',
        scope: 'project',
        convention: 'agents',
        version: catalogVersion,
        status: 'available',
      };
      const skill = {
        id: 'skill:synthetic',
        sourceId: source.id,
        path: 'synthetic/SKILL.md',
        name: 'synthetic',
        description: 'Synthetic Skill',
        version,
        byteLength: Buffer.byteLength(text),
        metadata: 'parsed',
      };
      const result =
        p.view === 'list'
          ? { ...base, sources: [source], skills: [skill], issues: [], truncated: false }
          : { ...base, source, skill, text };
      await controls.hold?.();
      return controls.transform?.(result) ?? result;
    });
    const pong = once(host.socket, 'pong');
    host.socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: host.runtime.machineId,
        workspaces: [host.runtime],
      }),
    );
    host.socket.ping();
    await pong;
  }
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0]!;
  const replica = space.replicas.find(
    (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
  )!;
  const scope = {
    skillsVersion: 1,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
  };
  return {
    ...relay,
    controls,
    space,
    replica,
    host,
    list: { ...scope, view: 'list' },
    detail: {
      ...scope,
      view: 'detail',
      sourceId: 'project-agents',
      skillId: 'skill:synthetic',
      version,
      catalogVersion,
      executionRevision: 0,
    },
    path: `/api/workspaces/${space.id}/replicas/${replica.id}/skills/read`,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}
test('Skills relay forwards exact typed reads only, no-store, without persisting Skill content', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const input of [f.list, f.detail]) {
    const response = await f.api(f.path, input);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.synthetic.messages.filter((m) => m.method === 'skills-read').length, 2);
  assert.equal(
    f.hosts.find((h) => h !== f.synthetic)!.messages.filter((m) => m.method === 'skills-read')
      .length,
    0,
  );
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const table = String(row.name);
    assert.match(table, /^[a-z_]+$/);
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()),
      /SYNTHETIC_SKILL_PRIVATE_BODY/,
    );
  }
});
test('Skills relay rejects foreign targets, raw paths, extra commands and oversized requests before dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const input of [
    { ...f.list, workspaceId: 'foreign' },
    { ...f.list, localProjectId: 'foreign' },
    { ...f.list, rootPath: '/private/skills' },
    { ...f.detail, path: '../../secret/SKILL.md' },
    { ...f.list, command: 'node arbitrary.js' },
    { ...f.detail, version: 'latest' },
  ])
    assert.equal((await f.api(f.path, input)).status, 400);
  assert.equal((await f.api(f.path, { ...f.list, body: 'x'.repeat(20 * 1024) })).status, 413);
  assert.equal((await f.api(f.path.replace('/read', '/install'), f.list)).status, 404);
  assert.equal(f.synthetic.messages.filter((m) => m.method === 'skills-read').length, 0);
});
test('Skills relay rejects wrong content scope, version, provenance, byte length, digest and private metadata', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (v: any) => ({ ...v, sessionId: 'other' }),
    (v: any) => ({ ...v, catalogVersion: version }),
    (v: any) => ({ ...v, executionRevision: 1 }),
    (v: any) => ({ ...v, source: { ...v.source, id: 'global' } }),
    (v: any) => ({ ...v, skill: { ...v.skill, id: 'other' } }),
    (v: any) => ({ ...v, skill: { ...v.skill, byteLength: 1 } }),
    (v: any) => ({ ...v, text: v.text.replace('SYNTHETIC', 'MODIFIED_') }),
    (v: any) => ({ ...v, source: { ...v.source, rootPath: '/private/skills' } }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path, f.detail);
    assert.equal(response.status, 502);
    assert.doesNotMatch(
      JSON.stringify(await response.json()),
      /SYNTHETIC_SKILL_PRIVATE_BODY|\/private/,
    );
  }
  for (const transform of [
    (v: any) => ({ ...v, sources: [...v.sources, ...v.sources] }),
    (v: any) => ({ ...v, skills: [...v.skills, ...v.skills] }),
    (v: any) => ({ ...v, sources: [] }),
  ]) {
    f.controls.transform = transform;
    assert.equal((await f.api(f.path, f.list)).status, 502);
  }
});
test('Skills responses are withheld after logout, runtime scope changes or project regrouping', async (t) => {
  for (const change of ['logout', 'user', 'machine', 'feature', 'project'] as const)
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const entered = signal(),
        release = signal();
      f.controls.hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = f.api(f.path, f.detail);
      await entered.promise;
      if (change === 'logout') f.store.db.prepare('DELETE FROM login').run();
      else if (change === 'project') {
        const other = f.space.projects.find((p) => p.id !== f.replica.projectId)!;
        f.store.catalog.assign(f.owner, f.space.id, f.replica.id, other.id);
      } else {
        if (change === 'user') f.synthetic.runtime.userId = 'different-user';
        if (change === 'machine') f.synthetic.runtime.machineId = 'different-machine';
        if (change === 'feature') f.synthetic.runtime.features = [];
        const pong = Promise.race([
          once(f.synthetic.socket, 'pong'),
          once(f.synthetic.socket, 'close'),
        ]);
        f.synthetic.socket.send(
          JSON.stringify({
            type: 'hello',
            protocol: PROTOCOL,
            machineId: f.synthetic.runtime.machineId,
            workspaces: [f.synthetic.runtime],
          }),
        );
        f.synthetic.socket.ping();
        await pong;
      }
      release.resolve();
      const response = await pending;
      assert.ok(response.status >= 400);
      assert.doesNotMatch(JSON.stringify(await response.json()), /SYNTHETIC_SKILL_PRIVATE_BODY/);
    });
});
test('Skills pending read rejects when the host socket is replaced and cannot accept its late response', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = signal(),
    release = signal();
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path, f.detail);
  await entered.promise;
  const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + f.synthetic.device.token },
  });
  t.after(() => replacement.terminate());
  await once(replacement, 'open');
  const pong = once(replacement, 'pong');
  replacement.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.synthetic.runtime.machineId,
      workspaces: [f.synthetic.runtime],
    }),
  );
  replacement.ping();
  await pong;
  release.resolve();
  const response = await pending;
  assert.ok(response.status >= 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), /SYNTHETIC_SKILL_PRIVATE_BODY/);
});
test('Skills configuration invalidation only broadcasts a scoped marker and validates the live session', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const viewer = new WebSocket(f.origin.replace('http:', 'ws:') + '/events', {
    headers: { Cookie: 'personal=' + f.secret, Origin: f.origin },
  });
  await once(viewer, 'open');
  t.after(() => viewer.terminate());
  const message = once(viewer, 'message');
  const event = { type: 'skills-changed', workspaceId: f.list.workspaceId };
  f.synthetic.socket.send(JSON.stringify(event));
  const [data] = await message;
  assert.deepEqual(JSON.parse(String(data)), {
    type: 'changed',
    deviceId: f.host.deviceId,
    workspaceId: f.list.workspaceId,
    room: { scope: 'skills' },
  });
  const closed = once(viewer, 'close');
  f.store.db.prepare('DELETE FROM login').run();
  f.synthetic.socket.send(JSON.stringify(event));
  const [code] = await closed;
  assert.equal(code, 1008);
});
