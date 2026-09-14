import { mirror } from '../src/model';
import { createGitHubClient } from '../src/runtime/github-client';
import { createGitHubWriteClient } from '../src/runtime/github-write-client';
import type { SessionGithubOptions } from '../src/runtime/session-github';
import type { SessionGithubWriteOptions } from '../src/runtime/session-github-write';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { HostCommandDispatcher } from '../src/bridge/host-command';
import { WorkspaceController } from '../src/web/workspace-controller';
import { WorkspaceStore } from '../src/web/workspace-store';
import type { SecureStorageBackend } from '../src/web/secure-store';
import {
  desktopWorkspaceCatalogSchema,
  type DesktopWorkspaceRequest,
} from '../src/desktop/workspace-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';
import { buildSessionTurn } from '../src/session-client';
import { createAttachmentDraftItem } from '../src/web/attachments';
import type { AgentCallbacks, AgentOpenOptions } from '../src/runtime/agent';
import { workspaceInteractionSnapshot } from '../src/web/workspace-interactions';
import type { QuestionRequest } from '../src/interaction-protocol';
import type { AgentForkInput } from '../src/runtime/agent-fork';
import { syntheticTaskPlan } from './support/task-plan';
import { type PreviewAnnotationSnapshot } from '../src/web/project-preview';
import type { SessionPreviewOptions } from '../src/runtime/session-preview';
import {
  previewFrame,
  previewPng,
  previewVersion,
  previewViewport,
} from './support/preview-fixture';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  locks = new Map<string, Promise<void>>();
  failWrite = false;
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>) {
    const prior = this.locks.get(key),
      done = signal();
    this.locks.set(key, done.promise);
    try {
      await prior;
      current();
      return await task();
    } finally {
      done.resolve();
      if (this.locks.get(key) === done.promise) this.locks.delete(key);
    }
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    current();
    if (this.failWrite) throw Error('Synthetic storage failure');
    assert.deepEqual(this.values.get(key) ?? null, expected, 'CAS conflict');
    this.values.set(key, structuredClone(value));
  }
}
async function fixture(
  t: TestContext,
  config: {
    nativeFork?: boolean;
    attention?: boolean;
    github?: (projectId: string) => SessionGithubOptions;
    githubWrite?: (projectId: string) => SessionGithubWriteOptions;
    preview?: (projectId: string) => SessionPreviewOptions;
    schedule?: (ms: number, work: () => void) => () => void;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-workspace-controller-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const runtime = new RuntimeStore(join(root, 'host.sqlite'), {
      worktreeRoot: join(root, 'private-worktrees'),
    }),
    projectId = runtime.registerProject(project);
  runtime.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: runtime.workspace.machineId,
    cliType: config.nativeFork ? 'builtin' : 'custom',
    agentType: config.nativeFork ? 'codex' : 'synthetic',
    ...(config.nativeFork
      ? { runtimeOverrides: { codexPath: process.execPath } }
      : { customAcp: { command: '/synthetic/never-run', args: [] } }),
  });
  const started = signal(),
    completion = signal();
  let prompts = 0;
  const inputs: any[] = [];
  const forks: Omit<AgentForkInput, 'assertCurrent' | 'onNativeId'>[] = [];
  let openOptions: AgentOpenOptions | undefined;
  let callbacks!: AgentCallbacks,
    steerCalls = 0;
  const host = new HostWorkspace(
    runtime,
    {
      open: async (_config, _root, _native, value, options) => {
        openOptions = options;
        callbacks = value;
        let active = false;
        return {
          id: _native ?? 'synthetic-native',
          ...(config.nativeFork
            ? {
                forkCapabilities: {
                  sameDirectory: true,
                  worktree: true,
                  turnCutoff: true,
                  adapter: 'codex-acp' as const,
                  adapterVersion: '1.11.0' as const,
                },
              }
            : {}),
          capabilities: syntheticCapabilities,
          inputCapabilities: { image: true, audio: true, embeddedContext: true },
          interactionCapabilities: { questions: true, steer: true },
          steer: async () => {
            steerCalls++;
            return { outcome: 'injected' as const };
          },
          configureModel: async () => syntheticCapabilities,
          prompt: async (input, binding) => {
            inputs.push(structuredClone(input));
            active = true;
            prompts++;
            options?.taskTools?.onPromptDispatch();
            started.resolve();
            await completion.promise;
            if (config.nativeFork && binding)
              value.forkAnchor?.(
                {
                  version: 1,
                  kind: 'completed-turn',
                  adapter: 'codex-acp',
                  adapterVersion: '1.11.0',
                  sourceNativeId: _native ?? 'synthetic-native',
                  messageId: 'message-' + binding.expectedTurnId,
                },
                binding,
              );
          },
          cancel: async () => {
            completion.resolve();
          },
          close: () => {
            if (active) completion.resolve();
          },
        };
      },
      fork: async (_config, input) => {
        const { assertCurrent, onNativeId, ...data } = input;
        assertCurrent?.();
        forks.push(structuredClone(data));
        const nativeId = 'synthetic-fork-' + forks.length;
        await onNativeId?.(nativeId);
        return { nativeId };
      },
    },
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    config.github?.(projectId),
    config.githubWrite?.(projectId),
    config.preview?.(projectId),
  );
  const dispatcher = new HostCommandDispatcher({
    ready: () => true,
    workspace: (id) => (id === host.workspace.id ? host : undefined),
    hasOperation: () => false,
  });
  const catalog = desktopWorkspaceCatalogSchema.parse({
    source: 'local',
    ...(config.attention
      ? { actor: { kind: 'local', authorityId: 'synthetic-authority', accountId: 'local-desktop' } }
      : {}),
    connectionId: '00000000-0000-4000-8000-000000000001',
    origin: 'http://127.0.0.1:12345',
    owner: 'local-desktop',
    targets: [
      {
        target: {
          serverKey: 'local:' + host.workspace.machineId,
          owner: 'local-desktop',
          deviceId: 'local-machine',
          userId: host.workspace.userId,
          machineId: host.workspace.machineId,
          workspaceId: host.workspace.id,
          localProjectId: projectId,
          catalogWorkspaceId: 'space',
          catalogProjectId: 'project',
          replicaId: 'replica',
        },
        workspaceName: 'Workspace',
        projectName: 'Project',
        hostName: 'Computer',
        online: true,
        runtime: host.workspace,
      },
    ],
  });
  const memory = new Memory(),
    store = new WorkspaceStore(memory),
    calls: DesktopWorkspaceRequest[] = [];
  const fault: {
    unavailable?: boolean;
    loseMutation?: boolean;
    wrongReceipt?: boolean;
    before?: (request: DesktopWorkspaceRequest) => Promise<void>;
    after?: (request: DesktopWorkspaceRequest) => Promise<void>;
  } = {};
  const request = async (input: DesktopWorkspaceRequest): Promise<unknown> => {
    calls.push(structuredClone(input));
    await fault.before?.(input);
    if (fault.unavailable)
      return {
        ok: false,
        error: { code: 'unavailable', status: null, rejected: false, message: 'Synthetic offline' },
      };
    if (input.action === 'catalog') return { ok: true, value: structuredClone(catalog) };
    if (input.action === 'attention') {
      assert.deepEqual(input.actor, catalog.actor);
      const target = input.target,
        command = input.command;
      const context = {
        actor: input.actor,
        executionDeviceId: target.deviceId,
        machineId: target.machineId,
        catalogWorkspaceId: target.catalogWorkspaceId,
        projectId: target.catalogProjectId,
        replicaId: target.replicaId,
        runtimeWorkspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      };
      const authority = {
        serverOrigin: catalog.origin,
        ownerId: catalog.owner,
        deviceId: target.deviceId,
        current: () => {
          if (fault.unavailable) throw Error('Synthetic revoked');
        },
      };
      let value: unknown;
      if (command.kind === 'list') value = host.attentionList(context, command.query);
      else if (command.kind === 'items') value = host.attentionItems(context, command.query);
      else if (command.kind === 'detail') value = host.attentionDetail(context, command.itemId);
      else if (command.kind === 'seen')
        value = await host.attentionSeen(context, command.itemId, command.input);
      else if (command.kind === 'disposition')
        value = await host.attentionDisposition(context, command.itemId, command.input);
      else if (command.kind === 'continue')
        value = await host.attentionContinue(context, command.itemId, command.input, authority);
      else
        value = await host.attentionPermission(context, command.itemId, command.input, authority);
      await fault.after?.(input);
      return { ok: true, value };
    }
    let value: unknown;
    try {
      value = await dispatcher.execute(input.command, {
        authority: {
          serverOrigin: catalog.origin,
          ownerId: catalog.owner,
          deviceId: catalog.targets[0]!.target.deviceId,
          current: () => {
            if (fault.unavailable) throw Error('Synthetic connection revoked');
          },
        },
      });
    } catch (error) {
      const failure = dispatcher.error(input.command, error);
      return {
        ok: false,
        error: {
          code: 'host',
          message: failure.message,
          status: failure.status,
          rejected: failure.rejected,
        },
      };
    }
    await fault.after?.(input);
    if (input.command.method === 'mutate' && fault.loseMutation)
      return {
        ok: false,
        error: {
          code: 'unavailable',
          status: null,
          rejected: false,
          message: 'Synthetic receipt lost',
        },
      };
    if (input.command.method === 'mutate' && fault.wrongReceipt)
      value = { accepted: true, delivered: true, operationId: 'another-operation' };
    return { ok: true, value };
  };
  const controller = new WorkspaceController({
    request,
    store,
    schedule: config.schedule ?? (() => () => {}),
  });
  t.after(() => {
    completion.resolve();
    controller.close();
    host.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  await controller.refreshCatalog('local');
  await controller.selectProject('local', catalog.targets[0]!.target);
  async function create() {
    const id = await controller.createSession('agent');
    await controller.refreshSessions();
    await controller.openSession(id);
    return id;
  }
  return {
    controller,
    project,
    runtime,
    create,
    request,
    memory,
    store,
    catalog,
    fault,
    calls,
    started,
    completion,
    inputs,
    host,
    callbacks: () => callbacks,
    steerCalls: () => steerCalls,
    prompts: () => prompts,
    forks,
    openOptions: () => openOptions,
  };
}

test('retired recovery copies are deleted atomically while current drafts and original operations remain usable', async (t) => {
  const f = await fixture(t),
    sessionId = await f.create();
  await f.controller.saveDraft('Current editable draft', {});
  const scope = f.controller.state.scope!;
  const before = await f.store.read(scope, () => {});
  const key = [...f.memory.values.keys()].find((key) =>
    key.startsWith('["moor-desktop-ledger-v1",'),
  )!;
  const retired = {
    ...before,
    legacy: [{ snapshot: 'obsolete' }],
    legacyDrafts: [{ draft: 'obsolete' }],
    legacyDraftSlots: { old: 'old-session' },
    legacyRevisions: [{ draft: 'obsolete revision' }],
  };
  f.memory.values.set(key, structuredClone(retired));
  f.memory.failWrite = true;
  await assert.rejects(
    f.store.read(scope, () => {}),
    /storage failure/,
  );
  assert.deepEqual(f.memory.values.get(key), retired);
  f.memory.failWrite = false;
  const cleaned = await f.store.read(scope, () => {});
  assert.deepEqual(cleaned, { ...before, revision: before.revision + 1 });
  assert.deepEqual(f.memory.values.get(key), cleaned);
  assert.equal(cleaned.drafts[sessionId]?.text, 'Current editable draft');
  assert.equal(f.prompts(), 0);
  await f.controller.refreshSession();
  await f.controller.send();
  await f.started.promise;
  assert.equal(f.prompts(), 1);
});

test('retired recovery cleanup validates current scope and does not erase a competing write', async (t) => {
  const f = await fixture(t);
  await f.create();
  const scope = f.controller.state.scope!;
  const before = await f.store.read(scope, () => {});
  const key = [...f.memory.values.keys()].find((key) =>
    key.startsWith('["moor-desktop-ledger-v1",'),
  )!;
  const retired = { ...before, legacy: [] };
  f.memory.values.set(key, {
    ...retired,
    scope: { ...scope, target: { ...scope.target, owner: 'another-owner' } },
  });
  await assert.rejects(
    f.store.read(scope, () => {}),
    /改变/,
  );
  assert(Object.hasOwn(f.memory.values.get(key) as object, 'legacy'));
  f.memory.values.set(key, retired);
  const compareAndSet = f.memory.compareAndSet.bind(f.memory);
  const competing = { ...before, revision: before.revision + 1 };
  f.memory.compareAndSet = async (...args) => {
    f.memory.values.set(key, competing);
    return compareAndSet(...args);
  };
  await assert.rejects(
    f.store.read(scope, () => {}),
    /CAS conflict/,
  );
  assert.deepEqual(f.memory.values.get(key), competing);
});

test('workspace client creates and sends through the host, preserving model selection and confirming delivery', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  assert.equal(f.controller.state.sessionId, id);
  assert(f.controller.state.session?.agent?.runConfig?.models.length);
  await f.controller.saveDraft('Synthetic prompt', {});
  await f.controller.send();
  await f.started.promise;
  assert.equal(f.prompts(), 1);
  assert.equal(f.controller.state.draft?.text, '');
  assert(f.controller.state.ledger?.operations.every((entry) => entry.status === 'confirmed'));
  await f.controller.refreshSession();
  const active = f.controller.state.session!.history.find(
    (turn) => turn.role === 'assistant' && !turn.finished,
  )!;
  await f.controller.stop(active.id);
  assert.equal(f.prompts(), 1);
});

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      '-C',
      root,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim();
}
async function gitProject(f: Awaited<ReturnType<typeof fixture>>) {
  git(f.project, 'init', '--initial-branch=main');
  writeFileSync(join(f.project, 'file.txt'), 'Synthetic baseline\n');
  git(f.project, 'add', '.');
  git(f.project, 'commit', '-m', 'Synthetic baseline');
  const oid = git(f.project, 'rev-parse', 'main');
  await f.create();
  const panel = await f.controller.openGit();
  await panel.refresh();
  return { panel, oid };
}

