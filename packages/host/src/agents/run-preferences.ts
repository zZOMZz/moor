import {
  runDefaultsSchema,
  runPreferencesSchema,
  type RunDefaults,
  type RunPreferences,
} from '@moor/protocol/agent-controls';
import type { ApprovalMode } from '@moor/protocol/run-config';
import { assert } from '@moor/protocol/protocol';
import type { RuntimeStore } from '../persistence/store';

export function readRunPreferences(store: RuntimeStore): RunPreferences {
  const raw = store.load('run-preferences-v1/' + store.workspace.userId);
  return raw
    ? runPreferencesSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')))
    : { version: 1, revision: 0, modeId: 'moor-agent' };
}
export function saveRunPreferences(
  store: RuntimeStore,
  expectedRevision: number,
  modeId: ApprovalMode,
): RunPreferences {
  return store.transaction(() => {
    const current = readRunPreferences(store);
    assert(current.revision === expectedRevision, 409, '审批默认值已更新，请重新读取后再修改');
    const next = runPreferencesSchema.parse({ ...current, revision: current.revision + 1, modeId });
    store.save('run-preferences-v1/' + store.workspace.userId, Buffer.from(JSON.stringify(next)));
    return next;
  });
}

const defaultsKey = (store: RuntimeStore, agentId: string) =>
  `run-defaults-v1/${store.workspace.userId}/${agentId}`;

export function readRunDefaults(store: RuntimeStore, agentId: string): RunDefaults {
  const raw = store.load(defaultsKey(store, agentId));
  return raw
    ? runDefaultsSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')))
    : { version: 1, revision: 0 };
}

export function saveRunDefaults(
  store: RuntimeStore,
  agentId: string,
  expectedRevision: number,
  selection: NonNullable<RunDefaults['selection']>,
): RunDefaults {
  return store.transaction(() => {
    const current = readRunDefaults(store, agentId);
    assert(current.revision === expectedRevision, 409, '运行默认值已更新，请重新读取后再修改');
    const next = runDefaultsSchema.parse({
      version: 1,
      revision: current.revision + 1,
      selection,
    });
    store.save(defaultsKey(store, agentId), Buffer.from(JSON.stringify(next)));
    return next;
  });
}
