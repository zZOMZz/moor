import test from 'node:test';
import assert from 'node:assert/strict';
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk';
import {
  INTERACTION_VERSION,
  QUESTION_LIMITS,
  questionRequestSchema,
  questionAnswerSchema,
  validateQuestionAnswer,
  steerRequestSchema,
  steerReceiptSchema,
  type QuestionRequest,
} from '../src/interaction-protocol';
import {
  normalizeElicitation,
  elicitationResponse,
  bridgeElicitation,
  claudeSteerParams,
  type ElicitationBinding,
} from '../src/runtime/elicitation';

const binding: ElicitationBinding = {
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  expectedTurnId: 'active-turn',
  requestId: 'question-id',
  nativeSessionId: 'native-session',
};
const form = {
  mode: 'form',
  sessionId: binding.nativeSessionId,
  message: 'Choose synthetic parameters',
  toolCallId: 'tool-synthetic',
  requestedSchema: {
    type: 'object',
    title: 'Synthetic form',
    required: ['choice', 'many', 'text', 'flag', 'count'],
    properties: {
      choice: {
        type: 'string',
        title: 'One choice',
        oneOf: [
          { const: 'a', title: 'Choice A' },
          { const: 'b', title: 'Choice B', description: 'Synthetic explanation' },
        ],
      },
      many: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'string', enum: ['first', 'second', 'third'] },
      },
      text: { type: 'string', minLength: 2, maxLength: 10 },
      flag: { type: 'boolean', default: false },
      count: { type: 'integer', minimum: 0, maximum: 4 },
      ratio: { type: 'number', minimum: -0.5, maximum: 0.5 },
      optional: { type: 'string', default: 'draft' },
    },
  },
} satisfies CreateElicitationRequest;
function question(value: unknown = form): QuestionRequest {
  const result = normalizeElicitation(value, binding);
  assert.equal(result.status, 'question');
  if (result.status !== 'question') throw new Error('Expected a form');
  return result.request;
}
const values = { choice: 'a', many: ['first'], text: '合成', flag: false, count: 0 };
function answer(
  overrides: Record<string, unknown> = {},
  action: 'accept' | 'decline' | 'cancel' = 'accept',
) {
  const { nativeSessionId: _, ...scope } = binding;
  return {
    ...scope,
    interactionVersion: INTERACTION_VERSION,
    operationId: 'answer-operation',
    answer: action === 'accept' ? { action, values: { ...values, ...overrides } } : { action },
  };
}

test('ACP form fields normalize into scoped Moor types with preserved values, labels and constraints', () => {
  const result = question();
  questionRequestSchema.parse(result);
  assert.equal(result.requestId, binding.requestId);
  assert.equal(result.expectedTurnId, binding.expectedTurnId);
  assert.equal(result.toolCallId, 'tool-synthetic');
  assert.deepEqual(
    result.fields.map((field) => field.kind),
    ['single-select', 'multi-select', 'text', 'boolean', 'number', 'number', 'text'],
  );
  assert.deepEqual(elicitationResponse(result, answer()), { action: 'accept', content: values });
  assert.equal(
    'optional' in (elicitationResponse(result, answer()) as any).content,
    false,
    'defaults never silently become answers',
  );
  assert.deepEqual(elicitationResponse(result, answer({}, 'decline')), { action: 'decline' });
  assert.deepEqual(elicitationResponse(result, answer({}, 'cancel')), { action: 'cancel' });
  assert.deepEqual(validateQuestionAnswer(result, answer({ ratio: -0.25 })).answer, {
    action: 'accept',
    values: { ...values, ratio: -0.25 },
  });
});

test('answers enforce required fields, choices, types, lengths and finite numeric ranges without coercion', () => {
  const request = question();
  for (const invalid of [
    { choice: 'not-listed' },
    { choice: 1 },
    { many: [] },
    { many: ['first', 'first'] },
    { many: ['first', 'second', 'third'] },
    { many: ['unknown'] },
    { text: '' },
    { text: 'x'.repeat(11) },
    { flag: 'false' },
    { count: 1.5 },
    { count: -1 },
    { count: 5 },
    { ratio: NaN },
    { ratio: Infinity },
    { ratio: 1 },
    { unexpected: 'synthetic' },
  ])
    assert.throws(() => validateQuestionAnswer(request, answer(invalid)), JSON.stringify(invalid));
  for (const key of ['choice', 'many', 'text', 'flag', 'count']) {
    const incomplete = answer();
    if (incomplete.answer.action !== 'accept') throw new Error('Expected accept');
    delete (incomplete.answer.values as Record<string, unknown>)[key];
    assert.throws(() => validateQuestionAnswer(request, incomplete), /必填/);
  }
  assert.throws(() =>
    questionAnswerSchema.parse({ ...answer(), answer: { action: 'decline', values } }),
  );
  assert.throws(() => questionAnswerSchema.parse({ ...answer(), unexpected: true }));
});

