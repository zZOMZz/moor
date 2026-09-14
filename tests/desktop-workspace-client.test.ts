import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopWorkspaceClient } from '../src/desktop/workspace-client';
import { desktopWorkspaceCatalogSchema } from '../src/desktop/workspace-protocol';
import type { AttentionActor } from '../src/attention';
import { agentModelFailures } from '../src/agent-errors';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(source: 'local' | 'remote' = 'local') {
  const identity = {
    owner: 'account',
    deviceId: 'device',
    workspaceId: 'runtime',
    machineId: 'machine',
    userId: 'user',
  };
  const runtime = {
    id: 'runtime',
    machineId: 'machine',
    userId: 'user',
    name: 'Runtime',
    projects: [{ id: 'local-project', name: 'Project', rootPath: '/synthetic/project' }],
    agents: [],
    features: [] as string[],
  };
  const catalog = [
    {
      id: 'workspace',
      name: 'Workspace',
      hosts: [
        {
          id: 'host',
          deviceId: 'device',
          machineId: 'machine',
          runtimeWorkspaceId: 'runtime',
          name: 'Computer',
          online: true,
          agents: [],
        },
      ],
      projects: [{ id: 'project', name: 'Project' }],
      replicas: [
        {
          id: 'replica',
          projectId: 'project',
          hostId: 'host',
          localProjectId: 'local-project',
          available: true,
        },
      ],
    },
  ];
  const calls: { path: string; method: string; body: string | undefined }[] = [];
  const state = {
    owner: 'account',
    actor: undefined as AttentionActor | undefined,
    current: true,
    response: [] as unknown,
    responseGate: undefined as ReturnType<typeof gate> | undefined,
    entered: gate(),
    fail: false,
    rejected: false,
    errorMessage: 'SYNTHETIC_PRIVATE_RESPONSE',
  };
  const client = new DesktopWorkspaceClient({
    source,
    origin: 'https://relay.synthetic.invalid',
    cookie: 'personal=SYNTHETIC_COOKIE_123456789',
    ...(source === 'local' ? { localIdentity: identity } : {}),
    current: () => {
      if (!state.current) throw Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');
    },
    fetch: (async (url: string, options: RequestInit) => {
      assert.equal(options.redirect, 'error');
      assert.equal(
        new Headers(options.headers).get('Cookie'),
        'personal=SYNTHETIC_COOKIE_123456789',
      );
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method!, body: options.body as string | undefined });
      if (path === '/api/me')
        return Response.json({
          owner: state.owner,
          ...(state.actor ? { actor: state.actor } : {}),
        });
      if (path === '/api/workspaces') return Response.json(catalog);
      if (path === '/api/devices')
        return Response.json([
          { id: 'device', name: 'Computer', online: true, workspaces: [runtime] },
        ]);
      state.entered.release();
      await state.responseGate?.promise;
      if (state.fail) throw Error('SYNTHETIC_PRIVATE_NETWORK_FAILURE');
      return Response.json(
        state.rejected ? { error: state.errorMessage, rejected: true } : state.response,
        { status: state.rejected ? 409 : 200 },
      );
    }) as typeof fetch,
  });
  async function request(method = 'sessions', params = {}, sessionId?: string) {
    const response: any = await client.request({ action: 'catalog', source });
    assert.equal(response.ok, true);
    const shown = desktopWorkspaceCatalogSchema.parse(response.value);
    return {
      action: 'execute',
      source,
      connectionId: shown.connectionId,
      target: { ...shown.targets[0]!.target, ...(sessionId ? { sessionId } : {}) },
      command: { workspaceId: 'runtime', localProjectId: 'local-project', method, params },
    };
  }
  return { client, state, runtime, catalog, calls, request };
}

test('desktop workspace catalog and commands bind the exact local identity and return validated data', async () => {
  const f = fixture(),
    request = await f.request();
  assert.equal(request.target.serverKey, 'local:machine');
  assert.equal(request.target.catalogProjectId, 'project');
  assert.deepEqual(await f.client.request(request), { ok: true, value: [] });
  const actions = f.calls.filter((call) => call.path.includes('/replicas/'));
  assert.deepEqual(actions, [
    { path: '/api/workspaces/workspace/replicas/replica/sessions', method: 'GET', body: undefined },
  ]);
  assert(
    !JSON.stringify(await f.client.request({ action: 'catalog', source: 'local' })).includes(
      'SYNTHETIC_COOKIE',
    ),
  );
  f.client.close();
});

test('workspace model diagnostics preserve only the known public failure categories', async () => {
  const f = fixture(),
    request = await f.request('agent-options', { agentId: 'agent' });
  f.state.rejected = true;
  for (const message of Object.values(agentModelFailures)) {
    f.state.errorMessage = message;
    const response: any = await f.client.request(request);
    assert.equal(response.ok, false);
    assert.equal(response.error.message, message);
  }
  f.state.errorMessage = 'SYNTHETIC_PRIVATE_RESPONSE';
  assert(!JSON.stringify(await f.client.request(request)).includes('SYNTHETIC_PRIVATE'));
});

