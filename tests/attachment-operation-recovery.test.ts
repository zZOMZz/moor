import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { HostProductCatalog } from '../src/bridge/host-product-catalog';
import { HostCommandDispatcher, type HostCommand } from '../src/bridge/host-command';
import { attachmentActionSchema, type AttachmentAction } from '../src/attachment-protocol';
import {
  ATTACHMENT_OPERATIONS_FEATURE,
  sessionOperationSchema,
  validateSessionOperationResult,
} from '../src/session-control-protocol';
import { validateHostResponse } from '../src/host-response';
import type { EncryptedProductTarget } from '../src/security/encrypted-product-catalog';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-attachment-recovery-'))),
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
  const open = () => {
    host = new HostWorkspace(
      runtime,
      {
        open: async () => {
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
  const upload = (operationId = 'original-upload'): AttachmentAction =>
    attachmentActionSchema.parse({
      contentVersion: 1,
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
      sessionId: scope.sessionId,
      operationId,
      action: 'upload',
      attachment: {
        contentVersion: 1,
        attachmentId: 'attachment',
        name: 'synthetic.txt',
        content: {
          mediaType: 'text/plain',
          byteLength: 9,
          version: 'sha256:' + createHash('sha256').update('synthetic').digest('hex'),
        },
      },
      data: Buffer.from('synthetic').toString('base64'),
    });
  const command = (value: AttachmentAction): HostCommand => ({
    method: 'attachment-action',
    workspaceId: scope.workspaceId,
    localProjectId: scope.localProjectId,
    params: value,
  });
  const recovery = (
    value: AttachmentAction,
    action: 'inspect' | 'abandon',
  ): HostCommand & { method: 'session-operations' } => ({
    method: 'session-operations',
    workspaceId: scope.workspaceId,
    localProjectId: scope.localProjectId,
    params: sessionOperationSchema.parse({
      ...scope,
      action,
      request: { kind: 'attachment', value },
    }),
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
    selected,
    upload,
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

test('accepted upload/remove recovery uses the original journal after restart and product revision change, without checking present bytes', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    upload = f.upload();
  const uploadReceipt = await f.execute(selected, f.command(upload));
  const remove = attachmentActionSchema.parse({
    contentVersion: 1,
    workspaceId: f.scope.workspaceId,
    localProjectId: f.scope.localProjectId,
    sessionId: f.scope.sessionId,
    operationId: 'original-remove',
    action: 'remove',
    attachmentId: 'attachment',
  });
  const removeReceipt = await f.execute(selected, f.command(remove));
  f.move();
  f.reopen();
  assert.notDeepEqual(f.selected(), selected);
  for (const [original, receipt] of [
    [upload, uploadReceipt],
    [remove, removeReceipt],
  ] as const) {
    await assert.rejects(f.execute(selected, f.command(original)));
    await assert.rejects(
      f.execute(f.selected(), f.command(original)),
      'cannot rebind old operation',
    );
    for (const action of ['inspect', 'abandon'] as const) {
      const command = f.recovery(original, action),
        raw = await f.execute(selected, command);
      const result = validateSessionOperationResult(raw, command.params);
      assert.equal(result.found, true);
      assert.equal(result.found && result.receipt.status, 'accepted');
      assert.deepEqual(result.found && result.receipt.attachmentReceipt, receipt);
    }
  }
  assert.equal(f.runtime.attachmentBytes(f.scope), 0);
  assert.equal(
    f.runtime.journal.db
      .prepare(
        "SELECT count(*) AS count FROM operation WHERE id IN ('original-upload', 'original-remove')",
      )
      .get()?.count,
    2,
  );
});

test('a claimed but absent old upload can be inspected then sealed after mapping changes; delayed exact upload cannot execute', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    original = f.upload();
  // The verified Host boundary persisted authority before an interrupted dispatch, without accepting bytes.
  f.products.bindOperation(selected, f.command(original));
  f.move();
  const inspection = f.recovery(original, 'inspect');
  assert.equal(
    validateSessionOperationResult(await f.execute(selected, inspection), inspection.params).found,
    false,
  );
  assert.equal(f.runtime.journal.has(original.operationId), false);
  const abandon = f.recovery(original, 'abandon');
  const sealed = validateSessionOperationResult(await f.execute(selected, abandon), abandon.params);
  assert.equal(sealed.found && sealed.receipt.status, 'abandoned');
  f.reopen();
  assert.deepEqual(
    validateSessionOperationResult(await f.execute(selected, inspection), inspection.params),
    { ...sealed, action: 'inspect' },
  );
  await assert.rejects(f.host.attachmentAction(original, f.scope.localProjectId), /封存/);
  await assert.rejects(f.execute(f.selected(), f.command(original)));
  assert.equal(f.runtime.attachmentBytes(f.scope), 0);
  const next = f.upload('new-explicit-upload');
  assert.ok(await f.execute(f.selected(), f.command(next)));
});

test('sealing an absent remove keeps the uploaded file and serial races have only one durable outcome', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    upload = f.upload();
  await f.execute(selected, f.command(upload));
  const remove = attachmentActionSchema.parse({
    contentVersion: 1,
    workspaceId: f.scope.workspaceId,
    localProjectId: f.scope.localProjectId,
    sessionId: f.scope.sessionId,
    operationId: 'remove',
    action: 'remove',
    attachmentId: 'attachment',
  });
  const abandon = f.recovery(remove, 'abandon');
  const sealed = validateSessionOperationResult(await f.execute(selected, abandon), abandon.params);
  assert.equal(sealed.found && sealed.receipt.status, 'abandoned');
  await assert.rejects(f.host.attachmentAction(remove, f.scope.localProjectId), /封存/);
  assert.equal(f.runtime.attachmentBytes(f.scope), 9);
  for (const first of ['upload', 'abandon'] as const) {
    const original = attachmentActionSchema.parse({
      ...f.upload(`racing-${first}`),
      attachment: {
        ...(f.upload() as Extract<AttachmentAction, { action: 'upload' }>).attachment,
        attachmentId: `racing-${first}`,
      },
    });
    const recovery = f.recovery(original, 'abandon');
    const uploadTask = () => f.execute(selected, f.command(original));
    const sealTask = () => f.execute(selected, recovery);
    const settled = await Promise.allSettled(
      first === 'upload' ? [uploadTask(), sealTask()] : [sealTask(), uploadTask()],
    );
    const result = validateSessionOperationResult(
      await f.execute(selected, f.recovery(original, 'inspect')),
      f.recovery(original, 'inspect').params,
    );
    assert.equal(
      result.found && result.receipt.status,
      first === 'upload' ? 'accepted' : 'abandoned',
    );
    assert.equal(
      settled.filter((entry) => entry.status === 'fulfilled').length,
      first === 'upload' ? 2 : 1,
    );
  }
});

test('historical attachment recovery rejects changed claims, targets, authority and project generations', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    original = f.upload();
  f.products.bindOperation(selected, f.command(original));
  f.move();
  const request = f.recovery(original, 'inspect');
  for (const altered of [
    f.recovery(
      { ...original, data: Buffer.from('different').toString('base64') } as AttachmentAction,
      'inspect',
    ),
    f.recovery(
      {
        ...original,
        attachment: {
          ...(original as Extract<AttachmentAction, { action: 'upload' }>).attachment,
          name: 'different.txt',
        },
      } as AttachmentAction,
      'abandon',
    ),
  ])
    await assert.rejects(f.execute(selected, altered));
  await assert.rejects(f.execute({ ...selected, revision: selected.revision + 1 }, request));
  const alteredScope = structuredClone(request);
  alteredScope.params.machineId = 'another-machine';
  await assert.rejects(f.execute(selected, alteredScope));
  f.host.workspace.projects[0].rootPath += '-changed';
  await assert.rejects(f.execute(selected, request));
  assert.equal(f.runtime.journal.has(original.operationId), false);
});

test('attachment recovery schemas reject wrong nested receipt, raw authority fields and unsupported capability', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    original = f.upload();
  await f.execute(selected, f.command(original));
  const command = f.recovery(original, 'inspect'),
    raw = (await f.execute(selected, command)) as any;
  for (const change of ['operationId', 'sessionId', 'name', 'status', 'kind']) {
    const changed = structuredClone(raw);
    if (change === 'name') changed.receipt.attachmentReceipt.attachment.name = 'other';
    else if (change === 'status') changed.receipt.status = 'abandoned';
    else if (change === 'kind') changed.receipt.kind = 'metadata';
    else changed.receipt.attachmentReceipt[change] = 'other';
    assert.throws(() => validateSessionOperationResult(changed, command.params));
  }
  assert.throws(() =>
    sessionOperationSchema.parse({
      ...command.params,
      request: { ...command.params.request, value: { ...original, owner: 'other' } },
    }),
  );
  await assert.rejects(
    validateHostResponse(raw, {
      command,
      workspace: {
        ...f.host.workspace,
        features: f.host.workspace.features?.filter(
          (feature) => feature !== ATTACHMENT_OPERATIONS_FEATURE,
        ),
      },
    }),
  );
});

test('a never-arrived attachment can inspect and seal the exact Host-published historical mapping without inventing an execution claim', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    original = f.upload('never-arrived');
  assert.equal(
    f.runtime.journal.db.prepare('SELECT count(*) AS count FROM encrypted_product_operation').get()
      ?.count,
    0,
  );
  assert.deepEqual(
    JSON.parse(
      String(
        f.runtime.journal.db.prepare('SELECT value FROM encrypted_product_mapping').get()?.value,
      ),
    ).target,
    selected,
  );
  f.move();
  f.reopen();
  const inspection = f.recovery(original, 'inspect');
  assert.equal(
    validateSessionOperationResult(await f.execute(selected, inspection), inspection.params).found,
    false,
  );
  assert.equal(
    f.runtime.journal.db.prepare('SELECT count(*) AS count FROM encrypted_product_operation').get()
      ?.count,
    0,
  );
  assert.equal(f.runtime.journal.has(original.operationId), false);
  const abandon = f.recovery(original, 'abandon');
  const result = validateSessionOperationResult(await f.execute(selected, abandon), abandon.params);
  assert.equal(result.found && result.receipt.status, 'abandoned');
  assert.equal(
    f.runtime.journal.db.prepare('SELECT count(*) AS count FROM encrypted_product_operation').get()
      ?.count,
    1,
  );
  assert.equal(f.runtime.attachmentBytes(f.scope), 0);
  await assert.rejects(f.host.attachmentAction(original, f.scope.localProjectId), /封存/);
  await assert.rejects(f.execute(selected, f.command(original)));
  await assert.rejects(f.execute(f.selected(), f.command(original)));
  assert.equal(
    validateSessionOperationResult(await f.execute(selected, inspection), inspection.params).found,
    true,
  );
});