test('each answer must match its exact request, active turn and execution ownership', () => {
  for (const key of ['workspaceId', 'localProjectId', 'sessionId', 'expectedTurnId', 'requestId'])
    assert.throws(
      () => validateQuestionAnswer(question(), { ...answer(), [key]: 'other' }),
      /已失效/,
    );
  assert.throws(() => validateQuestionAnswer(question(), { ...answer(), operationId: '' }));
});

test('titled multi-select and untitled single-select preserve native values and validate defaults', () => {
  const source = {
    ...form,
    requestedSchema: {
      properties: {
        one: { type: 'string', enum: ['plain', 'other'], default: 'plain' },
        many: {
          type: 'array',
          items: {
            anyOf: [
              { const: 'one', title: 'First' },
              { const: 'two', title: 'Second' },
            ],
          },
          default: ['two'],
        },
      },
    },
  };
  const result = question(source);
  assert.deepEqual(
    result.fields.map((field) => field.default),
    ['plain', ['two']],
  );
  assert.deepEqual(
    elicitationResponse(result, {
      ...answer(),
      answer: { action: 'accept', values: { one: 'other', many: ['one', 'two'] } },
    }),
    { action: 'accept', content: { one: 'other', many: ['one', 'two'] } },
  );
  assert.equal(
    normalizeElicitation(
      {
        ...source,
        requestedSchema: {
          properties: { one: { type: 'string', enum: ['plain'], default: 'wrong' } },
        },
      },
      binding,
    ).status,
    'unsupported',
  );
});

test('text formats and Unicode lengths follow the requested constraints', () => {
  for (const [format, valid, invalid] of [
    ['email', 'synthetic@example.invalid', 'invalid'],
    ['uri', 'https://synthetic.invalid/path', 'relative-path'],
    ['date', '2024-02-29', '2025-02-29'],
    ['date-time', '2026-09-12T01:02:03+08:00', 'not-a-date'],
  ]) {
    const request = question({
      ...form,
      requestedSchema: { properties: { field: { type: 'string', format } } },
    });
    validateQuestionAnswer(request, {
      ...answer(),
      answer: { action: 'accept', values: { field: valid } },
    });
    assert.throws(() =>
      validateQuestionAnswer(request, {
        ...answer(),
        answer: { action: 'accept', values: { field: invalid } },
      }),
    );
  }
  const request = question({
    ...form,
    requestedSchema: { properties: { field: { type: 'string', minLength: 1, maxLength: 1 } } },
  });
  validateQuestionAnswer(request, {
    ...answer(),
    answer: { action: 'accept', values: { field: '😀' } },
  });
});

test('unknown, malformed and unsupported schema constraints explicitly decline', () => {
  const invalidProperties = [
    { field: { type: 'object' } },
    { field: { type: 'string', pattern: '(a+)+$' } },
    { field: { type: 'string', minimum: 1 } },
    { field: { type: 'boolean', enum: ['yes', 'no'] } },
    { field: { type: 'string', minLength: 10, maxLength: 1 } },
    { field: { type: 'number', minimum: 10, maximum: 1 } },
    { field: { type: 'number', minimum: Infinity } },
    { field: { type: 'string', enum: ['same', 'same'] } },
    { field: { type: 'string', enum: ['a'], oneOf: [{ const: 'b', title: 'B' }] } },
    { field: { type: 'string', enum: ['a'], minLength: 2 } },
    { field: { type: 'array', minItems: 2, items: { type: 'string', enum: ['one'] } } },
    { field: { type: 'array', items: { type: 'number' } } },
    { field: { type: 'string', unknownConstraint: true } },
    { field: { type: 'number', default: '1' } },
    JSON.parse('{"__proto__":{"type":"string"}}'),
    Object.fromEntries(
      Array.from({ length: QUESTION_LIMITS.fields + 1 }, (_, i) => [
        'field' + i,
        { type: 'boolean' },
      ]),
    ),
  ];
  for (const properties of invalidProperties) {
    const result = normalizeElicitation({ ...form, requestedSchema: { properties } }, binding);
    assert.equal(result.status, 'unsupported', JSON.stringify(properties));
    if (result.status !== 'unsupported') throw new Error('Expected a decline');
    assert.deepEqual(result.response, { action: 'decline' });
  }
  for (const required of [['missing'], ['flag', 'flag']])
    assert.equal(
      normalizeElicitation(
        { ...form, requestedSchema: { properties: { flag: { type: 'boolean' } }, required } },
        binding,
      ).status,
      'unsupported',
    );
});

