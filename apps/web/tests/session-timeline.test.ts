import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionTimeline,
  SessionInformation,
  hasTurnFileChanges,
  type TimelineTurn,
} from '../src/features/sessions/session-timeline';
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
test('shared timeline retains actionable records and share plain text, collapsed tools and separate information', () => {
  {
    const html = renderToStaticMarkup(
      createElement(SessionTimeline, {
        history: [turn],
        renderItem: (item: any) => createElement('p', null, item.title),
      }),
    );
    assert.match(html, /<strong>正文<\/strong>/);
    assert.doesNotMatch(html, /context-usage|用量/);
    assert.match(html, /<details class="session-tool-details">/);
    assert.match(html, /<span>工具与思考<\/span><span class="session-tool-count">1<\/span>/);
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
test('tool disclosures preserve transcript order and keep active work outside collapsed groups', () => {
  const html = renderToStaticMarkup(
    createElement(SessionTimeline, {
      history: [
        {
          ...turn,
          finished: false,
          items: [
            { type: 'text', text: 'before operation' },
            { type: 'tool_call', title: 'read synthetic file', status: 'completed' },
            { type: 'text', text: 'after operation' },
            { type: 'tool_call', title: 'check synthetic file', status: 'completed' },
            { type: 'tool_call', title: 'running synthetic check', status: 'in_progress' },
            { type: 'tool_call', title: 'waiting synthetic approval', permissionRequest: {} },
            { type: 'tool_call', title: 'failed synthetic check', status: 'failed' },
          ],
        },
      ],
      renderItem: (item: any) => createElement('p', null, item.title),
    }),
  );
  assert.ok(html.indexOf('before operation') < html.indexOf('read synthetic file'));
  assert.ok(html.indexOf('read synthetic file') < html.indexOf('after operation'));
  assert.ok(html.indexOf('after operation') < html.indexOf('check synthetic file'));
  const disclosures = [...html.matchAll(/<details class="session-tool-details">.*?<\/details>/g)];
  assert.equal(disclosures.length, 2);
  for (const [details] of disclosures)
    assert.doesNotMatch(details, /running synthetic|waiting synthetic|failed synthetic/);
  assert.match(html, /正在执行/);
  assert.match(html, /执行失败/);
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
