import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProjectContentController } from '../../apps/web/src/features/files/project-content-controller';
import {
  compareTextLines,
  projectContentKey,
  readProjectTree,
  readCurrentProjectFile,
  readProjectTurnDiff,
  readProjectDiffFile,
  type ProjectContentTarget,
} from '../../apps/web/src/features/files/project-content';
import type {
  ProjectDiffChange,
  ProjectDiffReference,
  ProjectDiffFileResult,
  ProjectTreeResult,
  ProjectTurnDiffResult,
} from '@moor/protocol/project-content-protocol';
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

test('content snapshots stay immutable and shared while updates and lost bindings notify subscribers', async () => {
  let online = true;
  let generation = 0;
  let cacheFails = false;
  const notifications: unknown[] = [];
  const panel = new ProjectContentController<ProjectContentTarget>({
    context: () => ({ target, online, generation }),
    parseTarget: (input) => input as ProjectContentTarget,
    contentTarget: (value) => value,
    cache: {
      read: async () => undefined,
      writeBatch: async () => {
        if (cacheFails) throw Error('synthetic unavailable cache');
      },
    },
    request: async (_target, method) => {
      if (method === 'read-project-tree')
        return {
          ...firstTree,
          entries: [{ path: 'a.txt', type: 'file', size: 3 }],
          nextOffset: undefined,
          total: 1,
        };
      if (method === 'file-content')
        return {
          ...scope,
          confirmed: true,
          path: 'a.txt',
          content: { version: hash('new'), byteLength: 3, mediaType: 'text/plain' },
          status: 'content',
          encoding: 'base64',
          data: Buffer.from('new').toString('base64'),
        };
      assert.fail('unexpected content request');
    },
  });
  const unsubscribe = panel.subscribe(() => notifications.push(panel.state));
  await panel.open('tree', []);
  const first = panel.state!;
  assert.strictEqual(panel.state, first, 'unchanged reads are a stable external store snapshot');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.tree!.result.entries[0]));
  assert.throws(() => {
    first.tree!.result.entries[0]!.path = 'tampered.txt';
  }, TypeError);
  cacheFails = true;
  await panel.file('a.txt', 3);
  const second = panel.state!;
  assert.notStrictEqual(first, second);
  assert.strictEqual(first.tree, second.tree, 'file reads retain the unchanged directory snapshot');
  assert.equal(first.currentFile, undefined, 'previous snapshots do not acquire future file text');
  assert.equal(second.currentFile!.text, 'new');
  assert.equal(second.currentFile!.cacheSaved, false, 'cache failures remain visible');
  assert.equal('bytes' in second.currentFile!, false, 'shared views omit mutable binary buffers');
  assert.ok(Object.isFrozen(second.currentFile));
  assert.equal(notifications.at(-1), second);
  online = false;
  assert.equal(panel.state, null, 'a lost connection binding is hidden synchronously');
  panel.sync();
  assert.equal(notifications.at(-1), null);
  online = true;
  generation++;
  assert.equal(panel.state, null, 'reconnection cannot resurrect a previous content scope');
  const count = notifications.length;
  unsubscribe();
  panel.close();
  assert.equal(notifications.length, count);
});

