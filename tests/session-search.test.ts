import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  SEARCH_LIMITS,
  searchEntrySchema,
  sessionSearchRequestSchema,
  sessionSearchResultSchema,
} from '../src/search-protocol';
import {
  SessionSearchIndex,
  SESSION_SEARCH_SCAN_SQL,
  sessionSearchDocument,
  type FrozenSearchDiff,
  type SearchScope,
} from '../src/runtime/session-search';

const scope: SearchScope = {
  workspaceId: 'workspace',
  userId: 'local:synthetic',
  machineId: 'machine',
  localProjectId: 'project',
  sessionId: 'session',
};
const document = (...texts: string[]) => ({
  partial: false,
  entries: texts.map((text, itemIndex) => ({
    turnId: 'turn',
    itemIndex,
    kind: 'message' as const,
    text,
  })),
});
function fixture(
  t: { after: (callback: () => unknown) => void },
  limits?: { candidates?: number; scanBytes?: number },
) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, index: new SessionSearchIndex(db, limits) };
}

test('SQLite host index handles Chinese substrings and punctuation as literal terms', (t) => {
  const { index } = fixture(t);
  index.replace(
    scope,
    document(
      '合成会话支持中文正文搜索，第二阶段完成',
      'literal foo OR bar value',
      'only foo value',
      'literal a*b plus a"b brackets [abc] percent 100% underscore _xyz_',
      'CaseInsensitive ABCDEFG',
    ),
  );
  for (const query of [
    '中文',
    '中文正',
    '正文 搜索',
    '中文\n第二',
    'foo OR bar',
    'a*b',
    'a"b',
    '[abc]',
    '100%',
    '_xyz_',
    'bcdef',
  ]) {
    const result = index.search(scope, query, 'session');
    assert.equal(result.hits.length, 1, query);
    assert.equal(result.partial, false, query);
  }
  assert.equal(index.search(scope, 'foo NOT bar', 'session').hits.length, 0);
  assert.equal(index.search(scope, '" OR 1=1 --', 'session').hits.length, 0);
  assert.equal(index.search(scope, '未命中', 'session').hits.length, 0);
});

test('search keeps account, device, execution workspace, project and session dimensions isolated', (t) => {
  const { index } = fixture(t);
  index.replace(scope, document('needle authorized current session'));
  index.replace(
    { ...scope, sessionId: 'neighbor' },
    document('needle authorized project neighbor'),
  );
  for (const [key, value] of [
    ['userId', 'other-user'],
    ['machineId', 'other-machine'],
    ['workspaceId', 'other-workspace'],
    ['localProjectId', 'other-project'],
  ] as const)
    index.replace(
      { ...scope, [key]: value },
      { ...document('needle forbidden ' + key), partial: true },
    );
  const own = index.search(scope, 'needle', 'session');
  assert.deepEqual(
    own.hits.map((hit) => hit.sessionId),
    ['session'],
  );
  assert.equal(own.partial, false);
  const project = index.search(scope, 'needle', 'project');
  assert.deepEqual(
    new Set(project.hits.map((hit) => hit.sessionId)),
    new Set(['session', 'neighbor']),
  );
  assert.equal(project.partial, false);
  assert.equal(JSON.stringify(project).includes('forbidden'), false);
  assert.equal(
    index.search({ ...scope, sessionId: 'missing' }, 'needle', 'session').hits.length,
    0,
  );
});

test('runtime scope, range, result limit and query validation cannot broaden malformed requests', (t) => {
  const { index } = fixture(t);
  index.replace(scope, document('needle'));
  for (const range of ['', 'all', undefined, null])
    assert.throws(() => index.search(scope, 'needle', range as any));
  for (const query of ['', ' ', 'x'.repeat(SEARCH_LIMITS.query + 1), 'x\0y'])
    assert.throws(() => index.search(scope, query, 'session'));
  for (const limit of [0, -1, 1.5, Infinity, SEARCH_LIMITS.results + 1])
    assert.throws(() => index.search(scope, 'needle', 'session', limit));
  for (const key of Object.keys(scope))
    assert.throws(() => index.search({ ...scope, [key]: '' }, 'needle', 'project'));
  assert.throws(() => index.search({ ...scope, unexpected: 'data' } as any, 'needle', 'session'));
  assert.throws(
    () => new SessionSearchIndex(fixture(t).db, { candidates: SEARCH_LIMITS.candidates + 1 }),
  );
  const parsed = sessionSearchRequestSchema.parse({
    searchVersion: 1,
    workspaceId: scope.workspaceId,
    localProjectId: scope.localProjectId,
    sessionId: scope.sessionId,
    scope: 'session',
    query: '  needle  ',
  });
  assert.equal(parsed.query, 'needle');
  assert.equal(parsed.limit, 30);
});

