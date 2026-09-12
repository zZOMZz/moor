import test from 'node:test';
import strict from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import type { AgentDriver } from '../src/runtime/agent';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../src/model';
import type { Mutation } from '../src/protocol';
import type {
  AttachmentAction,
  AttachmentRead,
  PromptInputCapabilities,
} from '../src/attachment-protocol';
import { attachmentActionSchema, MAX_SESSION_ATTACHMENT_BYTES } from '../src/attachment-protocol';
import type { AttachmentReference } from '../src/content-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';

const ws = {
  id: 'attachments-workspace',
  name: 'Synthetic workspace',
  userId: 'local:synthetic',
  machineId: 'synthetic-machine',
  projects: [
    { id: 'project-a', name: 'Synthetic A', rootPath: '/synthetic/a' },
    { id: 'project-b', name: 'Synthetic B', rootPath: '/synthetic/b' },
  ],
  agents: [{ id: 'agent-a', name: 'Synthetic Agent', cliType: 'builtin', agentType: 'codex' }],
};
const caps: PromptInputCapabilities = { image: true, audio: true, embeddedContext: true };
function fixture(file = ':memory:', inputCapabilities: PromptInputCapabilities | undefined = caps) {
  const store = new RuntimeStore(file);
  if (!store.machine.get(['localProject', 'project-a'])) {
    Object.assign(store.workspace, structuredClone(ws));
    store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
    for (const project of ws.projects) store.machine.set(['localProject', project.id], project);
    store.machine.set(['agentConfig', 'agent-a'], { ...ws.agents[0], machineId: ws.machineId });
    store.machine.set(['inputCapabilities', 'agent-a'], inputCapabilities as never);
    store.saveMachine();
  }
  let opens = 0;
  let release: (() => void) | undefined;
  let prompted!: () => void;
  const started = new Promise<void>((resolve) => {
    prompted = resolve;
  });
  const prompts: any[] = [];
  let callbacks: Parameters<AgentDriver['open']>[3];
  const driver: AgentDriver = {
    async open(_config, _cwd, nativeId, cb) {
      opens++;
      callbacks = cb;
      return {
        id: nativeId ?? 'synthetic-native',
        capabilities: syntheticCapabilities,
        inputCapabilities,
        async prompt(input) {
          prompts.push(input);
          prompted();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        async cancel() {
          release?.();
        },
        close() {
          release?.();
        },
      };
    },
  };
  const host = new HostWorkspace(
    store,
    driver,
    () => {},
    () => {},
  );
  return {
    host,
    store,
    prompts,
    started,
    opens: () => opens,
    setInputCapabilities: (next: PromptInputCapabilities | undefined) => {
      inputCapabilities = next;
    },
    update: (value: unknown) => callbacks.update(value),
    finish: async () => {
      const pending = [...host.active.values()].map((run) => run.done);
      release?.();
      await Promise.all(pending);
    },
    close: () => {
      host.close();
      store.close();
    },
  };
}
function upload(
  sessionId = 'session-a',
  data = Buffer.from('synthetic attachment'),
  mediaType = 'text/plain',
  attachmentId = randomUUID(),
): AttachmentAction & { action: 'upload' } {
  return {
    action: 'upload',
    contentVersion: 1,
    workspaceId: ws.id,
    localProjectId: 'project-a',
    sessionId,
    operationId: randomUUID(),
    attachment: {
      contentVersion: 1,
      attachmentId,
      name: 'synthetic.txt',
      content: {
        version: 'sha256:' + createHash('sha256').update(data).digest('hex'),
        byteLength: data.length,
        mediaType,
      },
    },
    data: data.toString('base64'),
  };
}
function read(action: ReturnType<typeof upload>): AttachmentRead {
  return {
    contentVersion: 1,
    workspaceId: action.workspaceId,
    localProjectId: action.localProjectId,
    sessionId: action.sessionId,
    attachmentId: action.attachment.attachmentId,
  };
}
function remove(action: ReturnType<typeof upload>): AttachmentAction {
  return { ...read(action), action: 'remove', operationId: randomUUID() };
}
function request(
  f: ReturnType<typeof fixture>,
  attachments: AttachmentReference[] = [],
  sessionId = 'session-a',
  projectId = 'project-a',
  overrides: Record<string, unknown> = {},
): Mutation {
  const doc = new LoroDoc();
  doc.import(f.store.doc(sessionId).export({ mode: 'snapshot' }));
  const before = vv(doc),
    flock = Flock.fromFile(f.store.meta.exportFile()),
    version = flock.version(),
    old = metas(flock)['session-' + sessionId],
    turnId = randomUUID();
  const view = mirror(doc, sessionId),
    inputConfig = {
      prompt: '',
      cliType: 'builtin',
      agentType: 'codex',
      mcpServerIds: [],
      taskToolsEnabled: false,
      attachments,
      ...overrides,
    };
  view.setState((s: any) => {
    s.history.push({
      id: turnId,
      role: 'user',
      userId: ws.userId,
      timestamp: '2026-01-01T00:00:00Z',
      status: 'pending',
      finished: true,
      items: [
        { type: 'text', text: inputConfig.prompt },
        ...attachments.map((attachment) => ({ type: 'attachment', attachment })),
      ],
      inputConfig,
      fileDiff: null,
    });
  });
  view.dispose();
  doc.commit();
  putMeta(
    flock,
    'session-' + sessionId,
    old
      ? { latestUserMsgId: turnId, lastMessageAt: 100 }
      : {
          id: sessionId,
          machineId: ws.machineId,
          userId: ws.userId,
          createdAt: '2026-01-01T00:00:00Z',
          cliType: 'builtin',
          agentType: 'codex',
          agentConfigId: 'agent-a',
          project: { kind: 'local', localProjectId: projectId },
          status: { type: 'idle' },
          isArchived: false,
          latestUserMsgId: turnId,
          lastMessageAt: 100,
        },
  );
  return {
    operationId: randomUUID(),
    sessionId,
    workspaceId: ws.id,
    kind: 'turn',
    expectedTurnId: (old?.latestUserMsgId as string) ?? null,
    update: delta(doc, before),
    metaBundle: flock.exportJson(version),
  };
}

test('upload confirms only after atomic receipt and bytes storage; duplicate retries preserve immutable data', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  strict.ok(f.host.workspace.features?.includes('attachments-v1'));
  strict.deepEqual(f.host.workspace.agents[0].inputCapabilities, caps);
  const receipt = await f.host.attachmentAction(action, 'project-a');
  strict.equal(receipt.delivered, true);
  strict.deepEqual(await f.host.attachmentAction(action, 'project-a'), receipt);
  strict.equal(
    f.store.journal.lookup(ws.id, attachmentActionSchema.parse(action)).phase,
    'accepted',
  );
  strict.deepEqual((await f.host.readAttachment(read(action))).attachment, action.attachment);
  strict.equal((await f.host.readAttachment(read(action))).data, action.data);
  strict.equal(f.opens(), 0);
  strict.equal(metas(f.store.meta)['session-session-a'], undefined);
  await strict.rejects(
    f.host.attachmentAction({ ...action, operationId: randomUUID() }),
    /编号已使用/,
  );
  await strict.rejects(
    f.host.attachmentAction({
      ...action,
      attachment: { ...action.attachment, name: 'different.txt' },
    }),
    /重复编号/,
  );
});

