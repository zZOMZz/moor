import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../../apps/web/src/components/content';
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
