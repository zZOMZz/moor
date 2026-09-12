import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SkillsController, skillsKey, agentCommandText } from '../src/web/skills';
import { normalizeSessionEvent } from '../src/runtime/session-events';
import type { SkillsRead } from '../src/skills-protocol';

const target = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'new-stable',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const version = 'sha256:' + 'a'.repeat(64);
const text = '# 合成 Skill\n\n<script>unsafe()</script>\n![image](https://invalid.test/pixel)';
const summary = {
  id: 'skill',
  sourceId: 'project-agents',
  path: 'synthetic/SKILL.md',
  name: 'Synthetic',
  description: 'Synthetic description',
  metadata: 'parsed' as const,
  version: 'sha256:' + createHash('sha256').update(text).digest('hex'),
  byteLength: Buffer.byteLength(text),
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const calls: { path: string; body: SkillsRead }[] = [];
  const state = {
    online: true,
    current: true,
    transform: (value: any) => value,
    wait: undefined as undefined | (() => Promise<void>),
  };
  const source = {
    id: 'project-agents',
    label: '.agents/skills',
    scope: 'project',
    convention: 'agents',
    version,
    status: 'available',
  };
  const controller = new SkillsController(target, {
    current: () => state.current,
    online: () => state.online,
    changed() {},
    request: async (path, body) => {
      calls.push({ path, body: structuredClone(body) });
      await state.wait?.();
      const base = {
        skillsVersion: 1,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        view: body.view,
        confirmed: true,
        catalogVersion: version,
        executionRevision: 3,
      };
      return state.transform(
        body.view === 'list'
          ? {
              ...base,
              sources: [
                source,
                { ...source, id: 'missing', label: '.claude/skills', status: 'missing' },
              ],
              skills: [summary],
              issues: [{ sourceId: 'project-agents', reason: 'limit' }],
              truncated: true,
            }
          : { ...base, source, skill: summary, text },
      );
    },
  });
  return { controller, state, calls };
}
test('Skills are scoped read-only content; a deliberate reference revalidates its exact catalog and file version', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  await f.controller.refresh();
  assert.ok(f.controller.list?.truncated);
  assert.equal(f.controller.list?.sources[1].status, 'missing');
  await f.controller.select('skill');
  const instruction = await f.controller.instructionForDraft();
  assert.ok(instruction.includes(text));
  assert.ok(instruction.includes(summary.version));
  assert.deepEqual(
    f.calls.map((call) => call.body.view),
    ['list', 'detail', 'detail'],
  );
  assert.deepEqual(f.calls[1], f.calls[2]);
  assert.match(f.calls[1].path, /\/catalog\/replicas\/replica\/skills\/read$/);
  assert.equal((f.calls[1].body as any).executionRevision, 3);
  assert.equal(skillsKey(target), skillsKey({ ...target, replicaId: 'moved' }));
  for (const field of [
    'owner',
    'deviceId',
    'userId',
    'machineId',
    'workspaceId',
    'localProjectId',
    'sessionId',
  ] as const)
    assert.notEqual(skillsKey(target), skillsKey({ ...target, [field]: 'different' }));
});
test('wrong scope, file digest, catalog, execution revision and deceptive source metadata cannot be appended', async () => {
  for (const change of [
    (value: any) => ({ ...value, sessionId: 'other' }),
    (value: any) => ({ ...value, text: value.text.replace('合成', '伪造') }),
    (value: any) => ({ ...value, catalogVersion: 'sha256:' + 'b'.repeat(64) }),
    (value: any) => ({ ...value, executionRevision: 4 }),
    (value: any) => ({ ...value, source: { ...value.source, label: 'Another source' } }),
    (value: any) => ({ ...value, skill: { ...value.skill, path: 'different/SKILL.md' } }),
  ]) {
    const f = fixture();
    await f.controller.refresh();
    await f.controller.select('skill');
    f.state.transform = change;
    await assert.rejects(f.controller.instructionForDraft());
    assert.equal(f.controller.detail, undefined);
    assert.equal(f.controller.list, undefined);
  }
});
test('closing, offline and scope invalidation discard late detail and never restore provider content', async () => {
  for (const invalidate of ['close', 'offline', 'target']) {
    const f = fixture();
    await f.controller.refresh();
    const gate = signal(),
      entered = signal();
    f.state.wait = () => {
      entered.resolve();
      return gate.promise;
    };
    const reading = f.controller.select('skill'),
      rejected = assert.rejects(reading);
    await entered.promise;
    if (invalidate === 'offline') f.state.online = false;
    if (invalidate === 'target') f.state.current = false;
    f.controller.invalidate();
    gate.resolve();
    await rejected;
    assert.equal(f.controller.detail, undefined);
    assert.equal(f.controller.list, undefined);
    assert.equal(f.calls.length, 2);
  }
});
test('a newer explicit read replaces an older response and malformed catalog references fail closed', async () => {
  const f = fixture(),
    gate = signal(),
    entered = signal();
  f.state.wait = () => {
    entered.resolve();
    return gate.promise;
  };
  const old = f.controller.refresh(),
    rejected = assert.rejects(old);
  await entered.promise;
  f.state.wait = undefined;
  await f.controller.refresh();
  gate.resolve();
  await rejected;
  assert.equal(f.controller.list?.skills[0].id, 'skill');
  f.state.transform = (value) => ({ ...value, skills: [...value.skills, value.skills[0]] });
  await assert.rejects(f.controller.refresh());
  assert.equal(f.controller.list, undefined);
});
test('pinned ACP adapter command spellings retain native dollar and slash prefixes', () => {
  // codex-acp 1.11.0 publishes Skills as $name; claude-agent-acp 0.76.0
  // publishes supportedCommands names through the same standard ACP event.
  const event = normalizeSessionEvent({
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: '$synthetic-review', description: 'Synthetic Codex Skill', input: null },
      { name: 'synthetic-review', description: 'Synthetic Claude command', input: null },
      { name: '/already-prefixed', description: 'Synthetic custom command', input: null },
    ],
  });
  assert.equal(event.status, 'accepted');
  if (event.status !== 'accepted' || event.event.kind !== 'commands')
    assert.fail('Missing command event');
  assert.deepEqual(
    event.event.commands.map((command) => agentCommandText(command.name)),
    ['$synthetic-review', '/synthetic-review', '/already-prefixed'],
  );
});