test('workspace Git prepares a real worktree, inspects a lost receipt and checks reviewed state before cleanup', async (t) => {
  const f = await fixture(t),
    { panel, oid } = await gitProject(f);
  writeFileSync(join(f.project, 'file.txt'), 'Original unsaved source\n');
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'git-action')
      throw Error('Synthetic lost Git receipt');
  };
  await assert.rejects(panel.prepare('main', oid, 'feature/synthetic'), /lost Git/);
  assert(panel.controller.pending);
  await f.controller.saveDraft('Keep this text', {});
  await assert.rejects(f.controller.send(), /原 Git 操作/);
  const id = f.controller.state.sessionId!;
  await f.controller.openSession(id);
  const restored = await f.controller.openGit();
  assert(restored.controller.pending);
  f.fault.after = undefined;
  await restored.inspect();
  assert.equal(restored.controller.pending, undefined);
  assert.equal(
    f.calls.filter((input) => input.action === 'execute' && input.command.method === 'git-action')
      .length,
    1,
  );
  const cwd = f.runtime.executions.get({ ...f.controller.state.scope!.target, sessionId: id })!
    .managed!.cwd;
  assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'Synthetic baseline\n');
  assert.equal(readFileSync(join(f.project, 'file.txt'), 'utf8'), 'Original unsaved source\n');
  assert.equal(git(f.project, 'branch', '--show-current'), 'main');
  await restored.refresh();
  writeFileSync(join(cwd, 'file.txt'), 'Unreviewed file change\n');
  await assert.rejects(restored.remove(), /审阅的工作目录或文件状态已改变/);
  assert(existsSync(cwd));
  writeFileSync(join(cwd, 'file.txt'), 'Synthetic baseline\n');
  await restored.refresh();
  await restored.remove();
  assert(!existsSync(cwd));
  assert.equal(git(f.project, 'rev-parse', 'feature/synthetic'), oid);
  assert.equal(f.controller.state.draft!.text, 'Keep this text');
  assert.equal(f.prompts(), 0);
});

test('workspace Git holds the shared operation lock across delivery so another page cannot replay it', async (t) => {
  const f = await fixture(t),
    { panel, oid } = await gitProject(f),
    arrived = signal(),
    release = signal();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'git-action') {
      arrived.resolve();
      await release.promise;
    }
  };
  const preparing = panel.prepare('main', oid, 'feature/one-operation');
  await arrived.promise;
  const second = new WorkspaceController({ request: f.request, store: f.store });
  t.after(() => second.close());
  await second.refreshCatalog('local');
  await second.selectProject('local', f.catalog.targets[0]!.target);
  await second.openSession(f.controller.state.sessionId!);
  const other = await second.openGit(),
    queued = signal(),
    originalLock = f.memory.exclusive.bind(f.memory);
  f.memory.exclusive = async (key, current, task) => {
    if (key.includes('git:') && f.memory.locks.has(key)) queued.resolve();
    return originalLock(key, current, task);
  };
  const rejected = assert.rejects(other.retry(), /原 Git 操作已改变或已有结果/);
  await queued.promise;
  release.resolve();
  await preparing;
  await rejected;
  assert.equal(
    f.calls.filter((input) => input.action === 'execute' && input.command.method === 'git-action')
      .length,
    1,
  );
  assert.equal(f.prompts(), 0);
});

test('an undelivered Git operation can be inspected and explicitly sealed without creating a worktree', async (t) => {
  const f = await fixture(t),
    { panel, oid } = await gitProject(f);
  f.fault.before = async (input) => {
    if (input.action === 'execute' && input.command.method === 'git-action')
      throw Error('Synthetic dispatch lost');
  };
  await assert.rejects(panel.prepare('main', oid, 'feature/not-dispatched'), /dispatch lost/);
  const original = structuredClone(panel.controller.pending);
  f.fault.before = undefined;
  await assert.rejects(panel.inspect(), /尚未记录/);
  assert.deepEqual(panel.controller.pending, original);
  await panel.abandon();
  assert.equal(panel.controller.pending, undefined);
  assert.equal(panel.controller.receipt?.phase, 'abandoned');
  await assert.rejects(panel.retry(), /已改变或已有结果/);
  assert.equal(git(f.project, 'branch', '--list', 'feature/not-dispatched'), '');
  assert.equal(f.prompts(), 0);
});

test('Git cache persistence failure prevents a new directory operation and retains the current draft', async (t) => {
  const f = await fixture(t),
    { panel, oid } = await gitProject(f);
  await f.controller.saveDraft('Keep original draft', {});
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'git-state')
      f.memory.failWrite = true;
  };
  await assert.rejects(panel.prepare('main', oid, 'feature/not-saved'), /storage failure/);
  f.memory.failWrite = false;
  assert.equal(git(f.project, 'branch', '--list', 'feature/not-saved'), '');
  assert.equal(f.controller.state.draft!.text, 'Keep original draft');
  assert.equal(
    f.calls.filter((input) => input.action === 'execute' && input.command.method === 'git-action')
      .length,
    0,
  );
});

test('a turn staged by another page during the Git read prevents the new directory request atomically', async (t) => {
  const f = await fixture(t),
    { panel, oid } = await gitProject(f);
  await f.controller.saveDraft('Concurrent draft', {});
  f.fault.after = async (input) => {
    if (input.action !== 'execute' || input.command.method !== 'git-state') return;
    const state = f.controller.state;
    const pending = buildSessionTurn({
      scope: { ...state.scope!.target, sessionId: state.sessionId! },
      read: state.session,
      agent: state.session!.agent!,
      prompt: 'Concurrent draft',
      operationId: 'concurrent-turn',
      turnId: 'concurrent-user',
      peerId: 'concurrent-peer',
      now: '2026-09-14T00:00:00.000Z',
    });
    await f.store.stage(
      state.scope!,
      { kind: 'mutation', value: pending },
      { sessionId: state.sessionId!, revision: state.draft!.revision },
      () => {},
    );
  };
  await assert.rejects(panel.prepare('main', oid, 'feature/raced'), /先核查此会话原操作/);
  assert.equal(
    f.calls.filter((input) => input.action === 'execute' && input.command.method === 'git-action')
      .length,
    0,
  );
  assert.equal(git(f.project, 'branch', '--list', 'feature/raced'), '');
  assert.equal(f.prompts(), 0);
});

async function forkSource(f: Awaited<ReturnType<typeof fixture>>) {
  const { oid } = await gitProject(f);
  await f.controller.saveDraft('Original source turn', {});
  await f.controller.send();
  await f.started.promise;
  const sourceId = f.controller.state.sessionId!,
    run = f.host.active.get(sourceId)!;
  f.completion.resolve();
  await run.done;
  await f.controller.refreshSession();
  const turnId = f.controller.state.session!.history.find((turn) => turn.role === 'assistant')!.id;
  const panel = await f.controller.openFork();
  await panel.refresh(turnId);
  assert(panel.controller.options!.turns.some((turn) => turn.turnId === turnId && turn.available));
  return { panel, sourceId, turnId, oid };
}

test('workspace Fork uses native completed-turn context and preserves the source draft while the child starts empty', async (t) => {
  const f = await fixture(t, { nativeFork: true }),
    { panel, sourceId, turnId } = await forkSource(f);
  await f.controller.saveDraft('Later source draft', {});
  await panel.create({ kind: 'turn', turnId }, { kind: 'same-directory' });
  assert.equal(f.forks.length, 1);
  assert.equal(f.forks[0]!.anchor!.messageId, 'message-' + turnId);
  assert.equal(f.forks[0]!.sourceCwd, f.forks[0]!.targetCwd);
  assert.equal(f.controller.state.draft!.text, 'Later source draft');
  const child = panel.controller.receipt!.childSessionId;
  await f.controller.openSession(child);
  assert.deepEqual(f.controller.state.session!.history, []);
  assert.equal(f.controller.state.session!.meta.forkOrigin!.sourceSessionId, sourceId);
  assert.deepEqual(f.controller.state.session!.meta.forkOrigin!.cutoff, { kind: 'turn', turnId });
  assert.equal(f.controller.state.draft!.text, '');
  assert.equal(f.prompts(), 1);
});

test('lost worktree Fork receipt blocks source and child until read-only recovery and retains directory cleanup', async (t) => {
  const f = await fixture(t, { nativeFork: true }),
    { panel, sourceId, oid } = await forkSource(f);
  await f.controller.saveDraft('Keep source draft', {});
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'fork-action')
      throw Error('Synthetic lost Fork receipt');
  };
  await assert.rejects(
    panel.create(
      { kind: 'current' },
      { kind: 'worktree', baseBranch: 'main', expectedOid: oid, newBranch: 'feature/fork' },
    ),
    /lost Fork/,
  );
  const pending = panel.controller.pending!,
    child = pending.request.childSessionId;
  assert(f.store.forkBlocked(f.controller.state.ledger!, sourceId));
  assert(f.store.forkBlocked(f.controller.state.ledger!, child));
  await assert.rejects(f.controller.send(), /原 Fork/);
  await f.controller.openSession(child);
  await f.controller.saveDraft('Reserved child draft', {});
  await assert.rejects(f.controller.send(), /原 Fork/);
  await f.controller.openSession(sourceId);
  const restored = await f.controller.openFork();
  assert.equal(f.forks.length, 1);
  f.fault.after = undefined;
  await restored.inspect();
  assert.equal(f.forks.length, 1);
  const gitPanel = await f.controller.openGit(() => {}, child);
  await gitPanel.refresh();
  assert.equal(gitPanel.controller.state!.execution.mode, 'worktree');
  await gitPanel.remove();
  await restored.confirmCleanup(child);
  assert.equal(restored.controller.cleanup!.status, 'removed');
  assert.equal(f.controller.state.draft!.text, 'Keep source draft');
  assert.equal(f.prompts(), 1);
});

test('a changed source turn invalidates reviewed Fork options before native execution', async (t) => {
  const f = await fixture(t, { nativeFork: true }),
    { panel, sourceId } = await forkSource(f),
    arrived = signal(),
    release = signal();
  f.fault.before = async (input) => {
    if (input.action === 'execute' && input.command.method === 'fork-options') {
      arrived.resolve();
      await release.promise;
    }
  };
  const rejected = assert.rejects(
    panel.create({ kind: 'current' }, { kind: 'same-directory' }),
    /源会话已经改变/,
  );
  await arrived.promise;
  await f.controller.saveDraft('New source turn', {});
  await f.controller.send();
  await f.host.active.get(sourceId)?.done;
  release.resolve();
  await rejected;
  assert.equal(f.forks.length, 0);
});

test('two pages cannot replay the same pending Fork while its original native result is being delivered', async (t) => {
  const f = await fixture(t, { nativeFork: true }),
    { panel, sourceId } = await forkSource(f),
    arrived = signal(),
    release = signal();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'fork-action') {
      arrived.resolve();
      await release.promise;
    }
  };
  const creating = panel.create({ kind: 'current' }, { kind: 'same-directory' });
  await arrived.promise;
  const second = new WorkspaceController({ request: f.request, store: f.store });
  t.after(() => second.close());
  await second.refreshCatalog('local');
  await second.selectProject('local', f.catalog.targets[0]!.target);
  await second.openSession(sourceId);
  const other = await second.openFork(),
    queued = signal(),
    originalLock = f.memory.exclusive.bind(f.memory);
  f.memory.exclusive = async (key, current, task) => {
    if (key.includes('fork:') && f.memory.locks.has(key)) queued.resolve();
    return originalLock(key, current, task);
  };
  const rejected = assert.rejects(other.retry(), /原 Fork 已改变或已有结果/);
  await queued.promise;
  release.resolve();
  await creating;
  await rejected;
  assert.equal(f.forks.length, 1);
});

test('a failed Fork save never invokes the native agent and closing a panel cancels a late options read', async (t) => {
  const f = await fixture(t, { nativeFork: true }),
    { panel } = await forkSource(f);
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'fork-options')
      f.memory.failWrite = true;
  };
  await assert.rejects(
    panel.create({ kind: 'current' }, { kind: 'same-directory' }),
    /storage failure/,
  );
  f.memory.failWrite = false;
  const reopened = await f.controller.openFork(),
    arrived = signal(),
    release = signal();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'fork-options') {
      arrived.resolve();
      await release.promise;
    }
  };
  const rejected = assert.rejects(
    reopened.create({ kind: 'current' }, { kind: 'same-directory' }),
    /Fork 面板已关闭/,
  );
  await arrived.promise;
  reopened.close();
  release.resolve();
  await rejected;
  assert.equal(f.forks.length, 0);
});