test('revoked session candidates are excluded before result and scan limits', (t) => {
  const { index } = fixture(t, { candidates: 1 });
  index.replace(scope, document('needle authorized'));
  index.replace(
    { ...scope, sessionId: 'revoked' },
    { ...document('needle revoked'), partial: true },
  );
  for (const query of ['needle', 'ne']) {
    const result = index.search(scope, query, 'project', 1, [scope.sessionId]);
    assert.deepEqual(
      result.hits.map((hit) => hit.sessionId),
      [scope.sessionId],
    );
    assert.equal(result.partial, false);
    assert.equal(result.more, false);
  }
  assert.deepEqual(index.search(scope, 'needle', 'project', 1, []), {
    hits: [],
    more: false,
    partial: false,
  });
});

test('projection indexes visible messages, tool text and diff while excluding raw payloads and attachment data', () => {
  const projected = sessionSearchDocument([
    {
      id: 'turn',
      privateMetadata: 'private-marker',
      inputConfig: { secret: 'private-marker' },
      items: [
        { type: 'text', text: 'Visible message', _meta: { private: 'private-marker' } },
        { type: 'thought', text: 'Visible thought' },
        { type: 'attachment', data: 'cHJpdmF0ZS1tYXJrZXI=' },
        {
          type: 'tool_call',
          title: 'Visible tool',
          rawInput: 'private-marker',
          rawOutput: 'private-marker',
          content: [
            { type: 'content', content: { type: 'text', text: 'Visible output' } },
            { type: 'content', content: { type: 'image', data: 'cHJpdmF0ZS1tYXJrZXI=' } },
            {
              type: 'content',
              content: { type: 'resource', resource: { blob: 'cHJpdmF0ZS1tYXJrZXI=' } },
            },
            {
              type: 'diff',
              path: 'src/example.ts',
              oldText: 'old value',
              newText: 'new value',
              _meta: { private: 'private-marker' },
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(
    projected.entries.map((entry) => entry.kind),
    ['message', 'message', 'tool', 'tool', 'diff'],
  );
  assert.equal(projected.partial, false);
  assert.equal(JSON.stringify(projected).includes('private-marker'), false);
  assert.equal(JSON.stringify(projected).includes('cHJpdmF0ZS1tYXJrZXI='), false);
  assert.equal(projected.entries.at(-1)?.text, 'src/example.ts\nold value\nnew value');
});

test('typed frozen snapshot diffs index saved paths and text without reading files or binary bytes', (t) => {
  const { index } = fixture(t);
  const file = (path: string, text: string) => ({
    path,
    size: Buffer.byteLength(text),
    state: 'text' as const,
    text,
    metadataVersion: 'synthetic-version',
  });
  const frozen: FrozenSearchDiff = {
    frozen: true,
    turnId: 'turn',
    itemIndex: 0,
    diff: {
      version: 1,
      basis: 'project-snapshot',
      partial: false,
      issues: [],
      changes: [
        {
          path: 'renamed.ts',
          previousPath: 'original.ts',
          kind: 'renamed',
          before: file('original.ts', 'frozen old baseline'),
          after: file('renamed.ts', 'frozen saved result'),
        },
        {
          path: 'removed.ts',
          kind: 'deleted',
          before: file('removed.ts', 'deleted baseline'),
          after: null,
        },
        {
          path: 'binary.bin',
          kind: 'added',
          before: null,
          after: { ...file('binary.bin', 'private-binary-marker'), state: 'binary' },
        },
      ],
    },
  };
  const projected = sessionSearchDocument([], [frozen]);
  index.replace(scope, projected);
  assert.equal(index.search(scope, 'frozen saved', 'session').hits[0]?.path, 'renamed.ts');
  assert.equal(index.search(scope, 'original.ts', 'session').hits[0]?.path, 'renamed.ts');
  assert.equal(index.search(scope, 'deleted baseline', 'session').hits[0]?.path, 'removed.ts');
  assert.equal(index.search(scope, 'private-binary-marker', 'session').hits.length, 0);
  frozen.diff.changes[0].after!.text = 'subsequent edit';
  assert.equal(index.search(scope, 'frozen saved', 'session').hits.length, 1);
  assert.equal(index.search(scope, 'subsequent edit', 'session').hits.length, 0);
  assert.equal(sessionSearchDocument([], [{ ...frozen, frozen: false } as any]).partial, true);
  assert.equal(
    sessionSearchDocument([], [{ ...frozen, diff: { ...frozen.diff, partial: true } }]).partial,
    true,
  );
  const invalid = {
    ...frozen,
    diff: { ...frozen.diff, changes: [{ ...frozen.diff.changes[0], path: '../outside' }] },
  };
  assert.deepEqual(sessionSearchDocument([], [invalid]), { entries: [], partial: true });
});

test('projection bounds text, entry count and UTF-8 document bytes and reports partial coverage', () => {
  const long = sessionSearchDocument([
    { id: 'turn', items: [{ type: 'text', text: 'x'.repeat(SEARCH_LIMITS.text - 1) + '😀tail' }] },
  ]);
  assert.equal(long.partial, true);
  assert.equal(Buffer.from(long.entries[0].text).toString('utf8'), long.entries[0].text);
  assert.ok(long.entries[0].text.length <= SEARCH_LIMITS.text);
  const many = sessionSearchDocument([
    {
      id: 'turn',
      items: Array.from({ length: SEARCH_LIMITS.entries + 1 }, () => ({
        type: 'text',
        text: 'Synthetic',
      })),
    },
  ]);
  assert.equal(many.entries.length, SEARCH_LIMITS.entries);
  assert.equal(many.partial, true);
  const wide = sessionSearchDocument([
    {
      id: 'turn',
      items: Array.from({ length: 150 }, () => ({
        type: 'text',
        text: 'x'.repeat(SEARCH_LIMITS.text),
      })),
    },
  ]);
  assert.equal(wide.partial, true);
  assert.ok(
    wide.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0) <=
      SEARCH_LIMITS.documentBytes,
  );
});

test('bounded short-term candidates and byte scans report partial instead of unbounded traversal', (t) => {
  const f = fixture(t, { candidates: 3 });
  f.index.replace(
    scope,
    document('针 hidden oldest', 'newest a', 'newest b', 'newest c', 'newest d'),
  );
  assert.deepEqual(f.index.search(scope, '针', 'session'), {
    hits: [],
    more: false,
    partial: true,
  });
  const g = fixture(t, { scanBytes: 30 });
  g.index.replace(scope, document('needle hidden oldest', 'x'.repeat(31)));
  assert.deepEqual(g.index.search(scope, '针', 'session'), {
    hits: [],
    more: false,
    partial: true,
  });
  const h = fixture(t);
  h.index.replace(scope, document('needle one', 'needle two', 'needle three'));
  const limited = h.index.search(scope, 'needle', 'session', 2);
  assert.equal(limited.hits.length, 2);
  assert.equal(limited.more, true);
  assert.equal(limited.partial, false);
});

test('long nonmatching queries are bounded before matching and preserve authorized session order', (t) => {
  const { index } = fixture(t, { candidates: 3 });
  index.replace(
    scope,
    document(
      'needle oldest',
      'unrelated first',
      'unrelated second',
      'unrelated third',
      'unrelated newest',
    ),
  );
  const result = index.search(scope, 'needle', 'session');
  assert.deepEqual(result, { hits: [], more: false, partial: true });
  index.replace({ ...scope, sessionId: 'neighbor' }, document('needle neighbor'));
  assert.deepEqual(index.search(scope, 'needle', 'project', 30, ['session', 'neighbor']), result);
  const prioritized = index.search(scope, 'needle', 'project', 30, ['neighbor', 'session']);
  assert.deepEqual(
    prioritized.hits.map((hit) => hit.sessionId),
    ['neighbor'],
  );
  assert.equal(prioritized.partial, true);
});

test('scoped bounded SQL scans use the scope index without a global sort or temporary B-tree', (t) => {
  const { db, index } = fixture(t);
  for (const sessionId of ['session', 'neighbor'])
    index.replace({ ...scope, sessionId }, document('one', 'two', 'three'));
  const plan = db
    .prepare('EXPLAIN QUERY PLAN ' + SESSION_SEARCH_SCAN_SQL)
    .all(scope.workspaceId, scope.userId, scope.machineId, scope.localProjectId, scope.sessionId, 4)
    .map((row) => String(row.detail))
    .join('\n');
  assert.match(plan, /SEARCH search_entry USING INDEX search_scope.*session_id=/u);
  assert.doesNotMatch(plan, /TEMP B-TREE|SCAN search_entry/u);
  assert.deepEqual(
    index.search(scope, 'e', 'session').hits.map((hit) => hit.itemIndex),
    [2, 0],
  );
});

test('Unicode excerpt boundaries preserve original text and transport limits', (t) => {
  const { index } = fixture(t);
  const text = '😀'.repeat(150) + ' needle ' + '😀'.repeat(500);
  index.replace(scope, document(text));
  const result = index.search(scope, 'needle', 'session');
  assert.equal(result.hits.length, 1);
  assert.ok(result.hits[0].excerpt.includes('needle'));
  assert.equal(Buffer.from(result.hits[0].excerpt).toString('utf8'), result.hits[0].excerpt);
  assert.ok(result.hits[0].excerpt.length <= 1000);
  index.replace(scope, document('İ'.repeat(400) + 'needle' + '😀'.repeat(400)));
  assert.ok(index.search(scope, 'needle', 'session').hits[0].excerpt.includes('needle'));
  const { userId: _, machineId: __, ...context } = scope;
  sessionSearchResultSchema.parse({
    ...context,
    searchVersion: 1,
    scope: 'session',
    query: 'needle',
    confirmed: true,
    source: 'host-index',
    ...index.search(scope, 'needle', 'session'),
  });
});

test('replacement removes old content and nested caller rollback restores the complete old index', (t) => {
  const { db, index } = fixture(t);
  index.replace(scope, { ...document('old frozen text'), partial: true });
  db.exec('BEGIN');
  index.replace(scope, document('temporary replacement'));
  db.exec('ROLLBACK');
  assert.equal(index.search(scope, 'old frozen', 'session').hits.length, 1);
  assert.equal(index.search(scope, 'old frozen', 'session').partial, true);
  assert.equal(index.search(scope, 'temporary', 'session').hits.length, 0);
  index.replace(scope, document('new committed text'));
  assert.equal(index.search(scope, 'old frozen', 'session').hits.length, 0);
  assert.equal(index.search(scope, 'new committed', 'session').hits.length, 1);
  assert.equal(index.search(scope, 'new committed', 'session').partial, false);
  index.replace(scope, document());
  assert.equal(index.search(scope, 'new committed', 'session').hits.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_text').get()!.n, 0);
});

test('mid-replacement failure rolls back entries and FTS bodies even without an outer transaction', (t) => {
  const { db, index } = fixture(t);
  index.replace(scope, document('old persistent index'));
  db.exec(
    "CREATE TRIGGER search_test_failure BEFORE INSERT ON search_entry WHEN NEW.item_index=1 BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END",
  );
  assert.throws(
    () => index.replace(scope, document('new uncommitted first', 'new uncommitted second')),
    /synthetic write failure/,
  );
  assert.equal(index.search(scope, 'old persistent', 'session').hits.length, 1);
  assert.equal(index.search(scope, 'new uncommitted', 'session').hits.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_text').get()!.n, 1);
  assert.throws(() =>
    index.replace(scope, {
      ...document('invalid'),
      entries: [{ ...document('invalid').entries[0], itemIndex: Number.MAX_SAFE_INTEGER + 1 }],
    }),
  );
  assert.equal(index.search(scope, 'old persistent', 'session').hits.length, 1);
  assert.throws(() => searchEntrySchema.parse({ ...document('x').entries[0], path: '../outside' }));
});

test('host index uses the same Unicode fold as offline literal matching and preserves original excerpts', (t) => {
  const { index } = fixture(t);
  index.replace(scope, document('İabc Ελληνικά 中文'));
  for (const query of ['i\u0307ab', 'İAB', 'ΕΛΛΗΝ', '中文']) {
    const result = index.search(scope, query, 'session');
    assert.equal(result.hits.length, 1, query);
    assert.equal(result.hits[0].excerpt, 'İabc Ελληνικά 中文');
    assert.equal(result.partial, false);
  }
});

test('earlier preview index upgrades discard only derived search data and allow rebuilding', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,snapshot TEXT);
    INSERT INTO session VALUES('original','synthetic source');
    CREATE TABLE search_entry(id INTEGER PRIMARY KEY,workspace_id TEXT,user_id TEXT,machine_id TEXT,project_id TEXT,session_id TEXT,turn_id TEXT,item_index INTEGER,kind TEXT,path TEXT);
    CREATE VIRTUAL TABLE search_text USING fts5(body,tokenize='trigram');
    INSERT INTO search_text(rowid,body) VALUES(1,'old derived text');`);
  const index = new SessionSearchIndex(db);
  assert.equal(db.prepare('SELECT snapshot FROM session').get()!.snapshot, 'synthetic source');
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_text').get()!.n, 0);
  index.replace(scope, document('İabc'));
  assert.equal(index.search(scope, 'i\u0307ab', 'session').hits.length, 1);
});
