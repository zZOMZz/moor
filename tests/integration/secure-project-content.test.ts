import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecureProjectContentController,
  type SecureProjectContentContext,
  type SecureProjectContentMethod,
} from '../../apps/web/src/features/files/secure-project-content';
import { SecureProjectContentCache } from '../../apps/web/src/features/files/secure-project-content-cache';
import type { SecureStorageBackend } from '../../apps/web/src/platform/secure-store';
import type { SecureCliTarget } from '@moor/client/secure-operation';
import type {
  ProjectDiffFileResult,
  ProjectTreeResult,
  ProjectTurnDiffResult,
} from '@moor/protocol/project-content-protocol';
import { projectDiffReferenceSchema } from '@moor/protocol/project-content-protocol';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { HostCommandDispatcher } from '@moor/host/commands/host-command';
import { RuntimeStore } from '@moor/host/persistence/store';
import { captureProjectSnapshot, enumerateProjectFiles } from '@moor/host/projects/snapshot';
import { readProjectFileBytes } from '@moor/host/projects/files';
import { buildSessionTurn, readClientSession } from '@moor/client/session-client';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';

const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'workspace',
  localProjectId: 'project',
  userId: 'local-owner',
  machineId: 'machine',
  sessionId: 'session',
  product: { catalogWorkspaceId: 'space', projectId: 'product', replicaId: 'replica', revision: 1 },
};
const scope = {
  contentVersion: 1 as const,
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  sessionId: target.sessionId,
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  writes = 0;
  beforeCommit?: () => Promise<void>;
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async exclusive<T>(_key: string, _current: () => void, _task: () => Promise<T>): Promise<T> {
    throw Error('Content cache must use bounded CAS, not operation dispatch locks');
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeCommit?.();
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
    this.writes++;
  }
}
const tree: ProjectTreeResult = {
  ...scope,
  confirmed: true,
  version: hash('tree'),
  source: 'git',
  offset: 0,
  total: 2,
  entries: [
    { path: 'a.txt', type: 'file', size: 3 },
    { path: 'b.txt', type: 'file', size: 3 },
  ],
  partial: false,
  enumerationComplete: true,
  issues: [],
};
const before = {
  path: 'a.txt',
  size: 3,
  state: 'text' as const,
  version: hash('old'),
  mediaType: 'text/plain' as const,
};
const after = { ...before, version: hash('new') };
const reference = {
  contentVersion: 1 as const,
  basis: 'project-snapshot' as const,
  turnId: 'turn',
  diffId: 'diff',
  state: 'ready' as const,
  version: hash('diff'),
  changeCount: 1,
};
const change = { path: 'a.txt', kind: 'modified' as const, before, after };
const summary: ProjectTurnDiffResult = {
  ...scope,
  confirmed: true,
  turnId: 'turn',
  state: 'ready',
  reference,
  changes: [change],
  partial: false,
  issues: [],
  attribution: 'shared-project',
};
const diff: ProjectDiffFileResult = {
  ...scope,
  confirmed: true,
  turnId: 'turn',
  path: 'a.txt',
  reference,
  before: { ...before, text: 'old' },
  after: { ...after, text: 'new' },
  partial: false,
  issues: [],
  attribution: 'shared-project',
};
const turns = [{ id: 'turn', label: 'Synthetic turn', reference }];
const fileResult = (path = 'a.txt', text = 'new') => ({
  ...scope,
  confirmed: true,
  path,
  status: 'content',
  encoding: 'base64',
  content: { version: hash(text), byteLength: Buffer.byteLength(text), mediaType: 'text/plain' },
  data: Buffer.from(text).toString('base64'),
});
function fixture(memory = new Memory()) {
  let context: SecureProjectContentContext = {
    target: structuredClone(target),
    online: true,
    generation: 1,
  };
  const calls: { target: SecureCliTarget; method: SecureProjectContentMethod; params: any }[] = [];
  let response = async (method: SecureProjectContentMethod, params: any): Promise<unknown> =>
    structuredClone(
      method === 'read-project-tree'
        ? tree
        : method === 'file-content'
          ? fileResult(params.path)
          : method === 'read-turn-diff'
            ? summary
            : diff,
    );
  const cache = new SecureProjectContentCache(memory);
  const controller = new SecureProjectContentController({
    context: () => context,
    cache,
    request: async (selected, method, params) => {
      calls.push({ target: structuredClone(selected), method, params: structuredClone(params) });
      return await response(method, params);
    },
  });
  return {
    controller,
    memory,
    cache,
    calls,
    context: () => context,
    setContext: (value: SecureProjectContentContext) => {
      context = value;
    },
    respond: (value: typeof response) => {
      response = value;
    },
  };
}