async function mcp(f: Awaited<ReturnType<typeof fixture>>, choose = true) {
  await f.create();
  await f.host.mcpSettings.handle({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic MCP',
    description: 'Synthetic tools',
    projectIds: [f.catalog.targets[0]!.target.localProjectId],
    enabled: true,
    connection: {
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      headers: { Authorization: 'Bearer SYNTHETIC_PRIVATE_MCP_TOKEN' },
    },
  });
  const panel = await f.controller.openMcp();
  await panel.controller.refresh();
  const server = panel.controller.list!.servers[0]!;
  assert(server);
  if (choose) await panel.controller.apply([server]);
  return { panel, server };
}

test('workspace MCP reads and selection stay local until manual delivery with the exact version', async (t) => {
  const f = await fixture(t),
    { server } = await mcp(f);
  assert.equal(f.prompts(), 0);
  await f.controller.saveDraft('Use reviewed tools', {});
  await f.controller.send();
  await f.started.promise;
  assert.equal(f.openOptions()?.mcp?.servers.length, 1);
  assert.equal(f.prompts(), 1);
  const ledger = f.controller.state.ledger!,
    saved = ledger.mcp![f.controller.state.sessionId!]!;
  assert.equal(saved.review, undefined);
  assert.equal(saved.delivery, undefined);
  assert.deepEqual(
    ledger.operations.find((item) => item.original.kind === 'mutation')!.mcpReview!.servers,
    [server],
  );
  assert.doesNotMatch(
    JSON.stringify(ledger),
    /SYNTHETIC_PRIVATE_MCP_TOKEN|Authorization|synthetic.invalid/,
  );
});

test('lost MCP receipt retains the original authorization and a newer selection survives explicit retry', async (t) => {
  const f = await fixture(t);
  await mcp(f);
  await f.controller.saveDraft('Original tools', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send(), /执行电脑暂不可用/);
  await f.started.promise;
  const id = f.controller.state.sessionId!,
    original = f.controller.state.ledger!.operations.find(
      (item) => item.original.kind === 'mutation',
    )!;
  await f.controller.openSession(id);
  assert.equal(f.prompts(), 1);
  const panel = await f.controller.openMcp();
  await panel.controller.apply([]);
  const newer = f.controller.state.ledger!.mcp![id]!.review;
  f.fault.loseMutation = false;
  await f.controller.retry(original.original.value.operationId);
  assert.equal(f.prompts(), 1);
  const calls = f.calls.filter(
    (input) => input.action === 'execute' && input.command.method === 'mutate',
  );
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(f.controller.state.ledger!.mcp![id]!.review, newer);
  assert.equal(f.controller.state.ledger!.mcp![id]!.delivery, undefined);
});

test('a concurrent MCP selection change refuses submission instead of using unseen authorization', async (t) => {
  const f = await fixture(t);
  await mcp(f);
  await f.controller.saveDraft('Keep reviewed text', {});
  const arrived = signal(),
    release = signal();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'mcp-read') {
      arrived.resolve();
      await release.promise;
    }
  };
  const rejection = assert.rejects(f.controller.send(), /MCP 草稿已改变/);
  await arrived.promise;
  const state = f.controller.state,
    saved = state.ledger!.mcp![state.sessionId!]!;
  await f.store.saveMcp(
    state.scope!,
    state.sessionId!,
    saved.cacheRevision,
    {
      ...saved,
      cacheRevision: saved.cacheRevision + 1,
      review: { reviewId: 'newer-review', servers: [] },
    },
    () => {},
  );
  release.resolve();
  await rejection;
  assert.equal(f.prompts(), 0);
  await f.controller.reloadDraft();
  assert.equal(f.controller.state.draft!.text, 'Keep reviewed text');
  assert.equal(f.controller.state.ledger!.mcp![state.sessionId!]!.delivery, undefined);
});

test('a removed MCP version preserves the original review and refuses a new turn', async (t) => {
  const f = await fixture(t);
  await mcp(f);
  await f.controller.saveDraft('Keep this authorization', {});
  const before = f.controller.state.ledger!.mcp![f.controller.state.sessionId!]!.review;
  const settings = f.host.mcpSettings.read();
  await f.host.mcpSettings.handle({
    action: 'enabled',
    expectedRevision: settings.revision,
    id: settings.presets[0]!.id,
    enabled: false,
  });
  await assert.rejects(f.controller.send(), /原版本|不可用|改变/);
  assert.deepEqual(f.controller.state.ledger!.mcp![f.controller.state.sessionId!]!.review, before);
  assert.equal(f.controller.state.draft!.text, 'Keep this authorization');
  assert.equal(f.prompts(), 0);
});

test('failed atomic MCP staging leaves both the selection and instruction unsent', async (t) => {
  const f = await fixture(t);
  await mcp(f);
  await f.controller.saveDraft('Save first', {});
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'mcp-read')
      f.memory.failWrite = true;
  };
  await assert.rejects(f.controller.send(), /storage failure/);
  f.memory.failWrite = false;
  await f.controller.reloadDraft();
  assert.equal(f.controller.state.draft!.text, 'Save first');
  assert.equal(f.controller.state.ledger!.mcp![f.controller.state.sessionId!]!.delivery, undefined);
  assert.equal(f.prompts(), 0);
});

async function skills(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.project, '.agents/skills/synthetic');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), '# Synthetic skill\n\nSYNTHETIC_SKILL_BODY');
  await f.create();
  const panel = f.controller.openSkills();
  await panel.controller.refresh();
  const skill = panel.controller.list!.skills.find((item) => item.path === 'synthetic/SKILL.md');
  assert(skill);
  await panel.controller.select(skill.id);
  return { panel, path: join(path, 'SKILL.md') };
}

test('workspace Skills uses actual host reads and appends reviewed instructions without executing', async (t) => {
  const f = await fixture(t),
    { panel } = await skills(f);
  await f.controller.saveDraft('Existing draft', { modelId: 'synthetic-model' });
  await panel.addToDraft();
  assert.match(f.controller.state.draft!.text, /^Existing draft\n\n\[Skill 说明快照\]/);
  assert.match(f.controller.state.draft!.text, /SYNTHETIC_SKILL_BODY/);
  assert.equal(f.controller.state.draft!.selection.modelId, 'synthetic-model');
  assert.equal(f.prompts(), 0);
  assert.equal(
    f.calls.filter((input) => input.action === 'execute' && input.command.method === 'skills-read')
      .length,
    3,
  );
  panel.close();
  assert.equal(panel.controller.detail, undefined);
  await assert.rejects(panel.addToDraft(), /面板已关闭/);
});

test('workspace Skills rejects changed source content and preserves the original draft', async (t) => {
  const f = await fixture(t),
    { panel, path } = await skills(f);
  await f.controller.saveDraft('Keep me', {});
  writeFileSync(path, '# Changed skill\n\nUNREVIEWED');
  await assert.rejects(panel.addToDraft());
  assert.equal(f.controller.state.draft!.text, 'Keep me');
  assert.equal(f.prompts(), 0);
});

test('workspace Skills refuses to overwrite another page draft during the reviewed read', async (t) => {
  const f = await fixture(t),
    { panel } = await skills(f),
    arrived = signal(),
    release = signal();
  await f.controller.saveDraft('Old draft', {});
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'skills-read') {
      arrived.resolve();
      await release.promise;
    }
  };
  const adding = panel.addToDraft();
  const rejected = assert.rejects(adding, /草稿|改变|更新/);
  await arrived.promise;
  await f.store.saveDraft(
    f.controller.state.scope!,
    f.controller.state.sessionId!,
    f.controller.state.draft!.revision,
    'Other page',
    {},
    () => {},
  );
  release.resolve();
  await rejected;
  await f.controller.reloadDraft();
  assert.equal(f.controller.state.draft!.text, 'Other page');
  assert.equal(f.prompts(), 0);
});

test('closing Skills cancels a late reviewed append even when the same session is reopened', async (t) => {
  const f = await fixture(t),
    { panel } = await skills(f),
    arrived = signal(),
    release = signal();
  await f.controller.saveDraft('Keep me', {});
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'skills-read') {
      arrived.resolve();
      await release.promise;
    }
  };
  const rejected = assert.rejects(panel.addToDraft());
  await arrived.promise;
  panel.close();
  await f.controller.openSession(f.controller.state.sessionId!);
  release.resolve();
  await rejected;
  assert.equal(f.controller.state.draft!.text, 'Keep me');
  assert.equal(f.prompts(), 0);
});

async function interactive(f: Awaited<ReturnType<typeof fixture>>) {
  const sessionId = await f.create();
  await f.controller.saveDraft('Interactive synthetic turn', {});
  await f.controller.send();
  await f.started.promise;
  await f.controller.refreshSession();
  const target = f.controller.state.scope!.target;
  const request: QuestionRequest = {
    interactionVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
    expectedTurnId: workspaceInteractionSnapshot(f.controller.state).activeId!,
    requestId: 'synthetic-question',
    message: 'Choose a color',
    fields: [
      { id: 'color', label: 'Color', kind: 'text', required: true, minLength: 1, maxLength: 20 },
    ],
  };
  return request;
}

test('workspace answers only the reviewed active question and retries a lost receipt with the original request', async (t) => {
  const f = await fixture(t),
    question = await interactive(f);
  let answers = 0;
  const native = f.callbacks().question!(question).then((value) => {
    answers++;
    return value;
  });
  await f.host.serial(question.sessionId, async () => {});
  await f.controller.refreshSession();
  await f.controller.saveQuestionDraft(question, { color: 'blue' });
  assert.equal(answers, 0);
  await assert.rejects(
    f.controller.answerQuestion(
      { ...question, message: 'Different question' },
      { action: 'accept', values: { color: 'blue' } },
    ),
    /已改变/,
  );
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'answer-question')
      throw Error('Synthetic lost answer receipt');
  };
  await assert.rejects(
    f.controller.answerQuestion(question, { action: 'accept', values: { color: 'blue' } }),
    /lost answer/,
  );
  assert.equal((await native).answer.action, 'accept');
  const pending = f.controller.state.ledger!.interactions![question.sessionId]!.value.pending!;
  await f.controller.openSession(question.sessionId);
  assert.equal(answers, 1);
  f.fault.after = undefined;
  await f.controller.retryInteraction();
  const sent = f.calls.filter(
    (input) => input.action === 'execute' && input.command.method === 'answer-question',
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal((sent[0] as any).command.params.operationId, pending.request.operationId);
  assert.equal(
    f.controller.state.ledger!.interactions![question.sessionId]!.value.pending,
    undefined,
  );
  assert.equal(answers, 1);
  assert.equal(f.prompts(), 1);
});

test('workspace steering is bound to the displayed turn and a restored pending steer never runs automatically', async (t) => {
  const f = await fixture(t),
    question = await interactive(f);
  await f.controller.saveSteerDraft('More detail');
  await assert.rejects(f.controller.steer('wrong-turn', 'More detail'), /原回合/);
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'steer')
      throw Error('Synthetic lost steer receipt');
  };
  await assert.rejects(f.controller.steer(question.expectedTurnId, 'More detail'), /lost steer/);
  assert.equal(f.steerCalls(), 1);
  await f.controller.openSession(question.sessionId);
  assert.equal(f.steerCalls(), 1);
  f.fault.after = undefined;
  await f.controller.retryInteraction();
  assert.equal(f.steerCalls(), 1);
  const calls = f.calls.filter(
    (input) => input.action === 'execute' && input.command.method === 'steer',
  );
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(f.controller.state.ledger!.interactions![question.sessionId]!.value.steerDraft, '');
  await f.controller.stop(question.expectedTurnId);
  await assert.rejects(
    f.controller.steer(question.expectedTurnId, 'Do not create another turn'),
    /原活动回合已结束/,
  );
  assert.equal(f.prompts(), 1);
});

test('closing an ended interaction preserves its unknown result without starting another turn', async (t) => {
  const f = await fixture(t),
    question = await interactive(f);
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'steer')
      throw Error('Synthetic lost steer receipt');
  };
  await assert.rejects(
    f.controller.steer(question.expectedTurnId, 'Original unknown result'),
    /lost steer/,
  );
  const pending = f.controller.state.ledger!.interactions![question.sessionId]!.value.pending;
  await assert.rejects(f.controller.dismissInteraction(), /尚未结束/);
  f.fault.after = undefined;
  await f.controller.stop(question.expectedTurnId);
  await f.controller.dismissInteraction();
  const saved = f.controller.state.ledger!.interactions![question.sessionId]!.value;
  assert.equal(saved.pending, undefined);
  assert.deepEqual(saved.closed[0]!.operation, pending);
  assert.equal(saved.closed[0]!.outcome, 'unknown');
  await assert.rejects(f.controller.retryInteraction(), /没有待确认/);
  assert.equal(f.prompts(), 1);
  assert.equal(f.steerCalls(), 1);
});

