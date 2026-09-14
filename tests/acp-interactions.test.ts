import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAcpDriver } from '../src/runtime/acp';
import type { AgentCallbacks, AgentRunBinding } from '../src/runtime/agent';
import {
  INTERACTION_VERSION,
  type QuestionAnswer,
  type QuestionRequest,
} from '../src/interaction-protocol';
import type { SessionEvent } from '../src/runtime/session-events';

const binding: AgentRunBinding = {
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  expectedTurnId: 'turn',
};
const form = {
  mode: 'form',
  sessionId: 'native-synthetic',
  message: 'Synthetic question',
  requestedSchema: {
    type: 'object',
    properties: { choice: { type: 'string', enum: ['a', 'b'] } },
    required: ['choice'],
  },
};
const answer = (question: QuestionRequest): QuestionAnswer => ({
  ...binding,
  interactionVersion: INTERACTION_VERSION,
  requestId: question.requestId,
  operationId: 'answer-operation',
  answer: { action: 'accept', values: { choice: 'b' } },
});
function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function fixture(
  t: { after: (callback: () => unknown) => void },
  callbacks: Partial<AgentCallbacks> = {},
  variant: {
    agentType?: string;
    name?: string;
    version?: string;
    custom?: boolean;
    nativeId?: string;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-acp-interactions-'));
  const messages: any[] = [],
    observers = new Set<() => void>();
  let child!: ChildProcessWithoutNullStreams;
  const driver = createAcpDriver((_command, _args, options) => {
    child = spawn(
      process.execPath,
      [
        resolve('tests/support/synthetic-acp-interactions.mjs'),
        variant.name ?? '@agentclientprotocol/codex-acp',
        variant.version ?? '1.11.0',
      ],
      {
        ...options,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      },
    ) as ChildProcessWithoutNullStreams;
    child.on('message', (message: any) => {
      if (message.kind === 'wire') messages.push(message.message);
      for (const observer of observers) observer();
    });
    return child;
  });
  const session = await driver.open(
    {
      id: 'synthetic',
      machineId: 'synthetic',
      name: 'Synthetic',
      cliType: 'builtin',
      agentType: variant.agentType ?? 'codex',
      ...(variant.custom ? { customAcp: { command: process.execPath, args: [] } } : {}),
      ...(!variant.custom ? { runtimeOverrides: { codexPath: process.execPath } } : {}),
    },
    cwd,
    variant.nativeId,
    {
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      ...callbacks,
    },
  );
  t.after(async () => {
    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const waitFor = (predicate: (message: any) => boolean) =>
    new Promise<any>((done) => {
      const inspect = () => {
        const message = messages.find(predicate);
        if (message) {
          observers.delete(inspect);
          done(message);
        }
      };
      observers.add(inspect);
      inspect();
    });
  const control = (value: unknown) => child.send(value as any);
  const start = (
    input: any = { prompt: 'Synthetic task' },
    scope: AgentRunBinding | undefined = binding,
  ) => {
    const prompt = session.prompt(input, scope);
    void prompt.catch(() => {});
    return prompt;
  };
  return { session, child, messages, waitFor, control, start };
}

test(
  'actual ACP usage updates ignore private extension metadata and require the exact active session',
  { timeout: 15000 },
  async (t) => {
    for (const variant of [
      {},
      { custom: true },
      { name: 'unverified-adapter' },
      { version: '1.11.1' },
      { nativeId: 'synthetic-resumed-native' },
    ]) {
      const events: { event: SessionEvent; binding: AgentRunBinding }[] = [];
      const seen = signal<void>();
      const f = await fixture(
        t,
        {
          event(event, binding) {
            events.push({ event, binding });
            if (event.kind === 'context-usage') seen.resolve();
          },
        },
        variant,
      );
      const active = f.start();
      const prompt = await f.waitFor((message) => message.method === 'session/prompt');
      const update = {
        sessionUpdate: 'usage_update',
        used: 12,
        size: 100,
        _meta: {
          '_claude/rateLimit': {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization: 0.9,
            resetsAt: 1893456000,
            credentials: 'synthetic-limit-secret',
            hasChargeableSavedPaymentMethod: true,
          },
        },
      };
      f.control({ kind: 'emit', sessionId: 'wrong-native', update });
      f.control({ kind: 'emit', sessionId: prompt.params.sessionId, update });
      await seen.promise;
      f.control({ kind: 'finish' });
      await active;
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.binding, binding);
      const report = events[0]!.event;
      assert.equal(report.kind, 'context-usage');
      if (report.kind !== 'context-usage') throw new Error('Expected actual context report');
      assert.deepEqual(report, {
        version: 1,
        source: 'acp',
        kind: 'context-usage',
        used: 12,
        size: 100,
      });
      assert.doesNotMatch(JSON.stringify(events), /synthetic-limit-secret|PaymentMethod/);
      await f.session.close();
    }
  },
);

test('real ACP initializes capability discovery, preserves attachments and binds informational events and questions', async (t) => {
  const events: { event: SessionEvent; binding: AgentRunBinding }[] = [],
    updates: unknown[] = [];
  const asked = signal<QuestionRequest>(),
    respond = signal<QuestionAnswer>(),
    contextSeen = signal<void>();
  const f = await fixture(t, {
    update: (value) => updates.push(value),
    event: (event, binding) => {
      events.push({ event, binding });
      if (event.kind === 'context-usage') contextSeen.resolve();
    },
    question: (question) => {
      asked.resolve(question);
      return respond.promise;
    },
  });
  const initialize = await f.waitFor((message) => message.method === 'initialize');
  assert.deepEqual(initialize.params.clientCapabilities.elicitation, {
    form: {},
  });
  assert.deepEqual(initialize.params.clientCapabilities.plan, {});
  assert.equal(events.length, 0);
  assert.equal(updates.length, 0);
  assert.deepEqual(
    f.session.currentEvents?.commands?.map((command) => command.name),
    ['review'],
  );
  assert.equal(f.session.interactionCapabilities?.steer, false);
  assert.equal(f.session.steer, undefined);
  assert.equal(
    f.session.runtimeFeatures?.steer,
    false,
    'protocol baseline has no standard steer method',
  );
  const bytes = Buffer.from('synthetic image');
  const reference = {
    contentVersion: 1 as const,
    attachmentId: 'image-one',
    name: 'image.png',
    content: {
      version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mediaType: 'image/png',
    },
  };
  const prompt = f.start({
    prompt: 'Inspect synthetic image',
    attachments: [reference],
    attachmentData: [{ reference, data: bytes.toString('base64') }],
  });
  const wire = await f.waitFor((message) => message.method === 'session/prompt');
  assert.deepEqual(wire.params.prompt, [
    { type: 'text', text: 'Inspect synthetic image' },
    { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
  ]);
  f.control({
    kind: 'emit',
    sessionId: 'wrong-native',
    update: { sessionUpdate: 'plan', entries: [] },
  });
  f.control({
    kind: 'emit',
    update: {
      sessionUpdate: 'plan',
      entries: [{ content: 'Synthetic step', priority: 'high', status: 'in_progress' }],
    },
  });
  f.control({
    kind: 'emit',
    update: {
      sessionUpdate: 'usage_update',
      used: 10,
      size: 100,
      cost: { amount: 0, currency: 'USD' },
    },
  });
  await contextSeen.promise;
  assert.deepEqual(
    events.map((item) => item.event.kind),
    ['plan', 'context-usage'],
  );
  for (const item of events) assert.deepEqual(item.binding, binding);
  f.control({ kind: 'ask', id: 'native-question', params: form });
  const question = await asked.promise;
  assert.equal(question.sessionId, binding.sessionId);
  assert.equal(question.expectedTurnId, binding.expectedTurnId);
  assert.notEqual(question.requestId, 'native-question');
  respond.resolve(answer(question));
  const delivered = await f.waitFor(
    (message) => message.id === 'native-question' && message.result,
  );
  assert.deepEqual(delivered.result, {
    action: 'accept',
    content: { choice: 'b' },
  });
  f.control({
    kind: 'finish',
    usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 },
  });
  await prompt;
  assert.deepEqual(
    events.map((item) => item.event.kind),
    ['plan', 'context-usage', 'token-usage'],
  );
  assert.equal(f.session.runtimeFeatures?.observed.formQuestions, true);
  assert.equal(f.session.currentEvents?.tokenUsage?.totalTokens, 12);
});

test('load command snapshots remain passive and unsupported native question scopes do not reach the host', async (t) => {
  let asked = 0;
  const f = await fixture(
    t,
    {
      update: () => assert.fail('replayed transcript'),
      event: () => assert.fail('unbound replay event'),
      question: async (request) => {
        asked++;
        return answer(request);
      },
    },
    { nativeId: 'native-synthetic' },
  );
  assert.equal(f.session.id, 'native-synthetic');
  assert.deepEqual(
    f.session.currentEvents?.commands?.map((command) => command.name),
    ['review'],
  );
  const prompt = f.start();
  await f.waitFor((message) => message.method === 'session/prompt');
  for (const [id, params, action] of [
    ['wrong-session', { ...form, sessionId: 'wrong-native' }, 'cancel'],
    ['request-scope', { ...form, sessionId: undefined, requestId: 1 }, 'decline'],
    [
      'url-mode',
      {
        mode: 'url',
        sessionId: 'native-synthetic',
        message: 'Synthetic URL',
        url: 'https://synthetic.invalid',
        elicitationId: 'url',
      },
      'decline',
    ],
  ] as const) {
    f.control({ kind: 'ask', id, params });
    assert.deepEqual((await f.waitFor((message) => message.id === id && message.result)).result, {
      action,
    });
  }
  assert.equal(asked, 0);
  f.control({ kind: 'finish' });
  await prompt;
  f.control({ kind: 'ask', id: 'late-question', params: form });
  assert.deepEqual(
    (await f.waitFor((message) => message.id === 'late-question' && message.result)).result,
    { action: 'cancel' },
  );
});

test('missing question handler and missing execution binding cannot accidentally enable forms', async (t) => {
  const f = await fixture(t);
  assert.equal(f.session.interactionCapabilities?.questions, false);
  const initialize = await f.waitFor((message) => message.method === 'initialize');
  assert.equal(initialize.params.clientCapabilities.elicitation, undefined);
  const prompt = f.start();
  await f.waitFor((message) => message.method === 'session/prompt');
  f.control({ kind: 'ask', id: 'no-handler', params: form });
  assert.deepEqual(
    (await f.waitFor((message) => message.id === 'no-handler' && message.result)).result,
    { action: 'decline' },
  );
  f.control({ kind: 'finish' });
  await prompt;
  const g = await fixture(t, {
    question: async () => assert.fail('unbound question'),
  });
  const unbound = g.session.prompt({ prompt: 'Legacy synthetic caller' });
  void unbound.catch(() => {});
  await g.waitFor((message) => message.method === 'session/prompt');
  g.control({ kind: 'ask', id: 'no-binding', params: form });
  assert.deepEqual(
    (await g.waitFor((message) => message.id === 'no-binding' && message.result)).result,
    { action: 'cancel' },
  );
  g.control({ kind: 'finish' });
  await unbound;
});

test('cancellation settles an unresolved native question once and rejects late host answers', async (t) => {
  const asked = signal<QuestionRequest>(),
    respond = signal<QuestionAnswer>();
  const f = await fixture(t, {
    question: (question) => {
      asked.resolve(question);
      return respond.promise;
    },
  });
  const prompt = f.start();
  await f.waitFor((message) => message.method === 'session/prompt');
  f.control({ kind: 'ask', id: 'cancelled-question', params: form });
  const question = await asked.promise;
  await f.session.cancel();
  await prompt;
  assert.deepEqual(
    (await f.waitFor((message) => message.id === 'cancelled-question' && message.result)).result,
    { action: 'cancel' },
  );
  respond.resolve(answer(question));
  f.control({ kind: 'ask', id: 'after-cancel-barrier', params: form });
  await f.waitFor((message) => message.id === 'after-cancel-barrier' && message.result);
  assert.equal(
    f.messages.filter((message) => message.id === 'cancelled-question' && message.result).length,
    1,
  );
});

test('Codex and custom ACP do not expose a non-standard steer action', async (t) => {
  for (const variant of [{}, { custom: true }]) {
    const f = await fixture(t, {}, variant);
    assert.equal(f.session.interactionCapabilities?.steer, false);
    assert.ok(f.session.interactionCapabilities?.steerUnavailableReason);
    assert.equal(f.session.steer, undefined);
    assert.equal(
      f.messages.some((message) => message.method === '_session/steering'),
      false,
    );
  }
});
