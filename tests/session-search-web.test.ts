import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { searchSessionContent, type SearchDependencies } from '../src/web/session-search';
import {
  projectContentKey,
  readProjectTurnDiff,
  readProjectDiffFile,
  type ProjectContentTarget,
} from '../src/web/project-content';
import type { ProjectDiffReference, ProjectDiffChange } from '../src/project-content-protocol';

const target: ProjectContentTarget = {
  owner: 'owner',
  deviceId: 'device',
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const sessions = [
  { id: 'session', title: 'One' },
  { id: 'second', title: 'Two' },
];
const scope = {
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  sessionId: target.sessionId,
};
const hash = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
function fixture() {
  const cache = new Map<string, unknown>(),
    histories = new Map<string, readonly any[]>();
  let request: SearchDependencies['request'] = async () => assert.fail('unexpected host request');
  const reads: ProjectContentTarget[] = [];
  const deps: SearchDependencies = {
    read: async (key) => structuredClone(cache.get(key)),
    write: async (key, value) => {
      cache.set(key, structuredClone(value));
    },
    readHistory: async (scope) => {
      reads.push(scope);
      return histories.get(projectContentKey(scope));
    },
    request: (path, body) => request(path, body),
  };
  return {
    cache,
    histories,
    deps,
    reads,
    respond: (callback: typeof request) => {
      request = callback;
    },
  };
}
const history = [
  {
    id: 'turn',
    items: [
      { type: 'text', text: '中文 Needle İSTANBUL <script> synthetic' },
      {
        type: 'tool_call',
        title: 'Tool',
        rawInput: { secret: 'excluded-token' },
        rawOutput: 'excluded-token',
        content: [{ type: 'content', content: { type: 'text', text: 'tool needle' } }],
      },
      { type: 'attachment', data: 'excluded-token' },
    ],
  },
];

test('online search validates exact context/query/range and does not fall back after host failure', async () => {
  const f = fixture();
  const result = {
    ...scope,
    searchVersion: 1,
    confirmed: true,
    source: 'host-index',
    scope: 'session',
    query: 'needle',
    hits: [
      { sessionId: 'session', turnId: 'turn', itemIndex: 0, kind: 'message', excerpt: 'needle' },
    ],
    more: false,
    partial: false,
  };
  f.respond(async (path, body) => {
    assert.equal(path, '/api/workspaces/catalog/replicas/replica/session-search');
    assert.deepEqual(body, {
      ...scope,
      searchVersion: 1,
      query: 'needle',
      scope: 'session',
      limit: 30,
    });
    return result;
  });
  assert.equal(
    (
      await searchSessionContent(
        target,
        { query: ' needle ', scope: 'session' },
        true,
        sessions,
        f.deps,
      )
    ).source,
    'host-index',
  );
  for (const patch of [
    { workspaceId: 'other' },
    { localProjectId: 'other' },
    { sessionId: 'other' },
    { query: 'other' },
    { scope: 'project' },
    { hits: [{ ...result.hits[0], sessionId: 'second' }] },
  ]) {
    f.respond(async () => ({ ...result, ...patch }));
    await assert.rejects(
      searchSessionContent(target, { query: 'needle', scope: 'session' }, true, sessions, f.deps),
      /不匹配/,
    );
  }
  f.respond(async () => {
    throw new Error('permission revoked');
  });
  f.histories.set(projectContentKey(target), history);
  await assert.rejects(
    searchSessionContent(target, { query: 'needle', scope: 'session' }, true, sessions, f.deps),
    /permission revoked/,
  );
  assert.equal(f.reads.length, 0);
  assert.equal(f.cache.size, 0, 'online search does not cache query results as an offline index');
});

test('offline queries search only the supplied authorized cached histories with explicit coverage', async () => {
  const f = fixture();
  f.histories.set(projectContentKey(target), history);
  f.histories.set(projectContentKey({ ...target, sessionId: 'foreign' }), history);
  let result = await searchSessionContent(
    target,
    { query: 'needle', scope: 'project' },
    false,
    sessions,
    f.deps,
  );
  assert.equal(result.source, 'cache');
  assert.equal(result.partial, true);
  assert.deepEqual(result.coverage, { cachedSessions: 1, knownSessions: 2, cachedDiffFiles: 0 });
  assert.equal(result.hits.length, 2);
  assert(result.hits.every((hit) => hit.sessionId === 'session'));
  assert.deepEqual(
    f.reads.map((value) => value.sessionId),
    ['session', 'second'],
  );
  result = await searchSessionContent(
    target,
    { query: 'excluded-token', scope: 'session' },
    false,
    sessions,
    f.deps,
  );
  assert.deepEqual(result.hits, []);
  assert.equal(result.partial, false);
  result = await searchSessionContent(
    target,
    { query: 'İSTANBUL', scope: 'session' },
    false,
    sessions,
    f.deps,
  );
  assert(result.hits[0].excerpt.includes('İSTANBUL'));
  for (const field of ['owner', 'deviceId', 'workspaceId', 'localProjectId'] as const) {
    result = await searchSessionContent(
      { ...target, [field]: 'other' },
      { query: 'needle', scope: 'session' },
      false,
      sessions,
      f.deps,
    );
    assert.equal(result.coverage!.cachedSessions, 0);
    assert.equal(result.hits.length, 0);
  }
});

test('offline diff search reads only validated frozen cached versions, never current project files', async () => {
  const f = fixture();
  const ref: ProjectDiffReference = {
    contentVersion: 1,
    basis: 'project-snapshot',
    turnId: 'turn',
    diffId: 'diff',
    state: 'ready',
    version: hash('diff'),
    changeCount: 1,
  };
  const before = {
    path: 'a.txt',
    state: 'text' as const,
    size: 3,
    version: hash('old'),
    mediaType: 'text/plain' as const,
  };
  const after = { ...before, version: hash('new') };
  const change: ProjectDiffChange = { path: 'a.txt', kind: 'modified', before, after };
  const base = {
    ...scope,
    contentVersion: 1,
    confirmed: true,
    turnId: 'turn',
    reference: ref,
    partial: false,
    issues: [],
    attribution: 'shared-project',
  };
  f.histories.set(projectContentKey(target), [{ id: 'turn', items: [], fileDiff: ref }]);
  f.respond(async (path) =>
    path.endsWith('turn-diff')
      ? { ...base, state: 'ready', changes: [change] }
      : {
          ...base,
          path: 'a.txt',
          before: { ...before, text: 'old' },
          after: { ...after, text: 'new' },
        },
  );
  await readProjectTurnDiff(target, 'turn', true, f.deps, ref);
  await readProjectDiffFile(target, ref, change, true, f.deps);
  f.respond(async () => assert.fail('offline search contacted host'));
  const result = await searchSessionContent(
    target,
    { query: 'old', scope: 'session' },
    false,
    sessions,
    f.deps,
  );
  assert.deepEqual(
    result.hits.map((hit) => [hit.kind, hit.path, hit.turnId]),
    [['diff', 'a.txt', 'turn']],
  );
  assert.equal(result.coverage!.cachedDiffFiles, 1);
  assert.equal(result.partial, false);
  const fileKey = projectContentKey(target, 'diff-file', 'turn', ref.version!, 'a.txt');
  const corrupt: any = f.cache.get(fileKey);
  corrupt.before.text = 'bad';
  f.cache.set(fileKey, corrupt);
  const rejected = await searchSessionContent(
    target,
    { query: 'bad', scope: 'session' },
    false,
    sessions,
    f.deps,
  );
  assert.equal(rejected.hits.length, 0);
  assert.equal(rejected.partial, true);
  f.histories.set(projectContentKey(target), [
    { id: 'turn', items: [], fileDiff: { ...ref, version: hash('next diff') } },
  ]);
  assert.equal(
    (
      await searchSessionContent(
        target,
        { query: 'old', scope: 'session' },
        false,
        sessions,
        f.deps,
      )
    ).hits.length,
    0,
  );
});

test('offline result and session budgets remain bounded and mark partial coverage', async () => {
  const f = fixture();
  f.histories.set(projectContentKey(target), history);
  const limited = await searchSessionContent(
    target,
    { query: 'needle', scope: 'session', limit: 1 },
    false,
    sessions,
    f.deps,
  );
  assert.equal(limited.hits.length, 1);
  assert.equal(limited.more, true);
  const large = Array.from({ length: 102 }, (_, i) => ({ id: `session-${i}`, title: 'Synthetic' }));
  const result = await searchSessionContent(
    target,
    { query: 'needle', scope: 'project' },
    false,
    large,
    f.deps,
  );
  assert.equal(result.partial, true);
  assert.equal(result.coverage!.knownSessions, 102);
  assert.equal(f.reads.length, 101);
});

test('offline diff traversal truncation reports incomplete coverage even for empty message histories', async () => {
  const f = fixture();
  f.histories.set(
    projectContentKey(target),
    Array.from({ length: 2001 }, (_, i) => ({ id: `turn-${i}`, items: [] })),
  );
  const result = await searchSessionContent(
    target,
    { query: 'needle', scope: 'session' },
    false,
    sessions,
    f.deps,
  );
  assert.equal(result.partial, true);
});