test('two workspace pages hold the interaction lock across delivery and only one retries the original', async (t) => {
  const f = await fixture(t),
    question = await interactive(f);
  const entered = signal(),
    release = signal(),
    queued = signal();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'steer') {
      entered.resolve();
      await release.promise;
    }
  };
  const first = f.controller.steer(question.expectedTurnId, 'Once across pages');
  await entered.promise;
  const other = new WorkspaceController({
    request: f.request,
    store: new WorkspaceStore(f.memory),
  });
  t.after(() => other.close());
  await other.refreshCatalog('local');
  await other.selectProject('local', f.catalog.targets[0]!.target);
  await other.openSession(question.sessionId);
  const exclusive = f.memory.exclusive.bind(f.memory);
  f.memory.exclusive = async (key, current, task) => {
    if (key.includes('interaction:') && f.memory.locks.has(key)) queued.resolve();
    return exclusive(key, current, task);
  };
  const second = assert.rejects(other.retryInteraction(), /没有待确认/);
  await queued.promise;
  assert.equal(f.steerCalls(), 1);
  release.resolve();
  await first;
  await second;
  assert.equal(
    f.calls.filter((input) => input.action === 'execute' && input.command.method === 'steer')
      .length,
    1,
  );
});

test('failed interaction draft persistence blocks submission until the user explicitly reloads saved state', async (t) => {
  const f = await fixture(t),
    question = await interactive(f);
  f.memory.failWrite = true;
  await assert.rejects(f.controller.saveSteerDraft('Unsaved'), /storage failure/);
  f.memory.failWrite = false;
  await assert.rejects(f.controller.steer(question.expectedTurnId, 'Unsaved'), /storage failure/);
  assert.equal(f.steerCalls(), 0);
  await f.controller.reloadDraft();
  await f.controller.saveSteerDraft('Reviewed after recovery');
  await f.controller.steer(question.expectedTurnId, 'Reviewed after recovery');
  assert.equal(f.steerCalls(), 1);
});

test('workspace attachments remain local until upload, then send their exact bytes without requiring text', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  await f.controller.addAttachments([
    new File(['Synthetic attachment'], 'notes.txt', { type: 'text/plain' }),
  ]);
  const item = f.controller.state.ledger!.attachments![id]!.items[0]!;
  assert.equal(f.prompts(), 0);
  assert.equal(item.uploaded, false);
  assert.equal(
    f.calls.filter(
      (call) => call.action === 'execute' && call.command.method === 'attachment-action',
    ).length,
    0,
  );
  await assert.rejects(f.controller.send(), /附件草稿/);
  await f.controller.uploadAttachment(item.reference.attachmentId);
  assert.equal(f.controller.state.ledger!.attachments![id]!.items[0]!.uploaded, true);
  await f.controller.send();
  await f.started.promise;
  assert.equal(f.prompts(), 1);
  assert.equal(f.controller.state.ledger!.attachments![id]!.items.length, 0);
  assert.deepEqual(f.inputs[0].attachments, [item.reference]);
  assert.deepEqual(f.inputs[0].attachmentData, [{ reference: item.reference, data: item.data }]);
});

test('lost attachment receipts retain an immutable original; reopening never uploads, and manual inspect confirms it', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  await f.controller.addAttachments([
    new File(['Exactly once'], 'once.txt', { type: 'text/plain' }),
  ]);
  const item = f.controller.state.ledger!.attachments![id]!.items[0]!;
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'attachment-action')
      throw Error('Synthetic lost attachment receipt');
  };
  await assert.rejects(
    f.controller.uploadAttachment(item.reference.attachmentId),
    /lost attachment/,
  );
  const operation = f.controller.state.ledger!.operations.find(
    (entry) => entry.status === 'pending',
  )!;
  assert.equal(operation.original.kind, 'attachment');
  await f.controller.openSession(id);
  assert(f.controller.state.ledger!.attachments![id]!.items[0]!.pending);
  const count = () =>
    f.calls.filter(
      (call) => call.action === 'execute' && call.command.method === 'attachment-action',
    ).length;
  assert.equal(count(), 1);
  await assert.rejects(f.controller.removeAttachment(item.reference.attachmentId), /尚未确认/);
  f.fault.after = undefined;
  await f.controller.inspect(operation.original.value.operationId);
  assert.equal(count(), 1);
  assert.equal(f.controller.state.ledger!.attachments![id]!.items[0]!.uploaded, true);
  assert.equal(f.prompts(), 0);
  await f.controller.removeAttachment(item.reference.attachmentId);
  assert.equal(f.controller.state.ledger!.attachments![id]!.items.length, 0);
});

test('attachment write failures, cross-page changes and a later attachment during delivery preserve reviewed data', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  f.memory.failWrite = true;
  await assert.rejects(
    f.controller.addAttachments([new File(['retain'], 'first.txt', { type: 'text/plain' })]),
    /storage failure/,
  );
  f.memory.failWrite = false;
  assert.equal(f.controller.state.ledger?.attachments, undefined);
  await f.controller.addAttachments([new File(['retain'], 'first.txt', { type: 'text/plain' })]);
  const item = f.controller.state.ledger!.attachments![id]!.items[0]!;
  await f.controller.uploadAttachment(item.reference.attachmentId);
  const before = f.controller.state.ledger!.attachments![id]!;
  const added = await createAttachmentDraftItem(
    new File(['later'], 'later.txt', { type: 'text/plain' }),
    'later-attachment',
  );
  await f.store.saveAttachments(
    f.controller.state.scope!,
    id,
    before.revision,
    [...before.items, added],
    () => {},
  );
  await assert.rejects(f.controller.send(), /附件草稿/);
  assert.equal(f.prompts(), 0);
  await f.controller.reloadDraft();
  await f.controller.removeAttachment(added.reference.attachmentId);
  const entered = signal(),
    release = signal();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'mutate') {
      entered.resolve();
      await release.promise;
    }
  };
  const sending = f.controller.send();
  await entered.promise;
  await f.controller.addAttachments([new File(['next turn'], 'next.txt', { type: 'text/plain' })]);
  release.resolve();
  await sending;
  await f.started.promise;
  assert.equal(
    f.controller.state.ledger!.attachments![id]!.items.length,
    2,
    'a receipt cannot clear a changed attachment selection',
  );
  assert.equal(f.prompts(), 1);
});

test('verified attachment contents can be read offline only for the original reference and complete project scope', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  await f.controller.addAttachments([
    new File(['Cached original bytes'], 'cached.txt', { type: 'text/plain' }),
  ]);
  const item = f.controller.state.ledger!.attachments![id]!.items[0]!;
  await f.controller.uploadAttachment(item.reference.attachmentId);
  const value = await f.controller.readAttachment(item.reference);
  assert.equal(value.source, 'host');
  assert.equal(value.cacheSaved, true);
  assert.equal(value.data, item.data);
  f.fault.unavailable = true;
  await assert.rejects(f.controller.readAttachment(item.reference), /原草稿/);
  await assert.rejects(f.controller.refreshSession());
  const calls = f.calls.length;
  const cached = await f.controller.readAttachment(item.reference);
  assert.equal(cached.source, 'cache');
  assert.equal(f.calls.length, calls);
  assert.equal(cached.data, item.data);
  await assert.rejects(
    f.controller.readAttachment({ ...item.reference, name: 'other.txt' }),
    /尚无/,
  );
  const scope = f.controller.state.scope!;
  assert.equal(
    await f.store.attachmentContent(
      { ...scope, target: { ...scope.target, owner: 'other' } },
      id,
      item.reference,
      () => {},
    ),
    null,
  );
  const key = [...f.memory.values.keys()].find((key) =>
    key.includes('moor-desktop-attachment-cache-v1'),
  )!;
  const corrupted = structuredClone(f.memory.values.get(key)) as any;
  corrupted.data = btoa('Corrupted same bytes!');
  f.memory.values.set(key, corrupted);
  await assert.rejects(f.controller.readAttachment(item.reference), /校验失败|字节数/);
});

test('lost delivery retains the original operation and draft; reconnect and restored controller never replay it', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  await f.controller.saveDraft('Do exactly once', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send(), /原草稿/);
  await f.started.promise;
  const original = f.controller.state.ledger!.operations.find(
    (entry) => entry.status === 'pending',
  )!;
  assert.equal(f.controller.state.draft?.text, 'Do exactly once');
  const sent = f.calls.filter(
    (call) => call.action === 'execute' && call.command.method === 'mutate',
  );
  assert.equal(sent.length, 1);
  f.fault.loseMutation = false;
  await f.controller.refreshCatalog('local');
  await f.controller.refreshSessions();
  const restored = new WorkspaceController({
    request: f.request,
    store: new WorkspaceStore(f.memory),
  });
  t.after(() => restored.close());
  await restored.refreshCatalog('local');
  await restored.selectProject('local', f.catalog.targets[0]!.target);
  await restored.openSession(id);
  assert.equal(restored.state.draft?.text, 'Do exactly once');
  assert.equal(
    f.calls.filter((call) => call.action === 'execute' && call.command.method === 'mutate').length,
    1,
  );
  await restored.retry(original.original.value.operationId);
  const retried = f.calls.filter(
    (call) => call.action === 'execute' && call.command.method === 'mutate',
  );
  assert.deepEqual(retried[1], retried[0]);
  assert.equal(f.prompts(), 1);
  assert.equal(restored.state.draft?.text, '');
});

test('host inspection recovers a lost receipt without sending a second mutation', async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.controller.saveDraft('Inspect me', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send());
  const original = f.controller.state.ledger!.operations.find(
    (entry) => entry.status === 'pending',
  )!;
  await f.controller.inspect(original.original.value.operationId);
  assert.equal(f.controller.state.draft?.text, '');
  assert.equal(
    f.calls.filter((call) => call.action === 'execute' && call.command.method === 'mutate').length,
    1,
  );
});

test('durable draft conflicts and failed operation staging prevent dispatch', async (t) => {
  const f = await fixture(t),
    id = await f.create(),
    scope = f.controller.state.scope!;
  await f.controller.saveDraft('Original', {});
  await f.store.saveDraft(scope, id, 1, 'Other page', {}, () => {});
  await assert.rejects(f.controller.saveDraft('Conflicting edit', {}), /另一页面/);
  await assert.rejects(f.controller.send(), /另一页面/);
  assert.equal(
    f.calls.filter((call) => call.action === 'execute' && call.command.method === 'mutate').length,
    0,
  );
  await f.controller.reloadDraft();
  assert.equal(f.controller.state.draft?.text, 'Other page');
  await f.controller.saveDraft('Resolved by user', {});
  const clean = new WorkspaceController({
    request: f.request,
    store: new WorkspaceStore(f.memory),
  });
  t.after(() => clean.close());
  await clean.refreshCatalog('local');
  await clean.selectProject('local', f.catalog.targets[0]!.target);
  await clean.openSession(id);
  f.memory.failWrite = true;
  await assert.rejects(clean.createSession('agent'), /storage failure/);
  assert.equal(
    f.calls.filter(
      (call) =>
        call.action === 'execute' &&
        call.command.method === 'session-control' &&
        call.command.params.action === 'create',
    ).length,
    1,
  );
});

test('a confirmed receipt never clears a draft edited while delivery was in flight', async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.controller.saveDraft('First message', {});
  const entered = signal(),
    release = signal();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'mutate') {
      entered.resolve();
      await release.promise;
    }
  };
  const sending = f.controller.send();
  await entered.promise;
  await f.controller.saveDraft('Next message', {});
  release.resolve();
  await sending;
  assert.equal(f.controller.state.draft?.text, 'Next message');
});

test('late session responses and mismatched receipts cannot overwrite selected content or clear drafts', async (t) => {
  const f = await fixture(t),
    first = await f.create(),
    second = await f.create();
  await f.controller.openSession(first);
  const entered = signal(),
    release = signal();
  f.fault.after = async (request) => {
    if (
      request.action === 'execute' &&
      request.command.method === 'session' &&
      request.command.params.sessionId === first
    ) {
      entered.resolve();
      await release.promise;
    }
  };
  const refresh = f.controller.refreshSession();
  const rejected = assert.rejects(refresh, /已改变/);
  await entered.promise;
  await f.controller.openSession(second);
  release.resolve();
  await rejected;
  assert.equal(f.controller.state.session?.meta.id, second);
  await f.controller.saveDraft('Retain on wrong receipt', {});
  f.fault.wrongReceipt = true;
  await assert.rejects(f.controller.send());
  assert.equal(f.controller.state.draft?.text, 'Retain on wrong receipt');
  assert(f.controller.state.ledger!.operations.some((entry) => entry.status === 'pending'));
});

test('client drafts stay isolated across source, account, device, project and replica identities', async (t) => {
  const f = await fixture(t),
    id = await f.create(),
    scope = f.controller.state.scope!;
  await f.controller.saveDraft('Private draft', {});
  for (const change of [
    { owner: 'other' },
    { deviceId: 'other' },
    { localProjectId: 'other' },
    { catalogProjectId: 'other' },
    { replicaId: 'other' },
    { machineId: 'other' },
  ]) {
    const other = { ...scope, target: { ...scope.target, ...change } };
    assert.deepEqual((await f.store.read(other, () => {})).drafts, {});
    assert.equal(await f.store.cachedSession(other, id, () => {}), null);
  }
  assert.deepEqual((await f.store.read({ ...scope, source: 'remote' }, () => {})).drafts, {});
  f.catalog.owner = 'other';
  f.catalog.targets[0]!.target.owner = 'other';
  await f.controller.refreshCatalog('local');
  assert.equal(f.controller.state.session, undefined);
  assert.equal(f.controller.state.scope, undefined);
  assert.equal((await f.store.read(scope, () => {})).drafts[id]?.text, 'Private draft');
});

