import { legacyReadSelection, legacyInventory } from '../src/desktop/legacy-cache-keys.cjs';
import { createHash } from 'node:crypto';
import { Flock, LoroDoc, putMeta, mirror, delta, encode } from '../src/model';
import { actorKey } from '../src/attention';
import { attentionItemKey, attentionPendingKey } from '../src/web/attention';
import { createGitHubClient } from '../src/runtime/github-client';
import { createGitHubWriteClient } from '../src/runtime/github-write-client';
import type { SessionGithubOptions } from '../src/runtime/session-github';
import type { SessionGithubWriteOptions } from '../src/runtime/session-github-write';
import { githubKey } from '../src/web/github';
import { githubWriteKey } from '../src/web/github-write';
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
import { normalizeLegacyCache, legacySessionRead } from '../src/desktop/legacy-cache';
import { buildSessionTurn, readLegacyClientSession } from '../src/session-client';
import { sessionActionKey } from '../src/web/session-actions';
import { createAttachmentDraftItem, attachmentDraftKey } from '../src/web/attachments';
import type { AgentCallbacks, AgentOpenOptions } from '../src/runtime/agent';
import { workspaceInteractionSnapshot } from '../src/web/workspace-interactions';
import { interactionKey } from '../src/web/interactions';
import type { QuestionRequest } from '../src/interaction-protocol';
import { mcpKey, mcpMutationVersion } from '../src/web/mcp';
import { workspaceFeatureTarget } from '../src/web/workspace-mcp';
import { gitWorkspaceKey } from '../src/web/git-workspace';
import type { AgentForkInput } from '../src/runtime/agent-fork';
import { sessionForkKey } from '../src/web/session-fork';
import { rolesKey, roleAppliedKey } from '../src/web/roles';
import { tasksKey, type TaskDraft } from '../src/web/tasks';
import { syntheticTaskPlan } from './support/task-plan';
import {
  previewAnnotationKey,
  projectPreviewKey,
  type PreviewAnnotationSnapshot,
} from '../src/web/project-preview';
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
  const legacy = {
    records: [] as { key: string; value: unknown }[],
    calls: [] as any[],
    before: undefined as (() => Promise<void>) | undefined,
  };
  const controller = new WorkspaceController({
    request,
    store,
    schedule: config.schedule ?? (() => () => {}),
    legacy: async (input: any) => {
      legacy.calls.push(structuredClone(input));
      await legacy.before?.();
      let records = legacy.records;
      if (input.selection) {
        const selected = legacyReadSelection(
          input.target,
          input.origin,
          catalog.actor,
          input.selection,
        );
        const prefixes = [...selected.prefixes];
        if (selected.newDraft) {
          const hints = selected.newDraft;
          const byKey = new Map(records.map((record) => [record.key, record.value]));
          const pending = byKey.get(hints.pendingKey) as any;
          for (const id of [
            byKey.get(hints.reservationKey),
            pending?.mutation?.sessionId ?? pending?.sessionId,
          ]) {
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) continue;
            prefixes.push(...hints.sessionPrefixes.map((prefix) => prefix + JSON.stringify(id)));
            prefixes.push(hints.actionPrefix + id + '/session-action');
          }
        }
        records = records.filter((record) =>
          prefixes.some((prefix) => record.key.startsWith(prefix)),
        );
      }
      if (input.action === 'index') {
        const keys = records.map((record) => record.key).sort();
        const version = 'sha256:' + createHash('sha256').update(JSON.stringify(keys)).digest('hex');
        if (input.cursor && input.cursor.version !== version)
          return {
            ok: false,
            error: { code: 'index-changed', message: 'Changed synthetic index' },
          };
        const index = legacyInventory(input.target, input.origin, catalog.actor, keys);
        const start = input.cursor ? index.sessionIds.indexOf(input.cursor.after) + 1 : 0;
        const sessionIds = index.sessionIds.slice(start, start + 100);
        return {
          ok: true,
          value: {
            scope: { source: input.source, origin: input.origin, target: input.target },
            version,
            sessionIds,
            hasNew: index.hasNew,
            total: index.sessionIds.length,
            ...(start + sessionIds.length < index.sessionIds.length
              ? { nextCursor: { version, after: sessionIds.at(-1) } }
              : {}),
          },
        };
      }
      return {
        ok: true,
        value:
          input.action === 'list'
            ? { origins: [catalog.origin] }
            : normalizeLegacyCache({
                source: input.source,
                origin: input.origin,
                target: input.target,
                records,
                ...(input.selection ? { selection: input.selection } : {}),
                actor: catalog.actor,
              }),
      };
    },
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
    legacy,
    inputs,
    host,
    callbacks: () => callbacks,
    steerCalls: () => steerCalls,
    prompts: () => prompts,
    forks,
    openOptions: () => openOptions,
  };
}

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

function oldSession(f: Awaited<ReturnType<typeof fixture>>, draft = 'Original offline draft') {
  const read = f.controller.state.session!,
    scope = f.controller.state.scope!,
    sessionId = read.meta.id;
  const base = [
    scope.target.owner,
    scope.target.deviceId,
    scope.target.workspaceId,
    sessionId,
  ].join('/');
  f.legacy.records = [
    {
      key: base + '/session',
      value: {
        snapshot: read.update,
        meta: read.meta,
        metaBundle: read.metaBundle,
        agent: read.agent,
      },
    },
    { key: base + '/draft', value: draft },
  ];
  return { read, scope, sessionId, base };
}

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

