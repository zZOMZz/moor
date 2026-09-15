import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DesktopWorkspaceBridge,
  WORKSPACE_CLIENT_LIMITS,
} from '../../apps/desktop/src/main/workspace-bridge.cjs';
import { CLIENT_ORIGIN, CLIENT_URL } from '../../apps/desktop/src/main/client-assets.cjs';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture() {
  const cookies = Object.assign(new EventEmitter(), {
    async get() {
      return [
        {
          name: 'personal',
          value: Buffer.alloc(32, 5).toString('base64url'),
          domain: 'relay.synthetic.invalid',
          hostOnly: true,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          session: true,
        },
      ];
    },
  });
  const contents = {
    mainFrame: { url: CLIENT_URL, origin: CLIENT_ORIGIN },
    session: { cookies },
    isDestroyed: () => false,
  };
  const window = { webContents: contents, isDestroyed: () => false };
  const registry = new Map([
    [contents, { window, trustedClient: true, origin: 'https://relay.synthetic.invalid' }],
  ]);
  const local = {
    origin: 'http://127.0.0.1:5555',
    cookie: 'personal=SYNTHETIC_LOCAL_COOKIE',
    identity: { owner: 'local' },
  };
  const state = {
    local: local as typeof local | undefined,
    origin: 'https://relay.synthetic.invalid',
    loads: 0,
    creates: 0,
    closes: 0,
    calls: [] as any[],
    configurations: [] as any[],
    blocked: undefined as ReturnType<typeof gate> | undefined,
    started: gate(),
  };
  const bridge = new DesktopWorkspaceBridge({
    registry,
    window: () => window,
    local: () => state.local,
    origin: () => state.origin,
    loadRuntime: async () => {
      state.loads++;
      return {
        DesktopWorkspaceClient: class {
          constructor(readonly options: any) {
            state.creates++;
            state.configurations.push(options);
          }
          close() {
            state.closes++;
          }
          async request(request: any) {
            this.options.current();
            state.calls.push(request);
            state.started.release();
            await state.blocked?.promise;
            this.options.current();
            return { ok: true, value: { observed: request.action } };
          }
        },
      };
    },
  });
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  return { bridge, state, contents, window, registry, event, cookies };
}

test('workspace native bridge admits only its current packaged main frame and independently owned connections', async () => {
  const f = fixture();
  assert.equal(
    (await f.bridge.request(f.event(), { action: 'catalog', source: 'local' })).ok,
    true,
  );
  assert.equal(f.state.configurations[0].origin, 'http://127.0.0.1:5555');
  assert.equal(f.state.configurations[0].cookie, 'personal=SYNTHETIC_LOCAL_COOKIE');
  assert.equal(
    (await f.bridge.request(f.event(), { action: 'catalog', source: 'remote' })).ok,
    true,
  );
  assert.equal(f.state.configurations[1].origin, f.state.origin);
  assert.notEqual(f.state.configurations[1].cookie, f.state.configurations[0].cookie);
  const calls = f.state.calls.length;
  assert.equal(
    (
      await f.bridge.request(f.event(), {
        action: 'catalog',
        source: 'local',
        url: 'https://other.synthetic.invalid',
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await f.bridge.request(
        { ...f.event(), senderFrame: { ...f.contents.mainFrame } },
        { action: 'catalog', source: 'local' },
      )
    ).ok,
    false,
  );
  f.contents.mainFrame.url = 'https://relay.synthetic.invalid/';
  assert.equal(
    (await f.bridge.request(f.event(), { action: 'catalog', source: 'local' })).ok,
    false,
  );
  assert.equal(f.state.calls.length, calls);
  f.bridge.close();
  assert.equal(f.state.closes, 2);
});

test('native connection invalidation rejects late responses without selecting another connection or replaying', async () => {
  for (const change of ['local-restart', 'logout', 'document', 'server'] as const) {
    const f = fixture();
    f.state.blocked = gate();
    const source = ['logout', 'server'].includes(change) ? 'remote' : 'local';
    const pending = f.bridge.request(f.event(), { action: 'catalog', source });
    await f.state.started.promise;
    if (change === 'local-restart') f.state.local = { ...f.state.local! };
    if (change === 'logout')
      f.cookies.emit('changed', {}, { name: 'personal', domain: 'relay.synthetic.invalid' });
    if (change === 'document') f.contents.mainFrame = { ...f.contents.mainFrame };
    if (change === 'server') f.state.origin = 'https://other.synthetic.invalid';
    f.state.blocked.release();
    assert.equal((await pending).ok, false);
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.state.creates, 1);
    f.bridge.close();
  }
});

test('native admission snapshots JSON and holds bounded slots until requests actually settle', async () => {
  const f = fixture();
  f.state.blocked = gate();
  const request = { action: 'catalog', source: 'local' };
  const pending = Array.from({ length: WORKSPACE_CLIENT_LIMITS.pending }, () =>
    f.bridge.request(f.event(), request),
  );
  request.source = 'remote';
  await f.state.started.promise;
  assert.equal(
    (await f.bridge.request(f.event(), { action: 'catalog', source: 'local' })).ok,
    false,
  );
  assert(f.state.calls.every((call) => call.source === 'local'));
  f.state.blocked.release();
  assert((await Promise.all(pending)).every((result) => result.ok));
  const before = f.state.calls.length;
  assert.equal(
    (
      await f.bridge.request(f.event(), {
        action: 'catalog',
        source: 'local',
        hidden: new ArrayBuffer(16),
      })
    ).ok,
    false,
  );
  assert.equal(f.state.calls.length, before);
  f.bridge.close();
});

test('workspace native bridge admits only the finite attention envelope on its current main frame', async () => {
  const f = fixture();
  const request = {
    action: 'attention',
    source: 'local',
    connectionId: 'synthetic',
    target: {},
    actor: {},
    command: {},
  };
  assert.equal((await f.bridge.request(f.event(), request)).ok, true);
  assert.deepEqual(f.state.calls[0], request);
  assert.equal(
    (await f.bridge.request(f.event(), { ...request, url: 'https://foreign.invalid' })).ok,
    false,
  );
  assert.equal(
    (await f.bridge.request({ ...f.event(), senderFrame: { ...f.contents.mainFrame } }, request))
      .ok,
    false,
  );
  f.bridge.close();
});
