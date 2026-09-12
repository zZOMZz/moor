import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractionController,
  interactionKey,
  questionDefaults,
  answerFromDraft,
  informationHtml,
  renderInteractionItem,
  sessionInformation,
  type InteractionTarget,
} from '../src/web/interactions';
import { questionRequestSchema, type QuestionRequest } from '../src/interaction-protocol';
import { ApiError } from '../src/web/api';
const target: InteractionTarget = {
  owner: 'owner',
  deviceId: 'device',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const request: QuestionRequest = questionRequestSchema.parse({
  interactionVersion: 1,
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
  expectedTurnId: 'turn',
  requestId: 'question',
  message: 'Synthetic question',
  fields: [
    { id: 'text', kind: 'text', label: 'Text', required: true, minLength: 1, maxLength: 20 },
    {
      id: 'number',
      kind: 'number',
      label: 'Number',
      required: true,
      integer: true,
      minimum: 0,
      maximum: 100,
      default: 0,
    },
    { id: 'bool', kind: 'boolean', label: 'Boolean', required: true, default: false },
    {
      id: 'single',
      kind: 'single-select',
      label: 'Pick',
      required: true,
      options: [
        { value: '', label: 'Empty value' },
        { value: 'b', label: 'B' },
      ],
      default: '',
    },
    {
      id: 'multi',
      kind: 'multi-select',
      label: 'Pick several',
      required: true,
      minItems: 1,
      maxItems: 2,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      default: ['a'],
    },
  ],
});
function fixture() {
  const storage = new Map<string, unknown>(),
    calls: { path: string; body: any }[] = [];
  let nextId = 0,
    mode = 'lost',
    failWrite = false;
  const deps = {
    read: async <T>(key: string) => structuredClone(storage.get(key)) as T | undefined,
    write: async (key: string, value: unknown) => {
      if (failWrite) throw new Error('Disk full');
      storage.set(key, structuredClone(value));
    },
    uuid: () => `operation-${++nextId}`,
    request: async (path: string, body: any) => {
      calls.push({ path, body: structuredClone(body) });
      assert.deepEqual((storage.get(interactionKey(target)) as any).pending.request, body);
      if (mode === 'lost') throw new ApiError('Lost', 504);
      if (mode === 'reject') throw new ApiError('Not staged', 409, true);
      return {
        ...Object.fromEntries(
          [
            'workspaceId',
            'localProjectId',
            'sessionId',
            'expectedTurnId',
            'operationId',
            ...(path.endsWith('question-answers') ? ['requestId'] : []),
          ].map((key) => [key, key === 'operationId' && mode === 'wrong' ? 'other' : body[key]]),
        ),
        accepted: true,
        delivered: true,
        ...(path.endsWith('question-answers')
          ? { interactionVersion: 1 }
          : { activityBound: true }),
      };
    },
  };
  return {
    storage,
    calls,
    deps,
    setMode: (value: string) => (mode = value),
    setFailWrite: (value: boolean) => (failWrite = value),
    controller: () => new InteractionController(target, deps),
  };
}
test('question outbox restores without sending, validates full receipt and explicitly retries original payload across catalog move', async () => {
  const f = fixture(),
    c = f.controller();
  await c.load();
  const values = { ...questionDefaults(request), text: 'Draft text' };
  await c.saveQuestionDraft(request, values);
  assert.equal(f.calls.length, 0);
  await assert.rejects(c.answer(request, answerFromDraft(request, values), target), /Lost/);
  const original = c.pending!;
  const restored = f.controller();
  await restored.load();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(restored.questionDraft(request), values);
  f.setMode('wrong');
  await assert.rejects(restored.retry(target), /有效的主机确认/);
  assert.deepEqual(restored.pending, original);
  assert.deepEqual(restored.questionDraft(request), values);
  await assert.rejects(restored.retry({ ...target, deviceId: 'another' }), /执行身份/);
  assert.equal(f.calls.length, 2);
  f.setMode('success');
  await restored.retry({ ...target, catalogWorkspaceId: 'moved', replicaId: 'new-replica' });
  assert.equal(f.calls[2]!.path, '/api/workspaces/moved/replicas/new-replica/question-answers');
  assert.deepEqual(f.calls[2]!.body, original.request);
  assert.equal(restored.pending, undefined);
  assert.deepEqual(restored.questionDraft(request), questionDefaults(request));
});
test('no network request without durable original operation, rejected request retains editable draft', async () => {
  const f = fixture(),
    c = f.controller();
  await c.load();
  await c.saveSteerDraft('Keep draft');
  f.setFailWrite(true);
  await assert.rejects(c.steer('turn', 'Keep draft', target), /Disk full/);
  assert.equal(f.calls.length, 0);
  assert.equal(c.pending, undefined);
  f.setFailWrite(false);
  f.setMode('reject');
  await assert.rejects(c.steer('turn', 'Keep draft', target), /Not staged/);
  assert.equal(c.pending, undefined);
  assert.equal(c.steerDraft, 'Keep draft');
});
test('unknown steer keeps exact operation until explicitly dismissed and retains an unknown audit', async () => {
  const f = fixture(),
    c = f.controller();
  await c.load();
  await c.saveSteerDraft('Steer text');
  await assert.rejects(c.steer('turn', 'Steer text', target));
  const original = c.pending!;
  const c2 = f.controller();
  await c2.load();
  assert.equal(f.calls.length, 1);
  await assert.rejects(c2.retry(target));
  assert.deepEqual(f.calls[1]!.body, original.request);
  await c2.dismiss('unknown', 'Turn ended; outcome remains unknown');
  assert.equal(c2.pending, undefined);
  assert.deepEqual(c2.closed[0]!.operation, original);
  assert.equal(c2.closed[0]!.outcome, 'unknown');
  assert.equal(c2.steerDraft, 'Steer text');
  assert.equal(f.calls.length, 2);
});
test('receipt cleanup failure retains pending so original delivered operation can be queried again', async () => {
  const f = fixture(),
    c = f.controller();
  await c.load();
  let writeCount = 0;
  const guarded = new InteractionController(target, {
    ...f.deps,
    write: async (key, value) => {
      if (++writeCount === 2) throw new Error('Cleanup failed');
      return f.deps.write(key, value);
    },
  });
  f.setMode('success');
  await assert.rejects(guarded.steer('turn', 'Text', target), /Cleanup failed/);
  assert.ok(guarded.pending);
  const original = guarded.pending!.request;
  await guarded.retry(target);
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [original, original],
  );
  assert.equal(guarded.pending, undefined);
});
test('question values preserve false, zero and empty option and validate before any write', async () => {
  const f = fixture(),
    c = f.controller();
  await c.load();
  const values = { ...questionDefaults(request), text: 'x', number: '0' };
  f.setMode('success');
  await c.answer(request, answerFromDraft(request, values), target);
  assert.deepEqual(f.calls[0]!.body.answer.values, {
    text: 'x',
    number: 0,
    bool: false,
    single: '',
    multi: ['a'],
  });
  assert.throws(
    () =>
      c.answer({ ...request, requestId: 'new' }, answerFromDraft(request, { text: 'x' }), target),
    /请回答必填问题/,
  );
  assert.equal(f.calls.length, 1);
});
test('informational snapshots are escaped and replace counters without inferring absent fields', () => {
  const state = sessionInformation([
    {
      type: 'session_event',
      event: {
        version: 1,
        source: 'acp',
        kind: 'context-usage',
        used: 50,
        size: 100,
        cost: { amount: 1, currency: 'USD' },
      },
    },
    {
      type: 'session_event',
      event: { version: 1, source: 'acp', kind: 'context-usage', used: 0, size: 100 },
    },
    {
      type: 'session_event',
      event: {
        version: 1,
        source: 'acp',
        kind: 'plan',
        content: { format: 'file', uri: 'javascript:<script>bad</script>' },
      },
    },
  ]);
  assert.equal(state.contextUsage?.used, 0);
  assert.equal(state.contextUsage?.cost, undefined);
  const html = informationHtml(state);
  assert.match(html, /0 \/ 100/);
  assert.match(html, /未提供/);
  assert.doesNotMatch(html, /<script>|href=|1 USD/);
  const rendered = renderInteractionItem(
    {
      type: 'question',
      request: { ...request, message: '<img src=x onerror=bad>' },
      status: 'pending',
    },
    'safe',
  )!;
  assert.doesNotMatch(rendered, /<img/);
  assert.match(rendered, /&lt;img/);
});
