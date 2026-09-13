import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  secureOperationSchema,
  secureOriginal,
  type SecureCliOperation,
  type SecureCliTarget,
} from '../src/cli/secure-operation';
import { CliState, requestVersion } from '../src/cli/state';
import {
  sessionOperationSchema,
  validateSessionOperationResult,
} from '../src/session-control-protocol';

const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'synthetic-owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'synthetic-client',
  hostDeviceId: 'synthetic-host',
  workspaceId: 'synthetic-runtime',
  localProjectId: 'synthetic-local-project',
  userId: 'synthetic-local-user',
  machineId: 'synthetic-machine',
  sessionId: 'synthetic-session',
  product: {
    catalogWorkspaceId: 'synthetic-catalog-workspace',
    projectId: 'synthetic-product-project',
    replicaId: 'synthetic-replica',
    revision: 7,
  },
};
const scope = {
  controlVersion: 1 as const,
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  sessionId: target.sessionId,
  userId: target.userId,
  machineId: target.machineId,
};
const now = '2026-01-02T00:00:00.000Z';

function operation(kind: SecureCliOperation['kind'] = 'permission'): SecureCliOperation {
  const operationId = 'synthetic-original';
  let method: string, params: unknown;
  if (kind === 'permission' || kind === 'turn') {
    method = 'mutate';
    params = {
      operationId,
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      kind,
      expectedTurnId: kind === 'permission' ? 'synthetic-active-turn' : null,
      ...(kind === 'permission'
        ? {
            requestId: 'synthetic-exact-request',
            permissionReview: {
              version: 1,
              assistantTurnId: 'synthetic-assistant-turn',
              itemJson: JSON.stringify({
                type: 'tool_call',
                toolCallId: 'synthetic-tool',
                rawInput: { path: 'synthetic-file.txt' },
                permissionRequest: {
                  requestId: 'synthetic-exact-request',
                  options: [{ optionId: 'allow', name: 'Synthetic allow', kind: 'allow_once' }],
                },
              }),
            },
          }
        : {}),
      update: Buffer.from('synthetic-original-crdt-update').toString('base64'),
      metaBundle: { synthetic: ['unchanged-original', { revision: 1 }] },
    };
  } else if (kind === 'session-action') {
    method = 'session-action';
    params = {
      operationId,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId: target.sessionId,
      expectedRevision: 4,
      action: 'rename',
      title: 'Synthetic title',
    };
  } else {
    method = 'session-control';
    params = {
      ...scope,
      operationId,
      action: kind,
      ...(kind === 'create' ? { agentId: 'synthetic-agent' } : { turnId: 'synthetic-active-turn' }),
    };
  }
  const body =
    JSON.stringify(
      {
        method,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        params,
      },
      null,
      2,
    ) + '\n';
  return {
    operationId,
    kind,
    target: structuredClone(target),
    body,
    requestVersion: requestVersion(body),
    state: 'pending',
    createdAt: now,
  };
}

test('permission originals preserve their exact mutation, target and bytes through JSON recovery', () => {
  const input = operation(),
    parsed = secureOperationSchema.parse(JSON.parse(JSON.stringify(input))),
    original = secureOriginal(parsed);
  assert.deepEqual(parsed, input);
  assert.equal(original.kind, 'mutation');
  assert.deepEqual(original.value, JSON.parse(input.body).params);
  assert.equal(Object.hasOwn(original.value, 'localProjectId'), false);
  for (const action of ['inspect', 'abandon'] as const) {
    const recovery = sessionOperationSchema.parse({ ...scope, action, request: original });
    assert.deepEqual(recovery.request, original);
    assert.equal(recovery.request.value.operationId, input.operationId);
  }
});

test('legacy turn, create, stop and metadata originals remain compatible without product mappings', () => {
  for (const kind of ['turn', 'create', 'stop', 'session-action'] as const) {
    const input = operation(kind);
    delete input.target.product;
    const parsed = secureOperationSchema.parse(JSON.parse(JSON.stringify(input))),
      original = secureOriginal(parsed);
    assert.deepEqual(parsed, input);
    assert.equal(
      original.kind,
      kind === 'turn' ? 'mutation' : kind === 'session-action' ? 'metadata' : 'control',
    );
    assert.deepEqual(original.value, JSON.parse(input.body).params);
  }
});

test('mutations cannot relabel turns as permissions or use a different command method', () => {
  for (const kind of ['turn', 'permission'] as const) {
    const input = operation(kind);
    for (const replacement of ['turn', 'permission', 'create', 'stop', 'session-action'] as const) {
      if (replacement === kind) continue;
      assert.equal(
        secureOperationSchema.safeParse({ ...input, body: operation(replacement).body }).success,
        false,
        `${kind} with ${replacement} command`,
      );
    }
  }
  assert.equal(
    secureOperationSchema.safeParse({ ...operation('create'), body: operation('stop').body })
      .success,
    false,
  );
});

test('permission originals reject mismatched envelope, operation and session scope', () => {
  for (const [location, field] of [
    ['envelope', 'workspaceId'],
    ['envelope', 'localProjectId'],
    ['params', 'operationId'],
    ['params', 'workspaceId'],
    ['params', 'sessionId'],
  ]) {
    const input = operation(),
      command = JSON.parse(input.body);
    (location === 'envelope' ? command : command.params)[field] = 'synthetic-wrong-scope';
    assert.equal(
      secureOperationSchema.safeParse({ ...input, body: JSON.stringify(command) }).success,
      false,
      `${location}.${field}`,
    );
  }
});