test('offline cache remains readable and editable without permitting execution', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  await f.controller.saveDraft('Before disconnect', {});
  f.fault.unavailable = true;
  await assert.rejects(f.controller.refreshCatalog('local'));
  await assert.rejects(f.controller.openSession(id), /重新连接/);
  assert.equal(f.controller.state.session?.meta.id, id);
  assert.equal(f.controller.state.offline, true);
  await f.controller.saveDraft('Edited offline', {});
  const count = f.calls.length;
  await assert.rejects(f.controller.send(), /重新连接/);
  assert.equal(f.calls.length, count);
  f.fault.unavailable = false;
  await f.controller.refreshCatalog('local');
  await f.controller.openSession(id);
  assert.equal(f.controller.state.draft?.text, 'Edited offline');
  assert.equal(f.prompts(), 0);
});

test('out-of-order reads on the same session never roll back the timeline', async (t) => {
  const f = await fixture(t);
  await f.create();
  const entered = signal(),
    release = signal();
  let reads = 0;
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'session' && ++reads === 1) {
      entered.resolve();
      await release.promise;
    }
  };
  const older = f.controller.refreshSession(),
    rejected = assert.rejects(older, /较新的请求/);
  await entered.promise;
  await f.controller.saveDraft('New timeline', {});
  await f.controller.send();
  await f.started.promise;
  await f.controller.refreshSession();
  const latest = f.controller.state.session!;
  assert(latest.history.length > 0);
  release.resolve();
  await rejected;
  assert.deepEqual(f.controller.state.session, latest);
});

test('two pages cannot replay the same pending operation concurrently', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  await f.controller.saveDraft('Shared original', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send());
  const operationId = f.controller.state.ledger!.operations.find(
    (entry) => entry.status === 'pending',
  )!.original.value.operationId;
  const other = new WorkspaceController({
    request: f.request,
    store: new WorkspaceStore(f.memory),
  });
  t.after(() => other.close());
  await other.refreshCatalog('local');
  await other.selectProject('local', f.catalog.targets[0]!.target);
  await other.openSession(id);
  f.fault.loseMutation = false;
  const entered = signal(),
    release = signal();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'mutate') {
      entered.resolve();
      await release.promise;
    }
  };
  const first = f.controller.retry(operationId);
  await entered.promise;
  const second = assert.rejects(other.retry(operationId), /无需重试/);
  release.resolve();
  await first;
  await second;
  await f.started.promise;
  assert.equal(
    f.calls.filter((call) => call.action === 'execute' && call.command.method === 'mutate').length,
    2,
  );
  assert.equal(f.prompts(), 1);
});

test('failed receipt persistence keeps the durable original recoverable', async (t) => {
  const f = await fixture(t),
    id = await f.create();
  await f.controller.saveDraft('Recover after storage failure', {});
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'mutate')
      f.memory.failWrite = true;
  };
  await assert.rejects(f.controller.send(), /storage failure/);
  f.memory.failWrite = false;
  const ledger = await f.store.read(f.controller.state.scope!, () => {});
  const pending = ledger.operations.find((entry) => entry.status === 'pending')!;
  assert.equal(ledger.drafts[id]?.text, 'Recover after storage failure');
  await f.controller.inspect(pending.original.value.operationId);
  assert.equal(f.controller.state.draft?.text, '');
  await f.started.promise;
  assert.equal(f.prompts(), 1);
});

async function taskSource(f: Awaited<ReturnType<typeof fixture>>) {
  const { oid } = await gitProject(f),
    id = f.controller.state.sessionId!;
  const panel = await f.controller.openTasks();
  const plan = syntheticTaskPlan();
  plan.tasks[0]!.expectedOid = oid;
  await panel.controller.edit(plan);
  const reviewed = await panel.review();
  await panel.enable(reviewed);
  return { id, panel, plan };
}

test('unified task review stays local and a lost parent receipt retains its original authorization', async (t) => {
  const f = await fixture(t),
    { id, plan } = await taskSource(f);
  assert.equal(f.prompts(), 0);
  assert.equal(
    f.calls.some((call) => call.action === 'execute' && call.command.method === 'tasks-action'),
    false,
  );
  await f.controller.saveDraft('Coordinate reviewed tasks', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send(), /暂不可用/);
  await f.started.promise;
  const pending = f.controller.state.ledger!.operations.find(
    (entry) => entry.status === 'pending',
  )!;
  assert.deepEqual(pending.taskReview?.plan, plan);
  assert(f.openOptions()?.taskTools);
  const panel = await f.controller.openTasks();
  await panel.controller.refresh();
  assert.deepEqual(panel.controller.list!.grants[0]!.plan, plan);
  assert.equal(f.prompts(), 1);
  await panel.controller.edit({
    ...plan,
    tasks: [{ ...plan.tasks[0]!, instruction: 'Later draft' }],
  });
  f.fault.loseMutation = false;
  await f.controller.inspect(pending.original.value.operationId);
  const saved = f.controller.state.ledger!.tasks![id]!;
  assert.equal(saved.delivery, undefined);
  assert.equal(saved.enabled, undefined);
  assert.equal(saved.draft.tasks[0]!.instruction, 'Later draft');
  assert.equal(f.prompts(), 1);
});

test('task review rejects moved baselines and invalid model choices without altering the parent draft', async (t) => {
  const f = await fixture(t),
    { panel, plan } = await taskSource(f);
  await panel.controller.disable();
  await f.controller.saveDraft('Parent text', {});
  writeFileSync(join(f.project, 'later.txt'), 'new baseline');
  git(f.project, 'add', 'later.txt');
  git(f.project, 'commit', '-m', 'synthetic later baseline');
  await assert.rejects(panel.enable(plan), /基线分支或提交/);
  assert.equal(panel.controller.enabled, undefined);
  const oid = git(f.project, 'rev-parse', 'HEAD').trim();
  await panel.controller.edit({
    ...plan,
    tasks: [{ ...plan.tasks[0]!, expectedOid: oid, selection: { modelId: 'obsolete' } }],
  });
  await assert.rejects(panel.review());
  assert.equal(f.controller.state.draft!.text, 'Parent text');
  assert.equal(f.prompts(), 0);
});

test('task authorization CAS rejects concurrent plan edits and failed storage before parent dispatch', async (t) => {
  const f = await fixture(t),
    { panel, plan } = await taskSource(f);
  await f.controller.saveDraft('Parent text', {});
  let edited = false;
  f.fault.before = async (request) => {
    if (!edited && request.action === 'execute' && request.command.method === 'agent-options') {
      edited = true;
      await panel.controller.edit({
        ...plan,
        tasks: [{ ...plan.tasks[0]!, instruction: 'Concurrent task' }],
      });
    }
  };
  await assert.rejects(f.controller.send(), /任务计划已改变/);
  assert.equal(f.prompts(), 0);
  f.fault.before = undefined;
  const fresh = await panel.review();
  await panel.enable(fresh);
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'agent-options')
      f.memory.failWrite = true;
  };
  await assert.rejects(f.controller.send(), /storage failure/);
  f.memory.failWrite = false;
  f.fault.before = undefined;
  assert.equal(f.prompts(), 0);
  assert.equal(f.controller.state.draft!.text, 'Parent text');
  assert.equal(
    (await f.store.read(f.controller.state.scope!, () => {})).tasks![f.controller.state.sessionId!]!
      .delivery,
    undefined,
  );
});

test('task review cannot complete after its panel closes and an unconfirmed parent blocks enabling another plan', async (t) => {
  const f = await fixture(t),
    { panel, plan } = await taskSource(f);
  await panel.controller.disable();
  const entered = signal(),
    release = signal();
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'git-state') {
      entered.resolve();
      await release.promise;
    }
  };
  const reviewing = panel.review();
  await entered.promise;
  panel.close();
  release.resolve();
  await assert.rejects(reviewing, /关闭|改变/);
  f.fault.before = undefined;
  await f.controller.saveDraft('Plain parent', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send(), /暂不可用/);
  const reopened = await f.controller.openTasks();
  await assert.rejects(reopened.enable(plan), /原父指令/);
  assert.equal(reopened.controller.enabled, undefined);
});

const syntheticRole = {
  name: 'Reviewer',
  agentId: 'agent',
  selection: { modelId: 'model-a', reasoningEffort: 'high', modeId: 'read-only' },
  instructions: 'SYNTHETIC_ROLE_BODY <script>not executable</script>',
};
async function roleSource(f: Awaited<ReturnType<typeof fixture>>) {
  const id = await f.create(),
    panel = await f.controller.openRoles();
  await panel.refresh();
  await panel.save(syntheticRole);
  await panel.refresh();
  return { id, panel, role: panel.controller.list!.roles[0]! };
}

test('unified roles save, apply and delete through the host without starting an Agent prompt', async (t) => {
  const f = await fixture(t),
    { id, panel, role } = await roleSource(f);
  await f.controller.saveDraft('Keep original text', {});
  await panel.apply(role);
  assert.match(f.controller.state.draft!.text, /^Keep original text\n\n\[角色预设：Reviewer/);
  assert.match(f.controller.state.draft!.text, /SYNTHETIC_ROLE_BODY/);
  assert.deepEqual(f.controller.state.draft!.selection, syntheticRole.selection);
  assert.equal(f.controller.state.ledger?.roleApplied?.[id]?.applied.length, 1);
  const applied = f.controller.state.draft!.text;
  await assert.rejects(panel.apply(role), /已应用/);
  assert.equal(f.controller.state.draft!.text, applied);
  const reopened = await f.controller.openRoles();
  await reopened.refresh();
  await assert.rejects(reopened.apply(role), /已应用/);
  await reopened.remove(role.id);
  await reopened.refresh();
  assert.equal(reopened.controller.list!.roles.length, 0);
  assert.equal(f.controller.state.draft!.text, applied);
  assert.equal(f.prompts(), 0);
});

test('role receipt loss preserves the exact original and cross-page recovery cannot repeat a resolved save', async (t) => {
  const f = await fixture(t),
    id = await f.create(),
    panel = await f.controller.openRoles();
  await panel.refresh();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'roles-action')
      throw Error('Synthetic lost role receipt');
  };
  await assert.rejects(panel.save(syntheticRole), /lost role receipt/);
  const original = structuredClone(panel.controller.pending);
  assert(original);
  f.fault.after = undefined;
  const other = await f.controller.openRoles();
  assert.deepEqual(other.controller.pending, original);
  const before = f.calls.length;
  await other.inspect();
  assert.equal(other.controller.pending, undefined);
  await assert.rejects(panel.retry(), /原角色操作已改变/);
  const recovery = f.calls
    .slice(before)
    .filter((call) => call.action === 'execute' && call.command.method === 'roles-action');
  assert.equal(recovery.length, 1);
  assert.equal((recovery[0] as any).command.params.action, 'inspect');
  assert.deepEqual((recovery[0] as any).command.params.request, original);
  assert.equal(f.controller.state.ledger?.roles?.[id]?.pending, undefined);
  await other.refresh();
  assert.equal(other.controller.list!.roles.length, 1);
  assert.equal(f.prompts(), 0);
});

test('role drafts use atomic apply and reject changed role versions, stale model choices and concurrent edits', async (t) => {
  const f = await fixture(t),
    { panel, role } = await roleSource(f);
  await f.controller.saveDraft('Original', {});
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'agent-options')
      f.memory.failWrite = true;
  };
  await assert.rejects(panel.apply(role), /storage failure/);
  f.memory.failWrite = false;
  f.fault.before = undefined;
  assert.equal(f.controller.state.draft!.text, 'Original');
  assert.equal(f.controller.state.ledger?.roleApplied, undefined);
  const other = await f.controller.openRoles();
  await other.refresh();
  await other.save({ ...syntheticRole, id: role.id, instructions: 'New role version' });
  await assert.rejects(panel.apply(role), /角色版本/);
  await panel.refresh();
  const updated = panel.controller.list!.roles[0]!;
  let edited = false;
  f.fault.before = async (request) => {
    if (!edited && request.action === 'execute' && request.command.method === 'agent-options') {
      edited = true;
      await f.controller.saveDraft('Concurrent edit', {});
    }
  };
  await assert.rejects(panel.apply(updated), /草稿或原操作/);
  assert.equal(f.controller.state.draft!.text, 'Concurrent edit');
  f.fault.before = undefined;
  let changedDuringProbe = false;
  f.fault.after = async (request) => {
    if (
      !changedDuringProbe &&
      request.action === 'execute' &&
      request.command.method === 'agent-options'
    ) {
      changedDuringProbe = true;
      await other.refresh();
      await other.save({
        ...syntheticRole,
        id: role.id,
        instructions: 'Changed during model probe',
      });
    }
  };
  await assert.rejects(panel.apply(updated), /角色版本/);
  assert.equal(f.controller.state.draft!.text, 'Concurrent edit');
  f.fault.after = undefined;
  await panel.save({ ...syntheticRole, id: role.id, selection: { modelId: 'obsolete' } });
  await panel.refresh();
  await assert.rejects(panel.apply(panel.controller.list!.roles[0]!));
  assert.equal(f.controller.state.draft!.text, 'Concurrent edit');
  assert.equal(f.prompts(), 0);
});

