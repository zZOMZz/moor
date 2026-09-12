import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSettings } from '../src/runtime/agent-settings';
import { RuntimeStore } from '../src/runtime/store';
import type { AgentDriver, AgentSession } from '../src/runtime/agent';
import { AppError } from '../src/protocol';

const caps = { models: [{ id: 'synthetic', name: 'Synthetic', efforts: [] }], modes: [] };
function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext, open?: AgentDriver['open']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-agent-settings-'))),
    file = join(root, 'runtime.sqlite'),
    command = join(root, 'synthetic-acp');
  writeFileSync(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const store = new RuntimeStore(file);
  let opens = 0,
    changes = 0;
  const service = new AgentSettings(
    store,
    {
      open: async (...args) => {
        opens++;
        if (open) return open(...args);
        throw new Error('Must not open');
      },
    },
    () => {
      changes++;
    },
  );
  t.after(() => {
    service.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const save = (extra = {}) => ({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic',
    command,
    args: ['--literal', '$(not-executed)'],
    ...extra,
  });
  return { root, file, command, store, service, save, counts: () => ({ opens, changes }) };
}
const conflict = (e: unknown) => e instanceof AppError && e.status === 409;

test('local Agent settings save disabled without execution and edits preserve old session snapshots across restart', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.service.read(), { revision: 0, presets: [] });
  const first = await f.service.handle(f.save()),
    preset = first.presets[0];
  assert.equal(preset.enabled, false);
  assert.equal(f.store.machine.get(['disabledAgent', preset.versionId]), true);
  const scope = {
    workspaceId: f.store.workspace.id,
    userId: f.store.workspace.userId,
    machineId: f.store.workspace.machineId,
    localProjectId: 'project',
    sessionId: 'session',
  };
  const original = f.store.agents.bind(scope, f.store.agents.get(preset.versionId)!);
  const enabled = await f.service.handle({
    action: 'enabled',
    expectedRevision: 1,
    id: preset.id,
    enabled: true,
  });
  assert.equal(enabled.presets[0].enabled, true);
  const edited = await f.service.handle(
    f.save({ expectedRevision: 2, id: preset.id, args: ['--new'], enabled: true }),
  );
  assert.notEqual(edited.presets[0].versionId, preset.versionId);
  assert.deepEqual(f.store.agents.binding(scope), original);
  assert.equal(f.store.machine.get(['retiredAgent', preset.versionId]), true);
  await assert.rejects(f.service.handle(f.save()), conflict);
  assert.equal(f.counts().opens, 0);
  const reopened = new RuntimeStore(f.file);
  try {
    assert.deepEqual(
      new AgentSettings(reopened, {
        open: async () => {
          throw new Error('Must not open');
        },
      }).read(),
      edited,
    );
  } finally {
    reopened.close();
  }
});

test('Agent settings transactions roll back preset pointers, enable flags, revision and new versions together', async (t) => {
  const f = fixture(t),
    saved = await f.service.handle(f.save()),
    originalMachine = f.store.machine;
  const rows = f.store.journal.db.prepare('SELECT * FROM session_agent_version').all();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_agent_settings BEFORE INSERT ON runtime_state WHEN NEW.key='agent-settings-v1' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await assert.rejects(
    f.service.handle(f.save({ expectedRevision: 1, id: saved.presets[0].id, args: ['--changed'] })),
    /synthetic failure/,
  );
  assert.equal(f.store.machine, originalMachine);
  assert.deepEqual(f.service.read(), saved);
  assert.deepEqual(f.store.journal.db.prepare('SELECT * FROM session_agent_version').all(), rows);
  await assert.rejects(
    f.service.handle({
      action: 'enabled',
      expectedRevision: 1,
      id: saved.presets[0].id,
      enabled: true,
    }),
    /synthetic failure/,
  );
  assert.equal(f.store.machine, originalMachine);
  assert.deepEqual(f.service.read(), saved);
  assert.equal(f.counts().changes, 1);
});

test('strict private Agent actions reject shell strings, symlinks, directories, nonexecutables, oversize requests and identity changes', async (t) => {
  const f = fixture(t),
    link = join(f.root, 'link'),
    plain = join(f.root, 'plain'),
    directory = join(f.root, 'directory');
  symlinkSync(f.command, link);
  writeFileSync(plain, 'synthetic', { mode: 0o600 });
  mkdirSync(directory);
  for (const action of [
    f.save({ command: 'relative' }),
    f.save({ command: link }),
    f.save({ command: directory }),
    f.save({ command: plain }),
    f.save({ shell: true }),
    f.save({ args: ['\0'] }),
    f.save({ args: Array(17).fill('x'.repeat(4096)) }),
    { action: 'read', command: f.command },
  ])
    await assert.rejects(
      f.service.handle(action),
      (e: unknown) => e instanceof AppError && e.status === 400,
    );
  assert.deepEqual(f.service.read(), { revision: 0, presets: [] });
  assert.equal(f.counts().opens, 0);
  await f.service.handle(f.save());
  f.store.workspace.userId = 'other-owner';
  assert.throws(() => f.service.read(), conflict);
  const another = new AgentSettings(f.store, {
    open: async () => {
      throw new Error('Must not open');
    },
  });
  assert.throws(() => another.read(), conflict);
});

