import assert from 'node:assert/strict';
import type { SecureCliTarget } from '@moor/client/secure-operation';
import {
  forkRequestVersion,
  type ForkOptionsResult,
  type ForkReceipt,
  type SessionFork,
} from '@moor/protocol/fork-protocol';
import { SecureStore, type SecureStorageBackend } from '../../apps/web/src/platform/secure-store';
import { SecureScopedStorage } from '../../apps/web/src/platform/secure-scoped-storage';
import {
  SecureForkController,
  readSecureForkExecutionBlock,
  type SecureForkContext,
  type SecureForkDependencies,
} from '../../apps/web/src/features/fork/secure-fork';

export function forkSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export class ForkMemory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  queues = new Map<string, Promise<void>>();
  beforeRead?: () => Promise<void>;
  beforeWrite?: () => Promise<void>;
  async read(key: string) {
    await this.beforeRead?.();
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeWrite?.();
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(key: string, current: () => void, work: () => Promise<T>) {
    const previous = this.queues.get(key) ?? Promise.resolve(),
      release = forkSignal();
    this.queues.set(key, release.promise);
    try {
      await previous;
      current();
      return await work();
    } finally {
      release.resolve();
      if (this.queues.get(key) === release.promise) this.queues.delete(key);
    }
  }
}
export const forkTarget: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: 'A'.repeat(43),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'project',
  userId: 'user',
  machineId: 'machine',
  sessionId: 'source',
  product: { catalogWorkspaceId: 'space', projectId: 'product', replicaId: 'replica', revision: 1 },
};
export const forkVersion = 'sha256:' + 'a'.repeat(64),
  forkOid = 'b'.repeat(40);
