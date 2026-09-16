import { runPreferencesSchema, type RunPreferences } from '@moor/protocol/agent-controls';
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
