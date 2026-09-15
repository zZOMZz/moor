import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { RuntimeStore } from '@moor/host/persistence/store';
import { SkillsConfig } from '@moor/host/integrations/skills-config';
import type { SecureCliTarget } from '@moor/client/secure-operation';
import type { SkillDetail, SkillsList, SkillsRead } from '@moor/protocol/skills-protocol';
import { skillInstruction } from '../../apps/web/src/features/skills/skills';
import {
  SecureSkillsController,
  type SecureSkillsContext,
} from '../../apps/web/src/features/skills/secure-skills';

const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'workspace',
  localProjectId: 'project',
  userId: 'local-owner',
  machineId: 'machine',
  sessionId: 'empty-session',
  product: { catalogWorkspaceId: 'space', projectId: 'product', replicaId: 'replica', revision: 1 },
};
const text =
  '# Synthetic Skill\n\n完整说明 <script>unsafe()</script>\n![track](https://invalid.test/pixel)';
const hash = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const source = {
  id: 'project-agents',
  label: '.agents/skills',
  scope: 'project' as const,
  convention: 'agents' as const,
  status: 'available' as const,
  version: hash('source'),
};
const summary = {
  id: 'skill',
  sourceId: source.id,
  path: 'synthetic/SKILL.md',
  name: 'Synthetic',
  description: '合成说明',
  metadata: 'parsed' as const,
  version: hash(text),
  byteLength: Buffer.byteLength(text),
};
function response(params: SkillsRead): SkillsList | SkillDetail {
  const base = {
    skillsVersion: 1 as const,
    workspaceId: params.workspaceId,
    localProjectId: params.localProjectId,
    sessionId: params.sessionId,
    confirmed: true as const,
    catalogVersion: hash('catalog'),
    executionRevision: 0,
  };
  return params.view === 'list'
    ? { ...base, view: 'list', sources: [source], skills: [summary], issues: [], truncated: false }
    : { ...base, view: 'detail', source, skill: summary, text };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function fixture(input = target) {
  const state = {
    context: { target: structuredClone(input), online: true, generation: 1 } as SecureSkillsContext,
    request: async (params: SkillsRead): Promise<unknown> => response(params),
    beforeAppend: undefined as undefined | (() => Promise<void>),
    beforeCAS: undefined as undefined | (() => Promise<void>),
    draft: 'Existing unsent draft',
  };
  const calls: { target: SecureCliTarget; method: string; params: SkillsRead }[] = [];
  const writes: string[] = [];
  const controller = new SecureSkillsController({
    context: () => state.context,
    request: async (target, method, params) => {
      calls.push(structuredClone({ target, method, params }));
      return state.request(params);
    },
    appendInstruction: async (target, instruction, current) => {
      assert.deepEqual(target, state.context.target);
      await state.beforeAppend?.();
      current();
      const expected = state.draft;
      await state.beforeCAS?.();
      current();
      assert.equal(state.draft, expected, '草稿已被其他页面改变');
      state.draft = [expected, instruction].filter(Boolean).join('\n\n');
      writes.push(state.draft);
    },
  });
  const select = async () => {
    const snapshot = controller.state!;
    await controller.select(
      snapshot.controller.list!.skills[0].id,
      snapshot.controller.list!,
      snapshot.review,
    );
    const selected = controller.state!;
    return { detail: structuredClone(selected.controller.detail!), review: selected.review };
  };
  return { controller, calls, state, writes, select };
}

test('secure Skills reads and reviewed append use only the original finite target, with no automatic execution', async () => {
  const f = fixture();
  assert.equal(f.controller.state, null);
  assert.equal(f.calls.length, 0);
  await f.controller.open(target);
  const selected = await f.select();
  assert.equal(f.writes.length, 0);
  await f.controller.add(selected.detail, selected.review);
  assert.equal(f.state.draft, 'Existing unsent draft\n\n' + skillInstruction(selected.detail));
  assert.deepEqual(
    f.calls.map((call) => call.params.view),
    ['list', 'detail', 'detail'],
  );
  for (const call of f.calls) {
    assert.deepEqual(call.target, target);
    assert.equal(call.method, 'skills-read');
  }
  assert.deepEqual(f.calls[1], f.calls[2]);
  const oldController = f.controller.state!.controller;
  f.controller.close();
  assert.equal(oldController.list, undefined);
  assert.equal(oldController.detail, undefined);
  assert.equal(f.controller.state, null);
  await f.controller.open(target);
  assert.equal(f.controller.state!.controller.detail, undefined);
});

const changedTargets: [string, (value: SecureCliTarget) => void][] = [
  [
    'origin',
    (value) => {
      value.origin = 'https://other.synthetic.invalid';
    },
  ],
  [
    'owner',
    (value) => {
      value.owner = 'other';
    },
  ],
  [
    'root',
    (value) => {
      value.rootKeyId = Buffer.alloc(32, 2).toString('base64url');
    },
  ],
  [
    'client',
    (value) => {
      value.clientDeviceId = 'other';
    },
  ],
  [
    'host',
    (value) => {
      value.hostDeviceId = 'other';
    },
  ],
  [
    'workspace',
    (value) => {
      value.workspaceId = 'other';
    },
  ],
  [
    'localProject',
    (value) => {
      value.localProjectId = 'other';
    },
  ],
  [
    'user',
    (value) => {
      value.userId = 'other';
    },
  ],
  [
    'machine',
    (value) => {
      value.machineId = 'other';
    },
  ],
  [
    'session',
    (value) => {
      value.sessionId = 'other';
    },
  ],
  [
    'catalogWorkspace',
    (value) => {
      value.product!.catalogWorkspaceId = 'other';
    },
  ],
  [
    'productProject',
    (value) => {
      value.product!.projectId = 'other';
    },
  ],
  [
    'replica',
    (value) => {
      value.product!.replicaId = 'other';
    },
  ],
  [
    'revision',
    (value) => {
      value.product!.revision++;
    },
  ],
];
test('every complete target dimension hides Skills immediately and invalidates late reads', async () => {
  for (const [name, change] of changedTargets) {
    const f = fixture();
    await f.controller.open(target);
    const old = f.controller.state!.controller;
    const entered = signal(),
      release = signal();
    f.state.request = async (params) => {
      entered.resolve();
      await release.promise;
      return response(params);
    };
    const selecting = f.select();
    await entered.promise;
    change(f.state.context.target!);
    assert.equal(f.controller.state, null, name);
    f.controller.sync();
    release.resolve();
    await assert.rejects(selecting);
    assert.equal(old.list, undefined, name);
    assert.equal(old.detail, undefined, name);
    assert.equal(f.writes.length, 0);
  }
});
test('connection and selection ABA, close and loss of target do not revive pending Skills', async () => {
  for (const action of ['aba', 'offline', 'close', 'missing']) {
    const f = fixture();
    await f.controller.open(target);
    const entered = signal(),
      release = signal();
    f.state.request = async (params) => {
      entered.resolve();
      await release.promise;
      return response(params);
    };
    const selecting = f.select();
    await entered.promise;
    if (action === 'aba') f.state.context.generation += 2;
    else if (action === 'offline') f.state.context.online = false;
    else if (action === 'missing') f.state.context.target = null;
    else f.controller.close();
    assert.equal(f.controller.state, null);
    release.resolve();
    await assert.rejects(selecting);
    f.controller.sync();
    const count = f.calls.length;
    f.state.context = { target, generation: 10, online: true };
    f.controller.sync();
    assert.equal(f.controller.state, null);
    assert.equal(f.calls.length, count, 'reconnect requires explicit reopen');
  }
});
test('a completed text hash cannot reveal a detail after a target ABA change', async (t) => {
  const f = fixture();
  await f.controller.open(target);
  const entered = signal(),
    release = signal();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(
    crypto.subtle,
    'digest',
    async (...args: Parameters<typeof crypto.subtle.digest>) => {
      const value = await original(...args);
      entered.resolve();
      await release.promise;
      return value;
    },
  );
  const selecting = f.select();
  await entered.promise;
  f.state.context.generation += 2;
  release.resolve();
  await assert.rejects(selecting);
  assert.equal(f.controller.state, null);
  assert.equal(f.writes.length, 0);
});
test('reviewed details reject changed scope, digest, size, full summary, source, catalog and execution', async () => {
  const changes = [
    (detail: SkillDetail) => {
      detail.workspaceId = 'other';
    },
    (detail: SkillDetail) => {
      detail.localProjectId = 'other';
    },
    (detail: SkillDetail) => {
      detail.sessionId = 'other';
    },
    (detail: SkillDetail) => {
      detail.text = detail.text.replace('完整', '替换');
    },
    (detail: SkillDetail) => {
      detail.skill.byteLength++;
    },
    (detail: SkillDetail) => {
      detail.skill.name = 'Changed';
    },
    (detail: SkillDetail) => {
      detail.skill.path = 'other/SKILL.md';
    },
    (detail: SkillDetail) => {
      detail.skill.description = 'Changed';
    },
    (detail: SkillDetail) => {
      detail.source.label = 'Changed';
    },
    (detail: SkillDetail) => {
      detail.source.version = hash('changed');
    },
    (detail: SkillDetail) => {
      detail.source.scope = 'global';
    },
    (detail: SkillDetail) => {
      detail.source.status = 'unavailable';
    },
    (detail: SkillDetail) => {
      detail.catalogVersion = hash('changed');
    },
    (detail: SkillDetail) => {
      detail.executionRevision++;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    await f.controller.open(target);
    const selected = await f.select();
    f.state.request = async (params) => {
      const value = structuredClone(response(params));
      if (value.view === 'detail') change(value);
      return value;
    };
    await assert.rejects(f.controller.add(selected.detail, selected.review));
    assert.equal(f.writes.length, 0);
    assert.equal(f.controller.state!.controller.detail, undefined);
    assert.equal(f.controller.state!.controller.list, undefined);
  }
});
test('an old rendered selection cannot append into a reopened or foreign-authority panel with equal wire content', async () => {
  const f = fixture();
  await f.controller.open(target);
  const old = await f.select();
  f.controller.close();
  await f.controller.open(target);
  await f.select();
  const count = f.calls.length;
  await assert.rejects(f.controller.add(old.detail, old.review), /面板已改变/);
  assert.equal(f.calls.length, count);
  f.state.context.target = { ...target, owner: 'other' };
  await f.controller.open(f.state.context.target);
  await f.select();
  await assert.rejects(f.controller.add(old.detail, old.review), /面板已改变/);
  assert.equal(f.writes.length, 0);
});
test('an old rendered catalog or detail is rejected before reading or appending replacement content', async () => {
  const f = fixture();
  await f.controller.open(target);
  const old = structuredClone(f.controller.state!.controller.list!),
    review = f.controller.state!.review;
  f.state.request = async (params) => {
    const value = structuredClone(response(params));
    value.catalogVersion = hash('replacement');
    return value;
  };
  await f.controller.refresh();
  const count = f.calls.length;
  await assert.rejects(f.controller.select('skill', old, review), /列表已改变/);
  assert.equal(f.calls.length, count);
  f.state.request = async (params) => response(params);
  await f.controller.refresh();
  const selected = await f.select();
  const changed = structuredClone(selected.detail);
  changed.text = 'Not the displayed body';
  await assert.rejects(f.controller.add(changed, selected.review), /说明已改变/);
  assert.equal(f.writes.length, 0);
});
test('append uses the latest draft after revalidation and refuses a concurrent CAS write', async () => {
  const f = fixture();
  await f.controller.open(target);
  const selected = await f.select();
  const entered = signal(),
    release = signal();
  f.state.request = async (params) => {
    entered.resolve();
    await release.promise;
    return response(params);
  };
  const adding = f.controller.add(selected.detail, selected.review);
  await entered.promise;
  f.state.draft = 'Typed while reading the reviewed file';
  release.resolve();
  await adding;
  assert.match(f.state.draft, /^Typed while reading the reviewed file\n\n/);
  const casEntered = signal(),
    casRelease = signal();
  f.state.beforeCAS = async () => {
    casEntered.resolve();
    await casRelease.promise;
  };
  const competing = f.controller.add(selected.detail, selected.review);
  await casEntered.promise;
  f.state.draft = 'Other page draft';
  casRelease.resolve();
  await assert.rejects(competing, /其他页面/);
  assert.equal(f.state.draft, 'Other page draft');
  assert.equal(f.writes.length, 1);
});
test('closing or changing authority during draft CAS prevents writing either draft', async () => {
  for (const action of ['close', 'authority', 'aba']) {
    const f = fixture();
    await f.controller.open(target);
    const selected = await f.select();
    const entered = signal(),
      release = signal();
    f.state.beforeCAS = async () => {
      entered.resolve();
      await release.promise;
    };
    const adding = f.controller.add(selected.detail, selected.review);
    await entered.promise;
    if (action === 'close') f.controller.close();
    else if (action === 'authority') f.state.context.target = { ...target, owner: 'other' };
    else f.state.context.generation += 2;
    release.resolve();
    await assert.rejects(adding);
    assert.equal(f.state.draft, 'Existing unsent draft');
    assert.equal(f.writes.length, 0);
  }
});

function hostFixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-skills-')));
  const projectRoot = join(directory, 'project'),
    globalRoot = join(directory, 'global'),
    privateRoot = join(directory, 'private');
  for (const path of [projectRoot, globalRoot, privateRoot]) mkdirSync(path);
  const projectSkill = join(projectRoot, '.agents/skills/synthetic'),
    globalSkill = join(globalRoot, 'synthetic');
  for (const path of [projectSkill, globalSkill]) mkdirSync(path, { recursive: true });
  writeFileSync(join(projectSkill, 'SKILL.md'), text);
  writeFileSync(
    join(globalSkill, 'SKILL.md'),
    '# Synthetic global\n\nSYNTHETIC_PRIVATE_GLOBAL_BODY',
  );
  const store = new RuntimeStore(join(privateRoot, 'runtime.sqlite'));
  const project = store.registerProject(projectRoot);
  store.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/not-executed', args: [] },
  });
  const config = new SkillsConfig(join(privateRoot, 'skills-v1.json'), {
    identity: {
      workspaceId: store.workspace.id,
      userId: store.workspace.userId,
      machineId: store.workspace.machineId,
    },
    projectRoots: () => [projectRoot],
    privateRoots: [privateRoot],
  });
  const global = config.handle({
    action: 'source-save',
    expectedRevision: 0,
    label: 'Synthetic global',
    rootPath: globalRoot,
    enabled: true,
  });
  let opens = 0;
  const host = new HostWorkspace(
    store,
    {
      async open() {
        opens++;
        throw Error('Skills must not open an Agent');
      },
    },
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { config },
  );
  const scope: SecureCliTarget = {
    ...target,
    workspaceId: store.workspace.id,
    localProjectId: project,
    machineId: store.workspace.machineId,
    userId: store.workspace.userId,
  };
  const f = fixture(scope);
  f.state.request = (params) => host.readSkills(params);
  t.after(() => {
    f.controller.dispose();
    host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...f,
    directory,
    projectSkill,
    globalRoot,
    global,
    config,
    store,
    host,
    target: scope,
    get opens() {
      return opens;
    },
  };
}
test('actual Host reads project and registered Skills in a confirmed empty session, without Agent startup or body persistence', async (t) => {
  const f = hostFixture(t);
  const receipt = await f.host.controlManager.control({
    controlVersion: 1,
    workspaceId: f.target.workspaceId,
    localProjectId: f.target.localProjectId,
    sessionId: f.target.sessionId,
    machineId: f.target.machineId,
    userId: f.target.userId,
    action: 'create',
    operationId: 'create-empty',
    agentId: 'agent',
    title: 'Synthetic empty session',
  });
  assert.equal(receipt.status, 'accepted');
  await f.controller.open(f.target);
  const list = f.controller.state!.controller.list!;
  assert.equal(list.skills.length, 2);
  assert.doesNotMatch(JSON.stringify(list), /SYNTHETIC_PRIVATE_GLOBAL_BODY/);
  for (const skill of list.skills) {
    const review = f.controller.state!.review;
    await f.controller.select(skill.id, list, review);
    const detail = structuredClone(f.controller.state!.controller.detail!);
    await f.controller.add(detail, review);
    assert.ok(f.state.draft.includes(detail.text));
  }
  assert.equal(f.opens, 0);
  assert.equal(f.host.list(f.target.localProjectId).length, 1);
  for (const row of f.store.journal.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const table = String(row.name);
    assert.match(table, /^[a-z_]+$/);
    assert.doesNotMatch(
      JSON.stringify(f.store.journal.db.prepare(`SELECT * FROM ${table}`).all()),
      /SYNTHETIC_PRIVATE_GLOBAL_BODY|unsafe\(\)/,
    );
  }
});
test('actual Host revocation and file changes reject the previously reviewed selection before append', async (t) => {
  const f = hostFixture(t);
  await f.controller.open(f.target);
  const list = f.controller.state!.controller.list!;
  const global = list.skills.find(
    (skill) => list.sources.find((source) => source.id === skill.sourceId)?.scope === 'global',
  )!;
  await f.controller.select(global.id, list, f.controller.state!.review);
  const reviewed = structuredClone(f.controller.state!.controller.detail!),
    review = f.controller.state!.review;
  const config = f.config.read();
  f.config.handle({
    action: 'source-save',
    expectedRevision: config.revision,
    id: config.sources[0].id,
    label: config.sources[0].label,
    rootPath: f.globalRoot,
    enabled: false,
  });
  await assert.rejects(f.controller.add(reviewed, review));
  assert.equal(f.writes.length, 0);
  await f.controller.refresh();
  const project = await f.select();
  writeFileSync(join(f.projectSkill, 'SKILL.md'), '# Changed complete instruction');
  await assert.rejects(f.controller.add(project.detail, project.review));
  assert.equal(f.writes.length, 0);
  assert.equal(f.opens, 0);
});