test('role save failure does not dispatch and an undelivered original is only abandoned explicitly', async (t) => {
  const f = await fixture(t);
  await f.create();
  let panel = await f.controller.openRoles();
  await panel.refresh();
  f.memory.failWrite = true;
  await assert.rejects(panel.save(syntheticRole), /storage failure/);
  assert.equal(
    f.calls.some((call) => call.action === 'execute' && call.command.method === 'roles-action'),
    false,
  );
  f.memory.failWrite = false;
  panel = await f.controller.openRoles();
  await panel.refresh();
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'roles-action')
      throw Error('Synthetic before role dispatch');
  };
  await assert.rejects(panel.save(syntheticRole), /before role dispatch/);
  f.fault.before = undefined;
  const original = structuredClone(panel.controller.pending);
  await panel.inspect();
  assert.deepEqual(panel.controller.pending, original);
  await panel.abandon();
  assert.equal(panel.controller.receipt?.accepted, false);
  await panel.refresh();
  assert.equal(panel.controller.list!.roles.length, 0);
  assert.equal(f.prompts(), 0);
});

test('role application is tied to the viewed panel and new-role sessions preserve the source draft', async (t) => {
  const f = await fixture(t),
    { id, panel, role } = await roleSource(f);
  await f.controller.saveDraft('Source draft', {});
  const entered = signal(),
    release = signal();
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'roles-read') {
      entered.resolve();
      await release.promise;
    }
  };
  const applying = panel.apply(role);
  await entered.promise;
  panel.close();
  release.resolve();
  await assert.rejects(applying, /关闭|改变/);
  f.fault.before = undefined;
  const fresh = await f.controller.openRoles();
  await fresh.refresh();
  const child = await fresh.createFromRole(role);
  assert.notEqual(child, id);
  assert.equal(f.controller.state.sessionId, child);
  assert.equal(f.controller.state.session!.history.length, 0);
  assert.match(f.controller.state.draft!.text, /SYNTHETIC_ROLE_BODY/);
  await f.controller.openSession(id);
  assert.equal(f.controller.state.draft!.text, 'Source draft');
  f.runtime.registerAgent('second-synthetic', {
    id: 'second-agent',
    name: 'Second synthetic',
    machineId: f.runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/second-never-run', args: [] },
  });
  f.host.updateCatalogue();
  f.catalog.targets[0]!.runtime = f.host.workspace;
  await f.controller.refreshCatalog('local');
  await f.controller.openSession(id);
  const another = await f.controller.openRoles();
  await another.refresh();
  await another.save({ ...syntheticRole, id: role.id, agentId: 'second-agent' });
  await another.refresh();
  const different = another.controller.list!.roles[0]!;
  await assert.rejects(another.apply(different), /另一 Agent/);
  const second = await another.createFromRole(different);
  assert.equal(f.controller.state.session!.meta.agentConfigId, 'second-agent');
  assert.equal(f.controller.state.sessionId, second);
  await f.controller.openSession(id);
  assert.equal(f.controller.state.draft!.text, 'Source draft');
  assert.equal(f.prompts(), 0);
});

const annotationSnapshot: PreviewAnnotationSnapshot = {
  serviceId: 'service',
  serviceLabel: 'Synthetic project',
  pagePath: '/settings',
  frameId: 'frame',
  capturedAt: '2026-09-12T00:00:00Z',
  viewport: previewViewport,
  element: {
    elementId: 'element',
    tagName: 'button',
    role: 'button',
    name: 'Save',
    text: 'Synthetic',
    bounds: { x: 20, y: 90, width: 120, height: 40 },
  },
  note: 'Increase button spacing',
};
function syntheticPreview() {
  const actions: string[] = [],
    closed: string[] = [];
  let sequence = 0;
  const frame = (id: string, viewport = previewViewport) =>
    previewFrame(id, 'frame-' + ++sequence, viewport);
  const options = (localProjectId: string): SessionPreviewOptions => ({
    now: () => Date.parse('2026-09-12T00:00:00Z'),
    schedule: () => () => {},
    config: {
      getServices: () => [
        { id: 'service', label: 'Synthetic', version: previewVersion, startPath: '/' },
      ],
      getService: () => ({
        id: 'service',
        label: 'Synthetic',
        version: previewVersion,
        startPath: '/',
        origin: 'http://127.0.0.1:12345',
        localProjectId,
        executionId: 'shared',
        rootIdentity: previewVersion,
        projectRootIdentity: previewVersion,
      }),
      isCurrent: () => true,
    },
    driver: {
      available: async () => ({ available: true }),
      open: async (binding, check) => {
        check.assertCurrent();
        check.beforeDispatch!();
        actions.push('open');
        return frame(binding.previewId, binding.viewport);
      },
      capture: async (id, check) => {
        check.assertCurrent();
        return frame(id);
      },
      locate: async (_id, frameId, point, check) => {
        check.assertCurrent();
        return {
          elementId: 'element',
          frameId,
          tag: 'button',
          role: 'button',
          name: 'Save',
          text: 'Synthetic',
          rect: { x: point.x, y: point.y, width: 20, height: 20 },
          editable: false,
          password: false,
        };
      },
      interact: async (request, check) => {
        check.assertCurrent();
        check.beforeDispatch!();
        actions.push(request.action);
        return frame(request.previewId, 'viewport' in request ? request.viewport : previewViewport);
      },
      close: async (id) => {
        closed.push(id);
      },
      closeAll: async () => {},
    },
  });
  return { options, actions, closed };
}

test('unified preview keeps lost page-action receipts and inspects without replay', async (t) => {
  const preview = syntheticPreview(),
    f = await fixture(t, { preview: preview.options });
  const id = await f.create(),
    panel = await f.controller.openPreview();
  await panel.controller.refreshOptions();
  assert.equal(panel.controller.options?.available, true);
  await panel.controller.open('service', previewViewport);
  await panel.controller.locate(20, 40);
  const item = await panel.annotations.save(panel.controller.annotation('Move this button', true));
  assert.equal(f.controller.state.ledger?.attachments?.[id]?.items.length ?? 0, 0);
  await panel.addImage(item.id);
  assert.equal(f.controller.state.ledger?.attachments?.[id]?.items.length, 1);
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'preview-action')
      throw Error('Synthetic preview receipt lost');
  };
  await assert.rejects(panel.controller.interact({ action: 'click' }), /receipt lost/);
  assert.equal(panel.controller.pending?.action, 'click');
  f.fault.after = undefined;
  const reopened = await f.controller.openPreview();
  assert.equal(reopened.controller.active, false);
  assert.deepEqual(preview.actions, ['open', 'click']);
  await reopened.controller.inspect();
  assert.equal(reopened.controller.pending, undefined);
  assert.deepEqual(preview.actions, ['open', 'click']);
  assert.equal(f.controller.state.ledger?.previews?.[id]?.receipt?.frame, undefined);
  await reopened.close();
  assert.equal(preview.closed.length, 1);
  assert.equal(f.controller.state.ledger?.previews?.[id]?.open, undefined);
});

test('active preview renews only by reading status and a late timer cannot act after navigation', async (t) => {
  const timers = new Set<() => void>(),
    preview = syntheticPreview();
  const f = await fixture(t, {
    preview: preview.options,
    schedule: (ms, work) => {
      assert.equal(ms, 12000);
      timers.add(work);
      return () => {
        timers.delete(work);
      };
    },
  });
  await f.create();
  let waiting = false;
  const renewed = signal();
  const panel = await f.controller.openPreview(() => {
    if (waiting && !panel.controller.busy) renewed.resolve();
  });
  assert.equal(timers.size, 0);
  await panel.controller.refreshOptions();
  await panel.controller.open('service', previewViewport);
  assert.equal(timers.size, 1);
  const tick = [...timers][0]!;
  timers.delete(tick);
  waiting = true;
  tick();
  await renewed.promise;
  assert(
    f.calls.some(
      (call) =>
        call.action === 'execute' &&
        call.command.method === 'preview-read' &&
        call.command.params.view === 'status',
    ),
  );
  assert.deepEqual(preview.actions, ['open']);
  assert.equal(timers.size, 1);
  waiting = false;
  const late = [...timers][0]!;
  await f.create();
  const before = f.calls.length;
  timers.delete(late);
  late();
  assert.equal(f.calls.length, before);
  panel.dispose();
  assert.equal(timers.size, 0);
});

test('preview writes precede page actions and stale panels cannot act for another session', async (t) => {
  const preview = syntheticPreview(),
    f = await fixture(t, { preview: preview.options });
  await f.create();
  const first = await f.controller.openPreview(),
    second = await f.controller.openPreview();
  await first.controller.refreshOptions();
  await second.controller.refreshOptions();
  f.memory.failWrite = true;
  await assert.rejects(first.controller.open('service', previewViewport), /storage failure/);
  assert.deepEqual(preview.actions, []);
  f.memory.failWrite = false;
  await second.controller.open('service', previewViewport);
  const stale = await f.controller.openPreview();
  await stale.controller.capture();
  await second.controller.capture();
  await second.controller.interact({ action: 'scroll', deltaX: 0, deltaY: 40 });
  await assert.rejects(
    stale.controller.interact({ action: 'scroll', deltaX: 0, deltaY: 80 }),
    /改变/,
  );
  assert.deepEqual(preview.actions, ['open', 'scroll']);
  await f.create();
  await assert.rejects(second.controller.capture(), /变化/);
});

test('annotation-only sends persist selections with the original and preserve a later reselection', async (t) => {
  const f = await fixture(t),
    id = await f.create(),
    panel = await f.controller.openPreview();
  const item = await panel.annotations.save(annotationSnapshot);
  await panel.annotations.select(item.id, true);
  const selected = panel.annotations.items[0]!.selectionId;
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send(), /暂不可用/);
  await f.started.promise;
  const pending = f.controller.state.ledger!.operations.find(
    (entry) => entry.status === 'pending',
  )!;
  assert.equal(pending.annotations?.selection[0]?.selectionId, selected);
  assert.match(JSON.stringify(f.inputs[0]), /Increase button spacing/);
  await panel.annotations.select(item.id, true);
  const later = panel.annotations.items[0]!.selectionId;
  assert.notEqual(later, selected);
  f.fault.loseMutation = false;
  await f.controller.inspect(pending.original.value.operationId);
  assert.equal(f.controller.state.ledger?.annotations?.[id]?.annotations[0]?.selectionId, later);
  assert.equal(f.prompts(), 1);
});

test('annotation storage failures, invalid snapshots and selection races never send an agent prompt', async (t) => {
  const f = await fixture(t),
    id = await f.create(),
    panel = await f.controller.openPreview();
  const png = previewPng(),
    { data, ...content } = png;
  await assert.rejects(
    panel.annotations.save({
      ...annotationSnapshot,
      image: { data, content: { ...content, version: previewVersion } },
    }),
    /冻结版本/,
  );
  f.memory.failWrite = true;
  await assert.rejects(panel.annotations.save(annotationSnapshot), /storage failure/);
  f.memory.failWrite = false;
  const fresh = await f.controller.openPreview(),
    item = await fresh.annotations.save(annotationSnapshot);
  await fresh.annotations.select(item.id, true);
  const original = f.memory.exclusive.bind(f.memory);
  let raced = false;
  f.memory.exclusive = async (key, current, task) => {
    if (!raced && key.includes('moor-desktop-ledger-v1')) {
      raced = true;
      await fresh.annotations.select(item.id, false);
    }
    return original(key, current, task);
  };
  await assert.rejects(f.controller.send(), /标注草稿已改变/);
  assert.equal(f.controller.state.ledger?.annotations?.[id]?.annotations.length, 1);
  assert.equal(f.prompts(), 0);
});

