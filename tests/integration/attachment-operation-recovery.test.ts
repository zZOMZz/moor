import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostCommandDispatcher, type HostCommand } from '@moor/host/commands/host-command';
import { attachmentActionSchema, type AttachmentAction } from '@moor/protocol/attachment-protocol';
import {
  ATTACHMENT_OPERATIONS_FEATURE,
  sessionOperationSchema,
  validateSessionOperationResult,
} from '@moor/protocol/session-control-protocol';
import { validateHostResponse } from '@moor/protocol/host-response';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-attachment-recovery-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const database = join(root, 'host.sqlite');
  let runtime = new RuntimeStore(database),
    host: HostWorkspace,
    dispatcher: HostCommandDispatcher;
  const projectId = runtime.registerProject(project);
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
  const execute = async (command: HostCommand) => {
    const current = () => assert(!host.closed);
    const raw = await dispatcher.execute(command, { current });
    return validateHostResponse(raw, { command, workspace: host.workspace, current });
  };
  return {
    scope,
    upload,
    command,
    recovery,
    execute,
    get runtime() {
      return runtime;
    },
    get host() {
      return host;
    },
    reopen() {
      host.close();
      runtime.close();
      runtime = new RuntimeStore(database);
      open();
    },
  };
}

test('accepted upload/remove recovery uses the original journal after restart, without checking present bytes', async (t) => {
  const f = fixture(t),
    upload = f.upload();
  const uploadReceipt = await f.execute(f.command(upload));
  const remove = attachmentActionSchema.parse({
    contentVersion: 1,
    workspaceId: f.scope.workspaceId,
    localProjectId: f.scope.localProjectId,
    sessionId: f.scope.sessionId,
    operationId: 'original-remove',
    action: 'remove',
    attachmentId: 'attachment',
  });
  const removeReceipt = await f.execute(f.command(remove));
  f.reopen();
  for (const [original, receipt] of [
    [upload, uploadReceipt],
    [remove, removeReceipt],
  ] as const) {
    assert.deepEqual(await f.execute(f.command(original)), receipt);
    for (const action of ['inspect', 'abandon'] as const) {
      const command = f.recovery(original, action),
        raw = await f.execute(command);
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

test('sealing an absent remove keeps the uploaded file and serial races have only one durable outcome', async (t) => {
  const f = fixture(t),
    upload = f.upload();
  await f.execute(f.command(upload));
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
  const sealed = validateSessionOperationResult(await f.execute(abandon), abandon.params);
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
    const uploadTask = () => f.execute(f.command(original));
    const sealTask = () => f.execute(recovery);
    const settled = await Promise.allSettled(
      first === 'upload' ? [uploadTask(), sealTask()] : [sealTask(), uploadTask()],
    );
    const result = validateSessionOperationResult(
      await f.execute(f.recovery(original, 'inspect')),
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

test('attachment recovery schemas reject wrong nested receipt, raw authority fields and unsupported capability', async (t) => {
  const f = fixture(t),
    original = f.upload();
  await f.execute(f.command(original));
  const command = f.recovery(original, 'inspect'),
    raw = (await f.execute(command)) as any;
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
