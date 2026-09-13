import test from 'node:test';
import assert from 'node:assert/strict';
import { Flock, LoroDoc, delta, mirror, putMeta } from '../src/model';
import { buildSessionTurn } from '../src/session-client';
import { validateMutation } from '../src/bridge/validate-mutation';
import type { AttachmentReference } from '../src/content-protocol';

const scope = {
  userId: 'owner',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
};
const agent = {
  id: 'agent',
  name: 'Synthetic',
  cliType: 'custom',
  agentType: 'synthetic',
  inputCapabilities: { image: true, audio: true, embeddedContext: true },
};
const workspace = {
  id: scope.workspaceId,
  name: 'Synthetic',
  userId: scope.userId,
  machineId: scope.machineId,
  projects: [{ id: scope.localProjectId, name: 'Project', rootPath: '/synthetic' }],
  agents: [agent],
};
function reference(attachmentId: string, mediaType = 'text/plain'): AttachmentReference {
  return {
    contentVersion: 1,
    attachmentId,
    name: `${attachmentId}.txt`,
    content: { version: 'sha256:' + 'a'.repeat(64), byteLength: 1, mediaType },
  };
}
function fixture() {
  const doc = new LoroDoc(),
    flock = new Flock(),
    view = mirror(doc, scope.sessionId);
  const meta = {
    id: scope.sessionId,
    userId: scope.userId,
    machineId: scope.machineId,
    project: { kind: 'local', localProjectId: scope.localProjectId },
    agentConfigId: agent.id,
    cliType: agent.cliType,
    agentType: agent.agentType,
    isArchived: false,
  };
  view.setState((state) => {
    state.session.id = scope.sessionId;
  });
  doc.commit();
  view.dispose();
  putMeta(flock, 'session-' + scope.sessionId, meta);
  const read = {
    meta,
    metaBundle: flock.exportJson(),
    update: delta(doc),
    synced: true,
    online: true,
    persisted: true,
    agent,
  };
  const input = {
    scope,
    read,
    agent,
    prompt: 'Synthetic attachments',
    operationId: 'operation',
    turnId: 'turn',
    peerId: 'abcd1234',
    now: '2026-01-01T00:00:00.000Z',
  };
  return { doc, flock, input, close: () => doc.free() };
}

for (const prompt of ['Synthetic attachments', ''])
  test(`turn builder preserves confirmed attachment order in input and history for ${prompt ? 'text plus files' : 'files only'}`, (t) => {
    const f = fixture();
    t.after(f.close);
    const attachments = [
      reference('image', 'image/png'),
      reference('audio', 'audio/wav'),
      reference('text'),
    ];
    const mutation = buildSessionTurn({ ...f.input, prompt, attachments });
    const accepted = validateMutation(f.doc, f.flock, workspace, mutation),
      view = mirror(accepted.doc, scope.sessionId);
    try {
      const turn = view.getState().history[0];
      assert.deepEqual((turn.inputConfig as { attachments?: unknown })?.attachments, attachments);
      assert.deepEqual(turn.items, [
        { type: 'text', text: prompt },
        ...attachments.map((attachment) => ({ type: 'attachment', attachment })),
      ]);
      assert.equal(mutation.expectedTurnId, null);
      const original = mirror(f.doc, scope.sessionId);
      assert.deepEqual(original.getState().history, []);
      original.dispose();
    } finally {
      view.dispose();
      accepted.doc.free();
    }
  });

test('attachment turn validation enforces eight unique bounded references and advertised Agent capability', (t) => {
  const f = fixture();
  t.after(f.close);
  for (const attachments of [
    [reference('duplicate'), reference('duplicate')],
    Array.from({ length: 9 }, (_, i) => reference(`file-${i}`)),
    [
      {
        ...reference('large'),
        content: { ...reference('large').content, byteLength: 8 * 1024 * 1024 + 1 },
      },
    ],
  ])
    assert.throws(() => buildSessionTurn({ ...f.input, attachments }));
  for (const [capability, mediaType] of [
    ['image', 'image/png'],
    ['audio', 'audio/wav'],
    ['embeddedContext', 'text/plain'],
  ] as const)
    assert.throws(
      () =>
        buildSessionTurn({
          ...f.input,
          agent: {
            ...agent,
            inputCapabilities: { ...agent.inputCapabilities, [capability]: false },
          },
          attachments: [reference('unsupported', mediaType)],
        }),
      /不支持/,
    );
  assert.throws(
    () =>
      buildSessionTurn({
        ...f.input,
        agent: { ...agent, inputCapabilities: undefined },
        attachments: [reference('unknown')],
      }),
    /不支持/,
  );
  assert.throws(() => buildSessionTurn({ ...f.input, prompt: '', attachments: [] }), /文本或附件/);
  assert.doesNotThrow(() => buildSessionTurn(f.input));
});
