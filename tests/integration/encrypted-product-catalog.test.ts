import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENCRYPTED_PRODUCT_LIMITS,
  encryptedProductActionSchema,
  encryptedProductCatalogSchema,
  encryptedProductReceiptSchema,
  encryptedProductTargetSchema,
  validateEncryptedProductCatalog,
  validateEncryptedProductInspection,
  validateEncryptedProductReceipt,
  type EncryptedProductAction,
  type EncryptedProductCatalog,
  type EncryptedProductReceipt,
} from '@moor/e2ee/encrypted-product-catalog';

const authority = {
  serverOrigin: 'https://relay.example',
  accountId: 'account',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  hostDeviceId: 'host',
};
const catalog: EncryptedProductCatalog = {
  version: 1,
  authority,
  revision: 1,
  workspaces: [{ id: 'space', name: 'Space' }],
  projects: [{ id: 'project', workspaceId: 'space', name: 'Project', source: { kind: 'local' } }],
  replicas: [
    {
      id: 'replica',
      catalogWorkspaceId: 'space',
      projectId: 'project',
      revision: 1,
      runtimeWorkspaceId: 'runtime',
      localProjectId: 'local',
      machineId: 'machine',
      userId: 'user',
      available: true,
    },
  ],
};
const request: EncryptedProductAction = {
  version: 1,
  operationId: 'operation',
  expectedRevision: 1,
  action: 'create-workspace',
  id: 'space2',
  name: 'Space 2',
};
const receipt: EncryptedProductReceipt = {
  version: 1,
  authority,
  confirmed: true,
  operationId: 'operation',
  request,
  status: 'accepted',
  revision: 2,
};

test('product snapshots reject unknown fields, duplicate and broken cross-table identities', () => {
  assert.deepEqual(validateEncryptedProductCatalog(catalog, authority), catalog);
  for (const change of [
    { extra: true },
    { version: 2 },
    { revision: -1 },
    { workspaces: [...catalog.workspaces, ...catalog.workspaces] },
    { projects: [...catalog.projects, ...catalog.projects] },
    { replicas: [...catalog.replicas, ...catalog.replicas] },
    { projects: [{ ...catalog.projects[0]!, workspaceId: 'missing' }] },
    { replicas: [{ ...catalog.replicas[0]!, catalogWorkspaceId: 'missing' }] },
    { replicas: [{ ...catalog.replicas[0]!, projectId: 'missing' }] },
    { replicas: [{ ...catalog.replicas[0]!, revision: 0 }] },
    { replicas: [{ ...catalog.replicas[0]!, extra: true }] },
    {
      projects: [{ ...catalog.projects[0]!, source: { kind: 'local', password: 'must-not-pass' } }],
    },
    { authority: { ...authority, rootKeyId: 'not-a-digest' } },
  ])
    assert.equal(encryptedProductCatalogSchema.safeParse({ ...catalog, ...change }).success, false);
  const split = structuredClone(catalog);
  split.workspaces.push({ id: 'other', name: 'Other' });
  split.projects.push({
    id: 'other-project',
    workspaceId: 'other',
    name: 'Other',
    source: { kind: 'local' },
  });
  split.replicas.push({
    ...split.replicas[0]!,
    id: 'other-replica',
    localProjectId: 'other-local',
    catalogWorkspaceId: 'other',
    projectId: 'other-project',
  });
  assert.equal(
    encryptedProductCatalogSchema.safeParse(split).success,
    false,
    'one runtime cannot belong to two product workspaces',
  );
});

test('bounded snapshots and actions reject oversized collections, names and credential-bearing sources', () => {
  assert.equal(
    encryptedProductCatalogSchema.safeParse({
      ...catalog,
      workspaces: Array.from({ length: ENCRYPTED_PRODUCT_LIMITS.workspaces + 1 }, (_, index) => ({
        id: `space_${index}`,
        name: 'Space',
      })),
    }).success,
    false,
  );
  assert.equal(
    encryptedProductCatalogSchema.safeParse({
      ...catalog,
      projects: Array.from({ length: ENCRYPTED_PRODUCT_LIMITS.projects + 1 }, (_, index) => ({
        ...catalog.projects[0]!,
        id: `project_${index}`,
      })),
    }).success,
    false,
  );
  assert.equal(
    encryptedProductCatalogSchema.safeParse({
      ...catalog,
      replicas: Array.from({ length: ENCRYPTED_PRODUCT_LIMITS.replicas + 1 }, (_, index) => ({
        ...catalog.replicas[0]!,
        id: `replica_${index}`,
        localProjectId: `local_${index}`,
      })),
    }).success,
    false,
  );
  for (const change of [
    { name: 'x'.repeat(201) },
    { name: '' },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { operationId: 'bad/slash' },
    { extra: true },
  ])
    assert.equal(encryptedProductActionSchema.safeParse({ ...request, ...change }).success, false);
  for (const url of [
    'https://user:password@example.com/repo',
    'https://example.com/repo?secret=key',
    'https://example.com/repo#secret',
    'file:///private/repo',
  ])
    assert.equal(
      encryptedProductActionSchema.safeParse({
        version: 1,
        operationId: 'create-project',
        expectedRevision: 0,
        action: 'create-project',
        workspaceId: 'space',
        id: 'project',
        name: 'Project',
        source: { kind: 'git', provider: 'other', url },
      }).success,
      false,
    );
  assert.equal(
    encryptedProductTargetSchema.safeParse({
      catalogWorkspaceId: 'space',
      projectId: 'project',
      replicaId: 'replica',
      revision: 1,
      rootPath: '/private',
    }).success,
    false,
  );
});

test('catalog, receipt and inspection are bound to exact authority and original validated action', () => {
  assert.deepEqual(validateEncryptedProductReceipt(receipt, authority, request), receipt);
  const inspection = { version: 1, authority, confirmed: true, request, found: true, receipt };
  assert.deepEqual(validateEncryptedProductInspection(inspection, authority, request), inspection);
  for (const change of [
    { accountId: 'other' },
    { hostDeviceId: 'other' },
    { serverOrigin: 'https://other.example' },
    { rootKeyId: Buffer.alloc(32, 2).toString('base64url') },
  ]) {
    const wrong = { ...authority, ...change };
    assert.throws(() => validateEncryptedProductCatalog(catalog, wrong));
    assert.throws(() => validateEncryptedProductReceipt(receipt, wrong, request));
    assert.throws(() => validateEncryptedProductInspection(inspection, wrong, request));
  }
  assert.throws(() =>
    validateEncryptedProductReceipt(receipt, authority, { ...request, name: 'Changed' }),
  );
  assert.throws(() =>
    validateEncryptedProductInspection(
      { ...inspection, receipt: { ...receipt, request: { ...request, id: 'different' } } },
      authority,
      request,
    ),
  );
  for (const change of [
    { operationId: 'other' },
    { revision: 1 },
    { revision: 3 },
    { extra: true },
  ])
    assert.equal(encryptedProductReceiptSchema.safeParse({ ...receipt, ...change }).success, false);
  const abandoned = { ...receipt, status: 'abandoned', revision: 10 };
  assert.deepEqual(validateEncryptedProductReceipt(abandoned, authority, request), abandoned);
});