test('receipt write failure rolls back blob and new-session reservation', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  f.store.journal.db.exec(
    "CREATE TRIGGER attachment_receipt_failure BEFORE INSERT ON operation BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  await strict.rejects(f.host.attachmentAction(action), /synthetic failure/);
  strict.equal(f.store.journal.has(action.operationId), false);
  strict.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment').get()!.n, 0);
  strict.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment_scope').get()!.n,
    0,
  );
  strict.equal(f.opens(), 0);
});

test('all operations validate identity and registered project before accepted receipt lookup', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  await f.host.attachmentAction(action);
  for (const changed of [{ workspaceId: 'other' }, { localProjectId: 'project-b' }]) {
    await strict.rejects(f.host.attachmentAction({ ...action, ...changed }));
    await strict.rejects(f.host.readAttachment({ ...read(action), ...changed }));
  }
  await strict.rejects(f.host.attachmentAction(action, 'project-b'));
  const originalOwner = f.store.workspace.userId;
  f.store.workspace.userId = 'local:other';
  await strict.rejects(f.host.attachmentAction(action), /不属于/);
  await strict.rejects(f.host.readAttachment(read(action)), /不属于/);
  f.store.workspace.userId = originalOwner;
  f.store.workspace.projects = [];
  await strict.rejects(f.host.attachmentAction(action), /已从主机移除/);
  await strict.rejects(f.host.readAttachment(read(action)), /已从主机移除/);
});

