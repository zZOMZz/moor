import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  chmodSync,
  rmSync,
  symlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubConfig, type GitHubConfigVerifier } from '../src/runtime/github-config';
import { AppError } from '../src/protocol';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(t: { after(fn: () => unknown): void }) {
  const data = mkdtempSync(join(tmpdir(), 'moor-github-config-')),
    rootPath = join(data, 'project'),
    file = join(data, 'private', 'github-v1.json');
  mkdirSync(rootPath);
  t.after(() => rmSync(data, { recursive: true, force: true }));
  let identity = { workspaceId: 'workspace', machineId: 'machine', userId: 'local:synthetic' },
    repositoryId = 42,
    deny = false,
    waitUser: ReturnType<typeof gate> | undefined,
    waitRepository: ReturnType<typeof gate> | undefined;
  let notices = 0;
  const calledUser = gate(),
    calledRepository = gate(),
    calls: string[] = [];
  const verifier: GitHubConfigVerifier = {
    async getUser(token) {
      calls.push(token);
      calledUser.release();
      await waitUser?.promise;
      if (deny) throw new AppError(403, 'Synthetic auth denial');
      return { login: 'synthetic-user' };
    },
    async getRepository(token, owner, repo) {
      calls.push(token);
      calledRepository.release();
      await waitRepository?.promise;
      if (deny) throw new Error('/synthetic/private/path ' + token);
      return { id: repositoryId, owner, repo };
    },
  };
  const options = {
    identity: () => identity,
    projects: () => [{ id: 'project', name: 'Synthetic project', rootPath }],
    verifier,
    now: () => 1000,
    changed() {
      notices++;
    },
  };
  let config = new GitHubConfig(file, options);
  return {
    file,
    rootPath,
    options,
    calls,
    calledUser,
    calledRepository,
    get config() {
      return config;
    },
    get notices() {
      return notices;
    },
    set identity(value: typeof identity) {
      identity = value;
    },
    set repositoryId(value: number) {
      repositoryId = value;
    },
    set deny(value: boolean) {
      deny = value;
    },
    set waitUser(value: typeof waitUser) {
      waitUser = value;
    },
    set waitRepository(value: typeof waitRepository) {
      waitRepository = value;
    },
    restart() {
      config = new GitHubConfig(file, options);
    },
    async save(token = 'synthetic_token_1', credentialId?: string) {
      return config.handle({
        action: 'credential-save',
        expectedRevision: config.read().revision,
        label: 'Synthetic account',
        token,
        ...(credentialId ? { credentialId } : {}),
      });
    },
    async bind(credentialId: string) {
      return config.handle({
        action: 'project-bind',
        expectedRevision: config.read().revision,
        localProjectId: 'project',
        credentialId,
        owner: 'synthetic-owner',
        repo: 'synthetic-repo',
      });
    },
  };
}

