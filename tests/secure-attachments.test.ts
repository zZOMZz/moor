import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { SecureAttachments, type SecureAttachmentDraft } from '../src/web/secure-attachments';
import { SecureStore, type SecureStorageBackend } from '../src/web/secure-store';
import {
  secureOriginal,
  type SecureCliOperation,
  type SecureCliTarget,
} from '../src/cli/secure-operation';
import { hostCommandSchema } from '../src/bridge/host-command';

class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  locks = new Map<string, Promise<void>>();
  beforeRead?: (key: string) => Promise<void>;
  beforeWrite?: (key: string) => Promise<void>;
  async read(key: string) {
    await this.beforeRead?.(key);
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeWrite?.(key);
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected, 'CAS conflict');
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, queued);
    await prior;
    try {
      current();
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
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
const now = '2026-01-02T00:00:00.000Z',
  current = () => {};
const file = (name = 'synthetic.txt', text = 'SYNTHETIC_PRIVATE_ATTACHMENT') =>
  new File([text], name, { type: 'text/plain' });
function setup() {
  const memory = new Memory(),
    store = new SecureStore(memory);
  let id = 0;
  return {
    memory,
    store,
    attachments: new SecureAttachments(store, { uuid: () => `attachment-${++id}` }),
  };
}
function request(operation: SecureCliOperation) {
  const command = hostCommandSchema.parse(JSON.parse(operation.body));
  if (command.method !== 'attachment-action') throw Error('Expected attachment');
  return command.params;
}
function receipt(operation: SecureCliOperation) {
  const original = request(operation);
  return {
    contentVersion: 1,
    workspaceId: original.workspaceId,
    localProjectId: original.localProjectId,
    sessionId: original.sessionId,
    operationId: original.operationId,
    accepted: true,
    delivered: true,
    ...(original.action === 'upload' ? { attachment: original.attachment } : { removed: true }),
  };
}
async function uploaded(f: ReturnType<typeof setup>) {
  const items = await f.attachments.addFiles(target, [], [file()], current);
  const original = await f.attachments.stage(
    target,
    items[0].reference.attachmentId,
    'upload',
    'upload',
    now,
    current,
  );
  await f.attachments.confirm(original, receipt(original), current);
  return (await f.attachments.read(target, current))[0];
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}

test('offline attachment drafts persist exact bytes, use complete target isolation and never stage requests', async () => {
  const f = setup(),
    items = await f.attachments.addFiles(target, [], [file()], current);
  assert.equal(items[0].status, 'draft');
  assert.equal(
    items[0].reference.content.version,
    'sha256:' + createHash('sha256').update('SYNTHETIC_PRIVATE_ATTACHMENT').digest('hex'),
  );
  assert.deepEqual(
    await new SecureAttachments(new SecureStore(f.memory)).read(target, current),
    items,
  );
  assert.deepEqual(await f.store.list(target), []);
  for (const field of [
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
  ] as const) {
    const changed = {
      ...target,
      [field]:
        field === 'origin'
          ? 'https://other.invalid'
          : field === 'rootKeyId'
            ? Buffer.alloc(32, 2).toString('base64url')
            : 'other',
    };
    assert.deepEqual(await f.attachments.read(changed, current), [], field);
  }
  for (const field of ['catalogWorkspaceId', 'projectId', 'replicaId', 'revision'] as const)
    assert.deepEqual(
      await f.attachments.read(
        { ...target, product: { ...target.product!, [field]: field === 'revision' ? 2 : 'other' } },
        current,
      ),
      [],
    );
  await assert.rejects(f.attachments.read({ ...target, product: undefined }, current));
});

test('draft count, byte size, file metadata and changed reads fail before persistence', async () => {
  const f = setup();
  await assert.rejects(
    f.attachments.addFiles(
      target,
      [],
      Array.from({ length: 9 }, () => file()),
      current,
    ),
    /8/,
  );
  let read = false;
  const tooLarge = {
    name: 'large.bin',
    type: 'application/octet-stream',
    size: 8 * 1024 * 1024 + 1,
    arrayBuffer: async () => {
      read = true;
      return new ArrayBuffer(0);
    },
  } as File;
  await assert.rejects(f.attachments.addFiles(target, [], [tooLarge], current), /8 MiB/);
  assert.equal(read, false);
  await assert.rejects(f.attachments.addFiles(target, [], [file('../private.txt')], current));
  await assert.rejects(
    f.attachments.addFiles(
      target,
      [],
      [{ ...tooLarge, name: 'changed.bin', size: 1 } as File],
      current,
    ),
    /字节数/,
  );
  assert.deepEqual(await f.attachments.read(target, current), []);
});

test('draft CAS rejects stale append or removal without clearing a new page edit', async () => {
  const f = setup(),
    first = await f.attachments.addFiles(target, [], [file()], current);
  const second = await f.attachments.addFiles(target, first, [file('second.txt')], current);
  await assert.rejects(
    f.attachments.addFiles(target, first, [file('stale.txt')], current),
    /已改变/,
  );
  await assert.rejects(
    f.attachments.removeDraft(target, first, first[0].reference.attachmentId, current),
    /已改变/,
  );
  const remaining = await f.attachments.removeDraft(
    target,
    second,
    first[0].reference.attachmentId,
    current,
  );
  assert.deepEqual(remaining, [second[1]]);
});

test('unknown upload restores original body and blocks changed IDs, removal, forgetting and new product revisions', async () => {
  const f = setup(),
    items = await f.attachments.addFiles(target, [], [file()], current);
  const original = await f.attachments.stage(
    target,
    items[0].reference.attachmentId,
    'upload',
    'original',
    now,
    current,
  );
  await assert.rejects(
    f.store.dispatch(original, current, async () => {
      throw Error('lost reply');
    }),
    /lost reply/,
  );
  const reopened = new SecureAttachments(new SecureStore(f.memory));
  const pending = await reopened.read(target, current);
  assert.equal(pending[0].pendingOperationId, original.operationId);
  assert.equal(pending[0].status, 'pending');
  await assert.rejects(
    reopened.stage(target, items[0].reference.attachmentId, 'upload', 'replacement', now, current),
  );
  await assert.rejects(
    reopened.removeDraft(target, pending, items[0].reference.attachmentId, current),
  );
  await assert.rejects(reopened.forget(target, [items[0].reference], current));
  const changed = { ...target, product: { ...target.product!, revision: 2 } };
  const changedItems = await reopened.addFiles(changed, [], [file()], current);
  await assert.rejects(
    reopened.stage(
      changed,
      changedItems[0].reference.attachmentId,
      'upload',
      'new-map',
      now,
      current,
    ),
    /先核查/,
  );
  const retry = (await f.store.list(target))[0];
  assert.equal(retry.body, original.body);
  assert.equal(retry.requestVersion, original.requestVersion);
  assert.deepEqual(retry.target, original.target);
  assert.equal(secureOriginal(retry).kind, 'attachment');
  const answer = await f.store.dispatch(retry, current, async (sent) => {
    assert.deepEqual(sent, original);
    return receipt(sent);
  });
  await reopened.confirm(retry, answer, current);
  assert.equal((await reopened.read(target, current))[0].status, 'uploaded');
});

test('Host acknowledgement survives reopen without a draft marker; accepted remove never becomes a fresh upload', async () => {
  const f = setup(),
    item = await uploaded(f),
    reopened = new SecureAttachments(new SecureStore(f.memory));
  assert.equal((await reopened.read(target, current))[0].status, 'uploaded');
  await assert.rejects(
    reopened.stage(target, item.reference.attachmentId, 'upload', 'another-upload', now, current),
  );
  const original = await reopened.stage(
    target,
    item.reference.attachmentId,
    'remove',
    'remove',
    now,
    current,
  );
  assert.equal((await reopened.read(target, current))[0].pendingAction, 'remove');
  await reopened.confirm(original, receipt(original), current);
  assert.deepEqual(
    await new SecureAttachments(new SecureStore(f.memory)).read(target, current),
    [],
  );
  await assert.rejects(
    reopened.stage(
      target,
      item.reference.attachmentId,
      'upload',
      'accidental-upload',
      now,
      current,
    ),
  );
});

test('only exact Host receipt can mark uploaded and attachments cannot be falsely sealed', async () => {
  const f = setup(),
    [item] = await f.attachments.addFiles(target, [], [file()], current);
  const original = await f.attachments.stage(
    target,
    item.reference.attachmentId,
    'upload',
    'upload',
    now,
    current,
  );
  for (const change of [
    'operationId',
    'workspaceId',
    'localProjectId',
    'sessionId',
    'name',
    'version',
    'remove',
  ]) {
    const result: any = receipt(original);
    if (change === 'name') result.attachment.name = 'different.txt';
    else if (change === 'version') result.attachment.content.version = 'sha256:' + '0'.repeat(64);
    else if (change === 'remove') {
      delete result.attachment;
      result.removed = true;
    } else result[change] = 'different';
    await assert.rejects(f.attachments.confirm(original, result, current), change);
  }
  for (const state of ['abandoned', 'accepted'] as const)
    await assert.rejects(f.store.transition(original, ['pending'], state, undefined, current));
  assert.equal((await f.attachments.read(target, current))[0].status, 'pending');
});

test('forget removes exact sent references while preserving concurrent new local files', async () => {
  const f = setup(),
    item = await uploaded(f),
    before = await f.attachments.read(target, current);
  const added = await f.attachments.addFiles(target, before, [file('new.txt')], current);
  await assert.rejects(
    f.attachments.forget(target, [{ ...item.reference, name: 'changed.txt' }], current),
    /已改变/,
  );
  assert.deepEqual(await f.attachments.forget(target, [item.reference], current), [added[1]]);
});

test('draft corruption and mismatched stored original upload fail closed', async () => {
  for (const accepted of [false, true]) {
    const f = setup(),
      item = accepted
        ? await uploaded(f)
        : (await f.attachments.addFiles(target, [], [file()], current))[0];
    const entry = [...f.memory.values.entries()].find(([key]) =>
      key.includes('attachments-draft'),
    )!;
    const document = entry[1] as any;
    document.entries[0].data = Buffer.from('other').toString('base64');
    if (accepted)
      document.entries[0].reference.content = {
        ...item.reference.content,
        byteLength: 5,
        version: 'sha256:' + createHash('sha256').update('other').digest('hex'),
      };
    f.memory.values.set(entry[0], document);
    await assert.rejects(f.attachments.read(target, current));
  }
});

test('expired scope during file read, storage write and content hashing never exposes stale results', async () => {
  for (const phase of ['file', 'write', 'content'] as const) {
    const f = setup();
    let active = true;
    const lease = () => {
      if (!active) throw Error('stale');
    };
    if (phase === 'file') {
      const value = file();
      Object.defineProperty(value, 'arrayBuffer', {
        value: async () => {
          active = false;
          return new ArrayBuffer(value.size);
        },
      });
      await assert.rejects(f.attachments.addFiles(target, [], [value], lease), /stale/);
    } else if (phase === 'write') {
      f.memory.beforeWrite = async () => {
        active = false;
      };
      await assert.rejects(f.attachments.addFiles(target, [], [file()], lease), /stale/);
    } else {
      const [item] = await f.attachments.addFiles(target, [], [file()], current);
      await assert.rejects(
        f.attachments.readContent(target, item.reference, lease, async () => {
          active = false;
          return {};
        }),
        /stale/,
      );
    }
  }
});

test('verified return cache binds complete target and reference; no online fallback or altered bytes', async () => {
  const f = setup(),
    [item] = await f.attachments.addFiles(target, [], [file()], current);
  const content = {
    contentVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    confirmed: true,
    attachment: item.reference,
    data: item.data,
  };
  const host = await f.attachments.readContent(
    target,
    item.reference,
    current,
    async () => content,
  );
  assert.equal(host.source, 'host');
  assert.equal(host.cacheSaved, true);
  assert.equal(
    (
      await new SecureAttachments(new SecureStore(f.memory)).readContent(
        target,
        item.reference,
        current,
      )
    ).source,
    'cache',
  );
  await assert.rejects(
    f.attachments.readContent({ ...target, hostDeviceId: 'other' }, item.reference, current),
  );
  await assert.rejects(
    f.attachments.readContent(
      { ...target, product: { ...target.product!, revision: 2 } },
      item.reference,
      current,
    ),
  );
  await assert.rejects(
    f.attachments.readContent(target, { ...item.reference, name: 'other.txt' }, current),
  );
  await assert.rejects(
    f.attachments.readContent(target, item.reference, current, async () => {
      throw Error('network');
    }),
    /network/,
  );
  for (const altered of [
    { ...content, sessionId: 'other' },
    { ...content, attachment: { ...item.reference, name: 'other.txt' } },
    { ...content, data: Buffer.from('tampered').toString('base64') },
  ])
    await assert.rejects(
      f.attachments.readContent(target, item.reference, current, async () => altered),
    );
});

test('cache is bounded to eight contents, cache write conflicts keep verified Host data and never swallow expiry', async () => {
  const f = setup(),
    [item] = await f.attachments.addFiles(target, [], [file()], current);
  const content = (id: string) => ({
    contentVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    confirmed: true,
    attachment: { ...item.reference, attachmentId: id },
    data: item.data,
  });
  for (let index = 0; index < 9; index++) {
    const result = content(`read-${index}`);
    await f.attachments.readContent(target, result.attachment, current, async () => result);
  }
  await assert.rejects(f.attachments.readContent(target, content('read-0').attachment, current));
  assert.equal(
    (await f.attachments.readContent(target, content('read-8').attachment, current)).source,
    'cache',
  );
  f.memory.beforeWrite = async () => {
    throw Error('disk full');
  };
  assert.equal(
    (
      await f.attachments.readContent(target, item.reference, current, async () =>
        content(item.reference.attachmentId),
      )
    ).cacheSaved,
    false,
  );
  let active = true;
  f.memory.beforeWrite = async () => {
    active = false;
    throw Error('disk full');
  };
  await assert.rejects(
    f.attachments.readContent(
      target,
      item.reference,
      () => {
        if (!active) throw Error('stale');
      },
      async () => content(item.reference.attachmentId),
    ),
    /stale/,
  );
});

test('upload staging holds target lock so simultaneous local removal cannot erase a pending original', async () => {
  const f = setup(),
    items = await f.attachments.addFiles(target, [], [file()], current),
    entered = signal(),
    finish = signal();
  f.memory.beforeWrite = async (key) => {
    if (key.includes('moor-secure-operations-v1')) {
      entered.resolve();
      await finish.promise;
    }
  };
  const staged = f.attachments.stage(
    target,
    items[0].reference.attachmentId,
    'upload',
    'upload',
    now,
    current,
  );
  await entered.promise;
  const removed = f.attachments.removeDraft(
    target,
    items,
    items[0].reference.attachmentId,
    current,
  );
  finish.resolve();
  await staged;
  await assert.rejects(removed, /已改变/);
  assert.equal((await f.attachments.read(target, current))[0].status, 'pending');
});

test('actual Host journal returns original upload/remove receipts after dropped results and keeps attachment bytes exact', async (t) => {
  const runtime = new RuntimeStore(':memory:');
  Object.assign(runtime.workspace, {
    id: target.workspaceId,
    userId: target.userId,
    machineId: target.machineId,
    projects: [{ id: target.localProjectId, name: 'Synthetic', rootPath: '/synthetic/project' }],
  });
  runtime.machine.set(['localProject', target.localProjectId], runtime.workspace.projects[0]);
  const host = new HostWorkspace(
    runtime,
    {
      open: async () => {
        throw Error('No Agent should start for attachments');
      },
    },
    () => {},
    () => {},
  );
  t.after(() => {
    host.close();
    runtime.close();
  });
  const f = setup(),
    [item] = await f.attachments.addFiles(target, [], [file()], current);
  const original = await f.attachments.stage(
    target,
    item.reference.attachmentId,
    'upload',
    'upload',
    now,
    current,
  );
  const accepted = await host.attachmentAction(request(original), target.localProjectId);
  // Simulate only the missing acknowledgement, retaining the actual Host transaction and original browser ledger.
  const reopened = new SecureAttachments(new SecureStore(f.memory));
  assert.equal((await reopened.read(target, current))[0].status, 'pending');
  const replay = await f.store.dispatch(original, current, (sent) =>
    host.attachmentAction(request(sent), sent.target.localProjectId),
  );
  assert.deepEqual(replay, accepted);
  await reopened.confirm(original, replay, current);
  const returned = await reopened.readContent(target, item.reference, current, () =>
    host.readAttachment(
      {
        contentVersion: 1,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        attachmentId: item.reference.attachmentId,
      },
      target.localProjectId,
    ),
  );
  assert.equal(returned.data, item.data);
  const removal = await reopened.stage(
    target,
    item.reference.attachmentId,
    'remove',
    'remove',
    now,
    current,
  );
  const removed = await host.attachmentAction(request(removal), target.localProjectId);
  assert.deepEqual(await host.attachmentAction(request(removal), target.localProjectId), removed);
  await reopened.confirm(removal, removed, current);
  assert.deepEqual(await reopened.read(target, current), []);
  assert.equal(
    runtime.journal.db.prepare('SELECT count(*) AS total FROM operation').get()?.total,
    2,
  );
});

test('pending removal still authenticates local preview bytes against the complete original upload', async () => {
  const f = setup(),
    item = await uploaded(f);
  await f.attachments.stage(target, item.reference.attachmentId, 'remove', 'remove', now, current);
  const [key, raw] = [...f.memory.values.entries()].find(([key]) =>
    key.includes('attachments-draft'),
  )!;
  const document = raw as any;
  document.entries[0].data = Buffer.from('other').toString('base64');
  document.entries[0].reference.content.byteLength = 5;
  document.entries[0].reference.content.version =
    'sha256:' + createHash('sha256').update('other').digest('hex');
  f.memory.values.set(key, document);
  await assert.rejects(f.attachments.read(target, current), /原上传正文/);
});

test('actual SHA-256 await rechecks the authority before exposing draft or returned bytes', async (t) => {
  const f = setup(),
    [item] = await f.attachments.addFiles(target, [], [file()], current);
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  let active = true;
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<SubtleCrypto['digest']>) => {
    const result = await originalDigest(...args);
    active = false;
    return result;
  });
  const lease = () => {
    if (!active) throw Error('stale digest');
  };
  await assert.rejects(f.attachments.read(target, lease), /stale digest/);
  active = true;
  await assert.rejects(
    f.attachments.readContent(target, item.reference, lease, async () => ({
      contentVersion: 1,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId: target.sessionId,
      confirmed: true,
      attachment: item.reference,
      data: item.data,
    })),
    /stale digest/,
  );
  assert.equal(
    [...f.memory.values.keys()].some((key) => key.includes('attachments-cache')),
    false,
  );
});

