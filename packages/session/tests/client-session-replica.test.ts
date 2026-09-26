import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientSessionReplica, verifiedSessionDelta } from '../src/client-session-replica';
import { readClientSession } from '../src/session-operations';
import { appendSessionText } from '../src/session-output';
import { delta, Flock, LoroDoc, mirror, putMeta, vv } from '../src/model';

const scope = {
  userId: 'synthetic-user',
  machineId: 'synthetic-machine',
  workspaceId: 'synthetic-workspace',
  localProjectId: 'synthetic-project',
  sessionId: 'synthetic-session',
};

function fixture() {
  const doc = new LoroDoc();
  const host = mirror(doc, scope.sessionId);
  host.setState((state) => {
    state.session.id = scope.sessionId;
    for (const [id, finished] of [
      ['settled', true],
      ['active', false],
    ] as const)
      state.history.push({
        id,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        userId: undefined,
        userTurnId: undefined,
        status: undefined,
        read: undefined,
        inputConfig: undefined,
        fileDiff: null,
        finished,
        items: [{ type: 'text', text: id }],
      });
  });
  doc.commit();
  const metadata = new Flock();
  const meta = {
    id: scope.sessionId,
    userId: scope.userId,
    machineId: scope.machineId,
    project: { kind: 'local' as const, localProjectId: scope.localProjectId },
    agentConfigId: 'synthetic-agent',
    cliType: 'custom',
    agentType: 'synthetic',
  };
  putMeta(metadata, 'session-' + scope.sessionId, meta);
  return {
    doc,
    host,
    response: (from?: string) => ({
      meta,
      metaBundle: metadata.exportJson(),
      update: delta(doc, from),
      synced: true as const,
      online: true as const,
      persisted: true,
    }),
    append: (text: string) => appendSessionText(doc, scope.sessionId, 'active', 'text', text),
    close: () => {
      host.dispose();
      doc.free();
    },
  };
}

test('incremental host imports synchronously preserve unchanged turns and immutable earlier views', (t) => {
  const f = fixture();
  const replica = new ClientSessionReplica(scope);
  t.after(() => {
    replica.dispose();
    f.close();
  });
  const first = replica.read(f.response());
  const before = vv(f.doc);
  f.append(' next');
  const second = replica.read(f.response(before));
  assert.equal(second.version, vv(f.doc));
  assert.notEqual(second.version, first.version);
  assert.equal(second.history[0], first.history[0]);
  assert.equal(second.history[0]!.items, first.history[0]!.items);
  assert.notEqual(second.history[1], first.history[1]);
  assert.equal((second.history[1]!.items![0] as { text: string }).text, 'active next');
  assert.equal((first.history[1]!.items![0] as { text: string }).text, 'active');
  for (const value of [first, first.meta, first.history, first.history[0], first.history[0]!.items])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    (first.history[0]!.items![0] as { text: string }).text = 'consumer mutation';
  }, TypeError);
  const noop = replica.read(f.response(vv(f.doc)));
  assert.equal(noop.history, second.history);
  assert.equal(noop.version, second.version);
  assert.equal('update' in noop, false);
});

test('verified delta tokens bind all scope fields and snapshots export the accumulated document explicitly', (t) => {
  const f = fixture();
  const replica = new ClientSessionReplica(scope);
  t.after(() => {
    replica.dispose();
    f.close();
  });
  replica.read(f.response());
  const initial = replica.lastRead!;
  assert.equal(initial.baseVersion, undefined);
  const before = vv(f.doc);
  f.append(' delta');
  const response = f.response(before);
  const next = replica.read(response);
  const accepted = verifiedSessionDelta(replica.lastRead, scope);
  assert.equal(accepted.baseVersion, initial.version);
  assert.equal(accepted.version, next.version);
  assert.equal(accepted.response.update, response.update);
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.response));
  assert.throws(() => verifiedSessionDelta({ ...accepted }, scope));
  assert.throws(() => verifiedSessionDelta(response, scope));
  for (const key of Object.keys(scope) as (keyof typeof scope)[])
    assert.throws(() => verifiedSessionDelta(accepted, { ...scope, [key]: 'different' }));
  const exported = replica.exportSnapshot();
  assert.deepEqual(readClientSession(exported, scope).history, next.history);
  assert.equal(exported.version, next.version);
  assert.equal(exported.update, f.response().update);
});