test('private GitHub credentials persist without renderer token echo, and project bindings pin repository identity', async (t) => {
  const f = fixture(t);
  const initial = await f.save(),
    credentialId = initial.credentials[0]!.id;
  assert.equal(JSON.stringify(initial).includes('synthetic_token'), false);
  assert.equal(initial.credentials[0]!.status.state, 'unchecked');
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.calls.length, 0, 'saving does not send a network request');
  const bound = await f.bind(credentialId),
    lease = f.config.getProject('project');
  assert.equal(bound.projects[0]!.binding!.repositoryId, 42);
  assert.equal(lease.token, 'synthetic_token_1');
  assert.equal(JSON.stringify(bound).includes('synthetic_token'), false);
  assert.equal(f.notices, 3, 'save, unverified mapping, verified mapping are published separately');
  f.restart();
  assert.equal(f.config.isCurrent(lease), true);
  await f.config.handle({
    action: 'credential-check',
    credentialId,
    expectedRevision: f.config.read().revision,
  });
  assert.equal(
    f.config.getProject('project').version,
    lease.version,
    'account status changes do not change repository context',
  );
  f.deny = true;
  await f.config.handle({
    action: 'credential-check',
    credentialId,
    expectedRevision: f.config.read().revision,
  });
  assert.equal(
    f.config.isCurrent(lease),
    false,
    'an invalid account invalidates verified repository access',
  );
  f.deny = false;
  await f.config.handle({
    action: 'project-check',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
  });
  await f.save('synthetic_token_2', credentialId);
  assert.equal(f.config.isCurrent(lease), false);
  assert.throws(() => f.config.getProject('project'), /尚未验证/);
  assert.equal(f.config.read().projects[0]!.binding!.repositoryId, 42);
  await f.config.handle({
    action: 'project-check',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
  });
  assert.equal(f.config.getProject('project').token, 'synthetic_token_2');
  f.repositoryId = 43;
  const denied = await f.config.handle({
    action: 'project-check',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
  });
  assert.equal(denied.projects[0]!.binding!.status.state, 'denied');
  assert.equal(denied.projects[0]!.binding!.repositoryId, 42);
  assert.throws(() => f.config.getProject('project'));
  await f.bind(credentialId);
  assert.equal(
    f.config.getProject('project').repositoryId,
    43,
    'only explicit re-registration adopts a replacement repository',
  );
  await f.config.handle({
    action: 'credential-remove',
    credentialId,
    expectedRevision: f.config.read().revision,
  });
  assert.deepEqual(f.config.read().credentials, []);
  assert.equal(f.config.read().projects[0]!.binding, undefined);
  assert.equal(readFileSync(f.file, 'utf8').includes('synthetic_token'), false);
});

test('project external writes default off for old and new config, require verification, and use local revision CAS', async (t) => {
  const f = fixture(t),
    credentialId = (await f.save()).credentials[0]!.id;
  f.deny = true;
  await f.bind(credentialId);
  assert.equal(f.config.read().projects[0]!.binding!.writesEnabled, false);
  const uncheckedRevision = f.config.read().revision;
  await assert.rejects(
    f.config.handle({
      action: 'project-writes',
      localProjectId: 'project',
      expectedRevision: uncheckedRevision,
      enabled: true,
    }),
    /先验证/,
  );
  assert.equal(f.config.read().revision, uncheckedRevision);
  f.deny = false;
  await f.config.handle({
    action: 'project-check',
    localProjectId: 'project',
    expectedRevision: uncheckedRevision,
  });
  const oldFile = JSON.parse(readFileSync(f.file, 'utf8'));
  delete oldFile.projects[0].writesEnabled;
  delete oldFile.projects[0].writeGeneration;
  writeFileSync(f.file, JSON.stringify(oldFile));
  f.restart();
  const readOnly = f.config.getProject('project');
  assert.equal(
    readOnly.writesEnabled,
    false,
    'legacy mappings never implicitly enable external writes',
  );
  const originalRevision = f.config.read().revision,
    calls = f.calls.length,
    notices = f.notices;
  const enabled = await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: originalRevision,
    enabled: true,
  });
  assert.equal(enabled.projects[0]!.binding!.writesEnabled, true);
  assert.equal(enabled.revision, originalRevision + 1);
  assert.equal(
    f.calls.length,
    calls,
    'local opt-in never sends a GitHub write or verification request',
  );
  assert.equal(f.notices, notices + 1);
  assert.equal(f.config.isCurrent(readOnly), false);
  const writable = f.config.getProject('project');
  assert.notEqual(writable.version, readOnly.version);
  await assert.rejects(
    f.config.handle({
      action: 'project-writes',
      localProjectId: 'project',
      expectedRevision: originalRevision,
      enabled: false,
    }),
    /已变化/,
  );
  assert.equal(f.config.getProject('project').writesEnabled, true);
  await assert.rejects(
    f.config.handle({
      action: 'project-writes',
      localProjectId: 'project',
      expectedRevision: enabled.revision,
      enabled: 'true',
    }),
    /无效/,
  );
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: enabled.revision,
    enabled: false,
  });
  assert.equal(f.config.isCurrent(writable), false);
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
    enabled: true,
  });
  assert.equal(
    f.config.isCurrent(writable),
    false,
    're-enabling cannot revive a lease captured before disabling',
  );
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
    enabled: false,
  });
  f.restart();
  assert.equal(f.config.getProject('project').writesEnabled, false);
  assert.equal(JSON.stringify(f.config.read()).includes('synthetic_token'), false);
});

