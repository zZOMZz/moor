import test from 'node:test';
import assert from 'node:assert/strict';
import { Flock, LoroDoc, delta, decode, mirror, putMeta, vv } from '@moor/session/model';
import { appendSessionText } from '@moor/session/session-output';
import {
  buildSessionPermission,
  ClientSessionReplica,
  readClientSession,
  sessionPermissionReviews,
} from '@moor/client/session-client';
import { validateMutation } from '@moor/host/commands/validate-mutation';
import { buildRespondPermission } from '@moor/client/session-intent';
import { prepareSessionIntent } from '@moor/host/commands/prepare-session-intent';

const scope = {
  userId: 'owner',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
};
const agent = { id: 'agent', name: 'Synthetic', cliType: 'custom', agentType: 'synthetic' };
const workspace = {
  id: scope.workspaceId,
  name: 'Synthetic',
  userId: scope.userId,
  machineId: scope.machineId,
  projects: [{ id: scope.localProjectId, name: 'Project', rootPath: '/synthetic' }],
  agents: [agent],
};
function fixture(change?: (state: any) => void) {
  const doc = new LoroDoc(),
    flock = new Flock(),
    view = mirror(doc, scope.sessionId);
  const meta = {
    id: scope.sessionId,
    userId: scope.userId,
    machineId: scope.machineId,
    project: { kind: 'local', localProjectId: scope.localProjectId },
    agentConfigId: agent.id,
    cliType: agent.cliType,
    agentType: agent.agentType,
    latestUserMsgId: 'user-turn',
    lastHandledUserMsgId: 'user-turn',
    status: { type: 'working' },
    isArchived: false,
  };
  view.setState((state) => {
    state.session.id = scope.sessionId;
    state.history.push({
      id: 'user-turn',
      role: 'user',
      userId: scope.userId,
      userTurnId: undefined,
      status: undefined,
      read: undefined,
      inputConfig: undefined,
      fileDiff: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      finished: true,
      items: [{ type: 'text', text: 'Synthetic input' }],
    });
    state.history.push({
      id: 'assistant-turn',
      role: 'assistant',
      userTurnId: 'user-turn',
      userId: undefined,
      status: undefined,
      read: undefined,
      inputConfig: undefined,
      fileDiff: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      finished: false,
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Synthetic edit',
          rawInput: { path: 'sample.txt', content: 'reviewed text' },
          permissionRequest: {
            requestId: 'request-1',
            options: [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
            ],
          },
        },
      ],
    });
    change?.(state);
  });
  doc.commit();
  view.dispose();
  putMeta(flock, 'session-' + scope.sessionId, meta);
  const raw = {
    meta,
    metaBundle: flock.exportJson(),
    update: delta(doc),
    synced: true,
    online: true,
    persisted: true,
    agent,
  };
  const read = readClientSession(raw, scope),
    reviews = sessionPermissionReviews(read, scope);
  return { doc, flock, raw, read, reviews, close: () => doc.free() };
}

test('narrow permission builder freezes the reviewed tool and choice without creating a document edit', (t) => {
  const f = fixture();
  t.after(f.close);
  const before = delta(f.doc),
    review = f.reviews[0]!,
    input = {
      scope,
      read: f.raw,
      review,
      outcome: { outcome: 'selected' as const, optionId: 'allow' },
      operationId: 'original',
    },
    request = buildRespondPermission(input);
  assert.equal(request.requestId, review.requestId);
  assert.equal(request.permissionReview.assistantTurnId, review.assistantTurnId);
  assert.equal(request.permissionReview.itemJson, review.itemJson);
  assert.deepEqual(request.outcome, input.outcome);
  assert.equal('update' in request, false);
  assert.equal(delta(f.doc), before);
  const prepared = prepareSessionIntent(
    f.doc,
    f.flock,
    f.raw.meta,
    workspace,
    { kind: 'respond-permission', value: request },
    '2026-01-01T00:00:00.000Z',
  );
  const expected = structuredClone(f.read.history);
  (expected[1]!.items![0] as any).permissionRequest.outcome = request.outcome;
  const view = mirror(prepared.doc, scope.sessionId);
  assert.deepEqual(view.getState().history, expected);
  assert.equal(prepared.flock, f.flock);
  view.dispose();
  prepared.doc.free();
  assert.equal(delta(f.doc), before);
  const changed = fixture((state) => {
    state.history[1].items[0].rawInput.content = 'changed after review';
  });
  t.after(changed.close);
  assert.throws(() => buildRespondPermission({ ...input, read: changed.raw }), /已改变/);
  assert.throws(
    () => buildRespondPermission({ ...input, outcome: { outcome: 'selected', optionId: 'other' } }),
    /选项/,
  );
});

