import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { SkillsConfig } from '../src/runtime/skills-config';
import { discoverSkills, type SkillDiscoveryOptions } from '../src/runtime/project-skills';
import {
  SKILLS_FEATURE,
  type SkillsList,
  type SkillsRead,
  type SkillDetail,
} from '../src/skills-protocol';
import { putMeta } from '../src/model';

const body = (value: string) => `---\nname: synthetic\ndescription: 合成 Skill\n---\n${value}\n`;
function writeSkill(root: string, path: string, value: string) {
  const directory = join(root, path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), body(value));
}
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-skills-host-')));
  const root = join(directory, 'project'),
    globalRoot = join(directory, 'global');
  const privateRoot = join(directory, 'private');
  for (const path of [root, globalRoot, privateRoot]) mkdirSync(path);
  writeSkill(root, '.agents/skills/synthetic', 'PROJECT_SKILL_BODY');
  writeSkill(globalRoot, 'synthetic', 'GLOBAL_SKILL_BODY');
  const store = new RuntimeStore(join(privateRoot, 'runtime.sqlite'), {
    worktreeRoot: join(directory, 'worktrees'),
  });
  const project = store.registerProject(root);
  const other = store.registerProject(globalRoot);
  const identity = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
  };
  const config = new SkillsConfig(join(privateRoot, 'skills-v1.json'), {
    identity,
    projectRoots: () => [root, globalRoot],
    privateRoots: [privateRoot],
  });
  let opens = 0;
  const controls: { checkpoint?: SkillDiscoveryOptions['checkpoint']; after?: () => void } = {};
  const host = new HostWorkspace(
    store,
    {
      async open() {
        opens++;
        throw new Error('No Agent during read');
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
    {
      config,
      discover: async (sources, options) => {
        const result = await discoverSkills(sources, {
          ...options,
          checkpoint: controls.checkpoint,
        });
        controls.after?.();
        return result;
      },
    },
  );
  t.after(() => {
    host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = {
    skillsVersion: 1 as const,
    workspaceId: store.workspace.id,
    localProjectId: project,
    sessionId: 'new-session',
  };
  return {
    directory,
    root,
    globalRoot,
    privateRoot,
    store,
    project,
    other,
    config,
    host,
    scope,
    controls,
    get opens() {
      return opens;
    },
    list: () => host.readSkills({ ...scope, view: 'list' }) as Promise<SkillsList>,
    enable() {
      return config.handle({
        action: 'source-save',
        expectedRevision: config.read().revision,
        label: 'Synthetic global',
        rootPath: globalRoot,
        enabled: true,
      });
    },
  };
}
function detail(list: SkillsList, index = 0): SkillsRead {
  const skill = list.skills[index]!;
  return {
    skillsVersion: 1,
    workspaceId: list.workspaceId,
    localProjectId: list.localProjectId,
    sessionId: list.sessionId,
    view: 'detail',
    sourceId: skill.sourceId,
    skillId: skill.id,
    version: skill.version,
    catalogVersion: list.catalogVersion,
    executionRevision: list.executionRevision,
  };
}
test('Skills list and detail bind new sessions, preserve duplicate sources, and never create sessions or persist bodies', async (t) => {
  const f = fixture(t);
  assert.ok(f.host.workspace.features?.includes(SKILLS_FEATURE));
  const initial = await f.list();
  assert.equal(initial.skills.length, 1);
  assert.equal(initial.sources.filter((source) => source.status === 'missing').length, 2);
  f.enable();
  const list = await f.list();
  assert.equal(list.skills.length, 2);
  assert.deepEqual(
    list.skills.map((skill) => skill.name),
    ['synthetic', 'synthetic'],
  );
  assert.equal(new Set(list.skills.map((skill) => skill.id)).size, 2);
  assert.equal(JSON.stringify(list).includes(f.directory), false);
  assert.equal(JSON.stringify(list).includes('GLOBAL_SKILL_BODY'), false);
  for (let index = 0; index < list.skills.length; index++) {
    const result = (await f.host.readSkills(detail(list, index))) as SkillDetail;
    assert.match(result.text, /SKILL_BODY/);
    assert.equal(JSON.stringify(result).includes(f.directory), false);
  }
  assert.equal(f.opens, 0);
  assert.equal(f.host.list(f.project).length, 0);
  for (const row of f.store.journal.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const table = String(row.name);
    assert.match(table, /^[a-z_]+$/);
    assert.doesNotMatch(
      JSON.stringify(f.store.journal.db.prepare(`SELECT * FROM ${table}`).all()),
      /PROJECT_SKILL_BODY|GLOBAL_SKILL_BODY/,
    );
  }
});
test('Skills reads reject foreign workspaces, projects, known session ownership and arbitrary path controls', async (t) => {
  const f = fixture(t);
  putMeta(f.store.meta, 'session-owned', {
    id: 'owned',
    machineId: f.store.workspace.machineId,
    userId: f.store.workspace.userId,
    project: { kind: 'local', localProjectId: f.other },
  });
  for (const value of [
    { ...f.scope, view: 'list', workspaceId: 'foreign' },
    { ...f.scope, view: 'list', localProjectId: 'foreign' },
    { ...f.scope, view: 'list', sessionId: 'owned' },
    { ...f.scope, view: 'list', rootPath: f.globalRoot },
    { ...f.scope, view: 'list', path: '../../SKILL.md' },
  ])
    await assert.rejects(f.host.readSkills(value as SkillsRead));
  await assert.rejects(f.host.readSkills({ ...f.scope, view: 'list' }, f.other));
  assert.equal(f.opens, 0);
});
test('Skills bounds concurrent discovery and releases capacity after success or rejected input', async (t) => {
  const f = fixture(t);
  let entered!: () => void,
    release!: () => void,
    count = 0;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  f.controls.checkpoint = async (stage) => {
    if (stage !== 'source-checked') return;
    if (++count === 2) entered();
    await waiting;
  };
  const first = f.list(),
    second = f.list();
  await started;
  await assert.rejects(f.list(), { status: 429 });
  release();
  await Promise.all([first, second]);
  f.controls.checkpoint = undefined;
  await assert.rejects(
    f.host.readSkills({ ...f.scope, view: 'list', rootPath: f.root } as SkillsRead),
  );
  assert.equal((await f.list()).skills.length, 1);
});
test('Skills detail refuses changed body, source authorization ABA and changed project directory', async (t) => {
  const f = fixture(t);
  const state = f.enable();
  let list = await f.list();
  const projectDetail = detail(
    list,
    list.skills.findIndex((skill) => skill.sourceId === 'project-agents'),
  );
  writeSkill(f.root, '.agents/skills/synthetic', 'MODIFIED_BODY');
  await assert.rejects(f.host.readSkills(projectDetail), /正文已变化/);
  const original = detail(list);
  f.config.handle({
    action: 'source-enabled',
    id: state.sources[0]!.id,
    expectedRevision: 1,
    enabled: false,
  });
  f.config.handle({
    action: 'source-enabled',
    id: state.sources[0]!.id,
    expectedRevision: 2,
    enabled: true,
  });
  await assert.rejects(f.host.readSkills(original), /目录或执行范围已变化/);
  list = await f.list();
  renameSync(join(f.root, '.agents'), join(f.root, '.agents-old'));
  writeSkill(f.root, '.agents/skills/synthetic', 'MODIFIED_BODY');
  await assert.rejects(f.host.readSkills(detail(list)), /目录或执行范围已变化/);
});
test('Skills checks local authorization, account and host lifecycle after awaited reads including final completion', async (t) => {
  for (const change of ['source', 'user', 'machine', 'project', 'closed'] as const) {
    await t.test(change, async (t) => {
      const f = fixture(t),
        state = f.enable();
      let changed = false;
      f.controls.checkpoint = (stage) => {
        if (stage !== 'after-file-read' || changed) return;
        changed = true;
        if (change === 'source')
          f.config.handle({
            action: 'source-enabled',
            id: state.sources[0]!.id,
            expectedRevision: 1,
            enabled: false,
          });
        if (change === 'user') f.store.workspace.userId = 'different-user';
        if (change === 'machine') f.store.workspace.machineId = 'different-machine';
        if (change === 'project') {
          f.store.machine.delete(['localProject', f.project]);
          f.host.updateCatalogue();
        }
        if (change === 'closed') f.host.close();
      };
      await assert.rejects(f.list());
      assert.equal(changed, true);
      assert.equal(f.opens, 0);
    });
  }
  const f = fixture(t);
  f.controls.after = () => f.host.close();
  await assert.rejects(f.list(), /已停止/);
});
test('Skills uses a real session worktree, invalidates original catalogue and fails after worktree removal', async (t) => {
  const f = fixture(t);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=synthetic@example.invalid',
        '-C',
        f.root,
        ...args,
      ],
      {
        encoding: 'utf8',
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
          ),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  git('init', '--initial-branch=main');
  git('add', '.');
  git('commit', '-m', 'Synthetic baseline');
  const original = await f.list();
  const receipt = await f.host.gitAction({
    gitVersion: 1,
    workspaceId: f.scope.workspaceId,
    localProjectId: f.project,
    sessionId: f.scope.sessionId,
    action: 'prepare',
    operationId: 'prepare-skills-worktree',
    expectedRevision: 0,
    baseBranch: 'main',
    expectedOid: git('rev-parse', 'main'),
    newBranch: 'synthetic-skills',
  });
  assert.equal(receipt.phase, 'accepted');
  const lease = f.host.executionLease(f.scope, undefined, true);
  assert.notEqual(lease.rootPath, f.root);
  writeSkill(lease.rootPath, '.agents/skills/synthetic', 'WORKTREE_SKILL_BODY');
  await assert.rejects(f.host.readSkills(detail(original)), /目录或执行范围已变化/);
  const current = await f.list();
  const result = (await f.host.readSkills(detail(current))) as SkillDetail;
  assert.match(result.text, /WORKTREE_SKILL_BODY/);
  assert.doesNotMatch(result.text, /PROJECT_SKILL_BODY/);
  rmSync(lease.rootPath, { recursive: true });
  await assert.rejects(f.host.readSkills(detail(current)));
  assert.equal(f.opens, 0);
});