test('refresh verifies new current bytes and cannot publish a late file into a different content view', async () => {
  let text: string | null = 'old';
  let entries: ProjectTreeResult['entries'] = [
    { path: 'folder', type: 'directory', size: 0 },
    { path: 'a.txt', type: 'file', size: 3 },
  ];
  let release: (() => void) | undefined;
  let fileStarted: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const reads: string[] = [];
  const panel = new ProjectContentController<ProjectContentTarget>({
    context: () => ({ target, online: true, generation: 0 }),
    parseTarget: (input) => input as ProjectContentTarget,
    contentTarget: (value) => value,
    cache: { read: async () => undefined, writeBatch: async () => {} },
    request: async (_target, method, params) => {
      reads.push(method);
      if (method === 'read-project-tree') {
        const offset = (params as { offset?: number }).offset ?? 0;
        return {
          ...firstTree,
          version: hash(JSON.stringify(entries)),
          offset,
          entries: entries.slice(offset, offset + 1),
          nextOffset: offset + 1 < entries.length ? offset + 1 : undefined,
          total: entries.length,
        };
      }
      if (method === 'read-turn-diff') return summary;
      assert.equal(method, 'file-content');
      fileStarted?.();
      await gate;
      if (text === null) throw Error('所选文件已被删除。');
      return {
        ...scope,
        confirmed: true,
        path: 'a.txt',
        content: {
          version: hash(text),
          byteLength: Buffer.byteLength(text),
          mediaType: 'text/plain',
        },
        status: 'content',
        encoding: 'base64',
        data: Buffer.from(text).toString('base64'),
      };
    },
  });
  await panel.open('tree', [{ id: 'turn', label: 'turn', reference }]);
  await panel.treeMore();
  await panel.file('a.txt', 3);
  const tree = panel.state!.tree;
  text = 'fresh current file';
  entries = [{ path: 'new.txt', type: 'file', size: 3 }, entries[1]!];
  await panel.refresh();
  assert.equal(panel.state!.currentFile!.text, text);
  assert.equal(panel.state!.currentFile!.result.content.version, hash(text));
  assert.notStrictEqual(panel.state!.tree, tree);
  assert.deepEqual(
    panel.state!.tree!.result.entries.map((entry) => entry.path),
    ['new.txt', 'a.txt'],
  );
  assert.equal(
    reads.filter((method) => method === 'read-project-tree').length,
    4,
    'refresh replays loaded pages with the new tree version',
  );
  entries = [entries[0]!, { path: 'newer.txt', type: 'file', size: 3 }, entries[1]!];
  await panel.refresh();
  assert.equal(
    panel.state!.tree!.result.entries.length,
    2,
    'refresh does not enumerate beyond the loaded range',
  );
  assert.equal(
    panel.state!.currentFile!.result.path,
    'a.txt',
    'a path shifted to a later page is still reverified by Host',
  );
  entries = entries.slice(0, 2);
  text = null;
  await panel.refresh();
  assert.equal(panel.state!.currentFile, undefined);
  assert.equal(panel.state!.currentUnavailable!.path, 'a.txt');
  assert.match(panel.state!.error!, /删除/);
  assert.deepEqual(
    panel.state!.tree!.result.entries.map((entry) => entry.path),
    ['new.txt', 'newer.txt'],
  );
  entries = [{ path: 'a.txt', type: 'file', size: 1024 * 1024 + 1 }];
  const fileReads = reads.filter((method) => method === 'file-content').length;
  await panel.refresh();
  assert.match(panel.state!.currentUnavailable!.message, /1 MiB/);
  assert.equal(panel.state!.currentFile, undefined);
  assert.equal(
    reads.filter((method) => method === 'file-content').length,
    fileReads,
    'known oversized files are not downloaded',
  );

  entries = [{ path: 'a.txt', type: 'file', size: 3 }];
  text = 'new';
  await panel.open('tree', [{ id: 'turn', label: 'turn', reference }]);
  await panel.file('a.txt', 3);

  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    fileStarted = resolve;
  });
  const pending = panel.refresh();
  assert.equal(
    panel.state!.currentFile,
    undefined,
    'unverified old bytes are not available to quote',
  );
  await started;
  await panel.setMode('changes');
  release!();
  await pending;
  assert.equal(panel.state!.mode, 'changes');
  assert.equal(panel.state!.currentFile, undefined);
  assert.equal(panel.state!.diff!.result.reference!.version, reference.version);
});

test('refresh keeps the selected frozen diff and rejects replacement versions or a changed scope', async () => {
  let generation = 0;
  let replaceVersion = false;
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const secondChange = {
    ...change,
    path: 'b.txt',
    before: { ...before, path: 'b.txt' },
    after: { ...after, path: 'b.txt' },
  };
  const selectedReference = { ...reference, changeCount: 2 };
  const panel = new ProjectContentController<ProjectContentTarget>({
    context: () => ({ target, online: true, generation }),
    parseTarget: (input) => input as ProjectContentTarget,
    contentTarget: (value) => value,
    cache: { read: async () => undefined, writeBatch: async () => {} },
    request: async (_target, method, params) => {
      if (method === 'read-turn-diff') {
        await gate;
        return {
          ...summary,
          reference: replaceVersion
            ? { ...selectedReference, version: hash('replacement') }
            : selectedReference,
          changes: [change, secondChange],
        };
      }
      assert.equal(method, 'read-diff-file');
      assert.equal((params as { path: string }).path, 'b.txt');
      return {
        ...diffFile,
        path: 'b.txt',
        reference: selectedReference,
        before: { ...diffFile.before!, path: 'b.txt' },
        after: { ...diffFile.after!, path: 'b.txt' },
      };
    },
  });
  await panel.open('changes', [{ id: 'turn', label: 'turn', reference: selectedReference }]);
  await panel.diffFile(secondChange);
  await panel.refresh();
  assert.equal(panel.state!.diffFile!.result.path, 'b.txt');
  assert.equal(panel.state!.diffFile!.result.reference.version, selectedReference.version);

  replaceVersion = true;
  await panel.refresh();
  assert.match(panel.state!.error!, /版本不匹配/);
  assert.equal(
    panel.state!.diffFile,
    undefined,
    'failed refresh exposes no old or replacement quote',
  );
  replaceVersion = false;
  await panel.open('changes', [{ id: 'turn', label: 'turn', reference: selectedReference }]);
  await panel.diffFile(secondChange);
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = panel.refresh();
  generation++;
  panel.sync();
  release!();
  await pending;
  assert.equal(panel.state, null, 'a refresh cannot resurrect content after navigation');
});