test('unclaimed recovery never trusts an invented target or legacy missing history, and cannot borrow a different runtime generation', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    original = f.upload('never-arrived');
  f.move();
  const inspection = f.recovery(original, 'inspect');
  await assert.rejects(f.execute({ ...selected, revision: selected.revision + 10 }, inspection));
  await assert.rejects(f.execute({ ...selected, projectId: 'invented-project' }, inspection));
  const rows = f.runtime.journal.db
    .prepare('SELECT authority,target,value FROM encrypted_product_mapping')
    .all();
  const row = rows.find(
    (row) => JSON.parse(String(row.value)).target.revision === selected.revision,
  )!;
  f.runtime.journal.db
    .prepare('DELETE FROM encrypted_product_mapping WHERE authority=? AND target=?')
    .run(row.authority!, row.target!);
  f.reopen();
  await assert.rejects(
    f.execute(selected, inspection),
    'upgrade cannot reconstruct missing old history from client fields',
  );
  assert.equal(f.runtime.journal.has(original.operationId), false);
});

test('Host mapping evidence is immutable, committed before publication and cannot authorize a reused local project', async (t) => {
  const f = fixture(t),
    selected = f.selected(),
    original = f.upload('never-arrived');
  const historical = f.runtime.journal.db.prepare('SELECT * FROM encrypted_product_mapping').all();
  assert.equal(historical.length, 1);
  f.move();
  assert.deepEqual(
    f.runtime.journal.db
      .prepare('SELECT * FROM encrypted_product_mapping WHERE target=?')
      .all(historical[0].target!),
    historical,
  );
  f.host.workspace.projects[0].rootPath += '-replacement';
  await assert.rejects(f.execute(selected, f.recovery(original, 'abandon')));
  assert.equal(f.runtime.journal.has(original.operationId), false);
});
