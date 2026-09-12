import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  compareTextLines,
  projectContentKey,
  readProjectTree,
  readCurrentProjectFile,
  readProjectTurnDiff,
  readProjectDiffFile,
  type ProjectContentTarget,
} from '../src/web/project-content';
import type {
  ProjectDiffChange,
  ProjectDiffReference,
  ProjectDiffFileResult,
  ProjectTreeResult,
  ProjectTurnDiffResult,
} from '../src/project-content-protocol';
const hash = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const target: ProjectContentTarget = {
  owner: 'synthetic-owner',
  deviceId: 'device-a',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const scope = {
  contentVersion: 1 as const,
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  sessionId: target.sessionId,
};
const before = {
  path: 'a.txt',
  size: 3,
  state: 'text' as const,
  version: hash('old'),
  mediaType: 'text/plain' as const,
};
const after = { ...before, path: 'a.txt', version: hash('new') };
const change: ProjectDiffChange = { path: 'a.txt', kind: 'modified', before, after };
const reference: ProjectDiffReference = {
  contentVersion: 1,
  basis: 'project-snapshot',
  turnId: 'turn',
  diffId: 'diff',
  state: 'ready',
  version: hash('synthetic-diff'),
  changeCount: 1,
};
const summary: ProjectTurnDiffResult = {
  ...scope,
  confirmed: true,
  turnId: 'turn',
  state: 'ready',
  reference,
  changes: [change],
  partial: false,
  issues: [],
  attribution: 'shared-project',
};
const diffFile: ProjectDiffFileResult = {
  ...scope,
  confirmed: true,
  turnId: 'turn',
  path: 'a.txt',
  reference,
  before: { ...before, text: 'old' },
  after: { ...after, text: 'new' },
  partial: false,
  issues: [],
  attribution: 'shared-project',
};
function fixture() {
  const cache = new Map<string, unknown>(),
    calls: { path: string; body: unknown }[] = [];
  let respond: (path: string, body: any) => unknown = () =>
    assert.fail('Unexpected synthetic request');
  const dependencies = {
    read: async (key: string) => structuredClone(cache.get(key)),
    write: async (key: string, value: unknown) => {
      cache.set(key, structuredClone(value));
    },
    request: async (path: string, body: unknown) => {
      calls.push({ path, body: structuredClone(body) });
      return structuredClone(respond(path, body));
    },
  };
  return {
    cache,
    calls,
    dependencies,
    respond: (fn: typeof respond) => {
      respond = fn;
    },
  };
}
const firstTree: ProjectTreeResult = {
  ...scope,
  confirmed: true,
  version: hash('tree'),
  source: 'git',
  offset: 0,
  nextOffset: 1,
  total: 2,
  entries: [{ path: 'folder', type: 'directory', size: 0 }],
  partial: true,
  enumerationComplete: true,
  issues: [{ reason: 'policy-excluded' }],
};

test('tree pages retain one version, cache each page and isolate every execution identity', async () => {
  const f = fixture();
  f.respond((_path, body) =>
    body.offset
      ? {
          ...firstTree,
          offset: 1,
          nextOffset: undefined,
          entries: [{ path: 'folder/a.txt', type: 'file', size: 3 }],
        }
      : firstTree,
  );
  const first = await readProjectTree(target, {}, true, f.dependencies);
  const next = await readProjectTree(
    target,
    { offset: 1, knownVersion: first.result.version },
    true,
    f.dependencies,
  );
  assert.equal(next.result.entries[0].path, 'folder/a.txt');
  assert.equal((f.calls[1].body as any).knownVersion, first.result.version);
  assert.equal((await readProjectTree(target, {}, false, f.dependencies)).source, 'cache');
  assert.equal(
    (
      await readProjectTree(
        target,
        { offset: 1, knownVersion: first.result.version },
        false,
        f.dependencies,
      )
    ).result.offset,
    1,
  );
  assert.equal(f.calls.length, 2, 'offline reads never contact the host');
  for (const key of ['owner', 'deviceId', 'workspaceId', 'localProjectId', 'sessionId'] as const) {
    assert.notEqual(projectContentKey({ ...target, [key]: 'other' }), projectContentKey(target));
    await assert.rejects(
      readProjectTree({ ...target, [key]: 'other' }, {}, false, f.dependencies),
      /没有这个目录版本/,
    );
  }
  await readProjectTree(
    { ...target, catalogWorkspaceId: 'moved', replicaId: 'moved-replica' },
    {},
    true,
    f.dependencies,
  );
  assert.equal(f.calls.at(-1)!.path, '/api/workspaces/moved/replicas/moved-replica/project-tree');
});

test('tree responses reject scope substitution, mixed versions, duplicate paths and inconsistent paging', async () => {
  for (const patch of [
    { sessionId: 'other' },
    { offset: 1 },
    { nextOffset: 2 },
    { total: 0 },
    { version: hash('different') },
    { entries: [firstTree.entries[0], firstTree.entries[0]], nextOffset: undefined },
  ]) {
    const f = fixture();
    f.respond(() => ({ ...firstTree, ...patch }));
    await assert.rejects(
      readProjectTree(target, { knownVersion: firstTree.version }, true, f.dependencies),
    );
    assert.equal(f.cache.size, 0, 'invalid pages cannot enter cache');
  }
});

test('current file reads cache exact verified versions and offline results remain explicitly stale', async () => {
  const f = fixture();
  f.respond((_path, body) => ({
    ...scope,
    confirmed: true,
    path: body.path,
    content: { version: hash('current'), byteLength: 7, mediaType: 'text/plain' },
    status: 'content',
    encoding: 'base64',
    data: Buffer.from('current').toString('base64'),
  }));
  const current = await readCurrentProjectFile(target, 'current.md', true, f.dependencies);
  assert.equal(current.text, 'current');
  const cached = await readCurrentProjectFile(target, 'current.md', false, f.dependencies);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.stale, true);
  assert.equal(cached.result.content.version, hash('current'));
  await assert.rejects(
    readCurrentProjectFile(target, 'uncached.md', false, f.dependencies),
    /没有这个版本/,
  );
  assert.equal(f.calls.length, 1);
});

