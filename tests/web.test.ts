import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSessions,
  filterCatalogSessions,
  resolveSelection,
  type Device,
  type SessionSummary,
} from '../src/web/navigation';
import type { Workspace } from '../src/catalog';
import { markdown, renderItem, renderFileChanges } from '../src/web/content';
const workspace = {
  id: 'work-b',
  name: 'Research',
  userId: 'synthetic',
  machineId: 'host-b',
  projects: [
    { id: 'p1', name: 'Web API', rootPath: '/synthetic/api' },
    { id: 'p2', name: 'UI', rootPath: '/synthetic/ui' },
  ],
  agents: [],
};
const devices: Device[] = [
  { id: 'a', name: 'A', online: true, workspaces: [{ ...workspace, id: 'work-a' }] },
  {
    id: 'b',
    name: 'B',
    online: false,
    workspaces: [{ ...workspace, id: 'work-first' }, workspace],
  },
];
test('restore the exact offline device and second workspace without falling back to another host', () => {
  const saved = {
    deviceId: 'b',
    workspaceId: 'work-b',
    sessionId: 'session-b',
    projectId: 'p1',
    search: 'API',
  };
  const selection = resolveSelection(devices, saved)!;
  assert.equal(selection.device.id, 'b');
  assert.equal(selection.workspace.id, 'work-b');
  assert.equal(selection.sessionId, 'session-b');
  assert.equal(selection.device.online, false);
  assert.equal(selection.projectId, 'p1');
  assert.equal(
    resolveSelection(
      devices.filter((d) => d.id !== 'b'),
      saved,
    ),
    undefined,
  );
  const changed = resolveSelection(devices, {
    ...saved,
    workspaceId: 'removed',
    projectId: 'removed',
  })!;
  assert.equal(changed.sessionId, '');
  assert.equal(changed.projectId, '');
  assert.equal(changed.search, '');
});
test('search combines words and project names, filters by project and sorts by recent activity', () => {
  const list = [
    { id: 'old', title: 'Fix timeout', lastMessageAt: 1, project: { localProjectId: 'p1' } },
    { id: 'recent', title: 'Fix auth', lastMessageAt: 5, project: { localProjectId: 'p1' } },
    { id: 'ui', title: 'Fix auth', lastMessageAt: 10, project: { localProjectId: 'p2' } },
    { id: 'archived', title: 'Fix auth', isArchived: true, project: { localProjectId: 'p1' } },
  ];
  assert.deepEqual(
    filterSessions(list, workspace, 'fix API', 'p1').map((s) => s.id),
    ['recent', 'old'],
  );
  assert.deepEqual(
    filterSessions(list, workspace, 'no match', '').map((s) => s.id),
    [],
  );
  assert.deepEqual(
    list.map((s) => s.id),
    ['old', 'recent', 'ui', 'archived'],
    'sorting must not mutate the shared cached catalogue',
  );
});
test('catalog filtering separates archives and orders pins with deterministic replica ties', () => {
  const catalog = {
    projects: [
      { id: 'p1', name: 'Web API' },
      { id: 'p2', name: 'Mobile' },
    ],
  } as Workspace;
  const list: SessionSummary[] = [
    { id: 'recent', title: 'Fix auth', projectId: 'p1', lastMessageAt: 50, deviceName: 'Mac' },
    {
      id: 'pinned-old',
      title: 'Fix timeout',
      projectId: 'p1',
      lastMessageAt: 1,
      isPinned: true,
      deviceName: 'Mac',
    },
    {
      id: 'pinned-new',
      title: 'Fix auth',
      projectId: 'p1',
      lastMessageAt: 10,
      isPinned: true,
      deviceName: 'Mac',
    },
    {
      id: 'archive',
      title: 'Fix docs',
      projectId: 'p1',
      lastMessageAt: 100,
      isArchived: true,
      deviceName: 'Mac',
    },
    { id: 'other', title: 'Fix auth', projectId: 'p2', lastMessageAt: 200, isPinned: true },
    { id: 'tie', replicaId: 'b', projectId: 'p1', lastMessageAt: 2 },
    { id: 'tie', replicaId: 'a', projectId: 'p1', lastMessageAt: 2 },
  ];
  const before = structuredClone(list);
  assert.deepEqual(
    filterCatalogSessions(list, catalog, 'API fix mac', 'p1').map((s) => s.id),
    ['pinned-new', 'pinned-old', 'recent'],
  );
  assert.deepEqual(
    filterCatalogSessions(list, catalog, 'API fix', 'p1', true).map((s) => s.id),
    ['archive'],
  );
  assert.deepEqual(
    filterCatalogSessions(list, catalog, '', 'p1')
      .filter((s) => s.id === 'tie')
      .map((s) => s.replicaId),
    ['a', 'b'],
  );
  assert.deepEqual(filterCatalogSessions(list, catalog, 'Mobile', '', true), []);
  assert.deepEqual(list, before, 'filters and pinned sorting preserve the shared host cache');
});
test('Markdown makes code readable while HTML, scripts and unsafe links stay inert', () => {
  const html = markdown(
    '# Result\n\n**Done** and `x < y`\n\n```ts\nconst value = "<script>alert(1)</script>";\n```\n\n[unsafe](javascript:alert) [docs](https://example.com/docs?q="bad")\n<img src=x onerror=alert(1)>\n![image](https://example.com/pixel.png)',
  );
  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /<strong>Done<\/strong>/);
  assert.match(html, /data-copy/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:|onerror="/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /q=&quot;bad&quot;/);
  assert.match(
    markdown('```js\npartial <output'),
    /partial &lt;output/,
    'unfinished streaming code fences remain readable',
  );
});
test('tool output includes command, terminal exit status and diff while preserving exact permission identifiers', () => {
  const html = renderItem(
    {
      type: 'tool_call',
      title: 'Run checks',
      status: 'in_progress',
      content: [
        { type: 'terminal_command', command: 'pnpm', args: ['test'], cwd: '/synthetic' },
        {
          type: 'terminal_output',
          output: '\x1b[31m<script>\x1b[0m\nfailed',
          stream: 'stderr',
          exitStatus: { exitCode: 1 },
        },
        { type: 'diff', path: 'app.ts', oldText: 'false', newText: 'true' },
      ],
      permissionRequest: {
        requestId: 'request"1',
        options: [{ optionId: 'once', name: 'Allow once' }],
      },
    },
    false,
    'turn/tool',
  );
  assert.match(html, /pnpm test/);
  assert.match(html, /退出码 1/);
  assert.match(html, /修改前/);
  assert.match(html, /修改后/);
  assert.match(html, /data-permission="request&quot;1"/);
  assert.doesNotMatch(html, /\x1b|<script>/);
  assert.doesNotMatch(
    renderItem(
      { type: 'tool_call', permissionRequest: { requestId: 'old', options: [] } },
      true,
      'old',
    ),
    /data-permission/,
  );
});
test('runtime failure and warning metadata remain visible and escaped', () => {
  for (const name of ['chat_failed', 'agent_warning']) {
    const html = renderItem(
      { type: 'system_notice', name, meta: { message: '<script>upgrade Codex</script>' } },
      true,
      'notice',
    );
    assert.match(html, /upgrade Codex/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  }
});
test('file change summary exposes paths and counts rather than CRDT internals', () => {
  const html = renderFileChanges(
    [{ filePath: 'src/main.ts', add: 3, del: 1, cc: { fileId: 'private-internal-id' } }],
    'files',
  );
  assert.match(html, /src\/main.ts/);
  assert.match(html, /\+3/);
  assert.doesNotMatch(html, /private-internal-id/);
});
