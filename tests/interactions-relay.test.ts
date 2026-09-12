import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PROTOCOL } from '../src/protocol';
import { QUESTIONS_FEATURE, STEER_FEATURE } from '../src/interaction-protocol';
import { syntheticRelay } from './support/synthetic-relay';
import type { Workspace } from '../src/catalog';

const actions = ['question-answers', 'steer'] as const;
type Action = (typeof actions)[number];
async function fixture() {
  const relay = await syntheticRelay();
  const controls = {
    transform: undefined as undefined | ((result: any) => unknown),
    hold: undefined as undefined | (() => Promise<void>),
  };
  for (const host of relay.hosts) {
    host.runtime.features!.push(QUESTIONS_FEATURE, STEER_FEATURE);
    for (const method of ['answer-question', 'steer'])
      host.responses.set(method, async (m) => {
        const { workspaceId, localProjectId, sessionId, expectedTurnId, operationId, requestId } =
          m.params;
        const result = {
          workspaceId,
          localProjectId,
          sessionId,
          expectedTurnId,
          operationId,
          accepted: true,
          delivered: true,
          ...(method === 'answer-question'
            ? { interactionVersion: 1, requestId }
            : { activityBound: true }),
        };
        const response = controls.transform?.(result) ?? result;
        await controls.hold?.();
        return response;
      });
    const pong = once(host.socket, 'pong');
    host.socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: host.runtime.machineId,
        workspaces: [host.runtime],
      }),
    );
    host.socket.ping();
    await pong;
  }
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0]!;
  const replica = space.replicas.find(
    (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
  )!;
  const input = (action: Action) => ({
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
    expectedTurnId: 'active-assistant-turn',
    operationId: 'synthetic-' + action,
    ...(action === 'question-answers'
      ? {
          interactionVersion: 1,
          requestId: 'active-question',
          answer: { action: 'accept', values: { choice: 'synthetic response' } },
        }
      : { prompt: 'Synthetic additional instruction' }),
  });
  const path = (action: Action) => `/api/workspaces/${space.id}/replicas/${replica.id}/${action}`;
  return {
    ...relay,
    space,
    host,
    replica,
    input,
    path,
    controls,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}

test('question answers and steer use scoped canonical routes and preserve the exact payload and operation', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const host of f.space.hosts) {
    const replica = f.space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
    const synthetic = f.hosts.find((h) => h.device.id === host.deviceId)!;
    for (const action of actions) {
      const response = await f.api(
        `/api/workspaces/${f.space.id}/replicas/${replica.id}/${action}`,
        f.input(action),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json();
      assert.equal(result.operationId, f.input(action).operationId);
      assert.equal(result.expectedTurnId, 'active-assistant-turn');
      const request = synthetic.messages.at(-1);
      assert.equal(request.method, action === 'steer' ? 'steer' : 'answer-question');
      assert.equal(request.localProjectId, replica.localProjectId);
      assert.deepEqual(request.params, f.input(action));
    }
  }
  for (const table of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    assert.match(String(table.name), /^[a-z_]+$/u);
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table.name}`).all()),
      /synthetic response|Synthetic additional instruction|active-question|active-assistant-turn/,
    );
  }
});

test('interaction routes reject foreign ownership and invalid scope before forwarding to a host', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const action of actions) {
    for (const login of [undefined, f.store.createLogin('other-account')]) {
      const response = await fetch(f.origin + f.path(action), {
        method: 'POST',
        headers: {
          Origin: f.origin,
          'Content-Type': 'application/json',
          ...(login ? { Cookie: 'personal=' + login } : {}),
        },
        body: JSON.stringify(f.input(action)),
      });
      assert.equal(response.status, login ? 404 : 401);
    }
    for (const change of [
      { workspaceId: 'wrong' },
      { localProjectId: 'wrong' },
      { expectedTurnId: '' },
      { sessionId: '' },
      { owner: 'injected-owner' },
      { modelId: 'injected-model' },
    ])
      assert.equal((await f.api(f.path(action), { ...f.input(action), ...change })).status, 400);
    assert.equal((await f.api(f.path(action) + '/extra', f.input(action))).status, 404);
  }
  assert.equal((await f.api(f.path('steer'), { ...f.input('steer'), prompt: ' ' })).status, 400);
  assert.equal(
    (
      await f.api(f.path('question-answers'), {
        ...f.input('question-answers'),
        answer: { action: 'accept', values: { selection: { command: 'injected' } } },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.api(f.path('steer'), { ...f.input('steer'), padding: 'x'.repeat(128 * 1024) })).status,
    413,
  );
  assert.equal(
    (
      await f.api(f.path('question-answers'), {
        ...f.input('question-answers'),
        padding: 'x'.repeat(2 * 1024 * 1024),
      })
    ).status,
    413,
  );
  assert.equal(
    f.synthetic.messages.some((m) => ['steer', 'answer-question'].includes(m.method)),
    false,
  );
});

test('interaction confirmations must match full scope, operation, active turn and question identity', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const action of actions)
    for (const change of [
      { operationId: 'other' },
      { workspaceId: 'other' },
      { localProjectId: 'other' },
      { sessionId: 'other' },
      { expectedTurnId: 'other' },
      { accepted: false },
      { delivered: false },
    ]) {
      f.controls.transform = (result) => ({ ...result, ...change });
      const response = await f.api(f.path(action), f.input(action));
      assert.equal(response.status, 502);
      assert.equal((await response.json()).rejected, false);
    }
  f.controls.transform = (result) => ({ ...result, activityBound: false });
  assert.equal((await f.api(f.path('steer'), f.input('steer'))).status, 502);
  f.controls.transform = (result) => ({ ...result, requestId: 'old-question' });
  assert.equal((await f.api(f.path('question-answers'), f.input('question-answers'))).status, 502);
});

test('in-flight interaction receipts stay unknown when account or execution ownership changes', async (t) => {
  for (const action of actions)
    for (const change of ['logout', 'move', 'unavailable'] as const)
      await t.test(action + '/' + change, async (t) => {
        const f = await fixture();
        t.after(f.close);
        let observed!: () => void, release!: () => void;
        const entered = new Promise<void>((resolve) => {
          observed = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        f.controls.hold = async () => {
          observed();
          await held;
        };
        const pending = f.api(f.path(action), f.input(action));
        await entered;
        try {
          let status: number;
          if (change === 'logout') {
            await f.api('/api/logout', {});
            status = 401;
          } else if (change === 'move') {
            const target = await (
              await f.api('/api/workspaces', { name: 'Synthetic destination' })
            ).json();
            await f.api(`/api/workspaces/${f.space.id}/hosts/${f.host.id}/move`, {
              workspaceId: target.id,
            });
            status = 404;
          } else {
            const pong = once(f.synthetic.socket, 'pong');
            f.synthetic.socket.send(JSON.stringify({ type: 'unavailable' }));
            f.synthetic.socket.ping();
            await pong;
            status = 409;
          }
          release();
          const response = await pending;
          assert.equal(response.status, status);
          const result = await response.json();
          assert.equal(result.rejected, false);
          assert.equal('accepted' in result, false);
        } finally {
          release();
        }
      });
});