test('all reads use finite methods with complete targets, and exact file/diff caches work explicitly offline', async () => {
  const f = fixture();
  await f.controller.open('tree', turns);
  await f.controller.file('a.txt', 3);
  assert.equal(f.controller.state?.currentFile?.text, 'new');
  await f.controller.setMode('changes');
  await f.controller.diffFile(change);
  assert.equal(f.controller.state?.diffFile?.result.before?.text, 'old');
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['read-project-tree', 'file-content', 'read-turn-diff', 'read-diff-file'],
  );
  for (const call of f.calls) {
    assert.deepEqual(call.target, target);
    assert.equal(call.params.workspaceId, target.workspaceId);
    assert.equal(call.params.sessionId, target.sessionId);
  }
  f.setContext({ ...f.context(), online: false, generation: 2 });
  assert.equal(Boolean(f.controller.state), false);
  f.controller.sync();
  assert.equal(f.calls.length, 4);
  await f.controller.open('tree', turns);
  await f.controller.file('a.txt', 3);
  assert.equal(f.controller.state?.tree?.source, 'cache');
  assert.equal(f.controller.state?.currentFile?.source, 'cache');
  assert.equal(f.controller.state?.currentFile?.stale, true);
  await f.controller.setMode('changes');
  await f.controller.diffFile(change);
  assert.equal(f.controller.state?.diff?.source, 'cache');
  assert.equal(f.controller.state?.diffFile?.source, 'cache');
  assert.equal(f.calls.length, 4);
});

test('page merging rejects changed totals, versions, metadata or duplicate earlier paths before cache commit', async () => {
  for (const failure of ['duplicate', 'version', 'total', 'metadata', 'scope']) {
    const f = fixture();
    f.respond(async (_method, params) => ({
      ...tree,
      ...(params.offset
        ? {
            offset: 1,
            nextOffset: undefined,
            entries: [{ path: failure === 'duplicate' ? 'a.txt' : 'b.txt', type: 'file', size: 3 }],
            ...(failure === 'version' ? { version: hash('other') } : {}),
            ...(failure === 'total' ? { total: 3, nextOffset: 2 } : {}),
            ...(failure === 'metadata' ? { partial: true } : {}),
            ...(failure === 'scope' ? { sessionId: 'other' } : {}),
          }
        : { entries: tree.entries.slice(0, 1), nextOffset: 1 }),
    }));
    await f.controller.open('tree', []);
    const saved = structuredClone(f.memory.values);
    await f.controller.treeMore();
    assert(f.controller.state?.error, failure);
    assert.equal(f.controller.state?.tree?.result.entries.length, 1);
    assert.deepEqual(f.memory.values, saved, failure);
    assert.equal(f.calls[1].params.knownVersion, tree.version);
  }
});

test('valid tree pages append once and invalid selection cannot request arbitrary files or baseline changes', async () => {
  const f = fixture();
  f.respond(async (_method, params) => ({
    ...tree,
    offset: params.offset ?? 0,
    entries: params.offset ? tree.entries.slice(1) : tree.entries.slice(0, 1),
    ...(params.offset ? {} : { nextOffset: 1 }),
  }));
  await f.controller.open('tree', turns);
  await f.controller.treeMore();
  assert.deepEqual(f.controller.state?.tree?.result.entries, tree.entries);
  await f.controller.treeMore();
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.controller.file('other.txt', 3), /所选文件/);
  await assert.rejects(f.controller.file('a.txt', 4), /所选文件/);
  await assert.rejects(f.controller.file('../secret', 3));
  await assert.rejects(f.controller.turn('not-seen'), /所选回合/);
  assert.equal(f.calls.length, 2);
  const g = fixture();
  await g.controller.open('changes', turns);
  await assert.rejects(g.controller.diffFile({ ...change, before: after }), /所选历史文件/);
  assert.equal(g.calls.length, 1);
});

