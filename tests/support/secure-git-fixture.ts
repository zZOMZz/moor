import assert from 'node:assert/strict';
import type { SecureCliTarget } from '../../src/cli/secure-operation';
import {
  gitRequestVersion,
  type GitAction,
  type GitActionReceipt,
  type GitStateResult,
} from '../../src/git-protocol';
import { SecureStore } from '../../src/web/secure-store';
import { SecureScopedStorage, secureGitTarget } from '../../src/web/secure-scoped-storage';
import { gitWorkspaceKey } from '../../src/web/git-workspace';
import {
  SecureGitController,
  type SecureGitContext,
  type SecureGitDependencies,
  type SecureGitMethod,
} from '../../src/web/secure-git';
import { Memory, signal, target } from './secure-github-fixture';
export { Memory, signal, target };
export const oid = 'a'.repeat(40),
  version = 'sha256:' + 'b'.repeat(64);
export function gitState(target: SecureCliTarget): GitStateResult {
  return {
    gitVersion: 1,
    confirmed: true,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    repository: {
      kind: 'git',
      branch: 'main',
      headOid: oid,
      branches: [{ name: 'main', oid }],
      changes: [],
      dirty: false,
      partial: false,
      outsideProjectChanges: false,
      version,
      issues: [],
      writeSupported: true,
    },
    execution: { mode: 'shared', status: 'ready', revision: 0 },
    canPrepare: true,
    canRemove: false,
    canDetach: false,
    boundSessions: 1,
  };
}
export function fixture(memory = new Memory()) {
  const store = new SecureStore(memory),
    storage = new SecureScopedStorage(store),
    states = new Map<string, GitStateResult>(),
    receipts = new Map<string, GitActionReceipt>();
  const calls: {
    target: SecureCliTarget;
    method: SecureGitMethod;
    params: any;
    resource?: { parent: SecureCliTarget; childId: string; source?: SecureCliTarget };
  }[] = [];
  const state = {
    context: { target: structuredClone(target), online: true, generation: 1 } as SecureGitContext,
    beforeResponse: undefined as
      | undefined
      | ((method: SecureGitMethod, params: any) => Promise<void>),
    beforeWrite: undefined as undefined | (() => Promise<void>),
    beforeChanged: undefined as undefined | (() => Promise<void>),
    beforeRefresh: undefined as undefined | (() => Promise<void>),
    lost: false,
    unseen: false,
    unknown: false,
    wrong: false,
    reject: false,
    writes: 0,
    resourceWrites: 0,
    changed: 0,
    navigations: [] as string[],
    prepared: [] as { target: SecureCliTarget; execution: GitStateResult['execution'] }[],
    refreshed: [] as { target: SecureCliTarget; state: GitStateResult }[],
    callbackLocks: [] as number[],
  };
  const hostState = (input = state.context.target!) => {
    if (!states.has(input.sessionId)) states.set(input.sessionId, gitState(input));
    return states.get(input.sessionId)!;
  };
  const request: SecureGitDependencies['request'] = async (input, method, params, current) => {
    current();
    const original = structuredClone(input),
      r = structuredClone(params) as any;
    calls.push({ target: original, method, params: r });
    await state.beforeResponse?.(method, r);
    current();
    const host = hostState(input);
    if (method === 'git-state') return structuredClone(host);
    const action = (method === 'git-operations' ? r.request : r) as GitAction;
    const key = gitWorkspaceKey(secureGitTarget(original)),
      saved = (await storage.read(original, key, current)) as any;
    assert.deepEqual(saved.pending.request, action, 'Original request is persisted before RPC');
    if (method === 'git-action') {
      assert(!receipts.has(action.operationId), 'No action replay');
      if (state.unseen) throw Error('Synthetic frame never arrived');
      let execution = structuredClone(host.execution);
      if (!state.reject && !state.unknown) {
        execution =
          action.action === 'prepare'
            ? {
                mode: 'worktree',
                status: 'ready',
                revision: action.expectedRevision + 1,
                executionId: 'execution-' + action.sessionId,
                branch: action.newBranch,
                baseOid: action.expectedOid,
              }
            : {
                ...execution,
                revision: action.expectedRevision + 1,
                status: 'removed',
                disposition: action.action === 'detach' ? 'detached' : 'removed',
              };
        host.execution = execution;
        host.canPrepare = false;
        host.canRemove = execution.status === 'ready';
        host.canDetach = false;
      }
      const phase = state.reject ? 'rejected' : state.unknown ? 'unknown' : 'accepted';
      const receipt: GitActionReceipt = {
        gitVersion: 1,
        workspaceId: original.workspaceId,
        localProjectId: original.localProjectId,
        sessionId: original.sessionId,
        operationId: action.operationId,
        phase,
        confirmed: phase === 'accepted',
        execution,
        message: 'Synthetic directory result',
      };
      receipts.set(action.operationId, receipt);
      if (state.lost) throw Error('Synthetic lost receipt');
      return structuredClone(receipt);
    }
    let receipt = receipts.get(action.operationId);
    if (!receipt && r.action === 'abandon') {
      receipt = {
        gitVersion: 1,
        workspaceId: original.workspaceId,
        localProjectId: original.localProjectId,
        sessionId: original.sessionId,
        operationId: action.operationId,
        phase: 'abandoned',
        confirmed: false,
        execution: structuredClone(host.execution),
        message: 'Original request sealed',
      };
      receipts.set(action.operationId, receipt);
    }
    return {
      gitVersion: 1,
      workspaceId: original.workspaceId,
      localProjectId: original.localProjectId,
      sessionId: original.sessionId,
      operationId: action.operationId,
      action: r.action,
      requestVersion: state.wrong ? 'sha256:' + 'd'.repeat(64) : await gitRequestVersion(action),
      confirmed: true,
      ...(receipt ? { found: true, receipt: structuredClone(receipt) } : { found: false }),
    };
  };
  let nextId = 0;
  const deps: SecureGitDependencies = {
    context: () => state.context,
    storage,
    request,
    resourceRequest: async (parent, childId, method, params, current, source, originalTarget) => {
      assert.deepEqual(parent, state.context.target);
      current();
      const result = await request(
        originalTarget ?? { ...parent, sessionId: childId },
        method,
        params,
        current,
      );
      calls.at(-1)!.resource = {
        parent: structuredClone(parent),
        childId,
        source: structuredClone(source),
      };
      return result;
    },
    beforeWrite: async (_target, current) => {
      state.writes++;
      await state.beforeWrite?.();
      current();
    },
    beforeResourceWrite: async (parent, _childId, current) => {
      assert.deepEqual(parent, state.context.target);
      state.resourceWrites++;
      await state.beforeWrite?.();
      current();
    },
    changed: async (original, current) => {
      assert.deepEqual(original, state.context.target);
      await state.beforeChanged?.();
      current();
      state.changed++;
    },
    onPrepared: async (original, execution, current) => {
      current();
      state.callbackLocks.push(memory.locks.size);
      state.prepared.push({ target: structuredClone(original), execution });
    },
    onRefresh: async (original, value, current) => {
      await state.beforeRefresh?.();
      current();
      state.callbackLocks.push(memory.locks.size);
      state.refreshed.push({ target: structuredClone(original), state: value });
    },
    onWrite: async (_target, current) => {
      current();
      state.navigations.push('write');
    },
    onNewSession: async (_target, current) => {
      current();
      state.navigations.push('new-session');
    },
    uuid: () => 'git-operation-' + ++nextId,
  };
  const create = () => new SecureGitController(deps);
  return {
    memory,
    store,
    storage,
    calls,
    states,
    receipts,
    state,
    hostState,
    deps,
    create,
    controller: create(),
  };
}