test('desktop rejects arbitrary endpoints, cross-scope commands and changed mappings before dispatch', async () => {
  const f = fixture('remote'),
    original = await f.request('cancel', { sessionId: 'session', turnId: 'turn' }, 'session');
  for (const patch of [
    { url: 'https://other.synthetic.invalid/api/me' },
    { cookie: 'credential' },
    { source: 'local' },
    { connectionId: '00000000-0000-4000-8000-000000000000' },
    { target: { ...original.target, owner: 'other' } },
    { target: { ...original.target, sessionId: 'other' } },
    { command: { ...original.command, localProjectId: 'other' } },
    { command: { ...original.command, method: 'raw-shell', params: { command: 'echo unsafe' } } },
  ])
    assert.equal(((await f.client.request({ ...original, ...patch })) as any).ok, false);
  f.catalog[0]!.replicas[0]!.projectId = 'another-project';
  f.catalog[0]!.projects.push({ id: 'another-project', name: 'Another' });
  assert.equal(((await f.client.request(original)) as any).ok, false);
  assert.equal(f.calls.filter((call) => call.path.includes('/replicas/')).length, 0);
});

test('workspace delivery retains the original body and treats lost or mismatched receipts as unknown without replay', async () => {
  const f = fixture(),
    params = {
      operationId: 'original-operation',
      workspaceId: 'runtime',
      sessionId: 'session',
      kind: 'turn',
      expectedTurnId: null,
      update: 'AA==',
    };
  const original = await f.request('mutate', params, 'session');
  f.state.response = { accepted: true, delivered: true, operationId: params.operationId };
  const first: any = await f.client.request(original);
  assert.equal(first.ok, true);
  let writes = f.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]!.body!), params);
  f.state.fail = true;
  const lost: any = await f.client.request(original);
  assert.equal(lost.ok, false);
  assert.equal(lost.error.rejected, false);
  await f.client.request({ action: 'catalog', source: 'local' });
  writes = f.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[1]!.body, writes[0]!.body);
  assert(!JSON.stringify(lost).includes('SYNTHETIC_PRIVATE'));
  f.state.fail = false;
  f.state.response = { accepted: true, delivered: true, operationId: 'another-operation' };
  assert.equal(((await f.client.request(original)) as any).ok, false);
});

test('account, document and catalog changes invalidate late workspace responses', async () => {
  for (const change of ['account', 'document', 'catalog'] as const) {
    const f = fixture('remote'),
      request = await f.request();
    f.state.responseGate = gate();
    const pending = f.client.request(request);
    await f.state.entered.promise;
    if (change === 'account') f.state.owner = 'other';
    if (change === 'document') f.state.current = false;
    if (change === 'catalog') f.catalog[0]!.replicas[0]!.available = false;
    f.state.responseGate.release();
    assert.equal(((await pending) as any).ok, false);
    assert.equal(f.calls.filter((call) => call.path.includes('/replicas/')).length, 1);
  }
});

test('workspace response validation rejects fabricated session identity and revoked local host identity', async () => {
  const f = fixture(),
    request = await f.request();
  f.state.response = [
    {
      id: 'session',
      userId: 'other-user',
      machineId: 'machine',
      project: { kind: 'local', localProjectId: 'local-project' },
      agentConfigId: 'agent',
      cliType: 'fixture',
      agentType: 'fixture',
    },
  ];
  assert.equal(((await f.client.request(request)) as any).ok, false);
  f.runtime.machineId = 'other-machine';
  const before = f.calls.length;
  const invalid: any = await f.client.request(request);
  assert.equal(invalid.ok, false);
  assert.equal(f.calls.slice(before).filter((call) => call.path.includes('/replicas/')).length, 0);
});

async function attentionRequest(
  f: ReturnType<typeof fixture>,
  kind: 'list' | 'items' | 'detail' | 'seen' = 'list',
) {
  f.state.actor = { kind: 'local', authorityId: 'authority', accountId: 'account' };
  f.runtime.features.push('attention-v1', 'actor-context-v1', 'attention-followup-v1');
  const base = await f.request('sessions');
  return {
    action: 'attention',
    source: base.source,
    connectionId: base.connectionId,
    target: { ...base.target, ...(kind === 'list' ? {} : { sessionId: 'session' }) },
    actor: f.state.actor,
    command:
      kind === 'list' || kind === 'items'
        ? { kind, query: { view: 'pending', limit: 50 } }
        : kind === 'detail'
          ? { kind, itemId: 'item/one' }
          : { kind, itemId: 'item/one', input: { operationId: 'original-seen', eventRevision: 1 } },
  };
}
const attentionItem = {
  itemId: 'item/one',
  sessionId: 'session',
  localProjectId: 'local-project',
  assistantTurnId: 'assistant',
  userTurnId: 'user-turn',
  kind: 'outcome',
  lifecycle: 'ended',
  cause: 'agent_returned',
  eventRevision: 1,
  sequence: 1,
  occurredAt: null,
  summary: 'Synthetic result',
  seenRevision: 0,
  disposition: 'pending',
  observationRevision: 0,
};

