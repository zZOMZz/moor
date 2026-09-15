import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  snapshotVersion,
  previewAnnotationSnapshotSchema,
  type PreviewAnnotationSnapshot,
} from '../../apps/web/src/features/preview/project-preview';
import {
  validateWorkspaceAnnotations,
  validateWorkspacePreview,
} from '../../apps/web/src/features/preview/workspace-preview';
import type { GitTarget } from '../../apps/web/src/features/git/git-workspace';
import { previewPng, previewVersion, previewViewport } from '../fixtures/preview-fixture';

const target: GitTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const now = '2026-09-12T00:00:00.000Z';
async function savedAnnotations() {
  const { data, ...content } = previewPng();
  const snapshot: PreviewAnnotationSnapshot = previewAnnotationSnapshotSchema.parse({
    serviceId: 'service',
    serviceLabel: 'Synthetic service',
    pagePath: '/settings',
    frameId: 'frame',
    capturedAt: now,
    viewport: previewViewport,
    element: {
      elementId: 'element',
      tagName: 'button',
      role: 'button',
      name: 'Save',
      text: 'Synthetic page text',
      bounds: { x: 20, y: 90, width: 120, height: 40 },
    },
    note: 'Historical annotation',
    image: { content, data },
  });
  return {
    version: 1 as const,
    cacheRevision: 3,
    target,
    annotations: [
      {
        id: 'annotation',
        version: await snapshotVersion(snapshot),
        createdAt: now,
        selectionId: 'original-selection',
        snapshot,
      },
    ],
  };
}

test('retired annotations remain readable with their original image, version and selection', async () => {
  const record = await savedAnnotations(),
    before = structuredClone(record);
  assert.deepEqual(await validateWorkspaceAnnotations(record, target), before);
  assert.deepEqual(record, before);
  const textOnly = structuredClone(record);
  delete textOnly.annotations[0]!.snapshot.image;
  textOnly.annotations[0]!.version = await snapshotVersion(textOnly.annotations[0]!.snapshot);
  assert.deepEqual(await validateWorkspaceAnnotations(textOnly, target), textOnly);
});

test('retired annotation records reject changed identities, duplicates and modified snapshots', async () => {
  const record = await savedAnnotations();
  for (const key of Object.keys(target) as Array<keyof GitTarget>)
    await assert.rejects(validateWorkspaceAnnotations(record, { ...target, [key]: 'foreign' }));
  await assert.rejects(
    validateWorkspaceAnnotations(
      {
        ...record,
        annotations: [record.annotations[0], record.annotations[0]],
      },
      target,
    ),
  );
  const changed = structuredClone(record);
  changed.annotations[0]!.snapshot.note = 'Modified after review';
  await assert.rejects(validateWorkspaceAnnotations(changed, target), /保存的版本/);
});

test('retired image validation checks PNG bytes and dimensions even with a recomputed snapshot hash', async () => {
  const record = await savedAnnotations();
  for (const fault of ['length', 'digest', 'dimensions', 'signature'] as const) {
    const changed = structuredClone(record),
      item = changed.annotations[0]!,
      image = item.snapshot.image!;
    if (fault === 'length') image.content.byteLength++;
    if (fault === 'digest') image.content.version = 'sha256:' + '0'.repeat(64);
    if (fault === 'dimensions') item.snapshot.viewport.width++;
    if (fault === 'signature') {
      const bytes = Buffer.from(image.data, 'base64');
      bytes[0] = 0;
      image.data = bytes.toString('base64');
      image.content.version = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    }
    item.version =
      'sha256:' + createHash('sha256').update(JSON.stringify(item.snapshot)).digest('hex');
    await assert.rejects(
      validateWorkspaceAnnotations(changed, target),
      /截图内容与冻结版本不匹配/,
      fault,
    );
  }
});

test('retired preview requests retain original scope and cannot smuggle a live frame into stored state', () => {
  const open = {
    previewVersion: 1 as const,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    clientId: 'client',
    operationId: 'original-open',
    confirmed: true as const,
    action: 'open' as const,
    serviceId: 'service',
    serviceVersion: previewVersion,
    executionRevision: 1,
    viewport: previewViewport,
  };
  const record = {
    version: 1,
    cacheRevision: 2,
    target,
    open,
    pending: open,
    closing: false,
    uncertainClosed: false,
  };
  assert.deepEqual(validateWorkspacePreview(record, target), record);
  for (const key of ['workspaceId', 'localProjectId', 'sessionId', 'clientId'] as const)
    assert.throws(() =>
      validateWorkspacePreview({ ...record, pending: { ...open, [key]: 'foreign' } }, target),
    );
  assert.throws(() => validateWorkspacePreview({ ...record, open: undefined }, target));
  assert.throws(() => validateWorkspacePreview({ ...record, frame: {} }, target));
});
