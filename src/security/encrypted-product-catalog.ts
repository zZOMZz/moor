import { z } from 'zod';
import { id } from '../protocol';
import { projectSourceSchema } from '../catalog';
import { e2eeDigestSchema, e2eeOriginSchema } from './e2ee-trust';

export const ENCRYPTED_PRODUCT_LIMITS = Object.freeze({
  workspaces: 100,
  projects: 10000,
  replicas: 10000,
});
export const ENCRYPTED_PRODUCT_REJECTED = '主机产品目录或原操作范围不匹配';
const revision = z.number().int().nonnegative().safe();
const nextRevision = revision.max(Number.MAX_SAFE_INTEGER - 1);
const name = z.string().trim().min(1).max(200);
const source = z.discriminatedUnion('kind', [
  projectSourceSchema.options[0].strict(),
  projectSourceSchema.options[1].strict(),
]);
export const encryptedProductAuthoritySchema = z
  .object({
    serverOrigin: e2eeOriginSchema,
    accountId: id,
    rootKeyId: e2eeDigestSchema,
    hostDeviceId: id,
  })
  .strict();
export type EncryptedProductAuthority = z.infer<typeof encryptedProductAuthoritySchema>;
export const encryptedProductTargetSchema = z
  .object({ catalogWorkspaceId: id, projectId: id, replicaId: id, revision: revision.positive() })
  .strict();
export type EncryptedProductTarget = z.infer<typeof encryptedProductTargetSchema>;
export const encryptedProductCatalogSchema = z
  .object({
    version: z.literal(1),
    authority: encryptedProductAuthoritySchema,
    revision,
    workspaces: z.array(z.object({ id, name }).strict()).max(ENCRYPTED_PRODUCT_LIMITS.workspaces),
    projects: z
      .array(z.object({ id, workspaceId: id, name, source }).strict())
      .max(ENCRYPTED_PRODUCT_LIMITS.projects),
    replicas: z
      .array(
        z
          .object({
            id,
            catalogWorkspaceId: id,
            projectId: id,
            revision: revision.positive(),
            runtimeWorkspaceId: id,
            localProjectId: id,
            machineId: id,
            userId: z.string().min(1).max(160),
            available: z.boolean(),
          })
          .strict(),
      )
      .max(ENCRYPTED_PRODUCT_LIMITS.replicas),
  })
  .strict()
  .superRefine((catalog, context) => {
    const workspaces = new Set(catalog.workspaces.map((entry) => entry.id));
    const projects = new Map(catalog.projects.map((entry) => [entry.id, entry]));
    const replicas = new Set(catalog.replicas.map((entry) => entry.id));
    const runtimeProjects = new Set<string>();
    const runtimeWorkspaces = new Map<string, string>();
    let invalid =
      workspaces.size !== catalog.workspaces.length ||
      projects.size !== catalog.projects.length ||
      replicas.size !== catalog.replicas.length;
    for (const project of catalog.projects) invalid ||= !workspaces.has(project.workspaceId);
    for (const replica of catalog.replicas) {
      const runtimeProject = JSON.stringify([replica.runtimeWorkspaceId, replica.localProjectId]);
      invalid ||=
        projects.get(replica.projectId)?.workspaceId !== replica.catalogWorkspaceId ||
        runtimeProjects.has(runtimeProject);
      invalid ||=
        runtimeWorkspaces.has(replica.runtimeWorkspaceId) &&
        runtimeWorkspaces.get(replica.runtimeWorkspaceId) !== replica.catalogWorkspaceId;
      runtimeProjects.add(runtimeProject);
      runtimeWorkspaces.set(replica.runtimeWorkspaceId, replica.catalogWorkspaceId);
    }
    if (invalid) context.addIssue({ code: 'custom', message: ENCRYPTED_PRODUCT_REJECTED });
  });
