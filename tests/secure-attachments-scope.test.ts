import test from 'node:test';
import assert from 'node:assert/strict';
import { SecureAttachments } from '../src/web/secure-attachments';
import { SecureStore, type SecureStorageBackend } from '../src/web/secure-store';
import type { SecureCliTarget } from '../src/cli/secure-operation';
import { productCanonicalJson } from '../src/security/encrypted-product-catalog';

class Memory implements SecureStorageBackend {
  readonly values = new Map<string, unknown>();
  readonly locks = new Map<string, Promise<void>>();
  beforeRead?: () => void;
  beforeCommit?: () => void;
  writes = 0;
  async read(key: string) {
    this.beforeRead?.();
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    this.beforeCommit?.();
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
    this.writes++;
  }
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, held);
    await previous;
    try {
      current();
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === held) this.locks.delete(key);
    }
  }
}
const target: SecureCliTarget = {
  origin: 'https://synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'project',
  userId: 'local-owner',
  machineId: 'machine',
  sessionId: 'session',
  product: { catalogWorkspaceId: 'space', projectId: 'product', replicaId: 'replica', revision: 1 },
};
const current = () => {};
const key = (kind: 'draft' | 'cache', selected = target) =>
  productCanonicalJson([`moor-secure-attachments-${kind}-v1`, selected]);
async function fixture() {
  const memory = new Memory(),
    store = new SecureStore(memory),
    attachments = new SecureAttachments(store);
  const [item] = await attachments.addFiles(
    target,
    [],
    [new File(['SYNTHETIC_SCOPED_CONTENT'], 'synthetic.txt', { type: 'text/plain' })],
    current,
  );
  const returned = {
    contentVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    confirmed: true,
    attachment: item.reference,
    data: item.data,
  };
  await attachments.readContent(target, item.reference, current, async () => returned);
  return { memory, store, attachments, item, returned };
}

test('cold attachment draft and cache reads verify and retain the complete persisted target', async () => {
  const f = await fixture();
  for (const kind of ['draft', 'cache'] as const) {
    const document = f.memory.values.get(key(kind)) as { target: SecureCliTarget };
    assert.deepEqual(document.target, target);
  }
  const reopened = new SecureAttachments(new SecureStore(f.memory));
  assert.deepEqual(await reopened.read(target, current), [f.item]);
  const cached = await reopened.readContent(target, f.item.reference, current);
  assert.deepEqual(cached.target, target);
  assert.equal(cached.data, f.item.data);
  assert.equal(cached.source, 'cache');
  const expected = await reopened.read(target, current);
  await reopened.addFiles(
    target,
    expected,
    [new File(['second'], 'second.txt', { type: 'text/plain' })],
    current,
  );
  assert.deepEqual(
    (f.memory.values.get(key('draft')) as { target: SecureCliTarget }).target,
    target,
  );
});

test('copied whole attachment draft and cache rows cannot adopt another authority, runtime or product target', async () => {
  const f = await fixture();
  const variants: SecureCliTarget[] = [
    ...(
      [
        'origin',
        'owner',
        'rootKeyId',
        'clientDeviceId',
        'hostDeviceId',
        'workspaceId',
        'localProjectId',
        'userId',
        'machineId',
        'sessionId',
      ] as const
    ).map((field) => ({
      ...target,
      [field]:
        field === 'origin'
          ? 'https://other.synthetic.invalid'
          : field === 'rootKeyId'
            ? Buffer.alloc(32, 2).toString('base64url')
            : 'other',
    })),
    ...(['catalogWorkspaceId', 'projectId', 'replicaId', 'revision'] as const).map((field) => ({
      ...target,
      product: { ...target.product!, [field]: field === 'revision' ? 2 : 'other' },
    })),
  ];
  for (const selected of variants) {
    for (const kind of ['draft', 'cache'] as const) {
      f.memory.values.set(key(kind, selected), structuredClone(f.memory.values.get(key(kind))));
      const before = structuredClone(f.memory.values),
        reopened = new SecureAttachments(new SecureStore(f.memory));
      await assert.rejects(
        kind === 'draft'
          ? reopened.read(selected, current)
          : reopened.readContent(selected, f.item.reference, current),
        /完整执行身份不匹配/,
      );
      assert.deepEqual(f.memory.values, before);
    }
  }
});

test('unscoped older rows fail closed and are never repaired from their storage key', async () => {
  const f = await fixture();
  for (const kind of ['draft', 'cache'] as const) {
    const document = structuredClone(f.memory.values.get(key(kind))) as Record<string, unknown>;
    delete document.target;
    f.memory.values.set(key(kind), document);
  }
  const before = structuredClone(f.memory.values),
    reopened = new SecureAttachments(new SecureStore(f.memory));
  await assert.rejects(reopened.read(target, current));
  await assert.rejects(reopened.readContent(target, f.item.reference, current));
  await assert.rejects(
    reopened.addFiles(target, [], [new File(['new'], 'new.txt', { type: 'text/plain' })], current),
  );
  assert.deepEqual(f.memory.values, before);
  // An independently verified Host response remains useful; the invalid local row is not imported or migrated.
  const fresh = await reopened.readContent(
    target,
    f.item.reference,
    current,
    async () => f.returned,
  );
  assert.equal(fresh.source, 'host');
  assert.equal(fresh.cacheSaved, false);
  assert.deepEqual(f.memory.values, before);
});

test('attachment identity is rechecked after storage read and before CAS so expiry cannot return or persist data', async () => {
  for (const phase of ['read-draft', 'read-cache', 'write-draft', 'write-cache']) {
    const f = await fixture(),
      before = structuredClone(f.memory.values);
    let active = true;
    const lease = () => {
      if (!active) throw Error('Synthetic expired identity');
    };
    if (phase.startsWith('read'))
      f.memory.beforeRead = () => {
        active = false;
      };
    else
      f.memory.beforeCommit = () => {
        active = false;
      };
    const action =
      phase === 'read-draft'
        ? f.attachments.read(target, lease)
        : phase === 'read-cache'
          ? f.attachments.readContent(target, f.item.reference, lease)
          : phase === 'write-cache'
            ? f.attachments.readContent(target, f.item.reference, lease, async () => f.returned)
            : f.attachments.addFiles(
                target,
                [f.item],
                [new File(['new'], 'new.txt', { type: 'text/plain' })],
                lease,
              );
    await assert.rejects(action, /Synthetic expired identity/);
    assert.deepEqual(f.memory.values, before);
  }
});

test('a conflicting replacement at the cache CAS boundary cannot be overwritten or returned as verified content', async () => {
  const f = await fixture(),
    other = { ...target, owner: 'other-owner' };
  f.memory.beforeCommit = () => {
    const row = structuredClone(f.memory.values.get(key('cache'))) as { target: SecureCliTarget };
    row.target = other;
    f.memory.values.set(key('cache'), row);
  };
  const result = await f.attachments.readContent(
    target,
    f.item.reference,
    current,
    async () => f.returned,
  );
  assert.equal(result.source, 'host');
  assert.equal(result.cacheSaved, false);
  assert.deepEqual(
    (f.memory.values.get(key('cache')) as { target: SecureCliTarget }).target,
    other,
  );
  await assert.rejects(
    f.attachments.readContent(target, f.item.reference, current),
    /完整执行身份不匹配/,
  );
});