test('legacy Git records retain the exact pending request and can be restored and manually retried', async (t) => {
  const f = await fixture(t),
    { panel, oid } = await gitProject(f);
  const { scope, sessionId } = oldSession(f);
  const target = workspaceFeatureTarget({ ...scope.target, sessionId });
  const request = {
    gitVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
    operationId: 'old-git-operation',
    expectedRevision: 0,
    action: 'prepare',
    baseBranch: 'main',
    expectedOid: oid,
    newBranch: 'feature/legacy',
  };
  f.legacy.records.push({
    key: gitWorkspaceKey(target),
    value: {
      version: 1,
      cacheRevision: 2,
      target,
      state: panel.controller.state,
      pending: { target, request },
    },
  });
  const record = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert(record.git);
  assert.deepEqual(record.unresolvedKeys, []);
  const damaged = structuredClone(record);
  damaged.git!.pending!.target.replicaId = 'other-replica';
  await assert.rejects(
    f.store.restoreLegacy(scope, damaged, () => {}),
    /不匹配/,
  );
  await f.controller.restoreLegacy(record);
  await f.controller.openSession(sessionId);
  const restored = await f.controller.openGit();
  assert.equal(
    f.calls.filter((input) => input.action === 'execute' && input.command.method === 'git-action')
      .length,
    0,
  );
  await restored.retry();
  const action = f.calls.find(
    (input) => input.action === 'execute' && input.command.method === 'git-action',
  )!;
  assert(action.action === 'execute');
  assert.deepEqual(action.command.params, request);
  assert.equal(restored.controller.execution?.status, 'ready');
  assert.equal(f.prompts(), 0);
  assert.equal(f.controller.state.draft!.text, 'Original offline draft');
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

test('legacy native Fork records preserve the reviewed source, child id and original request on recovery', async (t) => {
  const f = await fixture(t, { nativeFork: true }),
    { panel } = await forkSource(f);
  const { scope, sessionId } = oldSession(f),
    options = panel.controller.options!,
    target = workspaceFeatureTarget({ ...scope.target, sessionId });
  const request = {
    forkVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
    operationId: 'original-fork',
    childSessionId: 'original-child',
    expectedSourceVersion: options.sourceVersion,
    expectedExecutionRevision: options.execution.revision,
    cutoff: { kind: 'current' },
    directory: { kind: 'same-directory' },
  };
  f.legacy.records.push({
    key: sessionForkKey(target),
    value: {
      version: 1,
      cacheRevision: 2,
      target,
      options,
      resources: [],
      operation: { target, request, sourceExecution: options.execution },
    },
  });
  const record = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert(record.fork);
  assert.deepEqual(record.unresolvedKeys, []);
  const wrong = structuredClone(record);
  wrong.fork!.operation!.target.owner = 'other-account';
  await assert.rejects(
    f.store.restoreLegacy(scope, wrong, () => {}),
    /不属于/,
  );
  await f.controller.restoreLegacy(record);
  await f.controller.openSession(sessionId);
  const restored = await f.controller.openFork();
  assert.equal(f.forks.length, 0);
  await restored.retry();
  assert.equal(f.forks.length, 1);
  const call = f.calls.find(
    (input) => input.action === 'execute' && input.command.method === 'fork-action',
  )!;
  assert(call.action === 'execute');
  assert.deepEqual(call.command.params, request);
  assert.equal(f.controller.state.draft!.text, 'Original offline draft');
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

test('legacy MCP selection and pending authorization restore atomically and only the original turn can be retried', async (t) => {
  const f = await fixture(t),
    { server } = await mcp(f, false);
  const { scope, sessionId, base, read } = oldSession(f);
  const pending = buildSessionTurn({
    scope: { ...scope.target, sessionId },
    read,
    agent: read.agent!,
    prompt: 'Old request',
    operationId: 'old-mcp-turn',
    turnId: 'old-user-turn',
    peerId: 'old-peer',
    now: '2026-09-14T00:00:00.000Z',
    mcpServerIds: [server.id],
  });
  const review = { reviewId: 'old-review', servers: [server] };
  f.legacy.records.push(
    { key: base + '/pending', value: pending },
    {
      key: mcpKey({ ...scope.target, sessionId }),
      value: {
        version: 1,
        cacheRevision: 2,
        target: workspaceFeatureTarget({ ...scope.target, sessionId }),
        review,
        delivery: {
          operationId: pending.operationId,
          review,
          requestVersion: await mcpMutationVersion(pending),
        },
      },
    },
  );
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(recovered.unresolvedKeys, []);
  assert(recovered.mcp);
  const damaged = structuredClone(recovered);
  damaged.mcp!.delivery!.requestVersion = 'sha256:' + '0'.repeat(64);
  await assert.rejects(
    f.store.restoreLegacy(scope, damaged, () => {}),
    /原指令不匹配/,
  );
  await f.controller.restoreLegacy(recovered);
  await f.controller.openSession(sessionId);
  assert.equal(f.prompts(), 0);
  await f.controller.retry(pending.operationId);
  await f.started.promise;
  assert.equal(f.prompts(), 1);
  assert.equal(f.openOptions()?.mcp?.servers.length, 1);
  assert.equal(f.controller.state.draft!.text, 'Original offline draft');
  assert.equal(f.controller.state.ledger!.mcp![sessionId]!.delivery, undefined);
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

test('legacy interaction drafts preserve the original steer and reject a different account', async (t) => {
  const f = await fixture(t),
    question = await interactive(f);
  const { scope, sessionId } = oldSession(f, '');
  const target = scope.target;
  const pending = {
    kind: 'steer' as const,
    owner: target.owner,
    deviceId: target.deviceId,
    catalogWorkspaceId: target.catalogWorkspaceId,
    replicaId: target.replicaId,
    request: {
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId,
      expectedTurnId: question.expectedTurnId,
      operationId: 'legacy-steer',
      prompt: 'Old reviewed steer',
    },
  };
  f.legacy.records.push({
    key: interactionKey({ ...target, sessionId }),
    value: { version: 1, drafts: {}, steerDraft: 'Old reviewed steer', pending, closed: [] },
  });
  const record = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(record.unresolvedKeys, []);
  const wrong = structuredClone(record);
  wrong.interactions!.pending!.owner = 'other';
  await assert.rejects(
    f.store.restoreLegacy(scope, wrong, () => {}),
    /不匹配/,
  );
  await f.controller.restoreLegacy(record);
  assert.equal(f.steerCalls(), 0);
  await f.controller.openSession(sessionId);
  assert.equal(f.steerCalls(), 0);
  await f.controller.retryInteraction();
  assert.equal(f.steerCalls(), 1);
  const call = f.calls.find(
    (input) => input.action === 'execute' && input.command.method === 'steer',
  )!;
  assert.deepEqual((call as any).command.params, pending.request);
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

test('legacy attachments restore bytes and the exact pending upload, reject corruption and never auto-submit', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { scope, sessionId } = oldSession(f);
  const target = scope.target;
  const item = await createAttachmentDraftItem(
    new File(['Old bytes'], 'old.txt', { type: 'text/plain' }),
    'old-attachment',
  );
  const attachmentScope = {
    owner: target.owner,
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
  };
  const request = {
    contentVersion: 1 as const,
    operationId: 'original-upload',
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
    action: 'upload' as const,
    attachment: item.reference,
    data: item.data,
  };
  item.pending = {
    owner: target.owner,
    deviceId: target.deviceId,
    catalogWorkspaceId: target.catalogWorkspaceId,
    replicaId: target.replicaId,
    request,
  };
  f.legacy.records.push({
    key: attachmentDraftKey(attachmentScope),
    value: { version: 1, scope: attachmentScope, items: [item] },
  });
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(recovered.unresolvedKeys, []);
  const corrupted = structuredClone(recovered);
  corrupted.attachments!.items[0]!.data = btoa('Bad bytes');
  await assert.rejects(
    f.store.restoreLegacy(scope, corrupted, () => {}),
    /校验失败|字节数/,
  );
  assert.equal(f.controller.state.ledger?.attachments, undefined);
  await f.controller.restoreLegacy(recovered);
  await f.controller.openSession(sessionId);
  assert.deepEqual(f.controller.state.ledger!.attachments![sessionId]!.items, [item]);
  assert.equal(
    f.calls.filter(
      (call) => call.action === 'execute' && call.command.method === 'attachment-action',
    ).length,
    0,
  );
  await f.controller.retry(request.operationId);
  const upload = f.calls.find(
    (call) => call.action === 'execute' && call.command.method === 'attachment-action',
  )!;
  assert.deepEqual((upload as any).command.params, request);
  assert.equal(f.controller.state.ledger!.attachments![sessionId]!.items[0]!.uploaded, true);
  assert.equal(f.prompts(), 0);
  assert.equal(f.controller.state.draft?.text, 'Original offline draft');
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

test('legacy cache restores a scoped draft atomically and repeated recovery never overwrites later edits', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { scope, sessionId } = oldSession(f);
  assert.deepEqual(await f.controller.legacyOrigins(), [f.catalog.origin]);
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert(recovered);
  const before = f.calls.length;
  f.memory.failWrite = true;
  await assert.rejects(f.controller.restoreLegacy(recovered), /storage failure/);
  f.memory.failWrite = false;
  assert.equal((await f.store.read(scope, () => {})).legacy, undefined);
  await f.controller.restoreLegacy(recovered);
  assert.equal(f.controller.state.draft?.text, 'Original offline draft');
  await f.controller.saveDraft('Edited after recovery', {});
  await f.controller.restoreLegacy(recovered);
  assert.equal(f.controller.state.draft?.text, 'Edited after recovery');
  assert.equal(f.controller.state.ledger?.legacy?.length, 1);
  assert.equal(f.calls.length, before, 'reading and importing never dispatches to an Agent');
  const cached = await f.store.cachedSession(scope, sessionId, () => {});
  assert(cached);
  f.legacy.records[1]!.value = 'Changed in original profile';
  await assert.rejects(f.controller.restoreLegacy(recovered), /已改变/);
  assert.equal(f.controller.state.draft?.text, 'Edited after recovery');
});

test('legacy original mutations retain their operationId, never execute on restore and preserve the reviewed draft after a receipt', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { read, scope, sessionId, base } = oldSession(f, 'Edited while waiting for receipt');
  const pending = buildSessionTurn({
    scope: { ...scope.target, sessionId },
    read,
    agent: read.agent!,
    prompt: 'Original submitted prompt',
    operationId: 'legacy-operation',
    turnId: 'legacy-turn',
    peerId: 'legacy-peer',
    now: '2026-09-14T00:00:00.000Z',
  });
  f.legacy.records.push({ key: base + '/pending', value: pending });
  const record = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  await f.controller.restoreLegacy(record);
  assert.equal(f.prompts(), 0);
  assert.deepEqual(
    f.controller.state.ledger?.operations.find(
      (item) => item.original.value.operationId === pending.operationId,
    )?.original,
    { kind: 'mutation', value: pending },
  );
  await f.controller.refreshCatalog('local');
  await assert.rejects(f.controller.send(), /尚未确认/);
  assert.equal(f.prompts(), 0);
  await f.controller.retry(pending.operationId);
  await f.started.promise;
  assert.equal(f.prompts(), 1);
  const sent = f.calls.filter(
    (call) => call.action === 'execute' && call.command.method === 'mutate',
  );
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as any).command.params, pending);
  assert.equal(f.controller.state.draft?.text, 'Edited while waiting for receipt');
});

test('legacy metadata is restored with its exact target and manually retried through validated host receipts', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { read, scope, sessionId } = oldSession(f);
  const target = scope.target;
  const request = {
    operationId: 'legacy-rename',
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
    action: 'rename' as const,
    title: 'Recovered title',
    expectedRevision: read.meta.metadataRevision ?? 0,
  };
  f.legacy.records.push({
    key: sessionActionKey({ ...target, sessionId }),
    value: {
      owner: target.owner,
      deviceId: target.deviceId,
      catalogWorkspaceId: target.catalogWorkspaceId,
      replicaId: target.replicaId,
      request,
    },
  });
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  await f.controller.restoreLegacy(recovered);
  assert.equal(
    f.calls.filter((item) => item.action === 'execute' && item.command.method === 'session-action')
      .length,
    0,
  );
  await f.controller.retry(request.operationId);
  await f.controller.refreshSession();
  assert.equal(f.controller.state.session?.meta.title, 'Recovered title');
  assert.equal(f.controller.state.draft?.text, 'Original offline draft');
  assert.equal(f.prompts(), 0);
});

test('unknown pending formats or attachments block new sends; wrong projects and late authority changes cannot import', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { scope, sessionId, base } = oldSession(f);
  f.legacy.records.push({
    key: base + '/pending',
    value: { futureVersion: 99, operationId: 'retain-original' },
  });
  const attachmentKey =
    'attachment-draft-v1/' +
    JSON.stringify([
      scope.target.owner,
      scope.target.deviceId,
      scope.target.workspaceId,
      scope.target.localProjectId,
      sessionId,
    ]);
  f.legacy.records.push({
    key: attachmentKey,
    value: { futureVersion: 99, bytes: 'Preserve original bytes' },
  });
  await assert.rejects(f.controller.send(), /恢复旧客户端草稿/);
  assert.equal(
    f.prompts(),
    0,
    'unimported old operations cannot be bypassed by using the new composer',
  );
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(recovered.unresolvedKeys, [base + '/pending', attachmentKey]);
  const wrong = structuredClone(recovered);
  wrong.scope.target.localProjectId = 'another-project';
  await assert.rejects(f.controller.restoreLegacy(wrong), /不属于/);
  await f.controller.restoreLegacy(recovered);
  await assert.rejects(f.controller.send(), /未识别/);
  assert.equal(f.prompts(), 0);
  await f.controller.saveDraft('Still editable', {});
  assert.equal(f.controller.state.draft?.text, 'Still editable');
  const started = signal(),
    release = signal();
  f.legacy.before = async () => {
    started.resolve();
    await release.promise;
  };
  const late = f.controller.readLegacy(f.catalog.origin);
  await started.promise;
  await f.controller.openSession(sessionId);
  release.resolve();
  await assert.rejects(late, /已改变/);
  const normalized = normalizeLegacyCache({
    ...scope,
    origin: f.catalog.origin,
    target: { ...scope.target, localProjectId: 'other' },
    records: f.legacy.records,
  });
  assert.equal(normalized.sessions.length, 0);
  assert.equal(normalized.unresolved, 4);
  assert.throws(
    () =>
      normalizeLegacyCache({
        ...scope,
        origin: 'https://foreign.invalid',
        records: f.legacy.records,
      }),
    /不匹配/,
  );
  assert.throws(
    () =>
      normalizeLegacyCache({
        ...scope,
        origin: f.catalog.origin,
        records: [...f.legacy.records, f.legacy.records[0]!],
      }),
    /重复/,
  );
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

test('confirmed task children open in their original project and lost revoke receipts only retry the original request', async (t) => {
  const f = await fixture(t),
    { id } = await taskSource(f);
  await f.controller.saveDraft('Coordinate tasks', {});
  await f.controller.send();
  await f.started.promise;
  let panel = await f.controller.openTasks();
  await panel.controller.refresh();
  const grant = panel.controller.list!.grants[0]!,
    tools = f.openOptions()!.taskTools!;
  let rpcId = 0;
  const rpc = async (method: string, params?: unknown) => {
    const response = await fetch(tools.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tools.token,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(method.startsWith('notifications/') ? {} : { id: ++rpcId }),
        method,
        params,
      }),
    });
    assert(response.ok);
    const body = await response.text();
    return body ? JSON.parse(body) : undefined;
  };
  await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'synthetic-parent', version: '1' },
  });
  await rpc('notifications/initialized');
  const created = await rpc('tools/call', {
    name: 'moor_task_create',
    arguments: {
      grantId: grant.grantId,
      taskId: grant.tasks[0]!.taskId,
      operationId: 'create-synthetic-child',
    },
  });
  assert.equal(JSON.parse(created.result.content[0].text).state, 'accepted');
  await panel.controller.refresh();
  const child = panel.controller.list!.grants[0]!.tasks[0]!.childSessionId;
  await panel.openSession(child);
  assert.equal(f.controller.state.session!.meta.taskOrigin?.parentSessionId, id);
  assert.equal(f.controller.state.session!.history.length, 0);
  const childPanel = await f.controller.openTasks();
  await assert.rejects(childPanel.review(), /父会话|子任务/);
  await f.controller.openSession(id);
  panel = await f.controller.openTasks();
  await panel.controller.refresh();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'tasks-action')
      throw Error('Synthetic task receipt lost');
  };
  await assert.rejects(panel.action('revoke', grant.grantId), /receipt lost/);
  const pending = structuredClone(panel.controller.pending);
  assert.equal(pending?.action, 'revoke');
  f.fault.after = undefined;
  const old = oldSession(f, 'Later parent draft');
  f.legacy.records.push({
    key: tasksKey(workspaceFeatureTarget({ ...old.scope.target, sessionId: id })),
    value: f.controller.state.ledger!.tasks![id],
  });
  f.memory.values.clear();
  await f.controller.reloadDraft();
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(recovered.tasks!.pending, pending);
  const beforeImport = f.calls.length;
  await f.controller.restoreLegacy(recovered);
  assert.equal(
    f.calls
      .slice(beforeImport)
      .some((call) => call.action === 'execute' && call.command.method === 'tasks-action'),
    false,
  );
  const restored = await f.controller.openTasks();
  assert.deepEqual(restored.controller.pending, pending);
  await restored.action('retry');
  assert.equal(restored.controller.pending, undefined);
  await assert.rejects(panel.action('retry'), /原任务操作已改变/);
  await restored.controller.refresh();
  const current = restored.controller.list!.grants[0]!;
  assert.equal(current.state, 'canceled');
  await restored.action('cleanup', current.grantId, undefined, {
    taskId: current.tasks[0]!.taskId,
    expectedExecutionRevision: current.tasks[0]!.execution!.revision,
  });
  assert.equal(restored.controller.receipt?.operation?.state, 'accepted');
  assert.equal(f.prompts(), 1);
});

