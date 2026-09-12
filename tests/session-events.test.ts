import test from 'node:test';
import strict from 'node:assert/strict';
import type { InitializeResponse, PromptResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import {
  applySessionEvent,
  normalizePromptUsage,
  normalizeSessionEvent,
  runtimeFeatureReport,
  runtimeFeatureReportSchema,
  sessionEventStateSchema,
  type SessionEvent,
  type SessionEventState,
} from '../src/runtime/session-events';

function event(value: unknown): SessionEvent {
  const result = normalizeSessionEvent(value);
  strict.equal(result.status, 'accepted');
  if (result.status !== 'accepted') throw new Error('Expected a normalized event');
  return result.event;
}
const entry = { content: 'Inspect synthetic files', priority: 'high', status: 'pending' } as const;

test('runtime reports use explicit ACP flags and keep observed event support separate', () => {
  const initialization = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { fork: {} },
      _meta: { steer: true, questions: true, plan: true, usage: true },
    },
  } satisfies InitializeResponse;
  const report = runtimeFeatureReport(initialization);
  strict.deepEqual(report, {
    version: 1,
    source: 'acp',
    prompt: { text: true, resourceLink: true, image: true, audio: false, embeddedContext: true },
    loadSession: true,
    forkSession: true,
    steer: false,
    observed: {
      commands: false,
      plan: false,
      contextUsage: false,
      tokenUsage: false,
      formQuestions: false,
    },
  });
  runtimeFeatureReportSchema.parse(report);
  for (const invalid of [null, 'yes', true, []])
    strict.equal(
      runtimeFeatureReport({ agentCapabilities: { sessionCapabilities: { fork: invalid } } })
        .forkSession,
      false,
    );
  strict.deepEqual(runtimeFeatureReport(undefined).prompt, {
    text: true,
    resourceLink: true,
    image: false,
    audio: false,
    embeddedContext: false,
  });
  strict.equal(
    runtimeFeatureReport({ agentCapabilities: { promptCapabilities: { image: 'true' } } }).prompt
      .image,
    false,
  );
});

test('command snapshots replace old choices, retain input hints, and strip extension metadata', () => {
  const first = event({
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      {
        name: 'review',
        description: 'Review changes',
        input: { hint: 'Scope', _meta: { hidden: 'private' } },
      },
    ],
    _meta: { secret: 'synthetic' },
  } satisfies SessionUpdate);
  strict.equal(JSON.stringify(first).includes('private'), false);
  strict.equal(JSON.stringify(first).includes('synthetic'), false);
  const before = applySessionEvent(undefined, first);
  strict.deepEqual(before.commands, [
    { name: 'review', description: 'Review changes', input: { hint: 'Scope' } },
  ]);
  const cleared = applySessionEvent(
    before,
    event({
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    } satisfies SessionUpdate),
  );
  strict.deepEqual(cleared.commands, []);
  strict.equal(before.commands?.length, 1);
  strict.equal(runtimeFeatureReport({}, cleared).observed.commands, true);
});

test('malformed or duplicate command menus cannot become accepted capabilities', () => {
  for (const availableCommands of [
    [{ name: 'review\nother', description: '' }],
    [{ name: '', description: '' }],
    [{ name: 'review' }],
    [{ name: 'review', description: '', input: { hint: 1 } }],
    [
      { name: 'review', description: '' },
      { name: 'review', description: '' },
    ],
    Array.from({ length: 501 }, (_, i) => ({ name: 'item' + i, description: '' })),
  ])
    strict.deepEqual(
      normalizeSessionEvent({ sessionUpdate: 'available_commands_update', availableCommands }),
      { status: 'ignored', reason: 'invalid-event' },
    );
});

test('legacy plans replace entries and never merge old tasks into a new snapshot', () => {
  const initial = applySessionEvent(
    undefined,
    event({ sessionUpdate: 'plan', entries: [entry] } satisfies SessionUpdate),
  );
  const updated = applySessionEvent(
    initial,
    event({
      sessionUpdate: 'plan',
      entries: [{ ...entry, status: 'completed' }],
    } satisfies SessionUpdate),
  );
  strict.equal(initial.plans[0].content.format, 'items');
  strict.deepEqual(updated.plans, [
    {
      planId: undefined,
      content: { format: 'items', entries: [{ ...entry, status: 'completed' }] },
    },
  ]);
  const cleared = applySessionEvent(
    updated,
    event({ sessionUpdate: 'plan', entries: [] } satisfies SessionUpdate),
  );
  strict.equal(runtimeFeatureReport({}, cleared).observed.plan, true);
  strict.deepEqual(cleared.plans[0].content, { format: 'items', entries: [] });
});