test('current content conditional reads require a verified local baseline; corrupt or foreign results cannot enter cache', async () => {
  const f = fixture();
  await f.controller.open('tree', []);
  await f.controller.file('a.txt', 3);
  f.respond(async (_method, params) => {
    assert.equal(params.knownVersion, hash('new'));
    const { encoding: _encoding, data: _data, ...result } = fileResult();
    return { ...result, status: 'not-modified' };
  });
  await f.controller.file('a.txt', 3);
  assert.equal(f.controller.state?.currentFile?.text, 'new');
  for (const field of ['hash', 'scope', 'not-modified']) {
    const g = fixture();
    await g.controller.open('tree', []);
    const saved = structuredClone(g.memory.values);
    g.respond(async (_method, params) => {
      assert.equal(params.knownVersion, undefined);
      if (field === 'not-modified') {
        const { encoding: _encoding, data: _data, ...result } = fileResult();
        return { ...result, status: 'not-modified' };
      }
      return {
        ...fileResult(),
        ...(field === 'hash'
          ? { data: Buffer.from('bad').toString('base64') }
          : { sessionId: 'foreign' }),
      };
    });
    await g.controller.file('a.txt', 3);
    assert(g.controller.state?.error);
    assert.equal(g.controller.state?.currentFile, undefined);
    assert.deepEqual(g.memory.values, saved);
  }
});

test('historical files reject changed baseline, scope or bytes and never consult current project files', async () => {
  for (const failure of ['baseline', 'scope', 'hash']) {
    const f = fixture();
    await f.controller.open('changes', turns);
    const saved = structuredClone(f.memory.values);
    f.respond(async (method, params) => {
      assert.equal(method, 'read-diff-file');
      assert.equal(params.knownVersion, reference.version);
      return {
        ...diff,
        ...(failure === 'baseline'
          ? { reference: { ...reference, version: hash('other') } }
          : failure === 'scope'
            ? { sessionId: 'other' }
            : { after: { ...diff.after!, text: 'bad' } }),
      };
    });
    await f.controller.diffFile(change);
    assert(f.controller.state?.error);
    assert.equal(f.controller.state?.diffFile, undefined);
    assert.deepEqual(f.memory.values, saved);
  }
});

test('a frozen turn reference must match the complete saved baseline, while a pending reference can finish', async () => {
  const f = fixture();
  f.respond(async () => ({
    ...summary,
    state: 'partial',
    partial: true,
    reference: { ...reference, state: 'partial' },
  }));
  await f.controller.open('changes', turns);
  assert.match(f.controller.state?.error ?? '', /完整基线引用/);
  assert.equal(f.controller.state?.diff, undefined);
  assert.equal(f.memory.writes, 0);
  const g = fixture();
  const { version: _version, ...pending } = reference;
  await g.controller.open('changes', [
    {
      id: 'turn',
      label: 'Synthetic pending turn',
      reference: { ...pending, state: 'pending', changeCount: 0 },
    },
  ]);
  assert.equal(g.controller.state?.diff?.result.state, 'ready');
});

test('oversized files stay as explicit unavailable previews without sending or keeping prior content', async () => {
  const f = fixture();
  const size = 1024 * 1024 + 1;
  f.respond(async () => ({
    ...tree,
    total: 1,
    entries: [{ path: 'large.txt', type: 'file', size }],
  }));
  await f.controller.open('tree', []);
  await f.controller.file('large.txt', size);
  assert.equal(f.controller.state?.currentFile, undefined);
  assert.equal(f.controller.state?.currentUnavailable?.path, 'large.txt');
  assert.equal(f.calls.length, 1);
});

test('late responses after identity changes, disconnect/reconnect ABA, close or new selection never display or persist', async () => {
  for (const reason of ['account', 'connection-aba', 'close', 'selection']) {
    const f = fixture(),
      entered = deferred(),
      release = deferred();
    f.respond(async () => {
      entered.resolve();
      await release.promise;
      return tree;
    });
    const pending = f.controller.open('tree', []);
    await entered.promise;
    if (reason === 'close') f.controller.close();
    else if (reason === 'account') f.setContext({ target: null, online: false, generation: 2 });
    else if (reason === 'selection')
      f.setContext({ ...f.context(), target: { ...target, sessionId: 'other' }, generation: 2 });
    else {
      f.setContext({ ...f.context(), online: false, generation: 2 });
      f.setContext({ ...f.context(), online: true, generation: 3 });
    }
    assert.equal(f.controller.state, null);
    release.resolve();
    await pending;
    assert.equal(f.controller.state, null);
    assert.equal(f.memory.writes, 0);
  }
});