test('an explicit capability check opens once in an empty disposable cwd, denies approvals, never prompts or resumes, and stores only validated capability fields', async (t) => {
  let cwd = '',
    closes = 0,
    prompts = 0;
  const f = fixture(t, async (config, directory, nativeId, callbacks) => {
    cwd = directory;
    assert.equal(nativeId, undefined);
    assert.deepEqual(readdirSync(directory), []);
    assert.equal(config.customAcp?.command, f.command);
    assert.deepEqual(await callbacks.permission({ private: 'synthetic' }), {
      outcome: { outcome: 'cancelled' },
    });
    callbacks.update({ private: 'SYNTHETIC_RAW_BODY' });
    return {
      id: 'SYNTHETIC_NATIVE_PRIVATE',
      capabilities: { ...caps, private: 'SYNTHETIC_RAW_CAP' } as any,
      inputCapabilities: { image: true, audio: false, embeddedContext: true },
      prompt: async () => {
        prompts++;
      },
      cancel: async () => {},
      close: () => {
        closes++;
      },
    };
  });
  const saved = await f.service.handle(f.save()),
    preset = saved.presets[0];
  const result = await f.service.handle({
    action: 'check',
    expectedRevision: 1,
    id: preset.id,
    versionId: preset.versionId,
  });
  assert.equal(result.revision, 2);
  assert.equal(result.presets[0].checked?.ok, true);
  assert.deepEqual(result.presets[0].checked?.runConfig, caps);
  assert.equal(result.presets[0].enabled, false);
  assert.equal(f.counts().opens, 1);
  assert.equal(closes, 1);
  assert.equal(prompts, 0);
  assert.equal(existsSync(cwd), false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_RAW|SYNTHETIC_NATIVE/);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM session').get()?.n, 0);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM agent_session').get()?.n, 0);
});

test('a later successful check without input capabilities clears the previous capability observation', async (t) => {
  let reportInputs = true;
  const f = fixture(t, async () => ({
    id: 'synthetic',
    capabilities: caps,
    inputCapabilities: reportInputs
      ? { image: true, audio: false, embeddedContext: true }
      : undefined,
    prompt: async () => {},
    cancel: async () => {},
    close: () => {},
  }));
  let state = await f.service.handle(f.save());
  const { id, versionId } = state.presets[0];
  state = await f.service.handle({
    action: 'check',
    expectedRevision: state.revision,
    id,
    versionId,
  });
  assert.equal(state.presets[0].inputCapabilities?.image, true);
  reportInputs = false;
  state = await f.service.handle({
    action: 'check',
    expectedRevision: state.revision,
    id,
    versionId,
  });
  assert.equal(state.presets[0].checked?.ok, true);
  assert.equal(state.presets[0].checked?.inputCapabilities, undefined);
  assert.equal(state.presets[0].inputCapabilities, undefined);
  assert.equal(f.store.machine.get(['inputCapabilities', versionId]), null);
});

test('failed or malformed capability checks expose fixed errors and always close returned sessions', async (t) => {
  let mode = 'throw',
    closes = 0;
  const f = fixture(t, async () => {
    if (mode === 'throw') throw new Error('/synthetic/private/path SYNTHETIC_SECRET');
    return {
      id: 'private',
      capabilities: mode === 'invalid' ? { models: 'wrong' } : caps,
      close: () => {
        closes++;
        if (mode === 'close') throw new Error('SYNTHETIC_SECRET');
      },
      prompt: async () => {},
      cancel: async () => {},
    } as AgentSession;
  });
  let saved = await f.service.handle(f.save());
  for (mode of ['throw', 'invalid', 'close']) {
    saved = await f.service.handle({
      action: 'check',
      expectedRevision: saved.revision,
      id: saved.presets[0].id,
      versionId: saved.presets[0].versionId,
    });
    assert.equal(saved.presets[0].checked?.ok, false);
    assert.match(saved.presets[0].checked?.error ?? '', /检查未完成/);
    assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC_SECRET|private\/path/);
  }
  assert.equal(closes, 2);
});