test('ending attachments remain pending until an exact Host recovery receipt accepts or seals them', async () => {
  for (const kind of ['upload', 'remove'] as const) {
    const f = setup(),
      item =
        kind === 'remove'
          ? await uploaded(f)
          : (await f.attachments.addFiles(target, [], [file()], current))[0];
    const original = await f.attachments.stage(
      target,
      item.reference.attachmentId,
      kind,
      `original-${kind}`,
      now,
      current,
    );
    const ending = await f.store.transition(original, ['pending'], 'ending', undefined, current);
    const pending = await f.attachments.read(target, current);
    assert.equal(pending[0].status, 'pending');
    assert.equal(pending[0].pendingAction, kind);
    await assert.rejects(
      f.attachments.removeDraft(target, pending, item.reference.attachmentId, current),
    );
    await assert.rejects(f.attachments.forget(target, [item.reference], current));
    await assert.rejects(
      f.store.dispatch(ending, current, async () => {
        throw Error('Must never dispatch ending');
      }),
    );
    const recovered = {
      controlVersion: 1,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId: target.sessionId,
      userId: target.userId,
      machineId: target.machineId,
      operationId: original.operationId,
      confirmed: true,
      kind: 'attachment',
      status: 'abandoned',
    };
    await assert.rejects(
      f.store.transition(
        ending,
        ['ending'],
        'abandoned',
        { ...recovered, machineId: 'other' },
        current,
      ),
    );
    await f.store.transition(ending, ['ending'], 'abandoned', recovered, current);
    const after = await new SecureAttachments(new SecureStore(f.memory)).read(target, current);
    assert.equal(after[0].status, kind === 'upload' ? 'draft' : 'uploaded');
    assert.equal(after[0].pendingOperationId, undefined);
    const staged = await f.attachments.stage(
      target,
      item.reference.attachmentId,
      kind,
      `next-${kind}`,
      now,
      current,
    );
    assert.notEqual(staged.operationId, original.operationId);
    assert.equal(request(staged).action, kind);
  }
});

test('accepted recovery wrappers restore exact uploaded state from ending without another upload or accepting altered references', async () => {
  const f = setup(),
    [item] = await f.attachments.addFiles(target, [], [file()], current);
  const original = await f.attachments.stage(
    target,
    item.reference.attachmentId,
    'upload',
    'original',
    now,
    current,
  );
  const ending = await f.store.transition(original, ['pending'], 'ending', undefined, current);
  const recovered = {
    controlVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    userId: target.userId,
    machineId: target.machineId,
    operationId: original.operationId,
    confirmed: true,
    kind: 'attachment',
    status: 'accepted',
    attachmentReceipt: receipt(original),
  };
  const wrong = structuredClone(recovered) as any;
  wrong.attachmentReceipt.attachment.name = 'changed.txt';
  await assert.rejects(f.store.transition(ending, ['ending'], 'accepted', wrong, current));
  await f.store.transition(ending, ['ending'], 'accepted', recovered, current);
  assert.equal((await f.attachments.read(target, current))[0].status, 'uploaded');
  assert.equal((await f.store.list(target))[0].body, original.body);
  await assert.rejects(
    f.attachments.stage(
      target,
      item.reference.attachmentId,
      'upload',
      'unneeded-upload',
      now,
      current,
    ),
  );
});