async function githubWorkspace(t: TestContext) {
  const repository = {
    id: 42,
    owner: { login: 'synthetic' },
    name: 'test',
    full_name: 'synthetic/test',
    default_branch: 'main',
    private: true,
    archived: false,
  };
  const issue = {
    id: 101,
    number: 1,
    title: 'EPHEMERAL_GITHUB_TITLE',
    body: 'EPHEMERAL_GITHUB_BODY',
    state: 'open',
    user: { login: 'reader', id: 9 },
    updated_at: '2026-09-12T00:00:00Z',
    labels: [],
  };
  const state = {
    issue,
    requests: [] as { path: string; method: string; body?: unknown }[],
    comments: [] as object[],
    before: undefined as (() => Promise<void>) | undefined,
  };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname,
      method = init.method ?? 'GET';
    state.requests.push({
      path,
      method,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    await state.before?.();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/repos/synthetic/test') return json(repository);
    if (path === '/user') return json({ id: 9, login: 'reader' });
    if (path === '/repos/synthetic/test/branches')
      return json([{ name: 'main', commit: { sha: 'a'.repeat(40) }, protected: false }]);
    if (path === '/repos/synthetic/test/branches/main')
      return json({ name: 'main', commit: { sha: 'a'.repeat(40) }, protected: false });
    if (path === '/repos/synthetic/test/issues') return json([state.issue]);
    if (path === '/repos/synthetic/test/issues/1') return json(state.issue);
    if (path === '/repos/synthetic/test/issues/1/comments') {
      if (method === 'POST') {
        const item = {
          id: 303 + state.comments.length,
          ...JSON.parse(String(init.body)),
          user: { id: 9, login: 'reader' },
          updated_at: issue.updated_at,
          issue_url: 'https://api.github.com/repos/synthetic/test/issues/1',
        };
        state.comments.push(item);
        return json(item, 201);
      }
      return json(state.comments);
    }
    throw Error('Unexpected synthetic GitHub route: ' + path);
  };
  const configFor = (localProjectId: string) => {
    const config = {
      localProjectId,
      owner: 'synthetic',
      repo: 'test',
      token: 'SYNTHETIC_PRIVATE_TOKEN',
      credentialId: 'credential',
      repositoryId: 42,
      version: 'sha256:' + 'c'.repeat(64),
      writesEnabled: true,
    };
    return {
      getProject: () => config,
      isCurrent: (input: unknown) => JSON.stringify(input) === JSON.stringify(config),
    };
  };
  const client: typeof createGitHubClient = (options) => createGitHubClient({ ...options, fetch });
  const writer: typeof createGitHubWriteClient = (options) =>
    createGitHubWriteClient({ ...options, fetch });
  const f = await fixture(t, {
    github: (id) => ({ config: configFor(id), client }),
    githubWrite: (id) => ({ config: configFor(id), client, writer }),
  });
  return { ...f, github: state };
}

test('workspace GitHub reads and binding share reviewed controls without retaining provider content or starting an Agent', async (t) => {
  const f = await githubWorkspace(t);
  await f.create();
  const c = await f.controller.openGithub();
  await c.branches(c.state!.review, 1);
  await c.list(c.state!.review, 'issues', 'open', 1);
  await c.item(c.state!.review, 'issue', 1);
  assert.equal(c.state!.read.detail?.item.body, 'EPHEMERAL_GITHUB_BODY');
  assert.doesNotMatch(
    JSON.stringify([...f.memory.values]),
    /EPHEMERAL_GITHUB|SYNTHETIC_PRIVATE_TOKEN/,
  );
  await c.bind(c.state!.review, 'main');
  assert.equal(c.state!.read.binding?.revision, 1);
  assert.equal(f.prompts(), 0);
  await c.item(c.state!.review, 'issue', 1);
  const stale = c.state!.review;
  await c.comments(stale, 1);
  await assert.rejects(c.add(stale), /改变/);
  await f.controller.saveDraft('Existing draft', {});
  await c.add(c.state!.review);
  assert.match(f.controller.state.draft!.text, /Existing draft/);
  assert.match(f.controller.state.draft!.text, /EPHEMERAL_GITHUB_BODY/);
  await c.unbind(c.state!.review);
  assert.equal(c.state!.read.binding?.revision, 2);
  c.dispose();
  assert.equal(f.prompts(), 0);
  assert.equal(f.github.requests.filter((r) => r.method !== 'GET').length, 0);
});

test('workspace GitHub comment stages exactly the reviewed request; reopening and inspecting a lost receipt never republishes', async (t) => {
  const f = await githubWorkspace(t);
  await f.create();
  let c = await f.controller.openGithub(() => {}, 'write');
  const id = await c.createDraft(c.state!.review, 'issue-comment', {
    number: 1,
    subject: 'issue',
    body: 'Synthetic manual comment',
  });
  await c.prepare(c.state!.review, id);
  const original = structuredClone(c.state!.write.review!.request);
  assert.equal(f.github.comments.length, 0);
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'github-write-action')
      throw Error('Synthetic lost GitHub receipt');
  };
  await assert.rejects(c.confirm(c.state!.review), /lost GitHub receipt/);
  assert.equal(f.github.comments.length, 1);
  assert.deepEqual(
    f.controller.state.ledger!.githubWrite![f.controller.state.sessionId!]!.pending!.request,
    original,
  );
  c.dispose();
  f.fault.after = undefined;
  c = await f.controller.openGithub(() => {}, 'write');
  assert.equal(f.github.comments.length, 1);
  await c.inspect(c.state!.review);
  assert.equal(c.state!.write.pending, undefined);
  assert.equal(c.state!.write.receipt?.phase, 'accepted');
  assert.equal(f.github.comments.length, 1);
  assert.equal(f.prompts(), 0);
  assert.doesNotMatch(
    JSON.stringify([...f.memory.values]),
    /EPHEMERAL_GITHUB|SYNTHETIC_PRIVATE_TOKEN/,
  );
  c.dispose();
});

test('workspace GitHub pending commit blocks Agent turns and Git changes until original receipt inspection', async (t) => {
  const f = await githubWorkspace(t);
  await gitProject(f);
  writeFileSync(join(f.project, 'file.txt'), 'Changed for reviewed commit\n');
  const c = await f.controller.openGithub(() => {}, 'write');
  const id = await c.createDraft(c.state!.review, 'commit', {
    paths: ['file.txt'],
    message: 'Synthetic reviewed commit',
    authorName: 'Synthetic',
    authorEmail: 'synthetic@example.invalid',
  });
  await c.prepare(c.state!.review, id);
  const original = structuredClone(c.state!.write.review!.request);
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'github-write-action')
      throw Error('Synthetic commit receipt lost');
  };
  await assert.rejects(c.confirm(c.state!.review), /receipt lost/);
  await f.controller.saveDraft('Next Agent instruction', {});
  await assert.rejects(f.controller.send(), /GitHub/);
  assert.equal(f.prompts(), 0);
  assert.equal(f.controller.state.draft!.text, 'Next Agent instruction');
  const git = await f.controller.openGit();
  await git.controller.refresh();
  const ledger = f.controller.state.ledger!,
    sessionId = f.controller.state.sessionId!;
  assert.equal(f.store.githubBlocked(ledger, sessionId), true);
  await assert.rejects(
    git.prepare('main', git.controller.state!.repository.headOid!, 'feature/blocked'),
    /原操作|GitHub|核查/,
  );
  const completed = execFileSync('git', ['log', '-1', '--format=%s'], {
    cwd: f.project,
    encoding: 'utf8',
  }).trim();
  assert.equal(completed, 'Synthetic reviewed commit');
  f.fault.after = undefined;
  await c.inspect(c.state!.review);
  assert.equal(c.state!.write.pending, undefined);
  assert.equal(c.state!.write.receipt?.operationId, original.operationId);
  assert.equal(f.store.githubBlocked(f.controller.state.ledger!, sessionId), false);
  assert.equal(f.controller.state.draft!.text, 'Next Agent instruction');
  c.dispose();
  git.close();
});

test('workspace GitHub storage failure, stale review and closed context stop dispatch before publication', async (t) => {
  const f = await githubWorkspace(t);
  await f.create();
  const c = await f.controller.openGithub(() => {}, 'write');
  const id = await c.createDraft(c.state!.review, 'issue-comment', {
    number: 1,
    subject: 'issue',
    body: 'Original body',
  });
  await c.prepare(c.state!.review, id);
  const stale = c.state!;
  await c.saveDraft(stale.review, stale.write.drafts[id]!, {
    ...stale.write.drafts[id]!,
    values: { ...stale.write.drafts[id]!.values, body: 'Changed body' },
  });
  await assert.rejects(c.confirm(stale.review), /改变/);
  await c.prepare(c.state!.review, id);
  f.memory.failWrite = true;
  await assert.rejects(c.confirm(c.state!.review), /storage failure/);
  f.memory.failWrite = false;
  assert.equal(f.github.comments.length, 0);
  c.dispose();
  const next = await f.controller.openGithub();
  const started = signal(),
    release = signal();
  f.github.before = async () => {
    started.resolve();
    await release.promise;
  };
  const reading = next.item(next.state!.review, 'issue', 1);
  await started.promise;
  next.close();
  release.resolve();
  await assert.rejects(reading, /改变|关闭|changed|上下文/);
  assert.equal(next.state, null);
  assert.equal(f.prompts(), 0);
  next.dispose();
});

test('workspace session organization uses host metadata revisions and keeps the conversation draft', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.controller.saveDraft('Keep my next instruction', {});
  await f.controller.metadata('rename', 'Reviewed title');
  assert.equal(f.controller.state.session!.meta.title, 'Reviewed title');
  assert.equal(f.controller.state.sessions.find((item) => item.id === id)!.title, 'Reviewed title');
  await f.controller.metadata('pin');
  assert.equal(f.controller.state.session!.meta.isPinned, true);
  await f.controller.metadata('archive');
  assert.equal(f.controller.state.session!.meta.isArchived, true);
  await f.controller.metadata('restore');
  await f.controller.metadata('unpin');
  assert.equal(f.controller.state.session!.meta.isArchived, false);
  assert.equal(f.controller.state.session!.meta.isPinned, false);
  assert.equal(f.controller.state.draft!.text, 'Keep my next instruction');
  assert.equal(f.prompts(), 0);
});

test('workspace lost metadata receipts preserve the original and stale reviews cannot rename a newer session', async (t) => {
  const f = await fixture(t);
  await f.create();
  const reviewed = structuredClone(f.controller.state.session!.meta);
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'session-action')
      throw Error('Synthetic metadata receipt lost');
  };
  await assert.rejects(f.controller.metadata('rename', 'Original new title'), /receipt lost/);
  const original = f.controller.state.ledger!.operations.find(
    (entry) => entry.status === 'pending',
  )!.original;
  f.fault.after = undefined;
  await f.controller.openSession(reviewed.id);
  const count = f.calls.filter(
    (input) => input.action === 'execute' && input.command.method === 'session-action',
  ).length;
  await assert.rejects(f.controller.metadata('rename', 'Stale title', reviewed), /已改变/);
  await f.controller.inspect(original.value.operationId);
  assert.equal(
    f.calls.filter(
      (input) => input.action === 'execute' && input.command.method === 'session-action',
    ).length,
    count,
  );
  assert.equal(f.controller.state.session!.meta.title, 'Original new title');
  assert.equal(f.prompts(), 0);
});

test('workspace metadata write failure prevents delivery and pending metadata cannot be bypassed', async (t) => {
  const f = await fixture(t);
  await f.create();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'session') f.memory.failWrite = true;
  };
  await assert.rejects(f.controller.metadata('pin'), /storage failure/);
  assert.equal(
    f.calls.some(
      (input) => input.action === 'execute' && input.command.method === 'session-action',
    ),
    false,
  );
  f.memory.failWrite = false;
  f.fault.after = undefined;
  await f.controller.refreshSession();
  const scope = f.controller.state.scope!,
    sessionId = f.controller.state.sessionId!;
  const pending = {
    kind: 'metadata' as const,
    value: {
      operationId: 'synthetic-metadata-pending',
      action: 'pin' as const,
      workspaceId: scope.target.workspaceId,
      localProjectId: scope.target.localProjectId,
      sessionId,
      expectedRevision: f.controller.state.session!.meta.metadataRevision ?? 0,
    },
  };
  await f.store.stage(scope, pending, undefined, () => {});
  await assert.rejects(f.controller.metadata('rename', 'Blocked title'), /原会话整理/);
  assert.equal(
    f.calls.some(
      (input) => input.action === 'execute' && input.command.method === 'session-action',
    ),
    false,
  );
});

async function searchableWorkspace(t: TestContext) {
  const f = await fixture(t);
  const sessionId = await f.create();
  await f.controller.saveDraft('Synthetic needle for content search', {});
  await f.controller.send();
  await f.started.promise;
  const run = f.host.active.get(sessionId);
  f.completion.resolve();
  await run?.done;
  await f.controller.refreshSession();
  return f;
}

test('workspace searches the real host index and opens only a result from the current query', async (t) => {
  const f = await searchableWorkspace(t);
  await f.controller.saveDraft('Preserved after search', {});
  const panel = f.controller.openSearch();
  const result = await panel.search('needle', 'project');
  assert.equal(result.source, 'host-index');
  assert.equal(result.hits.length, 1);
  await assert.rejects(panel.openHit({ ...result.hits[0]!, sessionId: 'foreign' }), /不属于/);
  await panel.openHit(result.hits[0]!);
  assert.deepEqual(f.controller.state.searchFocus, result.hits[0]);
  assert.equal(f.controller.state.draft!.text, 'Preserved after search');
  assert.equal(f.prompts(), 1);
  panel.close();
});