test('file digest and cache commit boundaries recheck scope before persisting or displaying', async (t) => {
  const f = fixture();
  await f.controller.open('tree', []);
  const saved = structuredClone(f.memory.values),
    entered = deferred(),
    release = deferred();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(
    crypto.subtle,
    'digest',
    async (...args: Parameters<typeof crypto.subtle.digest>) => {
      const result = await digest(...args);
      entered.resolve();
      await release.promise;
      return result;
    },
  );
  const pending = f.controller.file('a.txt', 3);
  await entered.promise;
  f.setContext({ ...f.context(), generation: 2 });
  release.resolve();
  await pending;
  assert.equal(f.controller.state, null);
  assert.deepEqual(f.memory.values, saved);
  t.mock.restoreAll();
  const g = fixture(),
    commitEntered = deferred(),
    commitRelease = deferred();
  g.memory.beforeCommit = async () => {
    commitEntered.resolve();
    await commitRelease.promise;
  };
  const committing = g.controller.open('tree', []);
  await commitEntered.promise;
  g.controller.invalidate();
  commitRelease.resolve();
  await committing;
  assert.equal(g.memory.writes, 0);
  assert.equal(g.controller.state, null);
});

test('new file selection supersedes in-flight content and cache storage failure retains a truthful Host result', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  await f.controller.open('tree', []);
  f.respond(async (_method, params) => {
    if (params.path === 'a.txt') {
      entered.resolve();
      await release.promise;
    }
    return fileResult(params.path, params.path === 'a.txt' ? 'old' : 'new');
  });
  const first = f.controller.file('a.txt', 3);
  await entered.promise;
  await f.controller.file('b.txt', 3);
  const writes = f.memory.writes;
  release.resolve();
  await first;
  assert.equal(f.controller.state?.currentFile?.result.path, 'b.txt');
  assert.equal(f.memory.writes, writes);
  const g = fixture();
  g.memory.beforeCommit = async () => {
    throw Error('synthetic unavailable storage');
  };
  await g.controller.open('tree', []);
  assert.equal(g.controller.state?.tree?.source, 'host');
  assert.equal(g.controller.state?.tree?.cacheSaved, false);
});

test('independent content cache isolates every authority and target dimension and never imports legacy keys', async () => {
  const f = fixture();
  await f.controller.open('tree', []);
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
    ).map((key) => ({
      ...target,
      [key]:
        key === 'origin'
          ? 'https://another.synthetic.invalid'
          : key === 'rootKeyId'
            ? Buffer.alloc(32, 2).toString('base64url')
            : 'another',
    })),
    ...(['catalogWorkspaceId', 'projectId', 'replicaId', 'revision'] as const).map((key) => ({
      ...target,
      product: { ...target.product!, [key]: key === 'revision' ? 2 : 'another' },
    })),
  ];
  for (const selected of variants) {
    f.setContext({ target: selected, online: false, generation: f.context().generation + 1 });
    await f.controller.open('tree', []);
    assert.equal(f.controller.state?.tree, undefined);
    assert.match(f.controller.state?.error ?? '', /没有.*缓存/);
  }
  assert.equal(f.calls.length, 1);
  assert(
    [...f.memory.values.keys()].every((key) => key.includes('moor-secure-project-content-v1')),
  );
  const g = fixture();
  g.memory.values.set(
    'project-content-v1/' +
      JSON.stringify(['owner', 'host', 'workspace', 'project', 'session', 'tree-last-read']),
    tree.version,
  );
  g.setContext({ ...g.context(), online: false });
  await g.controller.open('tree', []);
  assert.equal(g.controller.state?.tree, undefined);
  assert.equal(g.calls.length, 0);
});

test('content cache CAS preserves concurrent writes and evicts bounded oldest entries without overwriting operations', async () => {
  const memory = new Memory(),
    a = new SecureProjectContentCache(memory),
    b = new SecureProjectContentCache(memory),
    current = () => {};
  memory.values.set('original-operation-sentinel', { unchanged: true });
  await Promise.all([
    a.writeBatch(target, new Map([['a', 'A']]), current),
    b.writeBatch(target, new Map([['b', 'B']]), current),
  ]);
  assert.equal(await a.read(target, 'a', current), 'A');
  assert.equal(await b.read(target, 'b', current), 'B');
  await a.writeBatch(
    target,
    new Map(Array.from({ length: 96 }, (_, index) => [`entry-${index}`, index])),
    current,
  );
  assert.equal(await a.read(target, 'a', current), undefined);
  assert.equal(await a.read(target, 'entry-95', current), 95);
  assert.deepEqual(memory.values.get('original-operation-sentinel'), { unchanged: true });
});