for (const outcome of [
  { outcome: 'selected', optionId: 'allow' },
  { outcome: 'cancelled' },
] as const)
  test(`permission builder ${outcome.outcome} only changes the reviewed CRDT outcome and passes actual Host validator`, (t) => {
    const f = fixture();
    t.after(f.close);
    assert.equal(f.reviews.length, 1);
    const before = structuredClone(f.read.history),
      mutation = buildSessionPermission({
        scope,
        read: f.raw,
        review: f.reviews[0],
        outcome,
        operationId: 'operation',
      });
    assert.equal(mutation.expectedTurnId, 'user-turn');
    assert.equal(mutation.requestId, 'request-1');
    assert.equal(mutation.kind, 'permission');
    assert.equal(mutation.metaBundle, undefined);
    assert.deepEqual(mutation.permissionReview, {
      version: 1,
      assistantTurnId: f.reviews[0].assistantTurnId,
      itemJson: f.reviews[0].itemJson,
    });
    const accepted = validateMutation(f.doc, f.flock, workspace, mutation);
    const validatedView = mirror(accepted.doc, scope.sessionId);
    const expected = structuredClone(before);
    (expected[1].items![0] as any).permissionRequest.outcome = outcome;
    assert.deepEqual(validatedView.getState().history, expected);
    validatedView.dispose();
    accepted.doc.free();
    const originalView = mirror(f.doc, scope.sessionId);
    assert.deepEqual(originalView.getState().history, before);
    originalView.dispose();
  });

test('review extraction accepts repeated same-tool requests only when each immutable request ID is unique', (t) => {
  const f = fixture((state) => {
    const item = structuredClone(state.history[1].items[0]);
    item.permissionRequest.requestId = 'request-2';
    state.history[1].items.push(item);
  });
  t.after(f.close);
  assert.equal(f.reviews.length, 2);
  assert.equal(f.reviews[0].assistantTurnId, f.reviews[1].assistantTurnId);
  const mutation = buildSessionPermission({
    scope,
    read: f.raw,
    review: f.reviews[1],
    outcome: { outcome: 'cancelled' },
    operationId: 'second',
  });
  const accepted = validateMutation(f.doc, f.flock, workspace, mutation),
    view = mirror(accepted.doc, scope.sessionId);
  const items = view.getState().history[1].items as any[];
  assert.equal(items[0].permissionRequest.outcome, undefined);
  assert.deepEqual(items[1].permissionRequest.outcome, { outcome: 'cancelled' });
  view.dispose();
  accepted.doc.free();
});

for (const invalid of [
  'duplicate-request',
  'duplicate-option',
  'empty-tool',
  'oversized',
  'resolved',
  'finished',
  'wrong-parent',
  'two-active',
] as const)
  test(`review extraction fails closed for ${invalid}`, (t) => {
    const f = fixture((state) => {
      const turn = state.history[1],
        item = turn.items[0];
      if (invalid === 'duplicate-request') turn.items.push(structuredClone(item));
      else if (invalid === 'duplicate-option')
        item.permissionRequest.options.push(structuredClone(item.permissionRequest.options[0]));
      else if (invalid === 'empty-tool') item.toolCallId = '';
      else if (invalid === 'oversized') item.rawInput = { text: 'x'.repeat(256 * 1024 + 1) };
      else if (invalid === 'resolved') item.permissionRequest.outcome = { outcome: 'cancelled' };
      else if (invalid === 'finished') turn.finished = true;
      else if (invalid === 'wrong-parent') turn.userTurnId = 'old-user';
      else {
        const other = structuredClone(turn);
        other.id = 'other-assistant';
        other.items = [];
        state.history.push(other);
      }
    });
    t.after(f.close);
    assert.deepEqual(f.reviews, []);
  });

test('permission builder rejects forged choices and any changed rendered review or execution scope', (t) => {
  const f = fixture();
  t.after(f.close);
  const call = (review: (typeof f.reviews)[number], selected = 'allow') =>
    buildSessionPermission({
      scope,
      read: f.raw,
      review,
      outcome: { outcome: 'selected', optionId: selected },
      operationId: 'operation',
    });
  assert.throws(() => call(f.reviews[0], 'unknown'), /选项/);
  for (const changed of [
    { ...f.reviews[0], assistantTurnId: 'old-assistant' },
    { ...f.reviews[0], expectedUserTurnId: 'old-user' },
    { ...f.reviews[0], requestId: 'other-request' },
    { ...f.reviews[0], itemJson: f.reviews[0].itemJson.replace('reviewed text', 'changed text') },
    { ...f.reviews[0], scope: { ...scope, workspaceId: 'different-workspace' } },
    {
      ...f.reviews[0],
      options: [
        { ...f.reviews[0].options[0], name: 'Changed meaning' },
        ...f.reviews[0].options.slice(1),
      ],
    },
  ])
    assert.throws(() => call(changed), /审批.*改变/);
  assert.deepEqual(sessionPermissionReviews({ ...f.read, persisted: false }, scope), []);
  assert.deepEqual(
    sessionPermissionReviews({ ...f.read, persistenceError: 'synthetic failure' }, scope),
    [],
  );
});

