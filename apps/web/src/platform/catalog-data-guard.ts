import { CollaborationReplica } from '@moor/session/collaboration-replica';
import { collaborationScopeSchema } from '@moor/protocol/collaboration-protocol';
import { productCanonicalJson } from '@moor/protocol/canonical-json';

export type CatalogDataScope = {
  owner: string;
  origin: string;
  deviceId: string;
  workspaceId: string;
  machineId?: string;
  localProjectId?: string;
  replicaId?: string;
  catalogWorkspaceId: string;
  catalogProjectIds: string[];
};
const blocked = () =>
  Error('受影响的项目仍有未发送草稿、附件或待确认操作。请先回到原会话核对；本次没有更改分组。');
const object = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
const nonempty = (value: unknown) =>
  typeof value === 'string'
    ? value.length > 0
    : !!value && typeof value === 'object' && Object.keys(value).length > 0;

/** Recognizes recoverable data, never treats completed history as a new request. */
function catalogRecordHasUnfinished(raw: unknown, kind?: string): boolean {
  const value = object(raw);
  if (!value) return kind === 'draft' && typeof raw === 'string' && raw.length > 0;
  if (kind === 'draft') return typeof value.value?.text === 'string' && value.value.text.length > 0;
  if (kind === 'operation')
    return ['pending', 'ending'].includes(value.value?.status ?? value.value?.state);
  if (kind === 'attachments')
    return Array.isArray(value.value?.items) && value.value.items.length > 0;
  if (
    kind === 'collaboration' &&
    Array.isArray(value.tasks) &&
    value.tasks.some((task: any) => !['completed', 'failed', 'cancelled'].includes(task?.phase))
  )
    return true;
  if (kind && value.kind === kind && 'value' in value)
    return catalogRecordHasUnfinished(value.value);
  if (Array.isArray(value.pending)) {
    if (value.pending.length) return true;
  } else if (value.pending || value.delivery) return true;
  if (
    Array.isArray(value.operations) &&
    value.operations.some((entry: any) =>
      ['pending', 'ending'].includes(entry?.status ?? entry?.state),
    )
  )
    return true;
  if (value.operation && (!value.receipt || value.receipt.phase === 'unknown')) return true;
  if (nonempty(value.steerDraft) || nonempty(value.questionDrafts)) return true;
  if (
    value.drafts &&
    Object.values(value.drafts).some((draft: any) =>
      object(draft) && 'text' in draft ? !!draft.text : true,
    )
  )
    return true;
  if (
    Array.isArray(value.items) &&
    value.items.some((item: any) => item?.reference || item?.pending)
  )
    return true;
  if (Array.isArray(value.annotations) && value.annotations.length) return true;
  for (const key of [
    'attachments',
    'interactions',
    'git',
    'github',
    'githubWrite',
    'forks',
    'tasks',
    'mcp',
    'attention',
    'annotations',
    'previews',
    'roles',
  ])
    if (value[key] && Object.values(value[key]).some((entry) => catalogRecordHasUnfinished(entry)))
      return true;
  if (value.value && catalogRecordHasUnfinished(value.value)) return true;
  if (
    value.entries &&
    Object.entries(value.entries).some(([key, entry]) =>
      key.endsWith('/draft')
        ? nonempty(object(entry)?.text) || nonempty(object(entry)?.insertion)
        : catalogRecordHasUnfinished(entry),
    )
  )
    return true;
  return false;
}
function relevantKey(key: string, scope: CatalogDataScope, database: string): string | undefined {
  if (database === 'moor-runtime-v1') {
    const prefix = `${scope.owner}/${scope.deviceId}/${scope.workspaceId}/`;
    if (key.startsWith(prefix)) {
      if (key.endsWith('/draft')) return 'legacy-draft';
      if (key.endsWith('/pending')) return 'legacy-pending';
      if (key.endsWith('/session-action')) return 'legacy-pending';
      return undefined;
    }
    // Attention drafts use nested JSON scope keys and identify the execution
    // machine rather than a device id. Decode their historical shape exactly.
    if (key.startsWith('[')) {
      try {
        const outer = JSON.parse(key.slice(0, key.lastIndexOf(']') + 1));
        const attention = outer[0] === 'attention-v1' ? outer : JSON.parse(outer[0]);
        const actor = JSON.parse(attention[2]);
        if (
          attention[0] === 'attention-v1' &&
          attention[1] === scope.origin &&
          actor[2] === scope.owner &&
          attention[4] === scope.workspaceId &&
          (!scope.machineId || attention[3] === scope.machineId) &&
          (!scope.localProjectId || attention[5] === scope.localProjectId)
        ) {
          if (key.endsWith('/draft')) return 'legacy-draft';
          if (
            key.endsWith('/pending/' + scope.deviceId) ||
            key.endsWith('/seen-pending/' + scope.deviceId)
          )
            return 'legacy-pending';
        }
      } catch {
        /* Other legacy feature keys have their own shape below. */
      }
    }
    if (
      key.includes(JSON.stringify(scope.owner)) &&
      key.includes(JSON.stringify(scope.deviceId)) &&
      key.includes(JSON.stringify(scope.workspaceId)) &&
      (!scope.localProjectId || key.includes(JSON.stringify(scope.localProjectId))) &&
      !key.startsWith('project-content-')
    )
      return key.endsWith('/draft') ? 'legacy-draft' : 'legacy-record';
    return undefined;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  if (database === 'moor-collaboration-v1') {
    if (parsed[0] !== 'moor-collaboration-v1' || parsed[2]?.actor?.accountId !== scope.owner)
      return undefined;
    const target = JSON.parse(parsed[1]);
    return target[1] === scope.catalogWorkspaceId && scope.catalogProjectIds.includes(target[2])
      ? 'collaboration'
      : undefined;
  }
  const target = parsed[1]?.target;
  if (
    parsed[1]?.source !== 'remote' ||
    target?.owner !== scope.owner ||
    target.serverKey !== scope.origin ||
    target.deviceId !== scope.deviceId ||
    target.workspaceId !== scope.workspaceId ||
    (scope.replicaId && target.replicaId !== scope.replicaId) ||
    (scope.localProjectId && target.localProjectId !== scope.localProjectId)
  )
    return undefined;
  if (parsed[0] === 'moor-desktop-ledger-v1') return 'ledger';
  if (parsed[0] === 'moor-desktop-draft-v1') return 'draft';
  if (
    parsed[0] === 'moor-desktop-record-v2' &&
    !['attachment-blob', 'confirmed-draft', 'operation'].includes(parsed[2])
  )
    return parsed[2];
  return undefined;
}
async function inspectDatabase(database: string, scope: CatalogDataScope) {
  if (
    typeof indexedDB.databases === 'function' &&
    !(await indexedDB.databases()).some((entry) => entry.name === database)
  )
    return;
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open(database);
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction?.abort();
    };
    request.onerror = () =>
      absent ? resolve(null) : reject(Error('本机记录无法核对，尚未更改分组。'));
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(Error('本机记录正由另一页面使用，尚未更改分组。'));
  });
  if (!db) return;
  try {
    const name = database === 'moor-runtime-v1' ? 'cache' : 'state';
    if (!db.objectStoreNames.contains(name)) throw Error('本机记录格式不可验证，尚未更改分组。');
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(name, 'readonly'),
        store = transaction.objectStore(name),
        request = store.openKeyCursor();
      let failure: unknown,
        count = 0,
        bytes = 0;
      const abort = (error: unknown) => {
        failure = error;
        transaction.abort();
      };
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          if (++count > 100000) throw Error('本机记录数量超出本次核对预算，尚未更改分组。');
          const kind =
            typeof cursor.key === 'string' ? relevantKey(cursor.key, scope, database) : undefined;
          if (!kind) {
            cursor.continue();
            return;
          }
          const read = store.get(cursor.key);
          read.onsuccess = () => {
            try {
              const value = read.result;
              if (
                database === 'moor-desktop-workspace-v1' &&
                productCanonicalJson(value?.scope) !==
                  productCanonicalJson(JSON.parse(String(cursor.key))[1])
              )
                throw Error('本机记录身份不可验证，尚未更改分组。');
              bytes += new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;
              if (bytes > 16 * 1024 * 1024)
                throw Error('本机未完成记录超出本次核对预算，尚未更改分组。');
              if (
                kind === 'legacy-draft'
                  ? nonempty(value)
                  : kind === 'legacy-pending'
                    ? value != null
                    : catalogRecordHasUnfinished(value, kind)
              )
                throw blocked();
              if (kind === 'collaboration' && value?.snapshot) {
                const replica = new CollaborationReplica(
                  collaborationScopeSchema.parse(value.scope),
                  value.snapshot,
                );
                try {
                  if (
                    replica
                      .view()
                      .tasks.some(
                        (task) => !['completed', 'failed', 'cancelled'].includes(task.phase),
                      )
                  )
                    throw blocked();
                } finally {
                  replica.close();
                }
              }
              cursor.continue();
            } catch (error) {
              abort(error);
            }
          };
        } catch (error) {
          abort(error);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(failure ?? Error('本机记录核对失败，尚未更改分组。'));
    });
  } finally {
    db.close();
  }
}
export async function assertCatalogDataSettled(scope: CatalogDataScope) {
  await inspectDatabase('moor-desktop-workspace-v1', scope);
  if (location.origin === scope.origin) {
    await inspectDatabase('moor-runtime-v1', scope);
    await inspectDatabase('moor-collaboration-v1', scope);
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      if (!key.startsWith('["moor-collaboration-composer",')) continue;
      const [_, origin, actor, target] = JSON.parse(key);
      if (
        origin === scope.origin &&
        actor?.accountId === scope.owner &&
        target?.workspaceId === scope.catalogWorkspaceId &&
        scope.catalogProjectIds.includes(target.projectId)
      ) {
        const draft = JSON.parse(localStorage.getItem(key) ?? '{}');
        if (draft.text) throw blocked();
      }
    }
  }
}
