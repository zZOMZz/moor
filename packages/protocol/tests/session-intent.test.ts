import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTurnSchema, respondPermissionSchema } from '../src/session-intent-protocol';
import { PERMISSION_REVIEW_MAX_BYTES } from '../src/permission-review';

const scope = {
  intentVersion: 1,
  operationId: 'original',
  workspaceId: 'runtime',
  userId: 'user',
  machineId: 'machine',
  localProjectId: 'project',
  sessionId: 'session',
};
const send = {
  ...scope,
  expectedTurnId: null,
  agentId: 'fixed-agent',
  turnId: 'new-turn',
  prompt: 'Synthetic input',
  selection: {},
  attachments: [],
};
const permission = {
  ...scope,
  expectedTurnId: 'user-turn',
  requestId: 'request',
  permissionReview: { version: 1, assistantTurnId: 'assistant', itemJson: '{}' },
  outcome: { outcome: 'cancelled' },
};

test('narrow turn input rejects document edits, execution state and retired launch extensions', () => {
  assert.deepEqual(sendTurnSchema.parse(send), send);
  for (const extra of [
    { update: 'arbitrary-crdt' },
    { metaBundle: {} },
    { history: [] },
    { status: 'handled' },
    { timestamp: '2026-01-01T00:00:00.000Z' },
    { mcpServerIds: [] },
    { taskPlan: {} },
    { command: '/synthetic/executable' },
    { selection: { configOptionValues: { private: 'value' } } },
  ])
    assert.equal(sendTurnSchema.safeParse({ ...send, ...extra }).success, false);
  for (const changes of [
    { intentVersion: 2 },
    { expectedTurnId: 'new-turn' },
    { prompt: ' ' },
    { prompt: 'x'.repeat(100001) },
    { sessionId: '../other' },
    { machineId: '' },
    { attachments: undefined },
    { selection: undefined },
  ])
    assert.equal(sendTurnSchema.safeParse({ ...send, ...changes }).success, false);
});

test('narrow approvals require a complete bounded review, exact turn IDs and one finite outcome', () => {
  assert.deepEqual(respondPermissionSchema.parse(permission), permission);
  for (const changes of [
    { expectedTurnId: null },
    { requestId: '' },
    { update: 'arbitrary-crdt' },
    { permissionReview: undefined },
    { permissionReview: { ...permission.permissionReview, assistantTurnId: '' } },
    {
      permissionReview: {
        ...permission.permissionReview,
        itemJson: '界'.repeat(Math.ceil(PERMISSION_REVIEW_MAX_BYTES / 3)),
      },
    },
    { outcome: { outcome: 'selected' } },
    { outcome: { outcome: 'selected', optionId: 'allow\nforged' } },
    { outcome: { outcome: 'cancelled', optionId: 'allow' } },
  ])
    assert.equal(respondPermissionSchema.safeParse({ ...permission, ...changes }).success, false);
});