test('desktop attention lists, details and originals use fixed routes with authenticated actor identity', async () => {
  const f = fixture();
  const list = await attentionRequest(f);
  f.state.response = {
    sessions: [
      {
        sessionId: 'session',
        title: 'Synthetic',
        isArchived: false,
        items: [attentionItem],
        itemCount: 1,
      },
    ],
    total: 1,
    version: 1,
  };
  assert.equal(((await f.client.request(list)) as any).ok, true);
  const items = await attentionRequest(f, 'items');
  f.state.response = { items: [attentionItem], total: 1, version: 1 };
  assert.equal(((await f.client.request(items)) as any).ok, true);
  const detail = await attentionRequest(f, 'detail');
  f.state.response = {
    item: attentionItem,
    title: 'Synthetic',
    isArchived: false,
    turn: { id: 'assistant' },
    userTurn: { id: 'user-turn' },
  };
  assert.equal(((await f.client.request(detail)) as any).ok, true);
  const seen = await attentionRequest(f, 'seen');
  f.state.response = {
    accepted: true,
    delivered: true,
    operationId: 'original-seen',
    item: attentionItem,
  };
  assert.equal(((await f.client.request(seen)) as any).ok, true);
  const routes = f.calls.filter((call) => call.path.includes('/replicas/'));
  assert.deepEqual(
    routes.map((call) => call.method),
    ['GET', 'GET', 'GET', 'POST'],
  );
  assert.equal(
    routes[2]!.path,
    '/api/workspaces/workspace/replicas/replica/sessions/session/attention/item%2Fone',
  );
  assert.deepEqual(JSON.parse(routes[3]!.body!), seen.command.input);
  f.client.close();
});

test('desktop attention refuses forged actor, missing capability and cross-session requests before sending', async () => {
  const f = fixture('remote'),
    request = await attentionRequest(f, 'seen');
  for (const patch of [
    { actor: { ...request.actor, authorityId: 'foreign' } },
    { actor: { ...request.actor, accountId: 'foreign' } },
    { command: { ...request.command, kind: 'shell' } },
    { url: 'https://foreign.invalid' },
    {
      command: {
        kind: 'continue',
        itemId: 'item/one',
        input: {
          mutation: {
            kind: 'turn',
            workspaceId: 'runtime',
            sessionId: 'other',
            operationId: 'op',
            update: 'AA==',
          },
          eventRevision: 1,
          observationRevision: 0,
        },
      },
    },
    { target: { ...request.target, sessionId: undefined } },
  ])
    assert.equal(((await f.client.request({ ...request, ...patch })) as any).ok, false);
  f.runtime.features.length = 0;
  assert.equal(((await f.client.request(request)) as any).ok, false);
  assert.equal(f.calls.filter((call) => call.path.includes('/replicas/')).length, 0);
  f.client.close();
});

test('desktop attention lost or foreign receipts are not success and reconnect never retries them', async () => {
  const f = fixture(),
    request = await attentionRequest(f, 'seen');
  f.state.response = {
    accepted: true,
    delivered: true,
    operationId: 'foreign',
    item: attentionItem,
  };
  assert.equal(((await f.client.request(request)) as any).ok, false);
  f.state.response = {
    accepted: true,
    delivered: true,
    operationId: 'original-seen',
    item: { ...attentionItem, sessionId: 'foreign' },
  };
  assert.equal(((await f.client.request(request)) as any).ok, false);
  f.state.fail = true;
  assert.equal(((await f.client.request(request)) as any).ok, false);
  f.state.fail = false;
  await f.client.request({ action: 'catalog', source: 'local' });
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 3);
  f.client.close();
});

test('desktop attention rejects results after actor authority changes during an in-flight request', async () => {
  const f = fixture(),
    request = await attentionRequest(f, 'seen');
  f.state.responseGate = gate();
  f.state.response = {
    accepted: true,
    delivered: true,
    operationId: 'original-seen',
    item: attentionItem,
  };
  const pending = f.client.request(request);
  await f.state.entered.promise;
  f.state.actor = { ...f.state.actor!, authorityId: 'replacement-authority' };
  f.state.responseGate.release();
  assert.equal(((await pending) as any).ok, false);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  f.client.close();
});