test('extraction uses the already decoded history and requires no further CRDT import', (t) => {
  const f = fixture();
  t.after(f.close);
  const clone = { meta: f.read.meta, history: f.read.history, persisted: true };
  assert.deepEqual(sessionPermissionReviews(clone, scope), f.reviews);
  const doc = new LoroDoc();
  doc.import(decode(f.raw.update));
  doc.free();
});

test('shared frozen approval contents serialize once across text snapshots while current authorization facts remain checked', (t) => {
  const f = fixture((state) => {
    state.history[1].items[0].rawInput.content = 'x'.repeat(128 * 1024);
  });
  t.after(f.close);
  const replica = new ClientSessionReplica(scope);
  t.after(() => replica.dispose());
  let view = replica.read(f.raw);
  const item = view.history[1].items![0] as Record<string, unknown>;
  assert.equal(Object.isFrozen(item), true);
  const stringify = JSON.stringify;
  let serializations = 0;
  let counting = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    if (counting && value && typeof value === 'object' && 'toolCallId' in value) serializations++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  } as typeof stringify;
  try {
    for (let index = 0; index < 10; index++) {
      const before = vv(f.doc);
      appendSessionText(f.doc, scope.sessionId, 'assistant-turn', 'text', `chunk ${index}`);
      view = replica.read({ ...f.raw, update: delta(f.doc, before) });
      assert.equal(view.history[1].items![0], item);
      counting = true;
      // Navigation and conversation independently request this same review.
      assert.equal(sessionPermissionReviews(view, scope).length, 1);
      assert.equal(sessionPermissionReviews(view, scope).length, 1);
      counting = false;
    }
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(serializations, 1, 'twenty review extractions serialize the unchanged tool once');

  for (const changed of [
    { ...view, persisted: false },
    { ...view, persistenceError: 'not confirmed' },
    { ...view, meta: { ...view.meta, isArchived: true } },
    { ...view, meta: { ...view.meta, latestUserMsgId: 'different-user-turn' } },
    { ...view, history: [view.history[0], { ...view.history[1], finished: true }] },
    { ...view, history: [...view.history, { ...view.history[1], id: 'another-active-turn' }] },
    { ...view, history: [{ ...view.history[0], items: [item] }, view.history[1]] },
  ])
    assert.deepEqual(sessionPermissionReviews(changed, scope), []);
  for (const key of ['userId', 'machineId', 'localProjectId', 'sessionId'] as const)
    assert.deepEqual(sessionPermissionReviews(view, { ...scope, [key]: 'different' }), []);
  assert.equal(
    sessionPermissionReviews(view, { ...scope, workspaceId: 'another-workspace' })[0].scope
      .workspaceId,
    'another-workspace',
    'cached content never captures an earlier execution scope',
  );
  const request = item.permissionRequest as Record<string, unknown>;
  const answered = Object.freeze({
    ...item,
    permissionRequest: Object.freeze({
      ...request,
      outcome: Object.freeze({ outcome: 'cancelled' }),
    }),
  });
  assert.deepEqual(
    sessionPermissionReviews(
      {
        ...view,
        history: [view.history[0], { ...view.history[1], items: [answered] }],
      },
      scope,
    ),
    [],
  );
});

test('review extraction refuses accessor-bearing tool details without evaluating them', (t) => {
  const f = fixture();
  t.after(f.close);
  let accessed = 0;
  const item = f.read.history[1].items![0] as Record<string, unknown>;
  Object.defineProperty(item, 'rawInput', {
    get: () => {
      accessed++;
      return { path: 'injected' };
    },
    enumerable: true,
    configurable: true,
  });
  assert.deepEqual(sessionPermissionReviews(f.read, scope), []);
  assert.equal(accessed, 0);
  Object.defineProperty(item, 'permissionRequest', {
    get: () => {
      accessed++;
      return { requestId: 'injected' };
    },
    enumerable: true,
    configurable: true,
  });
  assert.deepEqual(sessionPermissionReviews(f.read, scope), []);
  assert.equal(accessed, 0);
});