test('named item, Markdown, file plans and removal have independent identity', () => {
  let state: SessionEventState | undefined;
  for (const update of [
    { sessionUpdate: 'plan', entries: [entry] },
    { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'legacy', entries: [entry] } },
    {
      sessionUpdate: 'plan_update',
      plan: { type: 'markdown', planId: 'design', content: '# Synthetic plan' },
    },
    {
      sessionUpdate: 'plan_update',
      plan: { type: 'file', planId: 'reference', uri: 'file:///synthetic/project/plan.md' },
    },
    { sessionUpdate: 'plan_removed', planId: 'legacy' },
  ] satisfies SessionUpdate[])
    state = applySessionEvent(state, event(update));
  strict.deepEqual(
    state?.plans.map((plan) => [plan.planId, plan.content.format]),
    [
      [undefined, 'items'],
      ['design', 'markdown'],
      ['reference', 'file'],
    ],
  );
  strict.equal(state?.plans.length, 3);
  sessionEventStateSchema.parse(state);
  for (const update of [
    { sessionUpdate: 'plan', entries: [{ ...entry, status: 'unknown' }] },
    { sessionUpdate: 'plan_update', plan: { type: 'markdown', content: 'No ID' } },
    { sessionUpdate: 'plan_update', plan: { type: 'unknown', planId: 'a', contents: 'untrusted' } },
    { sessionUpdate: 'plan_removed', planId: '' },
  ])
    strict.deepEqual(normalizeSessionEvent(update), { status: 'ignored', reason: 'invalid-event' });
});

test('current plan state is bounded without mutating saved historical snapshots', () => {
  let state: SessionEventState | undefined;
  const snapshots: SessionEventState[] = [];
  for (let i = 0; i < 101; i++) {
    state = applySessionEvent(
      state,
      event({
        sessionUpdate: 'plan_update',
        plan: { type: 'items', planId: String(i), entries: [entry] },
      }),
    );
    snapshots.push(state);
  }
  strict.equal(state?.plans.length, 100);
  strict.equal(state?.plans[0].planId, '1');
  strict.equal(snapshots[0].plans[0].planId, '0');
  strict.equal(snapshots[0].plans.length, 1);
});

test('context usage preserves true zero and optional cumulative cost without inferring missing data', () => {
  const first = event({
    sessionUpdate: 'usage_update',
    used: 0,
    size: 200000,
    cost: { amount: 0, currency: 'USD' },
  } satisfies SessionUpdate);
  strict.deepEqual(first, {
    version: 1,
    source: 'acp',
    kind: 'context-usage',
    used: 0,
    size: 200000,
    cost: { amount: 0, currency: 'USD' },
  });
  const state = applySessionEvent(
    applySessionEvent(undefined, first),
    event({
      sessionUpdate: 'usage_update',
      used: 1000,
      size: 200000,
      cost: null,
    } satisfies SessionUpdate),
  );
  strict.equal(state.contextUsage?.cost, undefined);
  strict.equal(state.contextUsage?.used, 1000);
  strict.equal(state.tokenUsage, undefined);
  strict.equal(runtimeFeatureReport({}, state).observed.contextUsage, true);
  for (const update of [
    { used: undefined, size: 200000 },
    { used: 3, size: undefined },
    { used: -1, size: 10 },
    { used: NaN, size: 10 },
    { used: Number.MAX_SAFE_INTEGER + 1, size: 10 },
    { used: 1, size: Infinity },
    { used: 1, size: 10, cost: { amount: -1, currency: 'USD' } },
    { used: 1, size: 10, cost: { amount: 1, currency: 'not a currency' } },
  ])
    strict.deepEqual(normalizeSessionEvent({ sessionUpdate: 'usage_update', ...update }), {
      status: 'ignored',
      reason: 'invalid-event',
    });
});

test('prompt token reports keep their own source and do not sum cumulative counters', () => {
  const response = {
    stopReason: 'end_turn',
    usage: {
      totalTokens: 100,
      inputTokens: 80,
      outputTokens: 20,
      thoughtTokens: null,
      cachedReadTokens: 0,
      _meta: { private: 'synthetic' },
    },
  } satisfies PromptResponse;
  const first = normalizePromptUsage(response);
  strict.equal(first.status, 'accepted');
  if (first.status !== 'accepted' || first.event.kind !== 'token-usage')
    throw new Error('Expected token report');
  strict.equal(first.event.thoughtTokens, undefined);
  strict.equal(first.event.cachedReadTokens, 0);
  strict.equal(first.event.cachedWriteTokens, undefined);
  strict.equal(first.event.scope, 'agent-reported');
  strict.equal(JSON.stringify(first).includes('synthetic'), false);
  const repeated = applySessionEvent(applySessionEvent(undefined, first.event), first.event);
  strict.equal(repeated.tokenUsage?.totalTokens, 100);
  strict.equal(repeated.contextUsage, undefined);
  strict.equal(runtimeFeatureReport({}, repeated).observed.tokenUsage, true);
  for (const missing of [{ stopReason: 'end_turn' }, { usage: null }])
    strict.deepEqual(normalizePromptUsage(missing), { status: 'ignored', reason: 'missing-usage' });
  for (const invalid of [
    { usage: { inputTokens: 1 } },
    { usage: { totalTokens: 2, inputTokens: 1, outputTokens: -1 } },
  ])
    strict.deepEqual(normalizePromptUsage(invalid), { status: 'ignored', reason: 'invalid-event' });
});

test('unknown events do not expose their payload or imply available capabilities', () => {
  for (const value of [
    { sessionUpdate: 'future_update', raw: 'private synthetic content' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'handled elsewhere' } },
  ])
    strict.deepEqual(normalizeSessionEvent(value), { status: 'ignored', reason: 'unknown-event' });
  for (const value of [null, undefined, [], 1])
    strict.deepEqual(normalizeSessionEvent(value), { status: 'ignored', reason: 'invalid-event' });
  strict.equal(runtimeFeatureReport({}, undefined, true).observed.formQuestions, true);
  strict.equal(runtimeFeatureReport({}, undefined).observed.formQuestions, false);
});