test('new session reservation prevents another project claiming a draft session id, even without attachments', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  await f.host.attachmentAction(action);
  const mutation = request(f, [], action.sessionId, 'project-b', { prompt: 'synthetic' });
  await strict.rejects(f.host.mutate(mutation, 'project-b'), /不属于/);
  strict.equal(f.store.journal.has(mutation.operationId), false);
  strict.equal(f.opens(), 0);
});

test('attachment-only first turn persists references, hydrates bytes only for confirmed Agent prompt, and protects history', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  await f.host.attachmentAction(action);
  const mutation = request(f, [action.attachment]);
  const receipt = await f.host.mutate(mutation, 'project-a');
  strict.equal(receipt.delivered, true);
  await f.started;
  strict.equal(f.store.journal.lookup(ws.id, mutation).phase, 'accepted');
  strict.equal(f.prompts.length, 1);
  strict.deepEqual(f.prompts[0].attachmentData, [
    { reference: action.attachment, data: action.data },
  ]);
  const view = mirror(f.store.doc(action.sessionId), action.sessionId);
  strict.deepEqual((view.getState().history[0].inputConfig as any).attachments, [
    action.attachment,
  ]);
  strict.equal(JSON.stringify(view.getState()).includes(action.data), false);
  view.dispose();
  strict.deepEqual(await f.host.mutate(mutation, 'project-a'), receipt);
  await strict.rejects(f.host.mutate(mutation, 'project-b'));
  strict.equal(f.prompts.length, 1);
  await strict.rejects(f.host.attachmentAction(remove(action)), /历史回合/);
  await f.finish();
  await strict.rejects(f.host.attachmentAction(remove(action)), /历史回合/);
});

test('unsupported, unconfirmed, mismatched and cross-session attachment references reject before staging', async (t) => {
  const f = fixture(':memory:', { image: false, audio: false, embeddedContext: false });
  t.after(f.close);
  for (const mediaType of ['image/png', 'audio/wav', 'application/pdf']) {
    const action = upload('session-a', Buffer.from('synthetic bytes'), mediaType);
    await f.host.attachmentAction(action);
    const mutation = request(f, [action.attachment]);
    await strict.rejects(f.host.mutate(mutation), /不支持该附件类型/);
    strict.equal(f.store.journal.has(mutation.operationId), false);
  }
  const missing = upload();
  await strict.rejects(f.host.mutate(request(f, [missing.attachment])), /尚未送达/);
  await f.host.attachmentAction(missing);
  const changed = { ...missing.attachment, name: 'changed.txt' };
  await strict.rejects(f.host.mutate(request(f, [changed])), /尚未送达/);
  await strict.rejects(
    f.host.mutate(request(f, [missing.attachment], 'other-session')),
    /尚未送达/,
  );
  strict.equal(f.opens(), 0);
});

test('unknown Agent input capabilities reject attachments until explicit capability refresh', async (t) => {
  const f = fixture(':memory:', undefined);
  t.after(f.close);
  // Clear the persisted capability record to model a host that has never probed this Agent.
  f.store.machine.set(['inputCapabilities', 'agent-a'], undefined as never);
  f.host.updateCatalogue();
  const action = upload();
  await f.host.attachmentAction(action);
  await strict.rejects(f.host.mutate(request(f, [action.attachment])), /不支持该附件类型/);
  strict.equal(f.opens(), 0);
  await f.host.refreshAgentOptions('agent-a', 'project-a');
  strict.deepEqual(f.store.machine.get(['inputCapabilities', 'agent-a']), caps);
});