test('offline content search stays within confirmed caches and can open a cached hit without executing', async (t) => {
  const f = await searchableWorkspace(t);
  f.fault.unavailable = true;
  await assert.rejects(f.controller.refreshSession(), /暂不可用/);
  const panel = f.controller.openSearch(),
    before = f.calls.length;
  const result = await panel.search('needle', 'project');
  assert.equal(result.source, 'cache');
  assert.equal(result.coverage?.cachedSessions, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(f.calls.length, before);
  await panel.openHit(result.hits[0]!);
  assert.equal(f.controller.state.offline, true);
  assert.deepEqual(f.controller.state.searchFocus, result.hits[0]);
  assert.equal(f.prompts(), 1);
  panel.close();
});

test('content search rejects late queries and a panel closed during host reads', async (t) => {
  const f = await searchableWorkspace(t);
  const panel = f.controller.openSearch(),
    started = signal(),
    release = signal();
  let held = false;
  f.fault.before = async (input) => {
    if (input.action === 'execute' && input.command.method === 'search-sessions' && !held) {
      held = true;
      started.resolve();
      await release.promise;
    }
  };
  const earlier = panel.search('needle', 'session');
  await started.promise;
  const latest = await panel.search('no match', 'session');
  assert.equal(latest.hits.length, 0);
  release.resolve();
  await assert.rejects(earlier, /新的查询/);
  const again = signal(),
    finish = signal();
  f.fault.before = async (input) => {
    if (input.action === 'execute' && input.command.method === 'search-sessions') {
      again.resolve();
      await finish.promise;
    }
  };
  const reading = panel.search('needle', 'session');
  await again.promise;
  panel.close();
  finish.resolve();
  await assert.rejects(reading, /搜索面板/);
  assert.equal(f.prompts(), 1);
});

async function attentionWorkspace(t: TestContext) {
  const f = await fixture(t, { attention: true });
  const sessionId = await f.create();
  await f.controller.saveDraft('Synthetic attention source', {});
  await f.controller.send();
  await f.started.promise;
  const active = f.host.active.get(sessionId);
  f.completion.resolve();
  await active?.done;
  await f.controller.refreshSession();
  const panel = await f.controller.openAttention();
  const list = panel.controller.state.lists[0]!;
  assert.equal(list.page?.total, 1, list.error);
  const item = list.page!.sessions[0]!.items[0]!;
  const selected = { replicaId: list.target.replicaId, sessionId, itemId: item.itemId };
  await panel.controller.open(selected);
  assert.equal(panel.controller.state.detailFresh, true, panel.controller.state.error);
  return { ...f, panel, selected, item };
}

test('workspace attention reads host outcomes, marks observations and keeps drafts bound to the verified actor', async (t) => {
  const f = await attentionWorkspace(t),
    c = f.panel.controller;
  assert.equal(c.state.detail!.item.seenRevision, c.state.detail!.item.eventRevision);
  await f.controller.saveDraft('My explicitly saved followup', {});
  await c.createDraft();
  assert.equal(c.state.draft!.text, 'My explicitly saved followup');
  c.editDraft('Attention-only draft');
  await c.saveDraft();
  assert.equal(c.state.detail!.item.disposition, 'needs_followup');
  assert.equal(f.controller.state.draft!.text, 'My explicitly saved followup');
  await c.disposition('checked');
  assert.equal(c.state.detail!.item.disposition, 'checked');
  assert.equal(f.prompts(), 1);
  f.panel.close();
  const ledger = await f.store.read(f.controller.state.scope!, () => {});
  assert(Object.keys(ledger.attention ?? {}).length > 0);
});

test('attention continuation retains its exact original after receipt loss and never clears a later edited draft', async (t) => {
  const f = await attentionWorkspace(t),
    c = f.panel.controller;
  await f.controller.saveDraft('Keep separate composer text', {});
  await c.createDraft();
  c.editDraft('Reviewed attention followup');
  await c.saveDraft();
  f.fault.after = async (input) => {
    if (input.action === 'attention' && input.command.kind === 'continue')
      throw Error('Synthetic attention receipt lost');
  };
  await assert.rejects(c.sendContinue(), /receipt lost/);
  const original = structuredClone(c.state.pending!);
  assert.equal(original.operation.kind, 'continue');
  c.editDraft('Later attention draft');
  await c.saveDraft();
  await assert.rejects(f.controller.send(), /原待办/);
  assert.equal(f.controller.state.draft!.text, 'Keep separate composer text');
  f.fault.after = undefined;
  f.panel.close();
  const restored = await f.controller.openAttention(),
    competing = await f.controller.openAttention();
  await restored.controller.open(f.selected);
  await competing.controller.open(f.selected);
  assert.deepEqual(restored.controller.state.pending, original);
  assert.equal(restored.controller.state.draft?.text, 'Later attention draft', 'reopened draft');
  assert.equal(original.draft?.text, 'Reviewed attention followup', 'original draft proof');
  const before = f.calls.filter(
    (input) => input.action === 'attention' && input.command.kind === 'continue',
  ).length;
  await restored.controller.retry();
  assert.equal(restored.controller.state.pending, undefined);
  assert.equal(restored.controller.state.draft!.text, 'Later attention draft');
  await assert.rejects(competing.controller.retry(), /已有结果/);
  assert.equal(
    f.calls.filter((input) => input.action === 'attention' && input.command.kind === 'continue')
      .length,
    before + 1,
  );
  assert.equal(f.controller.state.draft!.text, 'Keep separate composer text');
  restored.close();
  competing.close();
});

test('attention continuation persistence failure prevents a new Agent turn and an unscoped old draft is not imported', async (t) => {
  const f = await attentionWorkspace(t),
    c = f.panel.controller;
  const scope = f.controller.state.scope!,
    sessionId = f.controller.state.sessionId!;
  const draft = f.controller.state.draft!;
  await f.store.saveDraft(
    scope,
    sessionId,
    draft.revision,
    'Unverified old composer text',
    {},
    () => {},
  );
  await f.controller.reloadDraft();
  await c.createDraft();
  assert.notEqual(c.state.draft!.text, 'Unverified old composer text');
  assert.match(c.state.notice, /未关联当前账号/);
  c.editDraft('Reviewed isolated followup');
  await c.saveDraft();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'agent-options')
      f.memory.failWrite = true;
  };
  await assert.rejects(c.sendContinue(), /storage failure/);
  f.memory.failWrite = false;
  f.fault.after = undefined;
  assert.equal(
    f.calls.some((input) => input.action === 'attention' && input.command.kind === 'continue'),
    false,
  );
  assert.equal(f.prompts(), 1);
  f.panel.close();
});

test('attention cached reading remains available offline and actor replacement invalidates the old workbench', async (t) => {
  const f = await attentionWorkspace(t);
  f.panel.close();
  f.fault.unavailable = true;
  await assert.rejects(f.controller.refreshSession(), /暂不可用/);
  const before = f.calls.length,
    offline = await f.controller.openAttention();
  assert.equal(offline.controller.state.lists[0]!.cached, true);
  await offline.controller.open(f.selected);
  assert.equal(offline.controller.state.detailFresh, false);
  assert.equal(f.calls.length, before);
  offline.close();
  f.fault.unavailable = false;
  await f.controller.refreshSession();
  const panel = await f.controller.openAttention();
  await panel.controller.open(f.selected);
  f.catalog.actor!.authorityId = 'new-authority';
  await f.controller.refreshCatalog('local');
  assert.equal(f.controller.state.scope, undefined);
  await assert.rejects(panel.controller.disposition('checked'), /改变/);
  panel.close();
});

test('workspace attention approves only the original active request and retries a lost receipt without another approval', async (t) => {
  const f = await fixture(t, { attention: true });
  const sessionId = await f.create();
  await f.controller.saveDraft('Synthetic permission source', {});
  await f.controller.send();
  await f.started.promise;
  const answer = f.callbacks().permission({
    toolCall: { toolCallId: 'synthetic-edit', title: 'Synthetic edit' },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  const panel = await f.controller.openAttention();
  const list = panel.controller.state.lists[0]!;
  const item = list.page!.sessions[0]!.items.find((item) => item.kind === 'permission')!;
  assert(item);
  const selected = { replicaId: list.target.replicaId, sessionId, itemId: item.itemId };
  await panel.controller.open(selected);
  assert.equal(panel.controller.state.detailFresh, true, panel.controller.state.error);
  assert.equal(panel.controller.state.detail!.permission!.expectedTurnId, item.userTurnId);
  const before = f.calls.length;
  await assert.rejects(panel.controller.permission('invented-option'), /无效/);
  assert.equal(f.calls.length, before);
  f.fault.after = async (input) => {
    if (input.action === 'attention' && input.command.kind === 'permission')
      throw Error('Synthetic permission receipt lost');
  };
  await assert.rejects(panel.controller.permission('allow'), /receipt lost/);
  assert.deepEqual(await answer, { outcome: { outcome: 'selected', optionId: 'allow' } });
  const original = structuredClone(panel.controller.state.pending!);
  assert.equal(original.operation.kind, 'permission');
  panel.close();
  f.fault.after = undefined;
  const restored = await f.controller.openAttention();
  await restored.controller.open(selected);
  assert.deepEqual(restored.controller.state.pending, original);
  await restored.controller.retry();
  assert.equal(restored.controller.state.pending, undefined);
  const requests = f.calls.filter(
    (input) => input.action === 'attention' && input.command.kind === 'permission',
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(f.prompts(), 1);
  restored.close();
});

test('host missing-id repair is atomic and never replaces an existing mismatched document id', async (t) => {
  const f = await fixture(t),
    sessionId = await f.create();
  const source = f.runtime.doc(sessionId),
    view = mirror(source, sessionId);
  view.setState((state) => {
    state.session.id = '';
  });
  view.dispose();
  f.runtime.persist(sessionId, source);
  source.free();
  f.runtime.journal.db.exec(
    "CREATE TRIGGER fail_legacy_identity BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'synthetic repair failure'); END",
  );
  await assert.rejects(f.host.read(sessionId), /synthetic repair failure/);
  f.runtime.journal.db.exec('DROP TRIGGER fail_legacy_identity');
  const unchanged = f.runtime.doc(sessionId),
    old = mirror(unchanged, sessionId);
  assert.equal(old.getState().session.id, '');
  old.setState((state) => {
    state.session.id = 'another-session';
  });
  old.dispose();
  f.runtime.persist(sessionId, unchanged);
  unchanged.free();
  await assert.rejects(f.host.read(sessionId), /身份.*不匹配/);
  const bad = f.runtime.doc(sessionId),
    badView = mirror(bad, sessionId);
  assert.equal(badView.getState().session.id, 'another-session');
  badView.dispose();
  bad.free();
  assert.equal(f.prompts(), 0);
});

test('workspace project files and historical changes use actual host reads and bounded offline caches', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.project, 'sample.txt'), 'before');
  const sessionId = await f.create();
  await f.controller.saveDraft('Synthetic change', {});
  await f.controller.send();
  await f.started.promise;
  const active = f.host.active.get(sessionId)!;
  writeFileSync(join(f.project, 'sample.txt'), 'after');
  f.completion.resolve();
  await active.done;
  await f.controller.refreshSession();
  const turn = f.controller.state.session!.history.find((turn) => turn.role === 'assistant')!;
  const panel = await f.controller.openProjectContent();
  assert.equal(panel.state?.error, undefined);
  assert(panel.state?.tree?.result.entries.some((entry) => entry.path === 'sample.txt'));
  await panel.file('sample.txt', 5);
  assert.equal(panel.state?.currentFile?.text, 'after');
  await assert.rejects(panel.file('../elsewhere', 5));
  await panel.setMode('changes');
  assert.equal(panel.state?.turnId, turn.id);
  assert.equal(panel.state?.error, undefined);
  const change = panel.state!.diff!.result.changes.find((entry) => entry.path === 'sample.txt')!;
  assert(change);
  await panel.diffFile(change);
  assert.equal(panel.state?.error, undefined);
  assert(panel.state?.diffFile);
  const expected = structuredClone(panel.state!.diffFile!.result);
  const calls = f.calls.length;
  panel.dispose();
  assert.equal(f.calls.length, calls, 'closing content does not execute anything');
  f.fault.unavailable = true;
  await assert.rejects(f.controller.refreshSession());
  const offlineCalls = f.calls.length;
  const cached = await f.controller.openProjectContent();
  assert.equal(cached.state?.tree?.source, 'cache');
  await cached.file('sample.txt', 5);
  assert.equal(cached.state?.currentFile?.text, 'after');
  assert.equal(cached.state?.currentFile?.stale, true);
  await cached.setMode('changes');
  await cached.diffFile(change);
  assert.equal(cached.state?.diffFile?.source, 'cache');
  assert.deepEqual(cached.state?.diffFile?.result, expected);
  const search = f.controller.openSearch();
  const found = await search.search('after', 'session');
  assert.equal(found.coverage?.cachedDiffFiles, 1);
  assert(found.hits.some((hit) => hit.turnId === turn.id));
  search.close();
  assert.equal(f.calls.length, offlineCalls, 'offline reads never contact the host');
  assert.equal(f.prompts(), 1, 'only the explicitly sent synthetic turn ran');
  cached.dispose();
});

test('workspace content rejects late navigation results and labels failed cache writes without hiding host content', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.project, 'sample.txt'), 'before');
  const firstId = await f.create();
  const panel = await f.controller.openProjectContent();
  const before = structuredClone(f.memory.values);
  const entered = signal(),
    release = signal();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'file-content') {
      entered.resolve();
      await release.promise;
    }
  };
  const reading = panel.file('sample.txt', 6);
  await entered.promise;
  await f.controller.selectProject('local', f.catalog.targets[0]!.target);
  release.resolve();
  await reading;
  assert.equal(panel.state, null);
  assert.deepEqual(f.memory.values, before);
  f.fault.after = undefined;
  await f.controller.openSession(firstId);
  f.memory.failWrite = true;
  const uncached = await f.controller.openProjectContent();
  assert.equal(uncached.state?.tree?.source, 'host');
  assert.equal(uncached.state?.tree?.cacheSaved, false);
  await uncached.file('sample.txt', 6);
  assert.equal(uncached.state?.currentFile?.text, 'before');
  assert.equal(uncached.state?.currentFile?.cacheSaved, false);
  assert.equal(f.prompts(), 0);
  panel.dispose();
  uncached.dispose();
});
