import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown, renderItem, renderFileChanges } from '../../apps/web/src/components/content';
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