test('remove tombstones are idempotent and replayed upload receipts never resurrect deleted bytes', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload(),
    uploaded = await f.host.attachmentAction(action),
    deletion = remove(action);
  const removed = await f.host.attachmentAction(deletion);
  strict.equal(removed.removed, true);
  strict.deepEqual(await f.host.attachmentAction(deletion), removed);
  strict.deepEqual(await f.host.attachmentAction(action), uploaded);
  await strict.rejects(f.host.readAttachment(read(action)), /已删除/);
  await strict.rejects(f.host.mutate(request(f, [action.attachment])), /已删除/);
  await strict.rejects(
    f.host.attachmentAction({ ...action, operationId: randomUUID() }),
    /编号已使用/,
  );
  strict.equal(f.opens(), 0);
});

test('turn persistence rollback leaves an uploaded attachment removable and never opens Agent', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  await f.host.attachmentAction(action);
  const mutation = request(f, [action.attachment]);
  f.store.journal.db.exec(
    "CREATE TRIGGER attachment_snapshot_failure BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await strict.rejects(f.host.mutate(mutation), /synthetic failure/);
  strict.equal(f.store.journal.has(mutation.operationId), false);
  strict.equal(f.opens(), 0);
  strict.equal((await f.host.attachmentAction(remove(action))).removed, true);
});

test('hash, declared size, 8 MiB item, eight refs and 64 MiB session quotas are enforced', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  await strict.rejects(
    f.host.attachmentAction({
      ...action,
      attachment: {
        ...action.attachment,
        content: { ...action.attachment.content, version: 'sha256:' + '0'.repeat(64) },
      },
    }),
    /摘要/,
  );
  strict.equal(
    attachmentActionSchema.safeParse({ ...action, data: action.data + 'YQ==' }).success,
    false,
  );
  strict.equal(
    attachmentActionSchema.safeParse({
      ...action,
      attachment: {
        ...action.attachment,
        content: { ...action.attachment.content, byteLength: 8 * 1024 * 1024 + 1 },
      },
    }).success,
    false,
  );
  await strict.rejects(
    f.host.mutate(
      request(
        f,
        Array.from({ length: 9 }, () => upload().attachment),
      ),
    ),
  );
  await strict.rejects(f.host.mutate(request(f, [action.attachment, action.attachment])));
  const boundary = upload('boundary-session', Buffer.alloc(8 * 1024 * 1024, 97));
  strict.equal(attachmentActionSchema.safeParse(boundary).success, true);
  strict.equal((await f.host.attachmentAction(boundary)).delivered, true);
  strict.equal((await f.host.readAttachment(read(boundary))).data, boundary.data);
  const full = upload('full-session', Buffer.alloc(0));
  await f.host.attachmentAction(full);
  f.store.journal.db
    .prepare('UPDATE attachment SET bytes=zeroblob(?) WHERE session_id=?')
    .run(MAX_SESSION_ATTACHMENT_BYTES, 'full-session');
  await strict.rejects(f.host.attachmentAction(upload('full-session')), /总量超过/);
  strict.equal(f.opens(), 0);
});