export function secureForkFixture() {
  const memory = new ForkMemory(),
    store = new SecureStore(memory),
    storage = new SecureScopedStorage(store);
  let context: SecureForkContext = {
      target: structuredClone(forkTarget),
      online: true,
      generation: 1,
    },
    ids = 0;
  const options: ForkOptionsResult = {
    forkVersion: 1,
    workspaceId: forkTarget.workspaceId,
    localProjectId: forkTarget.localProjectId,
    sessionId: forkTarget.sessionId,
    confirmed: true,
    sourceVersion: forkVersion,
    execution: { mode: 'shared', status: 'ready', revision: 0 },
    agent: { id: 'agent', name: 'Synthetic <img src=x> Agent', agentType: 'synthetic' },
    capabilities: { sameDirectory: true, worktree: true, turnCutoff: true },
    currentAvailable: true,
    turns: [
      { turnId: 'finished', ordinal: 1, timestamp: '2026-09-12T00:00:00Z', available: true },
      {
        turnId: 'missing',
        ordinal: 2,
        timestamp: '2026-09-12T00:00:01Z',
        available: false,
        reason: 'No anchor <script>bad()</script>',
      },
    ],
    partial: false,
    repository: {
      kind: 'git',
      branch: 'main',
      headOid: forkOid,
      branches: [{ name: 'main', oid: forkOid }],
      changes: [],
      dirty: false,
      partial: false,
      outsideProjectChanges: false,
      version: forkVersion,
      issues: [],
      writeSupported: true,
    },
  };
  const calls: { target: SecureCliTarget; method: string; params: any }[] = [],
    children: unknown[] = [],
    directories: unknown[] = [],
    changed: unknown[] = [];
  const journal = new Map<string, { request: SessionFork; receipt: ForkReceipt }>();
  const controls = {
    loseAction: false,
    beforeAction: undefined as undefined | (() => Promise<void>),
    beforeOptions: undefined as undefined | (() => Promise<void>),
    beforeRecovery: undefined as undefined | (() => Promise<void>),
    phase: 'accepted' as ForkReceipt['phase'],
    corruptRecovery: false,
    nativeCalls: 0,
  };
  const receipt = (request: SessionFork, phase: ForkReceipt['phase']): ForkReceipt => ({
    forkVersion: 1,
    workspaceId: request.workspaceId,
    localProjectId: request.localProjectId,
    sessionId: request.sessionId,
    operationId: request.operationId,
    childSessionId: request.childSessionId,
    phase,
    confirmed: phase === 'accepted',
    origin: {
      version: 1,
      sourceSessionId: request.sessionId,
      sourceVersion: request.expectedSourceVersion,
      sourceTitle: '<script>bad()</script>',
      cutoff: request.cutoff,
      directory: request.directory.kind,
      ...(request.directory.kind === 'worktree'
        ? { branch: request.directory.newBranch, baseOid: request.directory.expectedOid }
        : {}),
      createdAt: '2026-09-12T00:00:00Z',
    },
    execution:
      request.directory.kind === 'worktree'
        ? {
            mode: 'worktree',
            status: 'ready',
            revision: 1,
            executionId: 'execution-' + request.childSessionId,
            branch: request.directory.newBranch,
            baseOid: request.directory.expectedOid,
          }
        : options.execution,
  });
  const dependencies: SecureForkDependencies = {
    context: () => context,
    storage,
    uuid: () => 'fork-id-' + ++ids,
    beforeWrite: async (target, current) => {
      const block = await readSecureForkExecutionBlock(storage, target, current);
      if (block) throw Error(block);
    },
    changed: async (target, current) => {
      current();
      changed.push(target);
    },
    openChild: async (target, childId, current) => {
      current();
      children.push({ target, childId });
    },
    openWorkspace: async (target, childId, current) => {
      current();
      directories.push({ target, childId });
    },
    request: async (target, method, input, current) => {
      current();
      const params = structuredClone(input) as any;
      calls.push({ target: structuredClone(target), method, params });
      if (method === 'fork-options') {
        await controls.beforeOptions?.();
        current();
        return structuredClone({
          ...options,
          workspaceId: params.workspaceId,
          localProjectId: params.localProjectId,
          sessionId: params.sessionId,
        });
      }
      if (method === 'fork-action') {
        await controls.beforeAction?.();
        current();
        const request = params as SessionFork;
        assert(
          (await storage.list(target, current)).some(
            (row: any) => row.value.operation?.request?.operationId === request.operationId,
          ),
          'the exact original operation is durable before dispatch',
        );
        if (!journal.has(request.operationId)) {
          controls.nativeCalls++;
          journal.set(request.operationId, { request, receipt: receipt(request, controls.phase) });
        } else assert.deepEqual(journal.get(request.operationId)!.request, request);
        if (controls.loseAction) throw Error('Synthetic lost original receipt');
        return structuredClone(journal.get(request.operationId)!.receipt);
      }
      await controls.beforeRecovery?.();
      current();
      const request = params.request as SessionFork,
        prior = journal.get(request.operationId);
      if (prior) assert.deepEqual(prior.request, request);
      if (params.action === 'abandon' && (!prior || prior.receipt.phase === 'unknown'))
        journal.set(request.operationId, { request, receipt: receipt(request, 'abandoned') });
      const found = journal.get(request.operationId);
      return {
        forkVersion: 1,
        workspaceId: request.workspaceId,
        localProjectId: request.localProjectId,
        sessionId: request.sessionId,
        operationId: request.operationId,
        requestVersion: controls.corruptRecovery
          ? 'sha256:' + 'f'.repeat(64)
          : await forkRequestVersion(request),
        action: params.action,
        confirmed: true,
        found: !!found,
        ...(found ? { receipt: structuredClone(found.receipt) } : {}),
      };
    },
  };
  const create = () => new SecureForkController(dependencies);
  return {
    memory,
    store,
    storage,
    options,
    controls,
    journal,
    calls,
    children,
    directories,
    changed,
    dependencies,
    create,
    target: structuredClone(forkTarget),
    context: () => context,
    setContext: (value: SecureForkContext) => {
      context = structuredClone(value);
    },
  };
}
