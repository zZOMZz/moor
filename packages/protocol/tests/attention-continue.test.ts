import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionContinueSchema, attentionContinueInput } from '../src/attention';
import { sendTurnSchema } from '../src/session-intent-protocol';

test('legacy attention originals retain their serialized field order, update bytes and metadata', () => {
  const saved =
    '{"mutation":{"operationId":"old-operation","sessionId":"session","workspaceId":"runtime","kind":"turn","expectedTurnId":"old-user","update":"bGVnYWN5LW9yaWdpbmFs","metaBundle":{"version":1,"entries":{}}},"eventRevision":2,"observationRevision":1}';
  const parsed = attentionContinueSchema.parse(JSON.parse(saved));
  assert.equal(JSON.stringify(parsed), saved);
  assert.equal(attentionContinueInput(parsed).operationId, 'old-operation');
});

test('typed attention continuation accepts only a scoped SendTurn and cannot carry CRDT edits or both wire formats', () => {
  const turn = sendTurnSchema.parse({
    intentVersion: 1,
    workspaceId: 'runtime',
    localProjectId: 'project',
    sessionId: 'session',
    userId: 'user',
    machineId: 'machine',
    operationId: 'operation',
    agentId: 'agent',
    expectedTurnId: 'previous',
    turnId: 'new-user',
    prompt: 'Reviewed followup',
    selection: {},
    attachments: [],
  });
  const input = { turn, eventRevision: 2, observationRevision: 1 };
  assert.deepEqual(attentionContinueInput(attentionContinueSchema.parse(input)), turn);
  assert.equal('update' in turn, false);
  assert.equal('metaBundle' in turn, false);
  for (const extra of [
    { update: 'hidden' },
    { metaBundle: {} },
    { mcpServerIds: [] },
    { taskPlan: {} },
  ])
    assert.equal(
      attentionContinueSchema.safeParse({ ...input, turn: { ...turn, ...extra } }).success,
      false,
    );
  assert.equal(attentionContinueSchema.safeParse({ ...input, mutation: {} }).success, false);
});