test('stopped-host copy preserves attachments, references, receipt tombstones and native context without replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-attachment-copy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const originalFile = join(dir, 'original.sqlite'),
    copiedFile = join(dir, 'copy.sqlite');
  const original = fixture(originalFile);
  const sent = upload(),
    discarded = upload();
  const uploadReceipt = await original.host.attachmentAction(sent);
  await original.host.attachmentAction(discarded);
  const deletion = remove(discarded),
    deleteReceipt = await original.host.attachmentAction(deletion);
  const mutation = request(original, [sent.attachment]),
    turnReceipt = await original.host.mutate(mutation);
  await original.started;
  original.update({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'resource',
      resource: { uri: 'file:///synthetic/copied.txt', text: 'synthetic generated copy' },
    },
  });
  const beforeCopy = mirror(original.store.doc(sent.sessionId), sent.sessionId);
  const generated = (beforeCopy.getState().history[1].items![0] as any)
    .attachment as AttachmentReference;
  beforeCopy.dispose();
  await original.finish();
  original.close();
  copyFileSync(originalFile, copiedFile);
  const restored = fixture(copiedFile);
  t.after(restored.close);
  strict.equal(restored.opens(), 0);
  strict.equal(restored.store.nativeSession(sent.sessionId), 'synthetic-native');
  strict.deepEqual(await restored.host.attachmentAction(sent), uploadReceipt);
  strict.deepEqual(await restored.host.attachmentAction(deletion), deleteReceipt);
  strict.deepEqual(await restored.host.mutate(mutation), turnReceipt);
  strict.equal((await restored.host.readAttachment(read(sent))).data, sent.data);
  await strict.rejects(restored.host.readAttachment(read(discarded)), /已删除/);
  await strict.rejects(restored.host.attachmentAction(remove(sent)), /历史回合/);
  strict.equal(restored.opens(), 0);
  strict.equal(
    Buffer.from(
      (await restored.host.readAttachment({ ...read(sent), attachmentId: generated.attachmentId }))
        .data,
      'base64',
    ).toString(),
    'synthetic generated copy',
  );
});

test('ACP embedded output and tool artifacts become scoped durable references without raw binary in history', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.mutate(
    request(f, [], 'session-a', 'project-a', { prompt: 'produce synthetic output' }),
  );
  await f.started;
  const image = {
    type: 'image',
    mimeType: 'image/png',
    data: Buffer.from('synthetic image bytes').toString('base64'),
  };
  f.update({ sessionUpdate: 'agent_message_chunk', content: image });
  const resource = {
    type: 'resource',
    resource: {
      uri: 'file:///synthetic/generated.txt',
      mimeType: 'text/plain',
      text: 'synthetic generated output',
    },
  };
  f.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-output',
    title: 'Synthetic generator',
    content: [
      { type: 'content', content: resource },
      {
        type: 'content',
        content: {
          type: 'audio',
          mimeType: 'audio/wav',
          data: Buffer.from('synthetic audio').toString('base64'),
        },
      },
    ],
    rawOutput: { image, ordinary: { data: 'ordinary tool metadata' } },
  });
  const view = mirror(f.store.doc('session-a'), 'session-a');
  const items: any[] = view.getState().history[1].items!;
  const imageRef = items[0].attachment as AttachmentReference;
  const toolRefs = items[1].content.map(
    (item: any) => item.content.attachment,
  ) as AttachmentReference[];
  const serialized = JSON.stringify(view.getState());
  view.dispose();
  strict.equal(serialized.includes(image.data), false);
  strict.equal(serialized.includes('synthetic generated output'), false);
  strict.equal(serialized.includes('ordinary tool metadata'), true);
  strict.equal(items[1].rawOutput.image.data, '[embedded data omitted]');
  strict.equal(
    (
      await f.host.readAttachment({
        contentVersion: 1,
        workspaceId: ws.id,
        localProjectId: 'project-a',
        sessionId: 'session-a',
        attachmentId: imageRef.attachmentId,
      })
    ).data,
    image.data,
  );
  strict.equal(toolRefs[0].name, 'generated.txt');
  strict.equal(
    Buffer.from(
      (
        await f.host.readAttachment({
          contentVersion: 1,
          workspaceId: ws.id,
          localProjectId: 'project-a',
          sessionId: 'session-a',
          attachmentId: toolRefs[0].attachmentId,
        })
      ).data,
      'base64',
    ).toString(),
    'synthetic generated output',
  );
  for (const ref of [imageRef, ...toolRefs]) {
    await strict.rejects(
      f.host.readAttachment({
        contentVersion: 1,
        workspaceId: ws.id,
        localProjectId: 'project-a',
        sessionId: 'other-session',
        attachmentId: ref.attachmentId,
      }),
      /不存在/,
    );
    await strict.rejects(
      f.host.attachmentAction({
        contentVersion: 1,
        action: 'remove',
        operationId: randomUUID(),
        workspaceId: ws.id,
        localProjectId: 'project-a',
        sessionId: 'session-a',
        attachmentId: ref.attachmentId,
      }),
      /历史回合/,
    );
  }
  // ACP may repeat complete tool content while updating status; keep one stored blob.
  f.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-output',
    status: 'completed',
    content: [{ type: 'content', content: resource }],
  });
  strict.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment').get()!.n, 3);
  await f.finish();
});

