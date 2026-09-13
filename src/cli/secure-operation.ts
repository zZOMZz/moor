import { z } from 'zod';
import { id } from '../protocol';
import {
  encryptedProductTargetSchema,
  encryptedProductAuthoritySchema,
  encryptedProductActionSchema,
} from '../security/encrypted-product-catalog';
import { hostCommandSchema } from '../bridge/host-command';
import { e2eeDigestSchema, e2eeOriginSchema } from '../security/e2ee-trust';
import {
  sessionOriginalOperationSchema,
  type SessionOriginalOperation,
} from '../session-control-protocol';

export const secureTargetSchema = z
  .object({
    origin: e2eeOriginSchema,
    owner: id,
    rootKeyId: e2eeDigestSchema,
    clientDeviceId: id,
    hostDeviceId: id,
    workspaceId: id,
    localProjectId: id,
    userId: z.string().min(1).max(160),
    machineId: id,
    sessionId: id,
    product: encryptedProductTargetSchema.optional(),
  })
  .strict();
export type SecureCliTarget = z.infer<typeof secureTargetSchema>;
export const secureOperationSchema = z
  .object({
    operationId: id,
    kind: z.enum(['turn', 'create', 'stop', 'session-action']),
    target: secureTargetSchema,
    body: z.string().max(48 * 1024 * 1024),
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    state: z.enum(['pending', 'ending', 'accepted', 'abandoned', 'rejected']),
    createdAt: z.string().datetime(),
    receipt: z.unknown().optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    try {
      const command = hostCommandSchema.parse(JSON.parse(operation.body)),
        target = operation.target;
      const expected =
        operation.kind === 'turn'
          ? 'mutate'
          : operation.kind === 'session-action'
            ? 'session-action'
            : 'session-control';
      if (
        command.method !== expected ||
        command.workspaceId !== target.workspaceId ||
        command.localProjectId !== target.localProjectId
      )
        throw Error();
      const params = command.params as {
        operationId?: string;
        sessionId?: string;
        workspaceId?: string;
        localProjectId?: string;
        userId?: string;
        machineId?: string;
        action?: string;
      };
      if (
        params.operationId !== operation.operationId ||
        params.sessionId !== target.sessionId ||
        params.workspaceId !== target.workspaceId ||
        // Mutations bind the project through the command envelope and session document.
        (command.method !== 'mutate' && params.localProjectId !== target.localProjectId)
      )
        throw Error();
      if (
        command.method === 'session-control' &&
        (params.action !== operation.kind ||
          params.userId !== target.userId ||
          params.machineId !== target.machineId)
      )
        throw Error();
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid original encrypted operation' });
    }
  });
export type SecureCliOperation = z.infer<typeof secureOperationSchema>;
export function secureOriginal(operation: SecureCliOperation): SessionOriginalOperation {
  const command = hostCommandSchema.parse(JSON.parse(operation.body));
  return sessionOriginalOperationSchema.parse({
    kind:
      operation.kind === 'turn'
        ? 'mutation'
        : operation.kind === 'session-action'
          ? 'metadata'
          : 'control',
    value: command.params,
  });
}

/** Catalog mutations stay separate from session recovery and preserve their complete original action. */
export const secureCatalogTargetSchema = encryptedProductAuthoritySchema
  .extend({ clientDeviceId: id })
  .strict();
export const secureCatalogOperationSchema = z
  .object({
    operationId: id,
    target: secureCatalogTargetSchema,
    body: z.string().max(64 * 1024),
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    state: z.enum(['pending', 'ending', 'accepted', 'abandoned', 'rejected']),
    createdAt: z.string().datetime(),
    receipt: z.unknown().optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    try {
      const action = encryptedProductActionSchema.parse(JSON.parse(operation.body));
      if (action.operationId !== operation.operationId) throw Error();
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid original encrypted catalog operation' });
    }
  });
export type SecureCatalogTarget = z.infer<typeof secureCatalogTargetSchema>;
export type SecureCatalogOperation = z.infer<typeof secureCatalogOperationSchema>;
export function secureCatalogOriginal(operation: SecureCatalogOperation) {
  return encryptedProductActionSchema.parse(JSON.parse(operation.body));
}
