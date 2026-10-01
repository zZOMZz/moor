import {
  runDefaultsSchema,
  runPreferencesSchema,
  type RunDefaults,
  type RunPreferences,
} from '@moor/protocol/agent-controls';
import { readUtf8, utf8 } from '@moor/protocol/binary';
import { assert } from '@moor/protocol/protocol';
import type { ApprovalMode } from '@moor/protocol/run-config';
import type { WorkspacePersistence } from '../persistence/workspace';

export function readRunPreferences(store: WorkspacePersistence): RunPreferences {
  const raw = store.load('run-preferences-v1/' + store.workspace.userId);
  return raw
    ? runPreferencesSchema.parse(JSON.parse(readUtf8(raw)))
    : { version: 1, revision: 0, modeId: 'moor-agent' };
}
export function saveRunPreferences(
  store: WorkspacePersistence,
  expectedRevision: number,
  modeId: ApprovalMode,
): RunPreferences {
  return store.transaction(() => {
    const current = readRunPreferences(store);
    assert(current.revision === expectedRevision, 409, '审批默认值已更新，请重新读取后再修改');
    const next = runPreferencesSchema.parse({ ...current, revision: current.revision + 1, modeId });
    store.save('run-preferences-v1/' + store.workspace.userId, utf8(JSON.stringify(next)));
    return next;
  });
}

const defaultsKey = (store: WorkspacePersistence, agentId: string) =>
  `run-defaults-v1/${store.workspace.userId}/${agentId}`;

export function readRunDefaults(store: WorkspacePersistence, agentId: string): RunDefaults {
  const raw = store.load(defaultsKey(store, agentId));
  return raw ? runDefaultsSchema.parse(JSON.parse(readUtf8(raw))) : { version: 1, revision: 0 };
}

export function saveRunDefaults(
  store: WorkspacePersistence,
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
    store.save(defaultsKey(store, agentId), utf8(JSON.stringify(next)));
    return next;
  });
}