test('disabling external writes invalidates pending checks and explicit repository rebind resets opt-in', async (t) => {
  const f = fixture(t),
    credentialId = (await f.save()).credentials[0]!.id;
  await f.bind(credentialId);
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
    enabled: true,
  });
  const waiting = gate();
  f.waitUser = waiting;
  const checking = f.config.handle({
      action: 'credential-check',
      credentialId,
      expectedRevision: f.config.read().revision,
    }),
    stale = assert.rejects(checking, /已变化/);
  await f.calledUser.promise;
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
    enabled: false,
  });
  waiting.release();
  await stale;
  assert.equal(f.config.getProject('project').writesEnabled, false);
  f.waitUser = undefined;
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
    enabled: true,
  });
  await f.save('synthetic_replaced_token', credentialId);
  assert.throws(() => f.config.getProject('project'), /尚未验证/);
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
    enabled: false,
  });
  assert.equal(
    f.config.read().projects[0]!.binding!.writesEnabled,
    false,
    'turning off never requires renewed repository access',
  );
  await f.bind(credentialId);
  await f.config.handle({
    action: 'project-writes',
    localProjectId: 'project',
    expectedRevision: f.config.read().revision,
    enabled: true,
  });
  f.repositoryId = 43;
  await f.bind(credentialId);
  assert.equal(f.config.getProject('project').repositoryId, 43);
  assert.equal(f.config.getProject('project').writesEnabled, false);
});

test('late account verification cannot revive a replaced token or overwrite a newer config revision', async (t) => {
  const f = fixture(t),
    credentialId = (await f.save()).credentials[0]!.id,
    waiting = gate();
  f.waitUser = waiting;
  const pending = f.config.handle({
      action: 'credential-check',
      credentialId,
      expectedRevision: f.config.read().revision,
    }),
    rejection = assert.rejects(pending, /已变化/);
  await f.calledUser.promise;
  await f.save('synthetic_replacement', credentialId);
  waiting.release();
  await rejection;
  assert.equal(f.config.read().credentials[0]!.status.state, 'unchecked');
  assert.equal(f.config.read().credentials[0]!.status.login, undefined);
  assert.equal(readFileSync(f.file, 'utf8').includes('synthetic_token_1'), false);
});

test('project registration revokes the old binding before verification and late checks cannot confirm a removed credential', async (t) => {
  const f = fixture(t),
    credentialId = (await f.save()).credentials[0]!.id,
    waiting = gate();
  f.waitRepository = waiting;
  const pending = f.bind(credentialId),
    rejection = assert.rejects(pending, /已变化/);
  await f.calledRepository.promise;
  assert.equal(f.config.read().projects[0]!.binding!.status.state, 'unchecked');
  assert.throws(() => f.config.getProject('project'));
  assert.equal(f.notices, 2);
  await f.config.handle({
    action: 'credential-remove',
    credentialId,
    expectedRevision: f.config.read().revision,
  });
  waiting.release();
  await rejection;
  assert.equal(f.config.read().projects[0]!.binding, undefined);
  assert.equal(f.config.read().credentials.length, 0);
});

