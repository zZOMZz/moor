import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CliState, cliAncestorAllowed, type CliTarget } from '../src/cli/state';
import { parseCliArgs } from '../src/cli/args';
const target: CliTarget & { sessionId: string } = {
  serverKey: 'https://synthetic.invalid',
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
  sessionId: 'session',
};
const input = (operationId = 'op') => ({
  operationId,
  kind: 'create' as const,
  target,
  path: '/api/workspaces/catalog/replicas/replica/session-control',
  body: JSON.stringify({
    operationId,
    workspaceId: 'runtime',
    localProjectId: 'project',
    sessionId: 'session',
    action: 'create',
    agentId: 'agent',
    title: 'private synthetic',
  }),
});
test('CLI parser keeps text off argv and rejects ignored or ambiguous flags', () => {
  assert.equal(
    parseCliArgs(['session', 'send', 'session', '--stdin', '--wait', '--json']).flags.stdin,
    true,
  );
  for (const argv of [
    ['auth', 'login', '--password', 'secret'],
    ['session', 'send', 'two', 'words'],
    ['operation', 'retry'],
    ['session', 'stop', '--file', 'file'],
    ['config', 'show', '--stdin'],
    ['session', 'read', '--timeout', '4'],
    ['session', 'create', 'id'],
    ['session', 'send', 'id', '--session', 'other'],
  ])
    assert.throws(() => parseCliArgs(argv));
});
test('private durable outbox preserves exact bytes and prevents competing stages or changed identities', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moor-cli-state-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new CliState(dir);
  const op = store.stage(input());
  assert.equal(statSync(join(dir, 'moor-cli-v1.sqlite')).mode & 0o777, 0o600);
  assert.deepEqual(store.stage(input()), op);
  assert.throws(() =>
    store.stage({ ...input(), target: { ...target, serverKey: 'https://other.invalid' } }),
  );
  assert.throws(() => store.stage(input('another')), /原操作/);
  store.close();
  store = new CliState(dir);
  assert.equal(store.operation('op')?.body, input().body);
  assert.equal(store.operation('op')?.state, 'pending');
  store.transition('op', ['pending'], 'accepted', { confirmed: true });
  assert.equal(store.stage(input('another')).state, 'pending');
  store.close();
  assert.ok(readFileSync(join(dir, 'moor-cli-v1.sqlite')).length > 0);
});
test('state rejects shared/hardlinked/symlink ancestry and detects moved directory before later writes', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-cli-private-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'private'),
    store = new CliState(dir);
  store.set('safe', 1);
  assert.throws(() => store.assertOutsideProjects([root]), /项目/);
  renameSync(dir, join(root, 'moved'));
  assert.throws(() => store.set('safe', 2));
  store.close();
  symlinkSync(join(root, 'moved'), dir, 'dir');
  assert.throws(() => new CliState(dir));
  rmSync(dir);
  renameSync(join(root, 'moved'), dir);
  linkSync(join(dir, 'moor-cli-v1.sqlite'), join(root, 'hardlink'));
  assert.throws(() => new CliState(dir));
  rmSync(join(root, 'hardlink'));
  chmodSync(dir, 0o777);
  assert.throws(() => new CliState(dir));
});

test('only root or current-user ancestors can protect a private CLI leaf', () => {
  assert.equal(cliAncestorAllowed({ uid: 123, mode: 0o755 }, 123), true);
  assert.equal(cliAncestorAllowed({ uid: 0, mode: 0o1777 }, 123), true);
  assert.equal(cliAncestorAllowed({ uid: 456, mode: 0o755 }, 123), false);
  assert.equal(cliAncestorAllowed({ uid: 456, mode: 0o1777 }, 123), false);
  assert.equal(cliAncestorAllowed({ uid: 123, mode: 0o777 }, 123), false);
});

test('CLI operation listing bounds history and selects summaries without loading original bodies', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moor-cli-summary-')));
  const store = new CliState(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (let index = 0; index < 102; index++) {
    const op = store.stage(input('op-' + index));
    store.transition(op.operationId, ['pending'], 'accepted', {
      confirmed: true,
      status: 'accepted',
      private: 'not a summary',
    });
  }
  const list = store.operationSummaries();
  assert.equal(list.operations.length, 100);
  assert.equal(list.truncated, true);
  assert.equal(list.limit, 100);
  assert.equal(list.operations[0]!.operationId, 'op-101');
  assert.ok(!JSON.stringify(list).includes('private synthetic'));
  assert.ok(!JSON.stringify(list).includes('not a summary'));
  const originalRead = store.operation.bind(store);
  store.operation = () => {
    throw new Error('should not load original operation for summaries');
  };
  assert.equal(store.operationSummaries(1).operations.length, 1);
  store.operation = originalRead;
  assert.equal(store.operation('op-0')?.body, input('op-0').body);
});
