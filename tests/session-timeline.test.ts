import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionTimeline,
  SessionInformation,
  hasTurnFileChanges,
  type TimelineTurn,
} from '../src/web/session-timeline';
const event = {
  type: 'session_event',
  event: { version: 1, source: 'acp', kind: 'context-usage', used: 10, size: 100 },
};
const turn: TimelineTurn = {
  id: 'turn',
  role: 'assistant',
  finished: true,
  items: [
    { type: 'text', text: '**正文**' },
    event,
    { type: 'tool_call', title: 'ordinary tool' },
    { type: 'tool_call', title: 'approval required', permissionRequest: { requestId: 'request' } },
    { type: 'tool_call', title: 'failed tool', status: 'failed' },
  ],
};
test('both timelines retain actionable records and share plain text, collapsed tools and separate information', () => {
  for (const variant of ['workspace', 'secure'] as const) {
    const html = renderToStaticMarkup(
      createElement(SessionTimeline, {
        history: [turn],
        variant,
        renderItem: (item: any) => createElement('p', null, item.title),
      }),
    );
    assert.match(html, /<strong>正文<\/strong>/);
    assert.doesNotMatch(html, /context-usage|用量/);
    assert.match(html, /<details class="session-tool-details"><summary>工具与思考 · 1<\/summary>/);
    assert.match(html, /approval required/);
    assert.match(html, /failed tool/);
    const tools = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
    assert.doesNotMatch(tools, /approval required|failed tool/);
  }
  const html = renderToStaticMarkup(
    createElement(SessionInformation, { history: [turn], disabled: false, onCommand: () => {} }),
  );
  assert.match(html, /10/);
  assert.match(html, /未提供/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});
test('turn changes need a matching saved reference and positive count; unknown or empty results never create a diff action', () => {
  const fileDiff = {
    contentVersion: 1,
    basis: 'project-snapshot',
    turnId: 'turn',
    diffId: 'diff',
    state: 'ready',
    version: 'sha256:' + 'a'.repeat(64),
    changeCount: 1,
  };
  assert.equal(hasTurnFileChanges({ ...turn, fileDiff }), true);
  assert.equal(hasTurnFileChanges({ ...turn, fileDiff: { ...fileDiff, state: 'partial' } }), true);
  for (const value of [
    null,
    { ...fileDiff, turnId: 'other' },
    { ...fileDiff, changeCount: 0 },
    { ...fileDiff, state: 'unavailable' },
    { ...fileDiff, state: 'pending', version: undefined, changeCount: 0 },
  ])
    assert.equal(hasTurnFileChanges({ ...turn, fileDiff: value }), false);
});