test('legacy task plans and delivery proofs restore atomically without authorizing a new parent turn', async (t) => {
  const f = await fixture(t),
    { id, plan } = await taskSource(f);
  await f.controller.saveDraft('Original parent', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send(), /暂不可用/);
  await f.started.promise;
  const ledger = f.controller.state.ledger!,
    pending = ledger.operations.find((entry) => entry.status === 'pending')!;
  const old = oldSession(f, 'Old editor after submission');
  f.legacy.records.push(
    { key: old.base + '/pending', value: pending.original.value },
    {
      key: tasksKey(workspaceFeatureTarget({ ...old.scope.target, sessionId: id })),
      value: ledger.tasks![id],
    },
  );
  f.memory.values.clear();
  await f.controller.reloadDraft();
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(recovered.unresolvedKeys, []);
  const damaged = structuredClone(recovered);
  damaged.tasks!.delivery!.requestVersion = 'sha256:' + 'f'.repeat(64);
  await assert.rejects(
    f.store.restoreLegacy(old.scope, damaged, () => {}),
    /原父指令/,
  );
  const wrong = structuredClone(recovered);
  wrong.tasks!.target.owner = 'another-account';
  await assert.rejects(
    f.store.restoreLegacy(old.scope, wrong, () => {}),
    /账号/,
  );
  await assert.rejects(f.controller.send(), /恢复旧客户端草稿/);
  const before = f.calls.length;
  await f.controller.restoreLegacy(recovered);
  assert.equal(
    f.calls
      .slice(before)
      .some(
        (call) =>
          call.action === 'execute' && ['mutate', 'tasks-action'].includes(call.command.method),
      ),
    false,
  );
  assert.deepEqual(f.controller.state.ledger!.tasks![id]!.delivery!.review.plan, plan);
  f.fault.loseMutation = false;
  await f.controller.inspect(pending.original.value.operationId);
  assert.equal(f.controller.state.ledger!.tasks![id]!.delivery, undefined);
  assert.equal(f.controller.state.ledger!.tasks![id]!.enabled, undefined);
  assert.equal(f.controller.state.draft!.text, 'Old editor after submission');
  assert.equal(f.prompts(), 1);
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

test('legacy role originals and applied markers restore by full scope and never execute on import', async (t) => {
  const f = await fixture(t),
    { id, panel, role } = await roleSource(f);
  await panel.apply(role);
  const marker = structuredClone(f.controller.state.ledger!.roleApplied![id]);
  await panel.refresh();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'roles-action')
      throw Error('Synthetic lost receipt');
  };
  await assert.rejects(
    panel.save({ ...syntheticRole, id: role.id, name: 'Updated reviewer' }),
    /lost receipt/,
  );
  f.fault.after = undefined;
  const saved = structuredClone(f.controller.state.ledger!.roles![id]);
  const old = oldSession(f, f.controller.state.draft!.text);
  f.legacy.records.push(
    { key: rolesKey(panel.controller.target), value: saved },
    { key: roleAppliedKey(panel.controller.target), value: marker },
  );
  f.memory.values.clear();
  await f.controller.reloadDraft();
  const recovered = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(recovered.unresolvedKeys, []);
  const wrong = structuredClone(recovered);
  wrong.roles!.target.owner = 'another-account';
  await assert.rejects(
    f.store.restoreLegacy(old.scope, wrong, () => {}),
    /账号/,
  );
  await assert.rejects(f.controller.send(), /恢复旧客户端草稿/);
  const before = f.calls.length;
  await f.controller.restoreLegacy(recovered);
  assert.equal(
    f.calls
      .slice(before)
      .some((call) => call.action === 'execute' && call.command.method === 'roles-action'),
    false,
  );
  assert.deepEqual(f.controller.state.ledger!.roleApplied![id], marker);
  const restored = await f.controller.openRoles();
  assert.deepEqual(restored.controller.pending, saved!.pending);
  await restored.inspect();
  await restored.refresh();
  assert.equal(restored.controller.list!.roles[0]!.name, 'Updated reviewer');
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

test('legacy annotation delivery and live preview originals restore without dispatch', async (t) => {
  const preview = syntheticPreview(),
    f = await fixture(t, { preview: preview.options });
  const id = await f.create(),
    panel = await f.controller.openPreview();
  await panel.controller.refreshOptions();
  await panel.controller.open('service', previewViewport);
  const annotation = await panel.annotations.save(annotationSnapshot);
  await panel.annotations.select(annotation.id, true);
  await f.controller.saveDraft('Original annotation request', {});
  f.fault.loseMutation = true;
  await assert.rejects(f.controller.send(), /暂不可用/);
  const ledger = f.controller.state.ledger!,
    original = ledger.operations.find((entry) => entry.status === 'pending')!;
  const old = oldSession(f, 'Legacy editor after submission');
  f.legacy.records.push(
    {
      key: old.base + '/pending',
      value: {
        previewDraftVersion: 1,
        mutation: original.original.value,
        annotationDelivery: {
          operationId: original.original.value.operationId,
          submission: original.annotations,
        },
      },
    },
    { key: previewAnnotationKey(panel.annotations.target), value: ledger.annotations![id] },
    { key: projectPreviewKey(panel.controller.target), value: ledger.previews![id] },
  );
  f.memory.values.clear();
  await f.controller.reloadDraft();
  const recovered = await f.controller.readLegacy(f.catalog.origin);
  assert.equal(recovered.sessions[0]!.unresolvedKeys.length, 0);
  const damaged = structuredClone(recovered.sessions[0]!);
  damaged.annotations!.annotations[0]!.snapshot.note = 'Modified after hashing';
  await assert.rejects(
    f.store.restoreLegacy(f.controller.state.scope!, damaged, () => {}),
    /版本不匹配/,
  );
  const moved = structuredClone(recovered.sessions[0]!);
  moved.annotations!.target.owner = 'another-account';
  await assert.rejects(
    f.store.restoreLegacy(f.controller.state.scope!, moved, () => {}),
    /账号/,
  );
  const extra = structuredClone(f.legacy.records);
  const wrapper = extra.find((record) => record.key === old.base + '/pending')!.value as any;
  wrapper.mutation.unsupported = true;
  const unsupported = normalizeLegacyCache({
    source: 'local',
    origin: f.catalog.origin,
    target: f.controller.state.scope!.target,
    records: extra,
  });
  assert.equal(unsupported.sessions[0]!.pending, undefined);
  assert(unsupported.sessions[0]!.unresolvedKeys.includes(old.base + '/pending'));
  const before = f.calls.length;
  await f.controller.restoreLegacy(recovered.sessions[0]!);
  assert.equal(
    f.calls
      .slice(before)
      .some(
        (call) =>
          call.action === 'execute' &&
          ['mutate', 'preview-action', 'preview-close'].includes(call.command.method),
      ),
    false,
  );
  assert.deepEqual(f.controller.state.ledger?.previews?.[id]?.open, ledger.previews![id]!.open);
  f.fault.loseMutation = false;
  await f.controller.inspect(original.original.value.operationId);
  assert.equal(
    f.controller.state.ledger?.annotations?.[id]?.annotations[0]?.selectionId,
    undefined,
  );
  assert.equal(f.controller.state.draft?.text, 'Legacy editor after submission');
  assert.deepEqual(preview.actions, ['open']);
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

test('workspace restores original GitHub drafts and pending binding without dispatch and rejects foreign identity', async (t) => {
  const f = await githubWorkspace(t);
  await f.create();
  const c = await f.controller.openGithub();
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'github-action')
      throw Error('Synthetic binding receipt lost');
  };
  await assert.rejects(c.unbind(c.state!.review), /receipt lost/);
  const sessionId = f.controller.state.sessionId!,
    scope = f.controller.state.scope!,
    target = workspaceFeatureTarget({ ...scope.target, sessionId });
  const saved = structuredClone(f.controller.state.ledger!.github![sessionId]!);
  c.dispose();
  f.fault.after = undefined;
  oldSession(f, 'Legacy GitHub draft');
  f.legacy.records.push(
    { key: githubKey(target), value: saved },
    {
      key: githubWriteKey(target),
      value: {
        version: 1,
        cacheRevision: 2,
        target,
        drafts: {
          manual: {
            id: 'manual',
            kind: 'issue-comment',
            values: { number: 1, body: 'Legacy manual text', subject: 'issue' },
          },
        },
      },
    },
  );
  const recovery = await f.controller.readLegacy(f.catalog.origin);
  assert.equal(recovery.sessions[0]!.unresolvedKeys.length, 0);
  const before = f.calls.length;
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  await store.restoreLegacy(scope, recovery.sessions[0]!, () => {});
  const ledger = await store.read(scope, () => {});
  assert.deepEqual(ledger.github![sessionId]!.pending, saved.pending);
  assert.equal(ledger.githubWrite![sessionId]!.drafts.manual!.values.body, 'Legacy manual text');
  assert.equal(store.githubBlocked(ledger, sessionId), true);
  assert.equal(f.calls.length, before);
  const wrong = structuredClone(recovery.sessions[0]!);
  wrong.github!.target.owner = 'foreign';
  await assert.rejects(
    new WorkspaceStore(new Memory()).restoreLegacy(scope, wrong, () => {}),
    /不匹配/,
  );
  const fresh = await f.controller.openGithub();
  await fresh.retryBinding(fresh.state!.review);
  assert.equal(fresh.state!.read.pending, undefined);
  fresh.dispose();
  assert.equal(f.prompts(), 0);
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

test('legacy attention drafts and pending observations restore atomically under the verified Actor without replay', async (t) => {
  const f = await attentionWorkspace(t),
    c = f.panel.controller;
  await c.createDraft();
  c.editDraft('Legacy attention draft');
  await c.saveDraft();
  f.fault.after = async (input) => {
    if (input.action === 'attention' && input.command.kind === 'disposition')
      throw Error('Synthetic legacy receipt lost');
  };
  await assert.rejects(c.disposition('checked'), /receipt lost/);
  const original = structuredClone(c.state.pending!);
  const { scope, sessionId, base } = oldSession(f, 'Legacy Actor composer');
  const bucket = Object.values((await f.store.read(scope, () => {})).attention!)[0]!;
  f.legacy.records.push(
    ...Object.entries(bucket.entries)
      .filter(([key]) => !key.includes('/page/'))
      .map(([key, value]) => ({ key, value })),
  );
  f.legacy.records.push({
    key: base + '/draft/actor',
    value: {
      scope: JSON.stringify([f.catalog.origin, actorKey(f.catalog.actor!)]),
      text: 'Legacy Actor composer',
    },
  });
  f.panel.close();
  f.fault.after = undefined;
  f.memory.values.clear();
  await f.controller.openSession(sessionId);
  const record = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.deepEqual(record.draftActor, f.catalog.actor);
  assert(record.attention);
  assert.deepEqual(record.unresolvedKeys, []);
  const count = f.calls.filter(
    (input) => input.action === 'attention' && input.command.kind === 'disposition',
  ).length;
  f.memory.failWrite = true;
  await assert.rejects(f.controller.restoreLegacy(record), /storage failure/);
  f.memory.failWrite = false;
  await f.controller.restoreLegacy(record);
  await f.controller.restoreLegacy(record);
  assert.equal(
    f.calls.filter((input) => input.action === 'attention' && input.command.kind === 'disposition')
      .length,
    count,
  );
  const restored = await f.controller.openAttention();
  await restored.controller.open(f.selected);
  assert.deepEqual(restored.controller.state.pending, original);
  assert.equal(restored.controller.state.draft!.text, 'Legacy attention draft');
  assert.equal(f.controller.state.draft!.text, 'Legacy Actor composer');
  assert.deepEqual(f.controller.state.draft!.actor, f.catalog.actor);
  await restored.controller.retry();
  assert.equal(restored.controller.state.pending, undefined);
  assert.equal(f.prompts(), 1);
  restored.close();
});

test('legacy attention rejects changed execution bindings and stale composer Actor proofs', async (t) => {
  const f = await attentionWorkspace(t);
  const { base, sessionId } = oldSession(f, 'Newer legacy text');
  const target = f.panel.controller.state.lists[0]!.target;
  const route = Object.fromEntries(
    Object.entries(target).filter(
      ([key]) => !['hostName', 'projectName', 'online', 'features'].includes(key),
    ),
  ) as typeof target;
  f.legacy.records.push({
    key: base + '/draft/actor',
    value: {
      scope: JSON.stringify([f.catalog.origin, actorKey(f.catalog.actor!)]),
      text: 'Older legacy text',
    },
  });
  const original = {
    route,
    sessionId,
    itemId: f.item.itemId,
    operation: {
      kind: 'disposition' as const,
      body: {
        operationId: 'old-observation',
        eventRevision: 1,
        observationRevision: 0,
        disposition: 'checked' as const,
      },
    },
  };
  const key = attentionPendingKey(original);
  f.legacy.records.push({
    key,
    value: { ...original, route: { ...route, replicaId: 'changed-replica' } },
  });
  f.legacy.records.push({
    key: attentionItemKey(route, sessionId, f.item.itemId) + '/draft',
    value: { text: 'Scoped draft', saved: true, shared: false },
  });
  const record = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert.equal(record.draftActor, undefined);
  assert.deepEqual(record.unresolvedKeys, [key]);
  assert.equal(Object.keys(record.attention!.entries).length, 1);
  await assert.rejects(f.controller.send(), /旧客户端/);
  const wrong = structuredClone(record);
  wrong.attention!.route.actor.accountId = 'another-account';
  await assert.rejects(
    f.store.restoreLegacy(f.controller.state.scope!, wrong, () => {}),
    /不匹配/,
  );
  f.panel.close();
});

test('attention continuation checks legacy originals in the item project while another project is selected', async (t) => {
  const f = await attentionWorkspace(t);
  oldSession(f);
  const source = f.catalog.targets[0]!;
  const otherRoot = join(f.project, 'other-project');
  mkdirSync(otherRoot);
  const otherId = f.runtime.registerProject(otherRoot);
  f.host.updateCatalogue();
  const other = {
    ...source,
    target: {
      ...source.target,
      localProjectId: otherId,
      catalogProjectId: 'other-logical-project',
      replicaId: 'other-replica',
    },
    projectName: 'Other project',
    runtime: f.host.workspace,
  };
  f.catalog.targets.push(other);
  f.panel.close();
  await f.controller.refreshCatalog('local');
  await f.controller.selectProject('local', other.target);
  const panel = await f.controller.openAttention();
  await panel.controller.open(f.selected);
  await panel.controller.createDraft();
  panel.controller.editDraft('Explicit followup in original project');
  await panel.controller.saveDraft();
  f.legacy.calls.length = 0;
  await panel.controller.sendContinue();
  const reads = f.legacy.calls.filter((input) => input.action === 'read');
  assert(reads.length > 0);
  assert(reads.every((input) => input.target.localProjectId === source.target.localProjectId));
  assert.equal(f.controller.state.project!.target.localProjectId, otherId);
  const sent = f.calls.findLast(
    (input) => input.action === 'attention' && input.command.kind === 'continue',
  )!;
  assert.equal('target' in sent && sent.target.localProjectId, source.target.localProjectId);
  panel.close();
});

function oldNewDraft(
  f: Awaited<ReturnType<typeof fixture>>,
  text = 'Old new-session draft',
  sessionId?: string,
) {
  const target = f.catalog.targets[0]!.target;
  const base = [target.owner, target.deviceId, target.workspaceId, 'new'].join('/');
  const agentId = f.catalog.targets[0]!.runtime.agents[0]!.id;
  f.legacy.records = [
    { key: base + '/draft', value: text },
    { key: base + '/options', value: { project: target.localProjectId, agent: agentId } },
    ...(sessionId
      ? [
          {
            key:
              'attachment-session-v1/' +
              JSON.stringify([
                target.owner,
                target.deviceId,
                target.workspaceId,
                target.localProjectId,
              ]),
            value: sessionId,
          },
        ]
      : []),
  ];
  return { target, base, agentId };
}

test('new-session legacy text and attachments restore locally and retain the original reserved session on explicit opening', async (t) => {
  const f = await fixture(t),
    sessionId = 'reserved-legacy-draft';
  const { target } = oldNewDraft(f, 'Original unsent text', sessionId);
  const item = await createAttachmentDraftItem(
    {
      name: 'synthetic.txt',
      type: 'text/plain',
      size: 5,
      arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
    } as File,
    'old-attachment',
  );
  const attachmentScope = {
    owner: target.owner,
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
  };
  f.legacy.records.push({
    key: attachmentDraftKey(attachmentScope),
    value: { version: 1, scope: attachmentScope, items: [item] },
  });
  const recovery = await f.controller.readLegacy(f.catalog.origin);
  assert.equal(recovery.sessions.length, 0);
  assert.equal(recovery.newDraft!.sessionId, sessionId);
  assert.equal(recovery.newDraft!.attachments!.items[0]!.data, item.data);
  assert.deepEqual(recovery.newDraft!.unresolvedKeys, []);
  const before = f.calls.length;
  f.memory.failWrite = true;
  await assert.rejects(f.controller.restoreLegacyDraft(recovery.newDraft!), /storage failure/);
  f.memory.failWrite = false;
  assert.equal(await f.controller.restoreLegacyDraft(recovery.newDraft!), sessionId);
  assert.equal(await f.controller.restoreLegacyDraft(recovery.newDraft!), sessionId);
  assert.equal(f.calls.length, before);
  assert.equal(f.prompts(), 0);
  await f.controller.openLegacyDraft(sessionId);
  assert.equal(f.controller.state.sessionId, sessionId);
  assert.equal(f.controller.state.draft!.text, 'Original unsent text');
  assert.deepEqual(f.controller.state.ledger!.attachments![sessionId]!.items, [item]);
  assert.equal(f.prompts(), 0);
});

test('a text-only legacy draft receives one durable session id and a lost creation receipt never creates a replacement', async (t) => {
  const f = await fixture(t);
  oldNewDraft(f);
  const source = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  assert.equal(source.sessionId, undefined);
  const sessionId = await f.controller.restoreLegacyDraft(source);
  assert.equal(await f.controller.restoreLegacyDraft(source), sessionId);
  f.fault.after = async (input) => {
    if (input.action === 'execute' && input.command.method === 'session-control')
      throw Error('Synthetic create receipt lost');
  };
  await assert.rejects(f.controller.openLegacyDraft(sessionId), /receipt lost/);
  f.fault.after = undefined;
  const ledger = await f.store.read(f.controller.state.scope!, () => {});
  const original = ledger.operations.find(
    (item) => item.original.kind === 'control' && item.original.value.action === 'create',
  )!;
  assert.equal(original.original.value.sessionId, sessionId);
  await f.controller.refreshCatalog('local');
  assert.equal(
    f.calls.filter(
      (input) => input.action === 'execute' && input.command.method === 'session-control',
    ).length,
    1,
  );
  await f.controller.inspect(original.original.value.operationId);
  await f.controller.openLegacyDraft(sessionId);
  assert.equal(f.controller.state.draft!.text, 'Old new-session draft');
  assert.equal(
    f.calls.filter(
      (input) => input.action === 'execute' && input.command.method === 'session-control',
    ).length,
    1,
  );
  assert.equal(f.prompts(), 0);
});

test('a legacy first instruction is recovered with its exact original and is sent only by an explicit retry', async (t) => {
  const f = await fixture(t);
  const sessionId = 'legacy-first-session';
  const { base, target, agentId } = oldNewDraft(f, 'Later unsent edit', sessionId);
  const agent = { ...f.catalog.targets[0]!.runtime.agents[0]!, runConfig: syntheticCapabilities };
  const meta = {
    id: sessionId,
    userId: target.userId,
    machineId: target.machineId,
    project: { kind: 'local' as const, localProjectId: target.localProjectId },
    agentConfigId: agentId,
    cliType: agent.cliType,
    agentType: agent.agentType,
    isArchived: false,
  };
  const flock = new Flock(),
    doc = new LoroDoc(),
    view = mirror(doc, sessionId);
  view.setState((state) => {
    state.history.push({
      id: 'old-first-user',
      role: 'user',
      userId: target.userId,
      timestamp: '2026-09-14T00:00:00.000Z',
      status: 'pending',
      finished: true,
      inputConfig: {
        prompt: 'Original first instruction',
        cliType: agent.cliType,
        agentType: agent.agentType,
        mcpServerIds: [],
        taskToolsEnabled: false,
      },
      items: [{ type: 'text', text: 'Original first instruction' }],
      fileDiff: null,
    } as never);
  });
  view.dispose();
  doc.commit();
  putMeta(flock, 'session-' + sessionId, {
    ...meta,
    latestUserMsgId: 'old-first-user',
    lastMessageAt: 1,
  });
  const original = {
    operationId: 'old-first-instruction',
    sessionId,
    workspaceId: target.workspaceId,
    kind: 'turn' as const,
    expectedTurnId: null,
    update: delta(doc),
    metaBundle: flock.exportJson(),
  };
  doc.free();
  f.legacy.records.push({ key: base + '/pending', value: original });
  const source = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  assert.deepEqual(source.pending, original);
  assert.deepEqual(source.unresolvedKeys, []);
  const originalRecord = f.legacy.records.find((item) => item.key === base + '/pending')!;
  originalRecord.value = { ...original, workspaceId: 'foreign-workspace' };
  const rejected = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  assert.equal(rejected.pending, undefined);
  assert(rejected.unresolvedKeys.includes(base + '/pending'));
  originalRecord.value = original;
  await f.controller.restoreLegacyDraft(source);
  await assert.rejects(f.controller.openLegacyDraft(sessionId), /首次指令尚未确认/);
  assert.equal(f.prompts(), 0);
  await f.controller.retry(original.operationId);
  await f.started.promise;
  assert.equal(f.prompts(), 1);
  await f.controller.openLegacyDraft(sessionId);
  assert.equal(f.controller.state.draft!.text, 'Later unsent edit');
  const sent = f.calls.find(
    (input) => input.action === 'execute' && input.command.method === 'mutate',
  );
  assert.deepEqual(sent && sent.action === 'execute' && sent.command.params, original);
});

test('unbound legacy new text is not attached to a project merely because that project has reserved attachments', async (t) => {
  const f = await fixture(t),
    sessionId = 'only-attachments';
  const { target, base } = oldNewDraft(f, 'Belongs to another project', sessionId);
  f.legacy.records.find((record) => record.key === base + '/options')!.value = {
    project: 'other-project',
    agent: 'other-agent',
  };
  const item = await createAttachmentDraftItem(
    {
      name: 'synthetic.txt',
      type: 'text/plain',
      size: 5,
      arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
    } as File,
    'scoped-attachment',
  );
  const scope = {
    owner: target.owner,
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
  };
  f.legacy.records.push({
    key: attachmentDraftKey(scope),
    value: { version: 1, scope, items: [item] },
  });
  const recovery = await f.controller.readLegacy(f.catalog.origin);
  const source = recovery.newDraft!;
  assert.equal(recovery.unassignedDraft, 'Belongs to another project');
  assert.equal(source.draft, undefined);
  assert.equal(source.agentId, undefined);
  assert.equal(source.attachments!.items.length, 1);
  await f.controller.restoreLegacyDraft(source);
  await assert.rejects(f.controller.openLegacyDraft(sessionId), /选择.*Agent/);
  await f.controller.openLegacyDraft(sessionId, f.catalog.targets[0]!.runtime.agents[0]!.id);
  assert.equal(f.controller.state.draft!.text, '');
  assert.equal(f.prompts(), 0);
});

test('old Moor snapshots with no document id remain unconfirmed until the host repairs its own persisted document', async (t) => {
  const f = await fixture(t),
    sessionId = await f.create();
  const document = f.runtime.doc(sessionId),
    view = mirror(document, sessionId);
  view.setState((state) => {
    state.session.id = '';
  });
  view.dispose();
  f.runtime.persist(sessionId, document);
  const { base } = oldSession(f);
  const snapshot = f.legacy.records.find((item) => item.key === base + '/session')!;
  (snapshot.value as { snapshot: string }).snapshot = encode(document.export({ mode: 'snapshot' }));
  document.free();
  const recovery = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  assert(recovery);
  await f.controller.restoreLegacy(recovery);
  for (const key of f.memory.values.keys())
    if (key.includes('moor-desktop-session-v1')) f.memory.values.delete(key);
  const cached = await f.store.cachedSession(f.controller.state.scope!, sessionId, () => {});
  assert.equal(cached!.persisted, false);
  const legacy = readLegacyClientSession(legacySessionRead(recovery), {
    ...f.controller.state.scope!.target,
    sessionId,
  });
  assert.equal(legacy.persisted, false);
  assert.throws(
    () =>
      readLegacyClientSession(
        { ...legacy, persisted: true },
        { ...f.controller.state.scope!.target, sessionId },
      ),
    /不能被标为主机已确认/,
  );
  assert.throws(() =>
    buildSessionTurn({
      scope: { ...f.controller.state.scope!.target, sessionId },
      read: legacy,
      agent: f.controller.state.session!.agent!,
      prompt: 'Must not execute from old cache',
      operationId: 'unconfirmed-send',
      turnId: 'unconfirmed-turn',
      peerId: 'unconfirmed-peer',
      now: '2026-09-14T00:00:00.000Z',
    }),
  );
  await f.controller.refreshSession();
  const repaired = f.runtime.doc(sessionId),
    repairedView = mirror(repaired, sessionId);
  assert.equal(repairedView.getState().session.id, sessionId);
  repairedView.dispose();
  repaired.free();
  assert.equal(f.prompts(), 0);
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

test('a cached session cannot hide an unresolved first instruction in the old new-draft namespace', async (t) => {
  const f = await fixture(t),
    sessionId = await f.create();
  oldSession(f);
  const cached = f.legacy.records[0]!;
  const { base } = oldNewDraft(f, 'Later draft', sessionId);
  f.legacy.records.push(cached, { key: base + '/pending', value: { unsupportedOriginal: true } });
  const recovery = await f.controller.readLegacy(f.catalog.origin);
  assert.equal(recovery.sessions[0]!.sessionId, sessionId);
  assert.equal(recovery.newDraft!.sessionId, sessionId);
  assert(recovery.newDraft!.unresolvedKeys.includes(base + '/pending'));
  await assert.rejects(f.controller.send(), /首次请求尚未恢复/);
  assert.equal(f.prompts(), 0);
});

test('legacy directory pagination reads no bodies and selected recovery rejects changed previews or mixed records', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { scope, sessionId, base } = oldSession(f);
  const root = [scope.target.owner, scope.target.deviceId, scope.target.workspaceId, ''].join('/');
  const additional = Array.from({ length: 205 }, (_, i) => ({
    key: root + 'page-' + String(i).padStart(3, '0') + '/session',
    get value(): unknown {
      throw Error('Unselected body must stay unread');
    },
  }));
  f.legacy.records.push(...additional);
  const before = f.calls.length;
  const ids: string[] = [];
  let cursor;
  do {
    const page = await f.controller.legacyIndex(f.catalog.origin, cursor);
    ids.push(...page.sessionIds);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 206);
  assert.equal(new Set(ids).size, 206);
  assert.equal(f.calls.length, before, 'directory reading never contacts the execution host');
  const first = await f.controller.legacyIndex(f.catalog.origin);
  const selection = { kind: 'session' as const, sessionId };
  const preview = await f.controller.readLegacy(f.catalog.origin, selection);
  assert.deepEqual(preview.selection, selection);
  assert.equal(preview.sessions.length, 1);
  assert.equal(preview.sessions[0]!.sessionId, sessionId);
  const draft = f.legacy.records.find((record) => record.key === base + '/draft')!;
  draft.value = 'Edited after preview';
  const next = await f.controller.legacyIndex(f.catalog.origin, first.nextCursor!);
  assert.equal(next.version, first.version, 'body edits do not change the key inventory');
  await assert.rejects(f.controller.restoreLegacy(preview.sessions[0]!), /已改变/);
  const fresh = await f.controller.readLegacy(f.catalog.origin, selection);
  await f.controller.restoreLegacy(fresh.sessions[0]!);
  assert.equal(f.controller.state.draft?.text, 'Edited after preview');
  assert.equal(f.prompts(), 0);
  assert.deepEqual(
    f.legacy.calls.at(-1).selection,
    selection,
    'restore rereads only its selected session',
  );
  f.legacy.records.push({ key: root + 'new-candidate/session', value: null });
  await assert.rejects(f.controller.legacyIndex(f.catalog.origin, first.nextCursor!), /目录已变化/);
  assert.throws(
    () =>
      normalizeLegacyCache({
        ...scope,
        origin: f.catalog.origin,
        selection,
        records: [
          ...f.legacy.records.slice(0, 2),
          { key: root + 'other/draft', value: 'Other text' },
        ],
      }),
    /混入其他会话/,
  );
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

test('legacy project and historical file caches restore atomically and remain readable without the original host', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.project, 'legacy.txt'), 'old bytes');
  const sessionId = await f.create();
  await f.controller.saveDraft('Synthetic file update', {});
  await f.controller.send();
  await f.started.promise;
  const active = f.host.active.get(sessionId)!;
  writeFileSync(join(f.project, 'legacy.txt'), 'new bytes');
  f.completion.resolve();
  await active.done;
  await f.controller.refreshSession();
  const panel = await f.controller.openProjectContent();
  await panel.file('legacy.txt', 9);
  await panel.setMode('changes');
  const change = panel.state!.diff!.result.changes.find((entry) => entry.path === 'legacy.txt')!;
  await panel.diffFile(change);
  const expected = structuredClone(panel.state!.diffFile!.result);
  panel.dispose();
  const { scope } = oldSession(f, 'Preserved legacy text');
  const buckets = [...f.memory.values].filter(([key]) =>
    key.includes('moor-workspace-project-content-v1'),
  );
  assert.equal(buckets.length, 1);
  const entries = (buckets[0]![1] as any).entries.map(({ key, value }: any) => ({ key, value }));
  f.legacy.records.push(...structuredClone(entries));
  for (const [key] of buckets) f.memory.values.delete(key);
  const reviewed = (await f.controller.readLegacy(f.catalog.origin, { kind: 'session', sessionId }))
    .sessions[0]!;
  assert.equal(reviewed.content?.length, entries.length);
  assert.deepEqual(reviewed.unresolvedKeys, []);
  const damaged = structuredClone(reviewed);
  const file = damaged.content!.find((entry) => entry.key.startsWith('file-content-v1/'))!;
  (file.value as any).result.data = Buffer.from('bad bytes').toString('base64');
  const before = structuredClone(f.memory.values);
  await assert.rejects(
    f.store.restoreLegacy(scope, damaged, () => {}),
    /缓存|校验/,
  );
  assert.deepEqual(
    f.memory.values,
    before,
    'bad bytes cannot partially import the text or operation ledger',
  );
  const damagedHistory = structuredClone(reviewed);
  (
    damagedHistory.content!.find((entry) => entry.key.includes('"diff-file"'))!.value as any
  ).after.text = 'bad bytes';
  await assert.rejects(
    f.store.restoreLegacy(scope, damagedHistory, () => {}),
    /校验/,
  );
  assert.deepEqual(f.memory.values, before);
  const foreign = structuredClone(reviewed);
  (
    foreign.content!.find((entry) => entry.key.startsWith('file-content-v1/'))!.value as any
  ).result.sessionId = 'other-session';
  await assert.rejects(
    f.store.restoreLegacy(scope, foreign, () => {}),
    /范围/,
  );
  f.memory.failWrite = true;
  await assert.rejects(f.controller.restoreLegacy(reviewed), /storage failure/);
  f.memory.failWrite = false;
  assert.deepEqual(f.memory.values, before);
  await f.controller.restoreLegacy(reviewed);
  assert.equal(f.controller.state.draft?.text, 'Preserved legacy text');
  assert.equal(f.controller.state.ledger?.legacy?.[0]?.content?.length, entries.length);
  assert.equal(f.legacy.records.length, entries.length + 2, 'original old cache remains intact');
  writeFileSync(join(f.project, 'legacy.txt'), 'latest bytes');
  const fresh = await f.controller.openProjectContent();
  await fresh.file('legacy.txt', 12);
  assert.equal(fresh.state?.currentFile?.text, 'latest bytes');
  fresh.dispose();
  f.fault.unavailable = true;
  await assert.rejects(f.controller.refreshSession());
  const calls = f.calls.length;
  const restored = await f.controller.openProjectContent();
  assert.equal(restored.state?.tree?.source, 'cache');
  await restored.file('legacy.txt', 12);
  assert.equal(
    restored.state?.currentFile?.text,
    'latest bytes',
    'newly read content takes precedence over recovered selectors',
  );
  await restored.setMode('changes');
  await restored.diffFile(change);
  assert.deepEqual(restored.state?.diffFile?.result, expected);
  const search = f.controller.openSearch();
  const results = await search.search('new bytes', 'session');
  assert.equal(results.coverage?.cachedDiffFiles, 1);
  assert(results.hits.length > 0);
  search.close();
  restored.dispose();
  assert.equal(f.calls.length, calls, 'restored cache reading and searching remain fully offline');
  assert.equal(f.prompts(), 1);
});

test('changed legacy source preserves current edits, all metadata originals and confirmed results', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { scope, sessionId, base, read } = oldSession(f, 'First source text');
  const target = scope.target;
  const original = {
    operationId: 'source-rename-one',
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
    action: 'rename' as const,
    title: 'First source name',
    expectedRevision: read.meta.metadataRevision ?? 0,
  };
  const metadata = {
    owner: target.owner,
    deviceId: target.deviceId,
    catalogWorkspaceId: target.catalogWorkspaceId,
    replicaId: target.replicaId,
    request: original,
  };
  f.legacy.records.push({ key: sessionActionKey({ ...target, sessionId }), value: metadata });
  const first = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  await f.controller.restoreLegacy(first);
  await f.controller.saveDraft('Later local edit', {});
  f.legacy.records.find((entry) => entry.key === base + '/draft')!.value = 'Updated source text';
  const secondRequest = {
    ...original,
    operationId: 'source-rename-two',
    title: 'Second source name',
  };
  metadata.request = secondRequest;
  const second = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  const writes = structuredClone(f.memory.values);
  f.memory.failWrite = true;
  await assert.rejects(f.controller.restoreLegacy(second), /storage failure/);
  f.memory.failWrite = false;
  assert.deepEqual(f.memory.values, writes);
  const calls = f.calls.length;
  await f.controller.restoreLegacy(second);
  assert.equal(f.calls.length, calls);
  assert.equal(f.controller.state.draft?.text, 'Later local edit');
  assert.equal(f.controller.state.ledger?.legacy?.[0]?.draft, 'Updated source text');
  assert.deepEqual(f.controller.state.ledger?.legacyRevisions, [first]);
  const originals = f.controller.state.ledger!.operations.filter(
    (entry) => entry.original.kind === 'metadata',
  );
  assert.deepEqual(
    originals.map((entry) => entry.original.value),
    [original, secondRequest],
  );
  await f.controller.restoreLegacy(second);
  assert.equal(f.controller.state.ledger?.legacyRevisions?.length, 1);
  await f.controller.retry(original.operationId);
  assert.equal(
    f.controller.state.ledger?.operations.find(
      (entry) => entry.original.value.operationId === original.operationId,
    )?.status,
    'confirmed',
  );
  f.legacy.records.find((entry) => entry.key === base + '/draft')!.value = 'Third source text';
  const third = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  await f.controller.restoreLegacy(third);
  assert.equal(
    f.controller.state.ledger?.operations.find(
      (entry) => entry.original.value.operationId === original.operationId,
    )?.status,
    'confirmed',
  );
  assert.equal(f.controller.state.draft?.text, 'Later local edit');
  metadata.request = { ...original, title: 'Altered original body' };
  const forged = (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  const before = structuredClone(f.memory.values);
  await assert.rejects(f.controller.restoreLegacy(forged), /同一旧操作编号/);
  assert.deepEqual(f.memory.values, before);
  assert.equal(f.prompts(), 0);
});

test('new-draft source updates retain the reserved session and only replace an untouched imported composer', async (t) => {
  const f = await fixture(t);
  const { base } = oldNewDraft(f, 'First unsent text');
  const first = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  const sessionId = await f.controller.restoreLegacyDraft(first);
  f.legacy.records.find((entry) => entry.key === base + '/draft')!.value = 'Second unsent text';
  const second = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  assert.equal(await f.controller.restoreLegacyDraft(second), sessionId);
  assert.equal(f.controller.state.ledger?.drafts[sessionId]?.text, 'Second unsent text');
  const draft = f.controller.state.ledger!.drafts[sessionId]!;
  await f.store.saveDraft(
    f.controller.state.scope!,
    sessionId,
    draft.revision,
    'Local revised text',
    {},
    () => {},
  );
  f.legacy.records.find((entry) => entry.key === base + '/draft')!.value = 'Third unsent text';
  const third = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  assert.equal(await f.controller.restoreLegacyDraft(third), sessionId);
  assert.equal(f.controller.state.ledger?.drafts[sessionId]?.text, 'Local revised text');
  assert.equal(f.controller.state.ledger?.legacyDrafts?.length, 1);
  assert.equal(f.controller.state.ledger?.legacyRevisions?.length, 2);
  assert.equal(f.prompts(), 0);
  assert.equal(
    f.calls.some((call) => call.action === 'execute' && call.command.method === 'session-control'),
    false,
  );
});

test('a changed legacy pending prompt is queued alongside its original and only an explicit retry dispatches it', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { read, scope, sessionId, base } = oldSession(f, 'Retained source draft');
  const make = (suffix: string) =>
    buildSessionTurn({
      scope: { ...scope.target, sessionId },
      read,
      agent: read.agent!,
      prompt: 'Original prompt ' + suffix,
      operationId: 'changed-source-' + suffix,
      turnId: 'source-turn-' + suffix,
      peerId: 'source-peer-' + suffix,
      now: '2026-09-14T00:00:00.000Z',
    });
  const first = make('one'),
    second = make('two');
  const pending = { key: base + '/pending', value: first };
  f.legacy.records.push(pending);
  await f.controller.restoreLegacy((await f.controller.readLegacy(f.catalog.origin)).sessions[0]!);
  pending.value = second;
  await f.controller.restoreLegacy((await f.controller.readLegacy(f.catalog.origin)).sessions[0]!);
  assert.deepEqual(
    f.controller.state
      .ledger!.operations.filter((entry) => entry.original.kind === 'mutation')
      .map((entry) => entry.original.value),
    [first, second],
  );
  assert.equal(f.prompts(), 0);
  await f.controller.refreshCatalog('local');
  assert.equal(f.prompts(), 0);
  await f.controller.retry(first.operationId);
  await f.started.promise;
  assert.equal(f.prompts(), 1);
  assert.equal(
    f.controller.state.ledger!.operations.find(
      (entry) => entry.original.value.operationId === second.operationId,
    )?.status,
    'pending',
  );
  assert.equal(f.controller.state.draft?.text, 'Retained source draft');
});

test('changed legacy attachments merge additions while retaining local files and exact pending upload identities', async (t) => {
  const f = await fixture(t);
  await f.create();
  const { scope, sessionId } = oldSession(f);
  const target = scope.target;
  const attachmentScope = {
    owner: target.owner,
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId,
  };
  const make = (id: string) =>
    createAttachmentDraftItem(new File([id], id + '.txt', { type: 'text/plain' }), id);
  const first = await make('original-file'),
    added = await make('added-file'),
    local = await make('local-file');
  const upload = (item: typeof first, operationId: string) => ({
    owner: target.owner,
    deviceId: target.deviceId,
    catalogWorkspaceId: target.catalogWorkspaceId,
    replicaId: target.replicaId,
    request: {
      contentVersion: 1 as const,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId,
      operationId,
      action: 'upload' as const,
      attachment: item.reference,
      data: item.data,
    },
  });
  first.pending = upload(first, 'original-upload-one');
  added.pending = upload(added, 'added-upload');
  const source = { version: 1, scope: attachmentScope, items: [first] };
  f.legacy.records.push({ key: attachmentDraftKey(attachmentScope), value: source });
  const read = async () => (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  await f.controller.restoreLegacy(await read());
  const current = f.controller.state.ledger!.attachments![sessionId]!;
  await f.store.saveAttachments(
    scope,
    sessionId,
    current.revision,
    [...current.items, local],
    () => {},
  );
  source.items.push(added);
  const calls = f.calls.length;
  await f.controller.restoreLegacy(await read());
  assert.equal(f.calls.length, calls);
  assert.deepEqual(
    f.controller.state.ledger!.attachments![sessionId]!.items.map(
      (item) => item.reference.attachmentId,
    ),
    ['original-file', 'local-file', 'added-file'],
  );
  first.pending = upload(first, 'original-upload-two');
  const updated = await read();
  const before = structuredClone(f.memory.values);
  await assert.rejects(f.controller.restoreLegacy(updated), /另一份未确认原请求/);
  assert.deepEqual(f.memory.values, before);
  await f.controller.retry('original-upload-one');
  await f.controller.restoreLegacy(updated);
  const originals = f.controller.state.ledger!.operations.filter(
    (entry) => entry.original.kind === 'attachment',
  );
  assert.equal(
    originals.find((entry) => entry.original.value.operationId === 'original-upload-one')?.status,
    'confirmed',
  );
  assert.equal(
    originals.find((entry) => entry.original.value.operationId === 'original-upload-two')?.status,
    'pending',
  );
  const restored = f.controller.state.ledger!.attachments![sessionId]!.items.find(
    (item) => item.reference.attachmentId === first.reference.attachmentId,
  )!;
  assert.equal(restored.uploaded, true);
  assert.equal(restored.pending?.request.operationId, 'original-upload-two');
  delete first.pending;
  first.uploaded = true;
  source.items = [first];
  await f.controller.restoreLegacy(await read());
  assert.equal(
    f.controller.state.ledger!.attachments![sessionId]!.items.length,
    3,
    'source cleanup does not delete current files',
  );
  assert.equal(
    f.controller.state.ledger!.attachments![sessionId]!.items[0]!.pending?.request.operationId,
    'original-upload-two',
    'old cache flags cannot confirm the current original',
  );
  const altered = await createAttachmentDraftItem(
    new File(['changed bytes'], first.reference.name, { type: 'text/plain' }),
    first.reference.attachmentId,
  );
  source.items = [altered];
  const stable = structuredClone(f.memory.values);
  await assert.rejects(f.controller.restoreLegacy(await read()), /同一旧附件编号/);
  assert.deepEqual(f.memory.values, stable);
  assert.equal(f.prompts(), 0);
});

test('changed legacy role originals require the previous outcome and remain manual after incremental recovery', async (t) => {
  const f = await fixture(t);
  const sessionId = await f.create();
  const panel = await f.controller.openRoles();
  await panel.refresh();
  f.fault.after = async (request) => {
    if (request.action === 'execute' && request.command.method === 'roles-action')
      throw Error('Synthetic role receipt lost');
  };
  await assert.rejects(panel.save(syntheticRole), /receipt lost/);
  f.fault.after = undefined;
  const saved = structuredClone(f.controller.state.ledger!.roles![sessionId]!);
  const { scope } = oldSession(f, 'Source text');
  const source = { key: rolesKey(panel.controller.target), value: saved };
  f.legacy.records.push(source);
  f.memory.values.clear();
  await f.controller.reloadDraft();
  const read = async () => (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  await f.controller.restoreLegacy(await read());
  assert(saved.pending?.action === 'save');
  const second = {
    ...saved.pending,
    operationId: 'second-role-source',
    expectedRevision: saved.pending.expectedRevision + 1,
    name: 'Second source role',
  };
  source.value = { ...saved, cacheRevision: saved.cacheRevision + 1, pending: second };
  const updated = await read();
  const before = structuredClone(f.memory.values);
  await assert.rejects(f.controller.restoreLegacy(updated), /另一份未确认原请求/);
  assert.deepEqual(f.memory.values, before);
  const recovered = await f.controller.openRoles();
  await recovered.inspect();
  assert.equal(f.controller.state.ledger!.roles![sessionId]!.pending, undefined);
  const calls = f.calls.length;
  f.memory.failWrite = true;
  await assert.rejects(f.controller.restoreLegacy(updated), /storage failure/);
  f.memory.failWrite = false;
  await f.controller.restoreLegacy(updated);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.controller.state.ledger!.roles![sessionId]!.pending, second);
  const next = await f.controller.openRoles();
  await next.retry();
  await next.refresh();
  assert(next.controller.list!.roles.some((role) => role.name === 'Second source role'));
  assert.equal(f.controller.state.ledger!.roles![sessionId]!.pending, undefined);
  await f.controller.restoreLegacy(updated);
  assert.equal(f.controller.state.ledger!.roles![sessionId]!.pending, undefined);
  assert.equal(f.prompts(), 0);
  assert.equal((await f.store.read(scope, () => {})).legacyRevisions?.length, 1);
});

test('changed legacy attention records retain later draft text and only replace a settled original for the same Actor', async (t) => {
  const f = await attentionWorkspace(t),
    c = f.panel.controller;
  await c.createDraft();
  c.editDraft('Old source attention text');
  await c.saveDraft();
  f.fault.after = async (request) => {
    if (request.action === 'attention' && request.command.kind === 'disposition')
      throw Error('Synthetic attention lost receipt');
  };
  await assert.rejects(c.disposition('checked'), /lost receipt/);
  f.fault.after = undefined;
  const { scope, sessionId } = oldSession(f);
  const bucket = Object.values((await f.store.read(scope, () => {})).attention!)[0]!;
  f.legacy.records.push(
    ...Object.entries(bucket.entries)
      .filter(([key]) => !key.includes('/page/'))
      .map(([key, value]) => ({ key, value: structuredClone(value) })),
  );
  f.panel.close();
  f.memory.values.clear();
  await f.controller.openSession(sessionId);
  const read = async () => (await f.controller.readLegacy(f.catalog.origin)).sessions[0]!;
  await f.controller.restoreLegacy(await read());
  const recovered = await f.controller.openAttention();
  await recovered.controller.open(f.selected);
  recovered.controller.editDraft('Later local attention text');
  await recovered.controller.saveDraft();
  const original = structuredClone(recovered.controller.state.pending!);
  assert.equal(original.operation.kind, 'disposition');
  const pending = f.legacy.records.find((entry) => entry.key === attentionPendingKey(original))!;
  const incoming = structuredClone(original);
  assert(incoming.operation.kind === 'disposition');
  incoming.operation.body.operationId = 'updated-attention-source';
  incoming.operation.body.disposition = 'needs_followup';
  incoming.operation.body.observationRevision =
    recovered.controller.state.detail!.item.observationRevision;
  pending.value = incoming;
  const draftKey = attentionItemKey(original.route, original.sessionId, original.itemId) + '/draft';
  (f.legacy.records.find((entry) => entry.key === draftKey)!.value as any).text =
    'New source attention text';
  const updated = await read();
  const before = structuredClone(f.memory.values);
  await assert.rejects(f.controller.restoreLegacy(updated), /另一份未确认原请求/);
  assert.deepEqual(f.memory.values, before);
  await recovered.controller.retry();
  recovered.close();
  const calls = f.calls.length;
  await f.controller.restoreLegacy(updated);
  assert.equal(f.calls.length, calls);
  const next = await f.controller.openAttention();
  await next.controller.open(f.selected);
  assert.equal(next.controller.state.draft?.text, 'Later local attention text');
  assert.deepEqual(next.controller.state.pending, incoming);
  await next.controller.retry();
  assert.equal(next.controller.state.pending, undefined);
  assert.equal(next.controller.state.detail?.item.disposition, 'needs_followup');
  assert.equal(f.prompts(), 1);
  next.close();
});

test('successive reserved drafts in one old origin keep separate sessions and neither replaces the other', async (t) => {
  const f = await fixture(t);
  oldNewDraft(f, 'First reserved source text', 'old-reserved-one');
  const first = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  assert.equal(await f.controller.restoreLegacyDraft(first), 'old-reserved-one');
  oldNewDraft(f, 'Second reserved source text', 'old-reserved-two');
  const second = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  assert.equal(await f.controller.restoreLegacyDraft(second), 'old-reserved-two');
  assert.equal(f.controller.state.ledger?.legacyDrafts?.length, 2);
  assert.equal(f.controller.state.ledger?.drafts['old-reserved-one']?.text, first.draft);
  assert.equal(f.controller.state.ledger?.drafts['old-reserved-two']?.text, second.draft);
  const calls = f.calls.length;
  await f.controller.restoreLegacyDraft(second);
  assert.equal(f.calls.length, calls);
  await f.controller.openLegacyDraft('old-reserved-one');
  assert.equal(f.controller.state.sessionId, 'old-reserved-one');
  assert.equal(f.controller.state.draft?.text, first.draft);
  await f.controller.openLegacyDraft('old-reserved-two');
  assert.equal(f.controller.state.sessionId, 'old-reserved-two');
  assert.equal(f.controller.state.draft?.text, second.draft);
  assert.equal(f.prompts(), 0);
});

test('an unassigned legacy draft slot cannot be concurrently rebound to another generated session', async (t) => {
  const f = await fixture(t);
  oldNewDraft(f, 'Unassigned original text');
  const source = (await f.controller.readLegacy(f.catalog.origin)).newDraft!;
  const sessionId = await f.controller.restoreLegacyDraft(source);
  const scope = f.controller.state.scope!;
  const before = structuredClone(f.memory.values);
  await assert.rejects(
    f.store.restoreLegacyDraft(scope, source, 'competing-assigned-session', () => {}),
    /另一页面/,
  );
  assert.deepEqual(f.memory.values, before);
  assert.equal(f.controller.state.ledger?.legacyDraftSlots?.[f.catalog.origin], sessionId);
  assert.equal(f.prompts(), 0);
});