test('URL, unknown modes and uncorrelated native request scopes decline without asking or exposing URLs', async () => {
  let asks = 0;
  for (const request of [
    {
      mode: 'url',
      sessionId: binding.nativeSessionId,
      message: 'Synthetic',
      url: 'https://synthetic.invalid/private',
      elicitationId: 'url-id',
    },
    { mode: 'future', sessionId: binding.nativeSessionId, message: 'Synthetic' },
    { ...form, sessionId: undefined, requestId: 7 },
    { ...form, requestId: 7 },
  ])
    assert.deepEqual(
      await bridgeElicitation(
        request,
        () => binding,
        async () => {
          asks++;
          return questionAnswerSchema.parse(answer());
        },
      ),
      { action: 'decline' },
    );
  assert.equal(asks, 0);
  assert.deepEqual(
    await bridgeElicitation(
      form,
      () => undefined,
      async () => {
        asks++;
        return questionAnswerSchema.parse(answer());
      },
    ),
    { action: 'cancel' },
  );
  assert.deepEqual(
    await bridgeElicitation(
      { ...form, sessionId: 'different-native' },
      () => binding,
      async () => {
        asks++;
        return questionAnswerSchema.parse(answer());
      },
    ),
    { action: 'cancel' },
  );
  assert.equal(asks, 0);
});

test('asynchronous answers cannot reach a replaced or stopped active request', async () => {
  for (const change of [
    'expectedTurnId',
    'requestId',
    'nativeSessionId',
    'localProjectId',
    'stop',
  ] as const) {
    let current: ElicitationBinding | undefined = { ...binding },
      release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asks = 0;
    const pending = bridgeElicitation(
      form,
      () => current,
      async () => {
        asks++;
        await held;
        return questionAnswerSchema.parse(answer());
      },
    );
    if (change === 'stop') current = undefined;
    else current[change] = 'replacement';
    release();
    assert.deepEqual(await pending, { action: 'cancel' });
    assert.equal(asks, 1);
  }
  assert.deepEqual(
    await bridgeElicitation(
      form,
      () => binding,
      async () => questionAnswerSchema.parse(answer()),
    ),
    { action: 'accept', content: values },
  );
});

test('extension metadata is excluded from shared questions and never overrides scope', () => {
  const request = question({
    ...form,
    _meta: { workspaceId: 'other', secret: 'synthetic-private' },
    requestedSchema: {
      properties: { field: { type: 'string', _meta: { secret: 'synthetic-private' } } },
    },
  });
  assert.equal(request.workspaceId, binding.workspaceId);
  assert.equal(JSON.stringify(request).includes('synthetic-private'), false);
  const bounds = request.fields[0];
  assert.equal(bounds.kind === 'text' && bounds.maxLength, QUESTION_LIMITS.text);
});

test('steer contracts require the exact active turn and safe Claude idle behavior', () => {
  const request = {
    operationId: 'steer-op',
    workspaceId: binding.workspaceId,
    localProjectId: binding.localProjectId,
    sessionId: binding.sessionId,
    expectedTurnId: binding.expectedTurnId,
    prompt: 'Synthetic additional instruction',
  };
  steerRequestSchema.parse(request);
  for (const change of [
    { expectedTurnId: null },
    { prompt: ' ' },
    { prompt: 'x'.repeat(16001) },
    { modelId: 'silently-replaced-model' },
  ])
    assert.throws(() => steerRequestSchema.parse({ ...request, ...change }));
  const { prompt: _, ...scope } = request;
  steerReceiptSchema.parse({ ...scope, accepted: true, delivered: true, activityBound: true });
  assert.throws(() =>
    steerReceiptSchema.parse({ ...scope, accepted: true, delivered: true, activityBound: false }),
  );
  assert.deepEqual(claudeSteerParams(binding.nativeSessionId, request.prompt), {
    sessionId: binding.nativeSessionId,
    prompt: [{ type: 'text', text: request.prompt }],
    _meta: { steering: { idleBehavior: 'promptRequired' } },
  });
});
