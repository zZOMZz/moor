import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { AppError } from '@moor/protocol/protocol';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import { SESSION_PAGE_FEATURE } from '@moor/protocol/session-page';
import { readSessionPage } from '@moor/host/sessions/page';
import {
  desktopWorkspaceCatalogSchema,
  type DesktopWorkspaceRequest,
} from '@moor/client/workspace-protocol';
import { WorkspaceController } from '../../apps/web/src/features/workspace/workspace-controller';
import { WorkspaceStore } from '../../apps/web/src/features/workspace/workspace-store';
import type { StorageBackend, StorageChange } from '../../apps/web/src/platform/indexed-storage';

export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Memory implements StorageBackend {
  values = new Map<string, unknown>();
  locks = new Map<string, Promise<void>>();
  failDeletion = false;
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async exclusive<T>(key: string, current: () => void, run: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key),
      done = signal();
    this.locks.set(key, done.promise);
    try {
      await prior;
      current();
      return await run();
    } finally {
      done.resolve();
      if (this.locks.get(key) === done.promise) this.locks.delete(key);
    }
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    return this.compareAndSetMany([{ key, expected, value }], current);
  }
  async compareAndSetMany(changes: StorageChange[], current: () => void) {
    current();
    for (const change of changes)
      assert.deepEqual(this.values.get(change.key) ?? null, change.expected);
    const next = new Map(this.values);
    for (const change of changes) {
      if (change.delete === true) next.delete(change.key);
      else next.set(change.key, structuredClone(change.value));
    }
    if (this.failDeletion && changes.some((change) => change.delete))
      throw Error('Synthetic atomic cache failure');
    current();
    this.values = next;
  }
}
export async function paginationFixture(
  t: Pick<TestContext, 'after'>,
  options: { legacy?: boolean } = {},
) {
  const projectIds = ['project-a', 'project-b'];
  const runtime = {
    id: 'runtime',
    name: 'Synthetic',
    userId: 'host-user',
    machineId: 'machine',
    features: options.legacy ? [] : [SESSION_PAGE_FEATURE],
    projects: projectIds.map((id) => ({ id, name: id, rootPath: '/synthetic/' + id })),
    agents: [{ id: 'agent', name: 'Synthetic', cliType: 'fixture', agentType: 'fixture' }],
  };
  const catalog = desktopWorkspaceCatalogSchema.parse({
    source: 'local',
    connectionId: '00000000-0000-4000-8000-000000000001',
    origin: 'http://127.0.0.1:12345',
    owner: 'owner',
    targets: projectIds.map((id) => ({
      target: {
        serverKey: 'local:machine',
        owner: 'owner',
        userId: runtime.userId,
        machineId: runtime.machineId,
        deviceId: 'device',
        workspaceId: runtime.id,
        localProjectId: id,
        catalogWorkspaceId: 'space',
        catalogProjectId: 'logical-' + id,
        replicaId: 'replica-' + id,
      },
      workspaceName: 'Workspace',
      projectName: id,
      hostName: 'Host',
      online: true,
      runtime,
    })),
  });
  const rows: SessionMetadata[] = projectIds.flatMap((project) =>
    Array.from({ length: 100 }, (_, index) => ({
      id: project + '-session-' + String(index).padStart(3, '0'),
      userId: runtime.userId,
      machineId: runtime.machineId,
      project: { kind: 'local' as const, localProjectId: project },
      agentConfigId: 'agent',
      cliType: 'fixture',
      agentType: 'fixture',
      title:
        index === 5 ? 'Needle far session' : index >= 95 ? 'Archived ' + index : 'Task ' + index,
      lastMessageAt: index,
      isArchived: index >= 95,
      isPinned: index % 20 === 0,
      metadataRevision: 0,
    })),
  );
  const calls: DesktopWorkspaceRequest[] = [],
    memory = new Memory(),
    store = new WorkspaceStore(memory);
  const failures = new Map<
    string,
    { code: string; status: number | null; rejected: boolean; message: string }
  >();
  const controls: { after?: (request: DesktopWorkspaceRequest) => Promise<void> } = {};
  const controller = new WorkspaceController({
    store,
    schedule: () => () => {},
    request: async (input) => {
      calls.push(structuredClone(input));
      if (input.action === 'catalog') return { ok: true, value: structuredClone(catalog) };
      if (input.action !== 'execute') throw Error('Only metadata reads are expected');
      const project = input.target.localProjectId;
      if (failures.has(project)) return { ok: false, error: failures.get(project) };
      const entry = catalog.targets.find((entry) => entry.target.localProjectId === project)!;
      try {
        let value;
        if (input.command.method === 'sessions-page')
          value = readSessionPage(
            {
              workspace: entry.runtime,
              list: (id) => rows.filter((item) => item.project.localProjectId === id),
            },
            input.command.params,
            input.command.localProjectId,
          );
        else if (input.command.method === 'sessions')
          value = rows.filter((item) => item.project.localProjectId === project);
        else throw Error('Unexpected execution command: ' + input.command.method);
        await controls.after?.(input);
        return { ok: true, value };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return {
          ok: false,
          error: { code: 'host', status: error.status, rejected: false, message: error.message },
        };
      }
    },
  });
  t.after(() => controller.close());
  await controller.refreshCatalog('local');
  return {
    controller,
    catalog,
    rows,
    calls,
    memory,
    store,
    failures,
    controls,
    listCalls: () =>
      calls.filter(
        (input) =>
          input.action === 'execute' &&
          (input.command.method === 'sessions' || input.command.method === 'sessions-page'),
      ),
  };
}