test('envelope and bundle rejection cannot change a previously accepted document', (t) => {
  const f = fixture();
  const replica = new ClientSessionReplica(scope);
  t.after(() => {
    replica.dispose();
    f.close();
  });
  const first = replica.read(f.response());
  const accepted = replica.lastRead;
  const mismatched = f.response();
  mismatched.meta = { ...mismatched.meta, machineId: 'other-machine' };
  assert.throws(() => replica.read(mismatched));
  const outside = f.response();
  outside.metaBundle.entries['["m","session-other","title"]'] = { c: '1', d: 'outside' };
  assert.throws(() => replica.read(outside));
  assert.equal(replica.view, first);
  assert.equal(replica.lastRead, accepted);
  const before = vv(f.doc);
  f.append(' accepted');
  assert.equal(
    (replica.read(f.response(before)).history[1]!.items![0] as { text: string }).text,
    'active accepted',
  );
});

test('missing predecessor deltas dispose the replica instead of applying pending bytes later', (t) => {
  const f = fixture();
  const replica = new ClientSessionReplica(scope);
  t.after(() => {
    replica.dispose();
    f.close();
  });
  const first = replica.read(f.response());
  f.append(' missing');
  const skipped = vv(f.doc);
  f.append(' pending');
  assert.throws(() => replica.read(f.response(skipped)), /缺少前置版本/);
  assert.equal(replica.view, undefined);
  assert.equal(replica.lastRead, undefined);
  assert.throws(() => replica.read(f.response()), /已释放/);
  assert.throws(() => replica.exportSnapshot(), /已释放/);
  assert.equal((first.history[1]!.items![0] as { text: string }).text, 'active');
  const recovered = new ClientSessionReplica(scope);
  try {
    assert.deepEqual(
      recovered.read(f.response()).history,
      readClientSession(f.response(), scope).history,
    );
  } finally {
    recovered.dispose();
  }
});

test('imported identity changes and malformed CRDT bytes cannot poison a retained view', (t) => {
  const f = fixture();
  t.after(f.close);
  for (const identityChange of [true, false]) {
    const replica = new ClientSessionReplica(scope);
    const first = replica.read(f.response());
    const bad = f.response();
    if (identityChange) {
      const changed = f.doc.fork();
      try {
        changed.getMap('session').set('id', 'another-session');
        changed.commit();
        bad.update = delta(changed);
      } finally {
        changed.free();
      }
    } else bad.update = 'AAAA';
    assert.throws(() => replica.read(bad));
    assert.equal(replica.view, undefined);
    assert.throws(() => replica.exportSnapshot(), /已释放/);
    assert.equal((first.history[0]!.items![0] as { text: string }).text, 'settled');
    replica.dispose();
  }
});

test('reset rehydrates checkpoints and deltas while dispose releases state permanently', (t) => {
  const f = fixture();
  const replica = new ClientSessionReplica(scope);
  t.after(() => {
    replica.dispose();
    f.close();
  });
  const checkpoint = f.response();
  const first = replica.read(checkpoint);
  const before = vv(f.doc);
  f.append(' replayed');
  const update = f.response(before);
  const final = replica.read(update);
  replica.reset();
  assert.equal(replica.view, undefined);
  assert.equal(replica.lastRead, undefined);
  assert.throws(() => replica.exportSnapshot(), /尚未读取/);
  replica.read(checkpoint);
  assert.deepEqual(replica.read(update), final);
  assert.equal((first.history[1]!.items![0] as { text: string }).text, 'active');
  replica.dispose();
  replica.dispose();
  assert.equal(replica.view, undefined);
  assert.equal(replica.lastRead, undefined);
  assert.throws(() => replica.reset(), /已释放/);
  assert.throws(() => replica.read(checkpoint), /已释放/);
});