test('frozen diff summaries and contents remain readable offline without consulting the current project file', async () => {
  const f = fixture();
  f.respond((path) => (path.endsWith('/turn-diff') ? summary : diffFile));
  const result = await readProjectTurnDiff(target, 'turn', true, f.dependencies, reference);
  assert.equal(result.result.state, 'ready');
  const body = await readProjectDiffFile(target, reference, change, true, f.dependencies);
  assert.equal(body.result.before?.text, 'old');
  f.respond(() => assert.fail('offline diff cannot read current project bytes'));
  assert.equal(
    (await readProjectTurnDiff(target, 'turn', false, f.dependencies, reference)).source,
    'cache',
  );
  assert.equal(
    (await readProjectDiffFile(target, reference, change, false, f.dependencies)).result.after
      ?.text,
    'new',
  );
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => !call.path.includes('file-content')));
  await assert.rejects(
    readProjectDiffFile(
      { ...target, sessionId: 'other' },
      reference,
      change,
      false,
      f.dependencies,
    ),
    /没有这个历史文件版本/,
  );
});

test('diff responses reject swapped scope, turn, baseline, paths and tampered UTF-8 content', async () => {
  for (const patch of [
    { sessionId: 'other' },
    { turnId: 'other' },
    { path: 'other.txt' },
    { reference: { ...reference, version: hash('other') } },
    { before: { ...diffFile.before, text: 'bad' } },
    { after: { ...diffFile.after, path: 'other.txt' } },
    { after: null },
  ]) {
    const f = fixture();
    f.respond(() => ({ ...diffFile, ...patch }));
    await assert.rejects(readProjectDiffFile(target, reference, change, true, f.dependencies));
    assert.equal(f.cache.size, 0);
  }
  for (const patch of [
    { turnId: 'other' },
    { reference: { ...reference, diffId: 'other' } },
    { partial: true },
    { changes: [change, change] },
    { changes: [{ ...change, kind: 'added' }] },
  ]) {
    const f = fixture();
    f.respond(() => ({ ...summary, ...patch }));
    await assert.rejects(readProjectTurnDiff(target, 'turn', true, f.dependencies, reference));
  }
});

test('unrecorded and interrupted summaries preserve uncertainty and binary or absent file sides are not invented as text', async () => {
  const f = fixture();
  for (const state of ['not-recorded', 'interrupted', 'unavailable', 'pending'] as const) {
    f.respond(() => ({
      ...summary,
      state,
      reference:
        state === 'not-recorded'
          ? undefined
          : { ...reference, state, version: undefined, changeCount: 0 },
      changes: [],
      partial: true,
      issues: [
        {
          reason:
            state === 'pending'
              ? 'incomplete-baseline'
              : state === 'unavailable'
                ? 'capture-failed'
                : state,
        },
      ],
    }));
    assert.equal(
      (await readProjectTurnDiff(target, 'turn', true, f.dependencies)).result.state,
      state,
    );
  }
  const binary = {
    path: 'binary.dat',
    state: 'binary' as const,
    size: 3,
    version: hash('bin'),
    mediaType: 'application/octet-stream' as const,
  };
  const added = { path: 'binary.dat', kind: 'added' as const, before: null, after: binary };
  f.respond(() => ({ ...diffFile, path: 'binary.dat', before: null, after: binary }));
  const body = await readProjectDiffFile(target, reference, added, true, f.dependencies);
  assert.equal(body.result.before, null);
  assert.equal(body.result.after?.text, undefined);
  f.respond(() => ({
    ...diffFile,
    path: 'binary.dat',
    before: null,
    after: { ...binary, text: 'bin' },
  }));
  await assert.rejects(
    readProjectDiffFile(target, reference, added, true, f.dependencies),
    /正文与摘要不匹配|不能携带文本/,
  );
});

test('bounded text comparison handles added, deleted and repeated lines without interpreting content', () => {
  const lines = compareTextLines('same\nold\n<script>\n', 'same\nnew\n<script>\n')!;
  assert.deepEqual(
    lines.filter((line) => line.kind !== 'same').map((line) => [line.kind, line.text]),
    [
      ['removed', 'old'],
      ['added', 'new'],
    ],
  );
  assert.equal(lines.find((line) => line.text === '<script>')!.kind, 'same');
  assert.deepEqual(compareTextLines('', 'new'), [{ kind: 'added', text: 'new', after: 1 }]);
  assert.deepEqual(compareTextLines('old', ''), [{ kind: 'removed', text: 'old', before: 1 }]);
  assert.equal(compareTextLines('a\n'.repeat(2000), 'b\n'.repeat(2000)), undefined);
});