test('unsupported or invalid Agent artifacts are explicit notices and never fetched or saved', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.mutate(request(f, [], 'session-a', 'project-a', { prompt: 'synthetic' }));
  await f.started;
  for (const content of [
    { type: 'resource_link', uri: 'file:///sensitive-file', name: 'unavailable' },
    { type: 'resource_link', uri: 'https://synthetic.invalid/private', name: 'unavailable' },
    { type: 'video', data: 'sensitive-unknown-content' },
    { type: 'image', mimeType: 'image/png', data: 'bad base64' },
    {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
    },
  ])
    f.update({ sessionUpdate: 'agent_message_chunk', content });
  const view = mirror(f.store.doc('session-a'), 'session-a');
  const items: any[] = view.getState().history[1].items!;
  strict.equal(items.length, 5);
  strict.ok(items.every((item) => item.type === 'text' && item.text.includes('Agent')));
  const serialized = JSON.stringify(view.getState());
  view.dispose();
  strict.equal(serialized.includes('sensitive-file'), false);
  strict.equal(serialized.includes('sensitive-unknown-content'), false);
  strict.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment').get()!.n, 0);
  await f.finish();
});

test('generated blobs and transcript persist together, and quota exhaustion leaves a visible notice', async (t) => {
  const f = fixture();
  t.after(f.close);
  const full = upload('session-a', Buffer.alloc(0));
  await f.host.attachmentAction(full);
  await f.host.mutate(request(f, [], 'session-a', 'project-a', { prompt: 'synthetic' }));
  await f.started;
  f.store.journal.db
    .prepare('UPDATE attachment SET bytes=zeroblob(?) WHERE session_id=?')
    .run(MAX_SESSION_ATTACHMENT_BYTES, 'session-a');
  f.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', mimeType: 'image/png', data: 'YQ==' },
  });
  const view = mirror(f.store.doc('session-a'), 'session-a');
  strict.match((view.getState().history[1].items![0] as any).text, /会话容量/);
  view.dispose();
  strict.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment').get()!.n, 1);
  await f.host.attachmentAction(remove(full));
  f.store.journal.db.exec(
    "CREATE TRIGGER generated_snapshot_failure BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'synthetic output persistence failure'); END",
  );
  strict.throws(
    () =>
      f.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: 'YQ==' },
      }),
    /synthetic output persistence failure/,
  );
  strict.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment').get()!.n, 1);
  f.store.journal.db.exec('DROP TRIGGER generated_snapshot_failure');
  await f.finish();
  const recovered = mirror(f.store.doc('session-a'), 'session-a');
  strict.equal(
    recovered.getState().history[1].items!.some((item: any) => item.type === 'attachment'),
    false,
  );
  recovered.dispose();
});

test('live Agent capability downgrade never dispatches the already confirmed attachment turn', async (t) => {
  const f = fixture();
  t.after(f.close);
  const action = upload();
  await f.host.attachmentAction(action);
  f.setInputCapabilities({ image: false, audio: false, embeddedContext: false });
  const mutation = request(f, [action.attachment]),
    receipt = await f.host.mutate(mutation);
  await Promise.all([...f.host.active.values()].map((run) => run.done));
  strict.equal(receipt.delivered, true);
  strict.equal(f.opens(), 1);
  strict.equal(f.prompts.length, 0);
  const view = mirror(f.store.doc(action.sessionId), action.sessionId);
  strict.equal(view.getState().history[1].status, 'failed');
  strict.match((view.getState().history[1].items![0] as any).message, /不支持该附件类型/);
  view.dispose();
  strict.deepEqual(await f.host.mutate(mutation), receipt);
  strict.equal(f.opens(), 1);
});