test('a settings edit while a check awaits close invalidates its late result and cannot revive a removed preset', async (t) => {
  const closing = signal(),
    release = signal();
  let closes = 0;
  const f = fixture(t, async () => ({
    id: 'private',
    capabilities: caps,
    prompt: async () => {},
    cancel: async () => {},
    close: async () => {
      closes++;
      closing.resolve();
      await release.promise;
    },
  }));
  const saved = await f.service.handle(f.save()),
    preset = saved.presets[0];
  const pending = f.service.handle({
    action: 'check',
    expectedRevision: 1,
    id: preset.id,
    versionId: preset.versionId,
  });
  await closing.promise;
  await assert.rejects(
    f.service.handle({
      action: 'check',
      expectedRevision: 1,
      id: preset.id,
      versionId: preset.versionId,
    }),
    /正在检查/,
  );
  const removed = await f.service.handle({ action: 'remove', expectedRevision: 1, id: preset.id });
  release.resolve();
  await assert.rejects(pending, conflict);
  assert.deepEqual(f.service.read(), removed);
  assert.equal(removed.presets.length, 0);
  assert.equal(f.store.machine.get(['disabledAgent', preset.versionId]), true);
  assert.equal(closes, 1);
  assert.equal(f.service.wasConfigured(preset.id), true);
});

test('shutdown or identity changes during open close the late session without publishing capabilities', async (t) => {
  for (const reason of ['close', 'identity']) {
    const opened = signal(),
      release = signal();
    let closes = 0,
      cwd = '';
    const f = fixture(t, async (_config, directory) => {
      cwd = directory;
      opened.resolve();
      await release.promise;
      return {
        id: 'private',
        capabilities: caps,
        prompt: async () => {},
        cancel: async () => {},
        close: () => {
          closes++;
        },
      };
    });
    const saved = await f.service.handle(f.save()),
      preset = saved.presets[0];
    const pending = f.service.handle({
      action: 'check',
      expectedRevision: 1,
      id: preset.id,
      versionId: preset.versionId,
    });
    await opened.promise;
    if (reason === 'close') f.service.close();
    else f.store.workspace.machineId = 'other-machine';
    release.resolve();
    await assert.rejects(pending, conflict);
    assert.equal(closes, 1);
    assert.equal(existsSync(cwd), false);
    assert.equal(f.store.machine.get(['capabilities', preset.versionId]), undefined);
  }
});

test('builtin registration is explicit, starts disabled, cannot be edited as custom, and removal remains a startup tombstone', async (t) => {
  const f = fixture(t);
  const saved = await f.service.handle({
    action: 'builtin',
    expectedRevision: 0,
    agentType: 'claude',
  });
  const preset = saved.presets[0];
  assert.equal(preset.id, 'personal-claude');
  assert.equal(preset.enabled, false);
  assert.equal(preset.command, undefined);
  assert.equal(f.service.wasConfigured(preset.id), true);
  await assert.rejects(
    f.service.handle({ action: 'builtin', expectedRevision: 1, agentType: 'claude' }),
    /已登记/,
  );
  await assert.rejects(f.service.handle(f.save({ expectedRevision: 1, id: preset.id })), /内置/);
  await f.service.handle({ action: 'remove', expectedRevision: 1, id: preset.id });
  assert.equal(f.service.wasConfigured(preset.id), true);
  const restored = await f.service.handle({
    action: 'builtin',
    expectedRevision: 2,
    agentType: 'claude',
  });
  assert.equal(restored.presets[0].enabled, false);
  assert.equal(restored.presets[0].versionId, preset.versionId);
  assert.equal(f.store.machine.get(['retiredAgent', preset.versionId]), false);
  assert.equal(f.counts().opens, 0);
});

test('legacy Agent configs without preset pointers remain manageable and shared version aliases combine their enable state', async (t) => {
  const f = fixture(t),
    config = {
      id: 'legacy',
      name: 'Legacy synthetic',
      machineId: f.store.workspace.machineId,
      cliType: 'custom',
      agentType: 'synthetic',
      customAcp: { command: f.command, args: [] },
    };
  f.store.machine.set(['agentConfig', config.id], config);
  f.store.saveMachine();
  const listed = f.service.read();
  assert.equal(listed.presets[0].id, config.id);
  assert.equal(f.store.machine.get(['agentPreset', config.id]), undefined);
  const disabled = await f.service.handle({
    action: 'enabled',
    expectedRevision: 0,
    id: config.id,
    enabled: false,
  });
  assert.equal(disabled.presets[0].versionId, config.id);
  assert.equal(f.store.machine.get(['agentPreset', config.id]), config.id);
  f.store.registerAgent('alias', config);
  await f.service.handle({ action: 'enabled', expectedRevision: 1, id: 'alias', enabled: true });
  assert.equal(f.store.machine.get(['disabledAgent', config.id]), false);
  await f.service.handle({ action: 'remove', expectedRevision: 2, id: config.id });
  assert.equal(f.store.machine.get(['retiredAgent', config.id]), false);
  assert.equal(f.store.machine.get(['disabledAgent', config.id]), false);
  await f.service.handle({ action: 'remove', expectedRevision: 3, id: 'alias' });
  assert.equal(f.store.machine.get(['retiredAgent', config.id]), true);
  assert.equal(f.store.machine.get(['disabledAgent', config.id]), true);
  assert.equal(f.service.read().presets.length, 0);
  assert.equal(f.counts().opens, 0);
});
