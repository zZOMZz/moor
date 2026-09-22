import { productCanonicalJson } from '@moor/protocol/canonical-json';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@moor/protocol/protocol';
import {
  sendTurnSchema,
  respondPermissionSchema,
  type SendTurn,
  type RespondPermission,
} from '@moor/protocol/session-intent-protocol';
import type { SessionOriginalOperation } from '@moor/protocol/session-control-protocol';
import type { AttachmentReference } from '@moor/protocol/content-protocol';
import {
  buildSessionTurn,
  readClientSession,
  sessionPermissionReviews,
} from '@moor/session/session-operations';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import type { AgentCallbacks, AgentDriver } from '@moor/host/agents/driver';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const conflict = (error: unknown) => error instanceof AppError && error.status === 409;
async function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-session-intents-'))),
    rootPath = join(directory, 'project'),
    file = join(directory, 'runtime.sqlite');
  mkdirSync(rootPath);
  let store = new RuntimeStore(file),
    host: HostWorkspace,
    closed = false;
  const scope = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: 'project',
    sessionId: 'session-a',
  };
  const agent = {
    id: 'agent',
    name: 'Synthetic',
    cliType: 'builtin',
    agentType: 'codex',
    machineId: scope.machineId,
    runtimeOverrides: { codexPath: process.execPath },
  };
  store.machine.set(['localProject', scope.localProjectId], {
    id: scope.localProjectId,
    name: 'Synthetic',
    rootPath,
  });
  store.machine.set(['agentConfig', agent.id], agent);
  store.saveMachine();
  const started = signal(),
    held = signal(),
    prompts: unknown[] = [];
  let opens = 0,
    callbacks!: AgentCallbacks;
  const driver: AgentDriver = {
    async open(_config, _cwd, nativeId, next) {
      opens++;
      callbacks = next;
      return {
        id: nativeId ?? 'synthetic-native',
        capabilities: syntheticCapabilities,
        inputCapabilities: { image: true, audio: true, embeddedContext: true },
        async prompt(input) {
          prompts.push(input);
          started.resolve();
          await held.promise;
        },
        async cancel() {
          held.resolve();
        },
        close() {
          held.resolve();
        },
      };
    },
  };
  const makeHost = () =>
    new HostWorkspace(
      store,
      driver,
      () => {},
      () => {},
    );
  host = makeHost();
  const create = async (sessionId: string) =>
    host.controlManager.control(
      {
        ...scope,
        sessionId,
        controlVersion: 1,
        operationId: 'create-' + sessionId,
        action: 'create',
        agentId: agent.id,
      },
      scope.localProjectId,
    );
  await create(scope.sessionId);
  await create('session-b');
  const finish = async () => {
    const pending = [...host.active.values()].map((run) => run.done);
    held.resolve();
    await Promise.all(pending);
  };
  t.after(async () => {
    if (!closed) {
      await finish();
      host.close();
      store.close();
      closed = true;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const send = (changes: Partial<SendTurn> = {}) =>
    sendTurnSchema.parse({
      ...scope,
      intentVersion: 1,
      operationId: 'send-original',
      expectedTurnId: null,
      agentId: agent.id,
      turnId: 'user-turn',
      prompt: 'Synthetic explicit input',
      selection: {},
      attachments: [],
      ...changes,
    });
  const recover = (original: SessionOriginalOperation, action: 'inspect' | 'abandon' = 'inspect') =>
    host.controlManager.recover(
      {
        ...scope,
        sessionId: original.value.sessionId,
        controlVersion: 1,
        action,
        request: original,
      },
      scope.localProjectId,
    );
  const permission = async () => {
    const pending = callbacks.permission({
      toolCall: {
        toolCallId: 'tool-a',
        title: 'Synthetic edit',
        rawInput: { path: 'synthetic.txt', text: 'reviewed' },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const response = await host.read(scope.sessionId, undefined, scope.localProjectId);
    const [review] = sessionPermissionReviews(readClientSession(response, scope), scope);
    assert(review);
    const request = respondPermissionSchema.parse({
      ...scope,
      intentVersion: 1,
      operationId: 'permission-original',
      expectedTurnId: review.expectedUserTurnId,
      requestId: review.requestId,
      permissionReview: {
        version: 1,
        assistantTurnId: review.assistantTurnId,
        itemJson: review.itemJson,
      },
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    return { pending, request };
  };
  const upload = async (sessionId = scope.sessionId) => {
    await host.refreshAgentOptions(agent.id, scope.localProjectId, sessionId);
    const bytes = Buffer.from('Synthetic confirmed attachment');
    const attachment: AttachmentReference = {
      contentVersion: 1,
      attachmentId: 'attachment-' + sessionId,
      name: 'fixture.txt',
      content: {
        version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
        mediaType: 'text/plain',
      },
    };
    await host.attachmentAction(
      {
        workspaceId: scope.workspaceId,
        localProjectId: scope.localProjectId,
        sessionId,
        operationId: 'upload-' + sessionId,
        contentVersion: 1,
        action: 'upload',
        attachment,
        data: bytes.toString('base64'),
      },
      scope.localProjectId,
    );
    return attachment;
  };
  return {
    scope,
    agent,
    send,
    recover,
    permission,
    upload,
    started,
    finish,
    prompts,
    opens: () => opens,
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    async reopen() {
      await finish();
      host.close();
      store.close();
      store = new RuntimeStore(file);
      host = makeHost();
    },
  };
}

test('concurrent typed sends have one durable DTO fingerprint and cannot collide with legacy, another session or another typed request', async (t) => {
  const f = await fixture(t),
    request = f.send();
  const before = await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId);
  const legacy = buildSessionTurn({
    scope: f.scope,
    read: before,
    agent: before.agent!,
    prompt: request.prompt,
    operationId: request.operationId,
    turnId: request.turnId,
    peerId: '17',
    now: '2026-01-01T00:00:00.000Z',
  });
  const results = await Promise.all([
    f.host.sendTurn(request, f.scope.localProjectId),
    f.host.sendTurn(
      Object.fromEntries(Object.entries(request).reverse()) as SendTurn,
      f.scope.localProjectId,
    ),
  ]);
  assert.deepEqual(results[0], results[1]);
  await f.started.promise;
  assert.equal(f.prompts.length, 1);
  for (const changed of [
    f.send({ sessionId: 'session-b' }),
    f.send({ prompt: 'Changed original' }),
  ])
    await assert.rejects(f.host.sendTurn(changed, f.scope.localProjectId), conflict);
  await assert.rejects(f.host.mutate(legacy, f.scope.localProjectId), conflict);
  const { request: approval, pending } = await f.permission();
  await assert.rejects(
    f.host.respondPermission(
      { ...approval, operationId: request.operationId },
      f.scope.localProjectId,
    ),
    conflict,
  );
  const row = f.store.journal.db
    .prepare('SELECT fingerprint,phase,result FROM operation WHERE id=?')
    .get(request.operationId)!;
  assert.equal(
    row.fingerprint,
    createHash('sha256')
      .update(
        productCanonicalJson([
          'session-intent-v1',
          f.scope.workspaceId,
          sendTurnSchema.parse(request),
          null,
        ]),
      )
      .digest('hex'),
  );
  assert.equal(row.phase, 'accepted');
  assert.deepEqual(JSON.parse(String(row.result)), results[0]);
  assert.equal(
    f.store.journal.lookup(
      f.scope.workspaceId,
      Object.fromEntries(Object.entries(request).reverse()) as SendTurn,
    ).fingerprint,
    row.fingerprint,
  );
  await f.finish();
  await pending;
  const recovered = await f.recover({ kind: 'send-turn', value: request });
  assert(recovered.found);
  assert.equal(recovered.receipt.status, 'accepted');
  assert.equal(recovered.receipt.kind, 'send-turn');
  assert.equal(f.prompts.length, 1);
});

test('an accepted typed send survives a lost reply, read-only recovery and restart without another Agent prompt', async (t) => {
  const f = await fixture(t),
    request = f.send();
  const receipt = { accepted: true, delivered: true, operationId: request.operationId };
  await assert.rejects(async () => {
    await f.host.sendTurn(request, f.scope.localProjectId);
    throw Error('Synthetic reply lost after Host acceptance');
  }, /reply lost/);
  await f.started.promise;
  const recovered = await f.recover({ kind: 'send-turn', value: request });
  assert(recovered.found);
  assert.equal(recovered.receipt.status, 'accepted');
  const fingerprint = f.store.journal.lookup(f.scope.workspaceId, request).fingerprint;
  await f.reopen();
  assert.deepEqual(await f.host.sendTurn(request, f.scope.localProjectId), receipt);
  assert.equal(f.store.journal.lookup(f.scope.workspaceId, request).fingerprint, fingerprint);
  assert.equal(f.prompts.length, 1);
  const restored = await f.recover({ kind: 'send-turn', value: request });
  assert(restored.found);
  assert.equal(restored.receipt.status, 'accepted');
});

for (const failure of ['snapshot', 'metadata-index', 'attachment-reference'] as const)
  test(
    'typed acceptance rolls back ' + failure + ' failure before dispatch or durable confirmation',
    async (t) => {
      const f = await fixture(t),
        attachment = failure === 'attachment-reference' ? await f.upload() : undefined;
      const request = f.send({ attachments: attachment ? [attachment] : [] });
      const before = await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId);
      const opens = f.opens();
      let restore = () => {};
      if (failure === 'attachment-reference') {
        const original = f.store.referenceAttachment;
        f.store.referenceAttachment = () => {
          throw Error('Synthetic reference failure');
        };
        restore = () => {
          f.store.referenceAttachment = original;
        };
      } else {
        const table = failure === 'snapshot' ? 'session' : 'session_metadata';
        f.store.journal.db.exec(
          `CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic durable failure'); END`,
        );
        restore = () => {
          f.store.journal.db.exec('DROP TRIGGER synthetic_failure');
        };
      }
      try {
        await assert.rejects(f.host.sendTurn(request, f.scope.localProjectId));
      } finally {
        restore();
      }
      assert.equal(f.store.journal.has(request.operationId), false);
      assert.equal(f.host.active.size, 0);
      assert.equal(f.opens(), opens);
      assert.equal(f.prompts.length, 0);
      const after = await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId);
      assert.deepEqual(after.meta, before.meta);
      assert.deepEqual(
        readClientSession(after, f.scope).history,
        readClientSession(before, f.scope).history,
      );
      const unseen = await f.recover({ kind: 'send-turn', value: request });
      assert.equal(unseen.found, false);
      await f.host.sendTurn(request, f.scope.localProjectId);
      await f.started.promise;
      assert.equal(f.prompts.length, 1);
    },
  );

test('typed send rejects an attachment confirmed for another session without accepting or dispatching', async (t) => {
  const f = await fixture(t),
    attachment = await f.upload('session-b');
  const request = f.send({ attachments: [attachment] });
  const opens = f.opens();
  await assert.rejects(f.host.sendTurn(request, f.scope.localProjectId));
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.opens(), opens);
});

test('typed permission binds the active turn and complete reviewed item, resolves once, and recovers its original DTO', async (t) => {
  const f = await fixture(t);
  await f.host.sendTurn(f.send(), f.scope.localProjectId);
  await f.started.promise;
  const { pending, request } = await f.permission();
  for (const changed of [
    { ...request, expectedTurnId: 'stale-user' },
    { ...request, requestId: 'different-request' },
    {
      ...request,
      permissionReview: { ...request.permissionReview, assistantTurnId: 'stale-assistant' },
    },
  ])
    await assert.rejects(f.host.respondPermission(changed, f.scope.localProjectId), conflict);
  const run = f.host.active.get(f.scope.sessionId)!;
  f.host.edit(f.scope.sessionId, run, (turn) => {
    (turn.items.find((item: any) => item.permissionRequest) as any).rawInput.text =
      'changed after review';
  });
  await assert.rejects(f.host.respondPermission(request, f.scope.localProjectId), conflict);
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(run.permissions.size, 1);
  const read = await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId);
  const [review] = sessionPermissionReviews(readClientSession(read, f.scope), f.scope);
  const fresh = respondPermissionSchema.parse({
    ...request,
    permissionReview: {
      version: 1,
      assistantTurnId: review.assistantTurnId,
      itemJson: review.itemJson,
    },
  });
  const receipts = await Promise.all([
    f.host.respondPermission(fresh, f.scope.localProjectId),
    f.host.respondPermission(structuredClone(fresh), f.scope.localProjectId),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.equal(f.host.active.get(f.scope.sessionId)!.permissions.size, 0);
  assert.equal(
    f.store.journal.lookup(f.scope.workspaceId, fresh).fingerprint,
    createHash('sha256')
      .update(
        productCanonicalJson([
          'session-intent-v1',
          f.scope.workspaceId,
          respondPermissionSchema.parse(fresh),
          null,
        ]),
      )
      .digest('hex'),
  );
  const recovered = await f.recover({ kind: 'respond-permission', value: fresh });
  assert(recovered.found);
  assert.equal(recovered.receipt.status, 'accepted');
  await f.finish();
  await assert.rejects(
    f.host.respondPermission({ ...fresh, operationId: 'late-decision' }, f.scope.localProjectId),
    conflict,
  );
  await f.reopen();
  assert.deepEqual(await f.host.respondPermission(fresh, f.scope.localProjectId), receipts[0]);
  assert.equal(f.prompts.length, 1);
});

for (const kind of ['send-turn', 'respond-permission'] as const)
  test(
    'sealing an undelivered ' + kind + ' prevents its late original from taking effect',
    async (t) => {
      const f = await fixture(t);
      let request: SendTurn | RespondPermission = f.send(),
        waiting: Promise<unknown> | undefined;
      if (kind === 'respond-permission') {
        await f.host.sendTurn(request as SendTurn, f.scope.localProjectId);
        await f.started.promise;
        const approval = await f.permission();
        request = approval.request;
        waiting = approval.pending;
      }
      const original = { kind, value: request } as SessionOriginalOperation;
      assert.equal((await f.recover(original)).found, false);
      const sealed = await f.recover(original, 'abandon');
      assert(sealed.found);
      assert.equal(sealed.receipt.status, 'abandoned');
      const result =
        kind === 'send-turn'
          ? await f.host.sendTurn(request as SendTurn, f.scope.localProjectId)
          : await f.host.respondPermission(request as RespondPermission, f.scope.localProjectId);
      assert.deepEqual(result, {
        accepted: false,
        delivered: false,
        abandoned: true,
        operationId: request.operationId,
      });
      assert.equal(f.prompts.length, kind === 'send-turn' ? 0 : 1);
      if (kind === 'respond-permission')
        assert.equal(f.host.active.get(f.scope.sessionId)!.permissions.size, 1);
      await f.finish();
      if (waiting) assert.deepEqual(await waiting, { outcome: { outcome: 'cancelled' } });
    },
  );
