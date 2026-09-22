import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { AppError, PROTOCOL } from '@moor/protocol/protocol';
import type { Workspace } from '@moor/protocol/catalog';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import {
  SESSION_PAGE_FEATURE,
  SESSION_PAGE_LIMITS,
  sessionPageRequestSchema,
  validateSessionPageResult,
  type SessionPageRequest,
  type SessionPageResult,
} from '@moor/protocol/session-page';
import { readSessionPage } from '@moor/host/sessions/page';
import { syntheticRelay } from '../fixtures/synthetic-relay';
import { syntheticSessionPageIndex } from '../fixtures/session-page-index';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function hello(peer: Awaited<ReturnType<typeof syntheticRelay>>['hosts'][number]) {
  const pong = once(peer.socket, 'pong');
  peer.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: peer.runtime.machineId,
      workspaces: [peer.runtime],
    }),
  );
  peer.socket.ping();
  await pong;
}
async function fixture() {
  const relay = await syntheticRelay();
  const projections: ReturnType<typeof syntheticSessionPageIndex>[] = [];
  const controls: {
    hold?: () => Promise<void>;
    transform?: (page: SessionPageResult) => unknown;
  } = {};
  const rows = new Map<string, SessionMetadata[]>();
  for (const peer of relay.hosts) {
    peer.runtime.features!.push(SESSION_PAGE_FEATURE);
    const metadata: SessionMetadata[] = peer.runtime.projects.flatMap((project) =>
      Array.from({ length: 75 }, (_, index) => ({
        id:
          'session-' +
          String(index).padStart(3, '0') +
          (project.id === 'local-moor' ? '' : '-' + project.id),
        userId: peer.runtime.userId,
        machineId: peer.runtime.machineId,
        project: { kind: 'local' as const, localProjectId: project.id },
        agentConfigId: 'agent',
        cliType: 'builtin',
        agentType: 'codex',
        title: `${peer.runtime.machineId}/${project.id}/${index}`,
        lastMessageAt: index,
        isPinned: index === 0,
        isArchived: false,
        metadataRevision: 0,
      })),
    );
    rows.set(peer.device.id, metadata);
    const projection = syntheticSessionPageIndex(metadata);
    projections.push(projection);
    peer.responses.set('sessions-page', async (message) => {
      try {
        projection.sync();
        const page = readSessionPage(
          {
            workspace: peer.runtime,
            index: projection.index,
          },
          sessionPageRequestSchema.parse(message.params),
          message.localProjectId,
        );
        await controls.hold?.();
        return controls.transform ? controls.transform(page) : page;
      } catch (error) {
        // The fixture's custom responder can send a Host error envelope; its
        // following empty response is ignored after the original RPC settles.
        peer.socket.send(
          JSON.stringify({
            type: 'response',
            requestId: message.requestId,
            error: {
              status: error instanceof AppError ? error.status : 502,
              message: 'Synthetic page unavailable',
              rejected: false,
            },
          }),
        );
        return undefined;
      }
    });
    await hello(peer);
  }
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0],
    peer = relay.hosts.find((value) => value.device.id === host.deviceId)!,
    replica = space.replicas.find(
      (value) => value.hostId === host.id && value.localProjectId === 'local-moor',
    )!;
  const base = `/api/workspaces/${space.id}/replicas/${replica.id}`;
  const path = base + '/sessions-page';
  const request = (extra: Partial<SessionPageRequest> = {}) =>
    sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: peer.runtime.id,
      localProjectId: replica.localProjectId,
      ...extra,
    });
  return {
    ...relay,
    close: async () => {
      await relay.close();
      for (const projection of projections) projection.close();
    },
    controls,
    rows,
    space,
    host,
    peer,
    replica,
    path,
    request,
    call: (extra: Partial<SessionPageRequest> = {}) => relay.api(path, request(extra)),
    requests: () =>
      relay.hosts.flatMap((value) =>
        value.messages.filter(
          (message) => message.type === 'request' && message.method === 'sessions-page',
        ),
      ),
  };
}

test('real relay forwards exact project pagination and transfers bounded pages without storing a session index', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const ids: string[] = [];
  let cursor: string | undefined, revision: string | undefined;
  do {
    const input = f.request(cursor ? { cursor } : {}),
      response = await f.api(f.path, input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bytes = await response.text();
    assert(Buffer.byteLength(bytes) <= SESSION_PAGE_LIMITS.responseBytes);
    const page = validateSessionPageResult(input, JSON.parse(bytes));
    assert(page.items.length <= 30);
    assert(
      page.items.every(
        (item) =>
          item.userId === f.peer.runtime.userId &&
          item.machineId === f.peer.runtime.machineId &&
          item.project.localProjectId === f.replica.localProjectId,
      ),
    );
    if (revision) assert.equal(page.revision, revision);
    revision = page.revision;
    ids.push(...page.items.map((item) => item.id));
    const forwarded = f.requests().at(-1)!;
    assert.equal(forwarded.workspaceId, f.peer.runtime.id);
    assert.equal(forwarded.localProjectId, f.replica.localProjectId);
    assert.deepEqual(forwarded.params, input);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.length, 75);
  assert.equal(new Set(ids).size, 75);
  assert.equal(ids[0], 'session-000');
  assert.equal(f.requests().length, 3);
  assert.equal(
    f.hosts.reduce((count, peer) => count + peer.operations.size, 0),
    0,
  );
  for (const name of ['session', 'session_delta', 'search_document'])
    assert.equal(
      f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
      undefined,
    );
});

