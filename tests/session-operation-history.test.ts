import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { HostProductCatalog } from '../src/bridge/host-product-catalog';
import { HostCommandDispatcher, type HostCommand } from '../src/bridge/host-command';
import { buildSessionTurn } from '../src/session-client';
import type { SessionOriginalOperation } from '../src/session-control-protocol';
import { productCanonicalJson } from '../src/security/encrypted-product-catalog';
import {
  sessionOperationSchema,
  validateSessionOperationResult,
} from '../src/session-control-protocol';
import { validateHostResponse } from '../src/host-response';
import type { EncryptedProductTarget } from '../src/security/encrypted-product-catalog';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-session-history-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const database = join(root, 'host.sqlite');
  let runtime = new RuntimeStore(database),
    host: HostWorkspace,
    products: HostProductCatalog,
    dispatcher: HostCommandDispatcher;
  const projectId = runtime.registerProject(project),
    authority = {
      serverOrigin: 'https://relay.synthetic.invalid',
      accountId: 'owner',
      rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
      hostDeviceId: 'host',
    };
  runtime.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/not-executed', args: [] },
  });
  let opens = 0;
  const open = () => {
    host = new HostWorkspace(
      runtime,
      {
        open: async () => {
          opens++;
          throw Error('Recovery never opens an Agent');
        },
      },
      () => {},
      () => {},
    );
    products = new HostProductCatalog({
      db: runtime.journal.db,
      authority,
      runtime: () => ({
        catalogVersion: 1,
        machineId: host.workspace.machineId,
        workspaces: [host.workspace],
      }),
    });
    dispatcher = new HostCommandDispatcher({
      ready: () => !host.closed,
      workspace: (id) => (id === host.workspace.id ? host : undefined),
      hasOperation: (id) => runtime.journal.has(id),
    });
  };
  open();
  const scope = {
    workspaceId: runtime.workspace.id,
    localProjectId: projectId,
    sessionId: 'synthetic-session',
    userId: runtime.workspace.userId,
    machineId: runtime.workspace.machineId,
    controlVersion: 1 as const,
  };
  t.after(() => {
    host.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const selected = (): EncryptedProductTarget => {
    const replica = products.read().replicas[0]!;
    return {
      catalogWorkspaceId: replica.catalogWorkspaceId,
      replicaId: replica.id,
      projectId: replica.projectId,
      revision: replica.revision,
    };
  };
  const command = (original: SessionOriginalOperation): HostCommand =>
    ({
      method: {
        control: 'session-control',
        mutation: 'mutate',
        metadata: 'session-action',
        attachment: 'attachment-action',
      }[original.kind],
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
      params: original.value,
    }) as HostCommand;
  const recovery = (
    original: SessionOriginalOperation,
    action: 'inspect' | 'abandon',
  ): HostCommand & { method: 'session-operations' } => ({
    method: 'session-operations',
    workspaceId: scope.workspaceId,
    localProjectId: scope.localProjectId,
    params: sessionOperationSchema.parse({ ...scope, action, request: original }),
  });
  const execute = async (target: EncryptedProductTarget, command: HostCommand) => {
    const lease = products.acquire(target, command);
    try {
      products.bindOperation(target, command);
      const raw = await dispatcher.execute(command, { current: () => lease.current() });
      return await validateHostResponse(raw, {
        command,
        workspace: host.workspace,
        current: () => lease.current(),
      });
    } finally {
      lease.release();
    }
  };
  const move = () => {
    products.action({
      version: 1,
      action: 'create-workspace',
      operationId: 'create-space',
      expectedRevision: products.read().revision,
      id: 'other-space',
      name: 'Other',
    });
    products.action({
      version: 1,
      action: 'move-host',
      operationId: 'move-host',
      expectedRevision: products.read().revision,
      runtimeWorkspaceId: scope.workspaceId,
      targetWorkspaceId: 'other-space',
    });
  };
  return {
    scope,
    get opens() {
      return opens;
    },
    selected,
    command,
    recovery,
    execute,
    move,
    get runtime() {
      return runtime;
    },
    get host() {
      return host;
    },
    get products() {
      return products;
    },
    reopen() {
      host.close();
      runtime.close();
      runtime = new RuntimeStore(database);
      open();
    },
  };
}

async function original(
  f: ReturnType<typeof fixture>,
  kind: 'control' | 'mutation' | 'metadata',
): Promise<SessionOriginalOperation> {
  const create = {
    ...f.scope,
    action: 'create' as const,
    operationId: 'create',
    agentId: 'agent',
    title: 'Synthetic',
  };
  if (kind === 'control') return { kind, value: create };
  await f.host.controlManager.control(create, f.scope.localProjectId);
  if (kind === 'metadata')
    return {
      kind,
      value: {
        workspaceId: f.scope.workspaceId,
        localProjectId: f.scope.localProjectId,
        sessionId: f.scope.sessionId,
        operationId: 'metadata',
        action: 'rename',
        title: 'Renamed synthetic',
        expectedRevision: 0,
      },
    };
  return {
    kind,
    value: buildSessionTurn({
      scope: f.scope,
      read: await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId),
      agent: f.host.workspace.agents[0]!,
      prompt: 'Synthetic skill snapshot and ordinary turn',
      operationId: 'turn',
      turnId: 'user',
      peerId: 'abcd1234',
      now: '2026-01-02T00:00:00.000Z',
    }),
  };
}