test('unverified or re-registered project roots and changed host accounts cannot expose configured credentials', async (t) => {
  const f = fixture(t),
    credentialId = (await f.save()).credentials[0]!.id;
  f.deny = true;
  const failed = await f.bind(credentialId);
  assert.equal(failed.projects[0]!.binding!.status.state, 'unavailable');
  assert.equal(JSON.stringify(failed).includes('synthetic_token'), false);
  assert.throws(() => f.config.getProject('project'));
  f.deny = false;
  await f.bind(credentialId);
  const lease = f.config.getProject('project');
  renameSync(f.rootPath, f.rootPath + '-old');
  mkdirSync(f.rootPath);
  assert.equal(f.config.read().projects[0]!.binding!.current, false);
  assert.equal(f.config.isCurrent(lease), false);
  f.identity = { workspaceId: 'workspace', machineId: 'machine', userId: 'other-user' };
  assert.throws(() => f.config.read(), /不属于/);
  await assert.rejects(
    f.config.handle({ action: 'credential-remove', credentialId, expectedRevision: 5 }),
    /不属于/,
  );
});

test('failed persistence preserves the previous credential, while unsafe files fail closed and changed callbacks cannot undo a commit', async (t) => {
  const f = fixture(t),
    credentialId = (await f.save()).credentials[0]!.id,
    original = readFileSync(f.file, 'utf8');
  const failing = new GitHubConfig(f.file, {
    ...f.options,
    write() {
      throw new Error('Synthetic disk failure');
    },
  });
  await assert.rejects(
    failing.handle({
      action: 'credential-save',
      credentialId,
      expectedRevision: f.config.read().revision,
      label: 'replacement',
      token: 'synthetic_not_saved',
    }),
    /保存失败/,
  );
  assert.equal(readFileSync(f.file, 'utf8'), original);
  const publishing = new GitHubConfig(f.file, {
    ...f.options,
    changed() {
      throw new Error('Synthetic listener failed');
    },
  });
  await publishing.handle({
    action: 'credential-save',
    credentialId,
    expectedRevision: f.config.read().revision,
    label: 'Saved replacement',
    token: 'synthetic_saved',
  });
  assert.equal(f.config.read().credentials[0]!.label, 'Saved replacement');
  chmodSync(f.file, 0o644);
  assert.throws(() => f.config.read(), /权限/);
  chmodSync(f.file, 0o600);
  renameSync(f.file, f.file + '.original');
  symlinkSync(f.file + '.original', f.file);
  assert.throws(() => f.config.read(), /安全读取/);
  assert.equal(readFileSync(f.file + '.original', 'utf8').includes('synthetic_saved'), true);
});

test('strict configuration actions refuse unknown projects, remote URLs, raw-shell fields and stale updates', async (t) => {
  const f = fixture(t),
    credentialId = (await f.save()).credentials[0]!.id;
  for (const input of [
    { action: 'read', token: 'synthetic' },
    {
      action: 'project-bind',
      expectedRevision: 1,
      localProjectId: 'missing',
      credentialId,
      owner: 'owner',
      repo: 'repo',
    },
    {
      action: 'project-bind',
      expectedRevision: 1,
      localProjectId: 'project',
      credentialId,
      owner: 'https://example.invalid',
      repo: 'repo',
    },
    { action: 'credential-save', expectedRevision: 1, label: 'bad', token: 'bad\nheader' },
    { action: 'credential-remove', expectedRevision: 0, credentialId },
  ])
    await assert.rejects(f.config.handle(input));
  assert.equal(f.calls.length, 0);
  assert.equal(f.config.read().revision, 1);
});

test('GitHub private data cannot be placed inside an existing project or exposed after registering a larger parent', async (t) => {
  const f = fixture(t),
    within = new GitHubConfig(join(f.rootPath, 'github-v1.json'), f.options);
  await assert.rejects(
    within.handle({
      action: 'credential-save',
      expectedRevision: 0,
      label: 'Unsafe location',
      token: 'synthetic_never_written',
    }),
    /不能位于/,
  );
  const credentialId = (await f.save()).credentials[0]!.id;
  await f.bind(credentialId);
  const lease = f.config.getProject('project');
  const parent = new GitHubConfig(f.file, {
    ...f.options,
    projects: () => [
      ...f.options.projects(),
      { id: 'parent', name: 'Too broad', rootPath: join(f.rootPath, '..') },
    ],
  });
  assert.throws(() => parent.read(), /不能位于/);
  assert.equal(parent.isCurrent(lease), false);
});
