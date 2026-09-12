import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/web/api';
import {
  actionScope,
  deliverSessionAction,
  pendingSessionActionSchema,
  routeSessionAction,
  sessionActionKey,
  type PendingSessionAction,
} from '../src/web/session-actions';

const original: PendingSessionAction = {
  owner: 'synthetic-owner',
  deviceId: 'synthetic-device',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica-a',
  request: {
    operationId: 'rename-once',
    workspaceId: 'runtime',
    localProjectId: 'project-a',
    sessionId: 'session-a',
    expectedRevision: 0,
    action: 'rename',
    title: 'Synthetic renamed session',
  },
};
const receipt = {
  accepted: true,
  delivered: true,
  operationId: original.request.operationId,
  meta: { id: original.request.sessionId, metadataRevision: 1, title: 'Synthetic renamed session' },
};

test('unknown metadata delivery survives reload and manual retry keeps the original target and request', async () => {
  const stored = new Map<string, PendingSessionAction | undefined>();
  const requests: unknown[] = [];
  let pending: PendingSessionAction | undefined;
  const dependencies = {
    write: async (key: string, value: PendingSessionAction | undefined) => {
      stored.set(key, structuredClone(value));
    },
    onPending: (value: PendingSessionAction | undefined) => {
      pending = value;
    },
    request: async (path: string, request: unknown) => {
      assert.deepEqual(stored.get(sessionActionKey(actionScope(original))), original);
      requests.push({ path, request: structuredClone(request) });
      if (requests.length === 1) throw new ApiError('synthetic response lost', 0);
      return receipt;
    },
  };
  await assert.rejects(deliverSessionAction(original, dependencies), /response lost/);
  assert.deepEqual(pending, original);
  const restored = pendingSessionActionSchema.parse(
    stored.get(sessionActionKey(actionScope(original))),
  );
  assert.equal(requests.length, 1, 'loading pending data never contacts the host');
  const result = await deliverSessionAction(restored, dependencies);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(result, receipt.meta);
  assert.equal(pending, undefined);
  assert.equal(stored.get(sessionActionKey(actionScope(original))), undefined);
});

test('metadata actions cannot leave the browser before durable storage completes', async () => {
  let transmissions = 0;
  await assert.rejects(
    deliverSessionAction(original, {
      write: async () => {
        throw new Error('synthetic storage unavailable');
      },
      onPending: () => assert.fail('undurable request must not become pending'),
      request: async () => {
        transmissions++;
        return receipt;
      },
    }),
    /storage unavailable/,
  );
  assert.equal(transmissions, 0);
});

test('only explicit host rejection clears a pending metadata action', async () => {
  for (const rejected of [false, true]) {
    const writes: (PendingSessionAction | undefined)[] = [];
    let pending: PendingSessionAction | undefined;
    await assert.rejects(
      deliverSessionAction(original, {
        write: async (_key, value) => {
          writes.push(value);
        },
        onPending: (value) => {
          pending = value;
        },
        request: async () => {
          throw new ApiError('synthetic conflict', 409, rejected);
        },
      }),
      /conflict/,
    );
    assert.equal(writes.length, rejected ? 2 : 1);
    assert.deepEqual(pending, rejected ? undefined : original);
  }
});

test('mismatched host receipts and failed receipt cleanup remain manually retryable', async () => {
  for (const mode of ['wrong-operation', 'wrong-session', 'not-delivered', 'failed-cleanup']) {
    let pending: PendingSessionAction | undefined;
    await assert.rejects(
      deliverSessionAction(original, {
        write: async (_key, value) => {
          if (value === undefined && mode === 'failed-cleanup')
            throw new Error('synthetic cleanup failed');
        },
        onPending: (value) => {
          pending = value;
        },
        request: async () => ({
          ...receipt,
          ...(mode === 'wrong-operation' ? { operationId: 'another-operation' } : {}),
          ...(mode === 'wrong-session'
            ? { meta: { id: 'another-session', metadataRevision: 1 } }
            : {}),
          ...(mode === 'not-delivered' ? { delivered: false } : {}),
        }),
      }),
    );
    assert.deepEqual(pending, original, mode);
  }
});

test('metadata pending keys isolate account, device, runtime, project and session', () => {
  const scope = actionScope(original);
  const key = sessionActionKey(scope);
  for (const field of ['owner', 'deviceId', 'workspaceId', 'localProjectId', 'sessionId'] as const)
    assert.notEqual(sessionActionKey({ ...scope, [field]: 'different' }), key, field);
  assert.throws(() =>
    pendingSessionActionSchema.parse({
      ...original,
      request: { ...original.request, title: ' ', command: '/bin/sh' },
    }),
  );
});

test('manual retry follows a moved host only when immutable execution scope is unchanged', async () => {
  const scope = actionScope(original);
  const target = { ...scope, catalogWorkspaceId: 'moved-workspace', replicaId: 'current-replica' };
  const routed = routeSessionAction(original, target);
  assert.deepEqual(routed.request, original.request);
  assert.equal(sessionActionKey(actionScope(routed)), sessionActionKey(scope));
  let destination = '';
  await deliverSessionAction(routed, {
    write: async () => {},
    onPending: () => {},
    request: async (path, body) => {
      destination = path;
      assert.deepEqual(body, original.request);
      return receipt;
    },
  });
  assert.equal(
    destination,
    '/api/workspaces/moved-workspace/replicas/current-replica/session-actions',
  );
  for (const field of ['owner', 'deviceId', 'workspaceId', 'localProjectId', 'sessionId'] as const)
    assert.throws(
      () => routeSessionAction(original, { ...target, [field]: 'different' }),
      /执行目标已改变/,
    );
});