for (const kind of ['control', 'mutation', 'metadata'] as const) {
  test(`a never-arrived ${kind} can be inspected and sealed after mapping move and cold restart, but never executed on another mapping`, async (t) => {
    const f = fixture(t),
      selected = f.selected(),
      request = await original(f, kind);
    assert.equal(f.runtime.journal.has(request.value.operationId), false);
    assert.equal(
      f.runtime.journal.db
        .prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation')
        .get()!.count,
      0,
    );
    f.move();
    f.reopen();
    await assert.rejects(f.execute(selected, f.command(request)));
    const inspection = f.recovery(request, 'inspect');
    const inspected = validateSessionOperationResult(
      await f.execute(selected, inspection),
      inspection.params,
    );
    assert.equal(inspected.found, false);
    assert.equal(
      f.runtime.journal.db
        .prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation')
        .get()!.count,
      0,
    );
    const seal = f.recovery(request, 'abandon');
    const sealed = validateSessionOperationResult(await f.execute(selected, seal), seal.params);
    assert.equal(sealed.found && sealed.receipt.status, 'abandoned');
    f.reopen();
    assert.deepEqual(await f.execute(selected, inspection), { ...sealed, action: 'inspect' });
    for (const target of [selected, f.selected()])
      await assert.rejects(f.execute(target, f.command(request)));
    const late =
      request.kind === 'control'
        ? await f.host.controlManager.control(request.value, f.scope.localProjectId)
        : request.kind === 'mutation'
          ? await f.host.mutate(request.value, f.scope.localProjectId)
          : request.kind === 'metadata'
            ? await f.host.sessionAction(request.value, f.scope.localProjectId)
            : undefined;
    assert.ok(late && ('status' in late ? late.status === 'abandoned' : late.abandoned === true));
    assert.equal(f.opens, 0);
    if (kind === 'control') assert.equal(f.host.list(f.scope.localProjectId).length, 0);
  });
}

test('old ordinary turns cannot borrow absent Host mapping evidence, changed generations or a conflicting original claim', async (t) => {
  for (const invalid of ['missing', 'generation', 'conflict'] as const) {
    const f = fixture(t),
      selected = f.selected(),
      request = await original(f, 'mutation');
    f.move();
    if (invalid === 'missing')
      f.runtime.journal.db
        .prepare('DELETE FROM encrypted_product_mapping WHERE target=?')
        .run(productCanonicalJson(selected));
    else if (invalid === 'generation') {
      const project = f.host.workspace.projects.pop()!;
      f.products.synchronize();
      f.host.workspace.projects.push(project);
      f.products.synchronize();
    } else f.products.bindOperation(f.selected(), f.command(request));
    if (invalid !== 'generation') f.reopen();
    for (const action of ['inspect', 'abandon'] as const)
      await assert.rejects(f.execute(selected, f.recovery(request, action)));
    assert.equal(f.runtime.journal.has(request.value.operationId), false);
    assert.equal(f.opens, 0);
  }
});