test('real Host reads current project bytes and saved before/after baselines through the finite controller boundary', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-project-content-'))),
    project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'a.txt'), 'old');
  const runtime = new RuntimeStore(join(root, 'host.sqlite')),
    projectId = runtime.registerProject(project);
  runtime.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: [] },
  });
  const started = deferred(),
    complete = deferred();
  const plain = {
    git: async () => {
      throw Object.assign(Error('synthetic non-git'), { nonRepository: true });
    },
  };
  const host = new HostWorkspace(
    runtime,
    {
      open: async () => ({
        id: 'synthetic-native',
        capabilities: syntheticCapabilities,
        prompt: async () => {
          started.resolve();
          await complete.promise;
        },
        cancel: async () => complete.resolve(),
        close: () => complete.resolve(),
      }),
    },
    () => {},
    () => {},
    readProjectFileBytes,
    {
      tree: (path) => enumerateProjectFiles(path, plain),
      capture: (path) => captureProjectSnapshot(path, plain),
    },
  );
  t.after(async () => {
    complete.resolve();
    host.close();
    await Promise.allSettled([...host.active.values()].map((run) => run.done));
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const selected: SecureCliTarget = {
    ...target,
    workspaceId: host.workspace.id,
    localProjectId: projectId,
    userId: host.workspace.userId,
    machineId: host.workspace.machineId,
  };
  const sessionScope = {
    workspaceId: selected.workspaceId,
    localProjectId: projectId,
    sessionId: selected.sessionId,
    userId: selected.userId,
    machineId: selected.machineId,
  };
  const agent = host.workspace.agents[0];
  await host.controlManager.control(
    {
      ...sessionScope,
      controlVersion: 1,
      operationId: 'create',
      action: 'create',
      agentId: agent.id,
    },
    projectId,
  );
  const mutation = buildSessionTurn({
    scope: sessionScope,
    read: await host.read(selected.sessionId, undefined, projectId),
    agent,
    prompt: 'Synthetic edit',
    operationId: 'turn-op',
    turnId: 'user-turn',
    peerId: '12345',
    now: '2026-01-01T00:00:00.000Z',
  });
  await host.mutate(mutation, projectId);
  await started.promise;
  const run = host.active.get(selected.sessionId)!;
  writeFileSync(join(project, 'a.txt'), 'new');
  complete.resolve();
  await run.done;
  const read = readClientSession(
    await host.read(selected.sessionId, undefined, projectId),
    sessionScope,
  );
  const assistant = read.history.find((turn) => turn.role === 'assistant')!;
  const ref = projectDiffReferenceSchema.parse(assistant.fileDiff);
  const choices = [{ id: assistant.id, label: 'Synthetic completed turn', reference: ref }];
  const dispatcher = new HostCommandDispatcher({
    ready: () => true,
    workspace: (id) => (id === host.workspace.id ? host : undefined),
    hasOperation: (id) => runtime.journal.has(id),
  });
  let context = { target: selected, online: true, generation: 1 };
  const methods: string[] = [];
  const controller = new SecureProjectContentController({
    context: () => context,
    cache: new SecureProjectContentCache(new Memory()),
    request: async (frozen, method, params) => {
      assert.deepEqual(frozen, selected);
      methods.push(method);
      return dispatcher.execute({
        method,
        workspaceId: selected.workspaceId,
        localProjectId: projectId,
        params,
      });
    },
  });
  await controller.open('tree', choices);
  assert.equal(controller.state?.tree?.result.entries[0].path, 'a.txt');
  await controller.file('a.txt', 3);
  assert.equal(controller.state?.currentFile?.text, 'new');
  writeFileSync(join(project, 'a.txt'), 'later');
  await controller.setMode('changes');
  assert.equal(controller.state?.diff?.result.changes.length, 1);
  await controller.diffFile(controller.state!.diff!.result.changes[0]);
  assert.equal(controller.state?.diffFile?.result.before?.text, 'old');
  assert.equal(controller.state?.diffFile?.result.after?.text, 'new');
  context = { ...context, online: false, generation: 2 };
  controller.sync();
  await controller.open('changes', choices);
  await controller.diffFile(controller.state!.diff!.result.changes[0]);
  assert.equal(controller.state?.diffFile?.source, 'cache');
  assert.equal(controller.state?.diffFile?.result.after?.text, 'new');
  assert.deepEqual(methods, [
    'read-project-tree',
    'file-content',
    'read-turn-diff',
    'read-diff-file',
  ]);
});
