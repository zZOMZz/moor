import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { readRunDefaults, readRunPreferences } from '@moor/host/agents/run-preferences';
import {
  changeRunSelection,
  initializeRunSelection,
  resolveRunSelection,
  type RunCapabilities,
} from '@moor/protocol/run-config';

const caps: RunCapabilities = {
  defaultModelId: 'a',
  currentModelId: 'a',
  currentReasoningEffort: 'high',
  sessionKind: 'new',
  effortConfigId: 'effort',
  models: [
    { id: 'a', name: 'A', efforts: ['high', 'low'], defaultEffort: 'high' },
    { id: 'b', name: 'B', efforts: ['medium'], defaultEffort: 'medium' },
  ],
  modes: ['moor-read-only', 'moor-agent', 'moor-auto-review', 'moor-full-access'].map((id) => ({
    id,
    name: id,
  })),
};
test('approval defaults persist through restart, are frozen per new session, and reads never overwrite preferences', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moor-controls-')),
    file = join(root, 'runtime.sqlite');
  const directory = join(root, 'project');
  mkdirSync(directory);
  let store = new RuntimeStore(file),
    host: HostWorkspace;
  const project = store.registerProject(directory);
  store.registerAgent('synthetic', {
    id: 'codex',
    name: 'Synthetic',
    agentType: 'codex',
    cliType: 'builtin',
    machineId: store.workspace.machineId,
    runtimeOverrides: { codexPath: process.execPath },
  });
  let opens = 0;
  const driver = {
    async open() {
      opens++;
      return {
        id: 'synthetic',
        capabilities: caps,
        async prompt() {
          throw Error('unexpected prompt');
        },
        async cancel() {},
        close() {},
      };
    },
  };
  host = new HostWorkspace(
    store,
    driver,
    () => {},
    () => {},
  );
  t.after(() => {
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const agentId = store.workspace.agents[0]!.id;
  const create = (sessionId: string) =>
    host.controlManager.control(
      {
        controlVersion: 1,
        action: 'create',
        operationId: 'create-' + sessionId,
        sessionId,
        agentId,
        workspaceId: store.workspace.id,
        userId: store.workspace.userId,
        machineId: store.workspace.machineId,
        localProjectId: project,
      },
      project,
    );
  await create('first');
  assert.equal((await host.read('first', undefined, project)).meta.initialModeId, 'moor-agent');
  const saved = host.runPreferences(
    { action: 'save', agentId, expectedRevision: 0, modeId: 'moor-auto-review' },
    project,
  );
  assert(saved.preferences);
  assert.equal(saved.preferences.revision, 1);
  assert.throws(
    () =>
      host.runPreferences(
        { action: 'save', agentId, expectedRevision: 0, modeId: 'moor-full-access' },
        project,
      ),
    /默认值已更新/,
  );
  await host.refreshAgentOptions(agentId, project);
  const initialDefaults = host.runPreferences({ action: 'read-defaults', agentId }, project);
  assert(initialDefaults.defaults);
  assert.equal(initialDefaults.defaults.revision, 0);
  const savedDefaults = host.runPreferences(
    {
      action: 'save-defaults',
      agentId,
      expectedRevision: 0,
      selection: { modelId: 'b', reasoningEffort: 'medium' },
    },
    project,
  );
  assert(savedDefaults.defaults);
  assert.equal(savedDefaults.defaults.revision, 1);
  assert.throws(
    () =>
      host.runPreferences(
        {
          action: 'save-defaults',
          agentId,
          expectedRevision: 0,
          selection: { modelId: 'a', reasoningEffort: 'high' },
        },
        project,
      ),
    /默认值已更新/,
  );
  assert.throws(
    () =>
      host.runPreferences(
        {
          action: 'save-defaults',
          agentId,
          expectedRevision: 1,
          selection: { modelId: 'removed-model', reasoningEffort: 'high' },
        },
        project,
      ),
    /模型已不可用/,
  );
  await create('second');
  assert.equal((await host.read('first', undefined, project)).meta.initialModeId, 'moor-agent');
  assert.equal(
    (await host.read('second', undefined, project)).meta.initialModeId,
    'moor-auto-review',
  );
  assert.equal((await host.read('second', undefined, project)).meta.initialModelId, 'b');
  assert.equal(
    (await host.read('second', undefined, project)).meta.initialReasoningEffort,
    'medium',
  );
  host.close();
  store.close();
  store = new RuntimeStore(file);
  host = new HostWorkspace(
    store,
    driver,
    () => {},
    () => {},
  );
  assert.equal(readRunPreferences(store).modeId, 'moor-auto-review');
  assert.deepEqual(readRunDefaults(store, agentId).selection, {
    modelId: 'b',
    reasoningEffort: 'medium',
  });
  await create('third');
  assert.equal(
    (await host.read('third', undefined, project)).meta.initialModeId,
    'moor-auto-review',
  );
  const beforeSessionRefresh = opens;
  await host.refreshAgentOptions(agentId, project, 'first');
  assert.equal(readRunPreferences(store).modeId, 'moor-auto-review');
  await host.refreshAgentOptions(agentId, project, 'second');
  assert.equal(
    opens,
    beforeSessionRefresh + 1,
    'sessions in the same execution directory share the catalog',
  );
  await Promise.all([
    host.refreshAgentOptions(agentId, project, undefined, undefined, true),
    host.refreshAgentOptions(agentId, project, undefined, undefined, true),
  ]);
  assert.equal(opens, beforeSessionRefresh + 2, 'concurrent manual refreshes are coalesced');
  rmSync(directory, { recursive: true });
  assert.equal(
    (await host.read('first', undefined, project)).meta.id,
    'first',
    'history stays readable after project removal',
  );
});
test('model changes use advertised defaults and old permission ids retain their actual semantics', () => {
  assert.deepEqual(
    changeRunSelection({ modelId: 'a', reasoningEffort: 'high' }, 'modelId', 'b', caps),
    { modelId: 'b', reasoningEffort: 'medium' },
  );
  assert.equal(
    changeRunSelection({ reasoningEffort: 'low' }, 'modelId', 'a', caps).reasoningEffort,
    'low',
  );
  assert.deepEqual(initializeRunSelection({}, caps, { fresh: true, initialModeId: 'moor-agent' }), {
    modelId: 'a',
    modeId: 'moor-agent',
    reasoningEffort: 'high',
  });
  assert.deepEqual(
    initializeRunSelection({}, caps, {
      fresh: true,
      initialModeId: 'moor-agent',
      initialModelId: 'b',
      initialReasoningEffort: 'medium',
    }),
    { modelId: 'b', modeId: 'moor-agent', reasoningEffort: 'medium' },
  );
  assert.deepEqual(
    initializeRunSelection(
      { modelId: 'no-effort' },
      { ...caps, models: [...caps.models, { id: 'no-effort', name: 'No effort', efforts: [] }] },
      { fresh: true, initialModelId: 'b', initialReasoningEffort: 'medium' },
    ),
    { modelId: 'no-effort' },
    'a restored model choice never inherits another model’s default effort',
  );
  assert.equal(
    initializeRunSelection({}, caps, { fresh: false, legacyCodex: true }).modelId,
    undefined,
  );
  assert.equal(resolveRunSelection({ modeId: 'read-only' }, caps).modeId, 'moor-agent');
  assert.equal(resolveRunSelection({ modeId: 'agent' }, caps).modeId, 'moor-auto-review');
});