test('actual Host page helper reports stale cursors through the relay as 409 without replay or silent restart', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const first = validateSessionPageResult(f.request(), await (await f.call()).json());
  const row = f.rows
    .get(f.peer.device.id)!
    .find((item) => item.project.localProjectId === f.replica.localProjectId)!;
  row.title = 'changed metadata with stable timestamp';
  const stale = await f.call({ cursor: first.nextCursor! });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).rejected, false);
  assert.equal(f.requests().length, 2);
  const refreshed = validateSessionPageResult(f.request(), await (await f.call()).json());
  assert.notEqual(refreshed.revision, first.revision);
  assert.equal(f.requests().length, 3);
});

test('page route rejects foreign request scope, missing login, unrelated accounts and unadvertised support before forwarding', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const unauthenticated = await fetch(f.origin + f.path, {
    method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(f.request()),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await f.api(f.path, f.request({ workspaceId: 'other' }))).status, 400);
  assert.equal((await f.api(f.path, f.request({ localProjectId: 'local-other' }))).status, 400);
  assert.equal((await f.api(f.path, { ...f.request(), limit: 101 })).status, 400);
  assert.equal((await f.api(f.path + '/extra', f.request())).status, 404);
  assert.equal((await f.api(f.path)).status, 404);
  const invitation = f.store.inviteAccount(f.owner);
  const otherSecret = await f.store.redeemAccountInvitation(
    invitation.invitation,
    'another@synthetic.invalid',
    'another-synthetic-password',
  );
  const foreign = await fetch(f.origin + f.path, {
    method: 'POST',
    headers: {
      Origin: f.origin,
      Cookie: 'personal=' + otherSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(f.request()),
  });
  assert.equal(foreign.status, 404);
  f.peer.runtime.features = f.peer.runtime.features!.filter(
    (feature) => feature !== SESSION_PAGE_FEATURE,
  );
  await hello(f.peer);
  assert.equal((await f.call()).status, 409);
  assert.equal(f.requests().length, 0);
});

test('shared relay response validation rejects forged page scope, metadata identities and page limits', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const changes: Array<(page: SessionPageResult) => unknown> = [
    (page) => ({ ...page, workspaceId: 'other' }),
    (page) => ({ ...page, localProjectId: 'local-other' }),
    (page) => ({
      ...page,
      items: [{ ...page.items[0], userId: 'another-owner', title: 'PRIVATE_HOST_RESULT' }],
    }),
    (page) => ({
      ...page,
      items: [{ ...page.items[0], machineId: 'another-machine', title: 'PRIVATE_HOST_RESULT' }],
    }),
    (page) => ({
      ...page,
      items: [{ ...page.items[0], project: { kind: 'local', localProjectId: 'local-other' } }],
    }),
    (page) => ({ ...page, items: [...page.items, page.items[0]] }),
    (page) => ({ ...page, items: [...page.items].reverse() }),
    (page) => ({
      ...page,
      nextCursor: null,
      padding: 'PRIVATE_HOST_RESULT' + 'x'.repeat(SESSION_PAGE_LIMITS.responseBytes),
    }),
  ];
  for (const transform of changes) {
    f.controls.transform = transform;
    const response = await f.call();
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.rejected, false);
    assert.doesNotMatch(
      JSON.stringify(body),
      /PRIVATE_HOST_RESULT|another-owner|another-machine|items/,
    );
  }
});

for (const change of ['logout', 'device-revocation', 'assignment', 'reconnect'] as const)
  test(`relay withholds a completed page after in-flight ${change}`, async (t) => {
    const f = await fixture();
    t.after(f.close);
    const entered = signal(),
      release = signal();
    t.after(release.resolve);
    f.controls.hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.call();
    await entered.promise;
    if (change === 'logout') f.store.logout(f.secret);
    if (change === 'device-revocation') f.store.revoke(f.owner, f.peer.device.id);
    if (change === 'assignment') {
      const project = f.store.catalog.createProject(f.owner, f.space.id, 'Reassigned', {
        kind: 'local',
      });
      f.store.catalog.assign(f.owner, f.space.id, f.replica.id, project.id);
    }
    if (change === 'reconnect') {
      const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
        headers: { Authorization: 'Bearer ' + f.peer.device.token },
      });
      t.after(() => replacement.terminate());
      await once(replacement, 'open');
      const ready = once(replacement, 'message');
      replacement.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL,
          machineId: f.peer.runtime.machineId,
          workspaces: [f.peer.runtime],
        }),
      );
      await ready;
    }
    release.resolve();
    const response = await pending;
    assert([401, 404, 409].includes(response.status));
    const body = await response.json();
    assert.equal(body.rejected, false);
    assert.doesNotMatch(JSON.stringify(body), /items|machine-A|local-moor\/|Task /);
    assert.equal(f.requests().length, 1);
  });