export type EncryptedProductCatalog = z.infer<typeof encryptedProductCatalogSchema>;
const actionBase = z.object({
  version: z.literal(1),
  operationId: id,
  expectedRevision: nextRevision,
});
export const encryptedProductActionSchema = z.discriminatedUnion('action', [
  actionBase.extend({ action: z.literal('create-workspace'), id, name }).strict(),
  actionBase.extend({ action: z.literal('rename-workspace'), workspaceId: id, name }).strict(),
  actionBase
    .extend({ action: z.literal('create-project'), workspaceId: id, id, name, source })
    .strict(),
  actionBase
    .extend({
      action: z.literal('assign-replica'),
      replicaId: id,
      projectId: id,
      expectedReplicaRevision: nextRevision.positive(),
    })
    .strict(),
  actionBase
    .extend({ action: z.literal('move-host'), runtimeWorkspaceId: id, targetWorkspaceId: id })
    .strict(),
]);
export type EncryptedProductAction = z.infer<typeof encryptedProductActionSchema>;
export const encryptedProductReceiptSchema = z
  .object({
    version: z.literal(1),
    authority: encryptedProductAuthoritySchema,
    confirmed: z.literal(true),
    operationId: id,
    request: encryptedProductActionSchema,
    status: z.enum(['accepted', 'abandoned']),
    revision,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.operationId !== receipt.request.operationId ||
      (receipt.status === 'accepted' && receipt.revision !== receipt.request.expectedRevision + 1)
    )
      context.addIssue({ code: 'custom', message: ENCRYPTED_PRODUCT_REJECTED });
  });
export type EncryptedProductReceipt = z.infer<typeof encryptedProductReceiptSchema>;
const inspectionBase = z.object({
  version: z.literal(1),
  authority: encryptedProductAuthoritySchema,
  confirmed: z.literal(true),
  request: encryptedProductActionSchema,
});
export const encryptedProductInspectionSchema = z
  .discriminatedUnion('found', [
    inspectionBase.extend({ found: z.literal(false) }).strict(),
    inspectionBase
      .extend({ found: z.literal(true), receipt: encryptedProductReceiptSchema })
      .strict(),
  ])
  .superRefine((inspection, context) => {
    if (
      inspection.found &&
      (productCanonicalJson(inspection.request) !==
        productCanonicalJson(inspection.receipt.request) ||
        productCanonicalJson(inspection.authority) !==
          productCanonicalJson(inspection.receipt.authority))
    )
      context.addIssue({ code: 'custom', message: ENCRYPTED_PRODUCT_REJECTED });
  });
export type EncryptedProductInspection = z.infer<typeof encryptedProductInspectionSchema>;

/** Stable across JSON property order; never traverses inherited object properties. */
export function productCanonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)]),
      );
    return input;
  };
  return JSON.stringify(normalize(value));
}
function sameAuthority(
  actual: EncryptedProductAuthority,
  expected: EncryptedProductAuthority,
): void {
  if (
    productCanonicalJson(actual) !==
    productCanonicalJson(encryptedProductAuthoritySchema.parse(expected))
  )
    throw Error(ENCRYPTED_PRODUCT_REJECTED);
}
export function validateEncryptedProductCatalog(
  value: unknown,
  authority: EncryptedProductAuthority,
): EncryptedProductCatalog {
  const parsed = encryptedProductCatalogSchema.parse(value);
  sameAuthority(parsed.authority, authority);
  return parsed;
}
export function validateEncryptedProductReceipt(
  value: unknown,
  authority: EncryptedProductAuthority,
  request: EncryptedProductAction,
): EncryptedProductReceipt {
  const parsed = encryptedProductReceiptSchema.parse(value);
  sameAuthority(parsed.authority, authority);
  if (
    productCanonicalJson(parsed.request) !==
    productCanonicalJson(encryptedProductActionSchema.parse(request))
  )
    throw Error(ENCRYPTED_PRODUCT_REJECTED);
  return parsed;
}
export function validateEncryptedProductInspection(
  value: unknown,
  authority: EncryptedProductAuthority,
  request: EncryptedProductAction,
): EncryptedProductInspection {
  const parsed = encryptedProductInspectionSchema.parse(value);
  sameAuthority(parsed.authority, authority);
  if (
    productCanonicalJson(parsed.request) !==
    productCanonicalJson(encryptedProductActionSchema.parse(request))
  )
    throw Error(ENCRYPTED_PRODUCT_REJECTED);
  return parsed;
}