test('permission originals require an exact nonempty bounded turn and request identifier', () => {
  for (const field of ['expectedTurnId', 'requestId'])
    for (const value of [undefined, null, '', 42, 'wrong request', 'x'.repeat(161)]) {
      const input = operation(),
        command = JSON.parse(input.body);
      command.params[field] = value;
      assert.equal(
        secureOperationSchema.safeParse({ ...input, body: JSON.stringify(command) }).success,
        false,
        `${field}=${JSON.stringify(value)}`,
      );
    }
});

test('permission originals reject extra request and authority fields before any parsing can strip them', () => {
  for (const field of ['request', 'optionId', 'turnId', 'localProjectId', 'owner', 'deviceId']) {
    const input = operation(),
      command = JSON.parse(input.body);
    command.params[field] = 'synthetic-untrusted-extra';
    assert.equal(
      secureOperationSchema.safeParse({ ...input, body: JSON.stringify(command) }).success,
      false,
      field,
    );
  }
});

test('permission originals require a supported complete Host review binding', () => {
  const input = operation(),
    valid = JSON.parse(input.body).params.permissionReview;
  for (const binding of [
    undefined,
    null,
    {},
    { ...valid, version: 2 },
    { ...valid, assistantTurnId: undefined },
    { ...valid, assistantTurnId: 'invalid turn' },
    { ...valid, itemJson: undefined },
    { ...valid, unreviewedAuthority: 'synthetic-other-owner' },
  ]) {
    const command = JSON.parse(input.body);
    command.params.permissionReview = binding;
    assert.equal(
      secureOperationSchema.safeParse({ ...input, body: JSON.stringify(command) }).success,
      false,
    );
  }
});

test('permission review material is bounded by UTF-8 bytes while preserving the exact maximum', () => {
  const limit = 256 * 1024,
    overhead = Buffer.byteLength(JSON.stringify({ input: '' })),
    input = operation(),
    command = JSON.parse(input.body);
  command.params.permissionReview.itemJson = JSON.stringify({
    input: 'x'.repeat(limit - overhead),
  });
  assert.equal(Buffer.byteLength(command.params.permissionReview.itemJson), limit);
  assert.equal(
    secureOperationSchema.safeParse({ ...input, body: JSON.stringify(command) }).success,
    true,
  );
  for (const itemJson of [
    JSON.stringify({ input: 'x'.repeat(limit - overhead + 1) }),
    JSON.stringify({ input: '字'.repeat(Math.floor((limit - overhead) / 3) + 1) }),
  ]) {
    command.params.permissionReview.itemJson = itemJson;
    assert(Buffer.byteLength(itemJson) > limit);
    assert.equal(
      secureOperationSchema.safeParse({ ...input, body: JSON.stringify(command) }).success,
      false,
    );
  }
});

test('permission confirmation and abandonment retain the durable original through close and reopen', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-permission-original-')));
  const stores = new Set<CliState>();
  const close = (store: CliState) => {
    store.close();
    stores.delete(store);
  };
  t.after(() => {
    stores.forEach((store) => store.close());
    rmSync(root, { recursive: true, force: true });
  });
  for (const status of ['accepted', 'abandoned'] as const) {
    const state = new CliState(root);
    stores.add(state);
    const input = operation();
    input.operationId += '-' + status;
    const command = JSON.parse(input.body);
    command.params.operationId = input.operationId;
    input.body = JSON.stringify(command, null, 2) + '\n';
    const staged = state.secureStage(input, now);
    state.secureTransition(staged.operationId, ['pending'], 'ending');
    const recovery = sessionOperationSchema.parse({
      ...scope,
      action: 'abandon',
      request: secureOriginal(staged),
    });
    const result = validateSessionOperationResult(
      {
        ...scope,
        confirmed: true,
        action: 'abandon',
        found: true,
        operationId: staged.operationId,
        receipt: {
          ...scope,
          confirmed: true,
          operationId: staged.operationId,
          kind: 'mutation',
          status,
        },
      },
      recovery,
    );
    assert.equal(result.found, true);
    if (!result.found) throw Error('Synthetic recovery must contain its original receipt');
    const completed = state.secureTransition(
      staged.operationId,
      ['ending'],
      status,
      result.receipt,
    );
    close(state);
    const reopened = new CliState(root);
    stores.add(reopened);
    const restored = reopened.secureOperation(staged.operationId)!;
    assert.deepEqual(restored, completed);
    assert.equal(restored.body, input.body);
    assert.equal(restored.operationId, input.operationId);
    assert.deepEqual(restored.target, input.target);
    assert.equal(restored.requestVersion, staged.requestVersion);
    assert.deepEqual(secureOriginal(restored), recovery.request);
    assert.deepEqual(secureOperationSchema.parse(JSON.parse(JSON.stringify(restored))), restored);
    assert.equal(reopened.secureOperationSummaries().operations[0].kind, 'permission');
    close(reopened);
  }
});
