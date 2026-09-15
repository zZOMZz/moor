import { z } from 'zod';
import { id, mutationSchema } from '../protocol';
import { attachmentReceiptSchema, MAX_SESSION_ATTACHMENT_BYTES } from '../attachment-protocol';
import { PREVIEW_ANNOTATION_LIMIT, previewAnnotationSchema } from '../web/project-preview';
import { MCP_LIMITS, mcpServerIdsSchema, mcpServerViewSchema } from '../mcp-protocol';
import {
  encryptedProductTargetSchema,
  encryptedProductAuthoritySchema,
  encryptedProductActionSchema,
} from '../security/encrypted-product-catalog';
import { hostCommandSchema } from '../bridge/host-command';
import { e2eeDigestSchema, e2eeOriginSchema } from '../security/e2ee-trust';
import {
  sessionOriginalOperationSchema,
  validateSessionControlReceipt,
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
export const secureMcpReviewSchema = z
  .object({ reviewId: id, servers: z.array(mcpServerViewSchema).max(MCP_LIMITS.selected) })
  .strict()
  .superRefine((review, context) => {
    if (!mcpServerIdsSchema.safeParse(review.servers.map((server) => server.id)).success)
      context.addIssue({ code: 'custom', message: 'Invalid immutable MCP review' });
  });
export const securePreviewReviewSchema = z
  .object({ annotations: z.array(previewAnnotationSchema).min(1).max(PREVIEW_ANNOTATION_LIMIT) })
  .strict()
  .superRefine((review, context) => {
    if (
      review.annotations.some((item) => !item.selectionId) ||
      new Set(review.annotations.map((item) => item.id)).size !== review.annotations.length ||
      review.annotations.reduce(
        (bytes, item) => bytes + (item.snapshot.image?.content.byteLength ?? 0),
        0,
      ) > MAX_SESSION_ATTACHMENT_BYTES
    )
      context.addIssue({ code: 'custom', message: 'Invalid immutable preview annotation review' });
  });
export const secureOperationSchema = z
  .object({
    operationId: id,
    kind: z.enum([
      'turn',
      'permission',
      'create',
      'stop',
      'session-action',
      'attachment-upload',
      'attachment-remove',
    ]),
    target: secureTargetSchema,
    body: z.string().max(48 * 1024 * 1024),
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    state: z.enum(['pending', 'ending', 'accepted', 'abandoned', 'rejected']),
    createdAt: z.string().datetime(),
    receipt: z.unknown().optional(),
    mcpReview: secureMcpReviewSchema.optional(),
    previewReview: securePreviewReviewSchema.optional(),
    userTurnId: id.optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    try {
      const raw = JSON.parse(operation.body),
        command = hostCommandSchema.parse(raw),
        target = operation.target;
      if (
        (operation.mcpReview || operation.previewReview || operation.userTurnId !== undefined) &&
        operation.kind !== 'turn'
      )
        throw Error();
      if (operation.previewReview && !operation.userTurnId) throw Error();
      const expected =
        operation.kind === 'turn' || operation.kind === 'permission'
          ? 'mutate'
          : operation.kind.startsWith('attachment-')
            ? 'attachment-action'
            : operation.kind === 'session-action'
              ? 'session-action'
              : 'session-control';
      if (
        command.method !== expected ||
        command.workspaceId !== target.workspaceId ||
        command.localProjectId !== target.localProjectId
      )
        throw Error();
      if (command.method === 'mutate') {
        if (command.params.kind !== operation.kind) throw Error();
        if (operation.kind === 'permission') {
          mutationSchema.strict().parse(raw.params);
          if (!Object.hasOwn(raw.params, 'permissionReview')) throw Error();
          id.parse(command.params.expectedTurnId);
          id.parse(command.params.requestId);
        }
      }
      if (command.method === 'attachment-action') {
        if (operation.kind !== `attachment-${command.params.action}`) throw Error();
        if (operation.state === 'accepted' || operation.state === 'abandoned') {
          const direct = attachmentReceiptSchema.safeParse(operation.receipt);
          const recovered = direct.success
            ? undefined
            : validateSessionControlReceipt(
                operation.receipt,
                { controlVersion: 1, ...target },
                { kind: 'attachment', value: command.params },
              );
          if (operation.state === 'abandoned') {
            if (recovered?.status !== 'abandoned') throw Error();
          } else {
            if (recovered && recovered.status !== 'accepted') throw Error();
            const receipt = direct.success ? direct.data : recovered!.attachmentReceipt!;
            if (
              receipt.operationId !== operation.operationId ||
              receipt.workspaceId !== target.workspaceId ||
              receipt.localProjectId !== target.localProjectId ||
              receipt.sessionId !== target.sessionId ||
              (command.params.action === 'upload'
                ? JSON.stringify(receipt.attachment) !== JSON.stringify(command.params.attachment)
                : receipt.removed !== true)
            )
              throw Error();
          }
        }
      }
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
/** Keep historical digests byte-compatible while binding new, explicitly reviewed MCP metadata. */
export function secureOperationDigestSource(
  value: Pick<SecureCliOperation, 'body' | 'target' | 'mcpReview' | 'previewReview' | 'userTurnId'>,
) {
  const target = secureTargetSchema.parse(value.target);
  if (value.previewReview !== undefined)
    return JSON.stringify([
      'reviewed-preview-turn-command-v1',
      target,
      value.body,
      value.mcpReview === undefined ? null : secureMcpReviewSchema.parse(value.mcpReview),
      id.parse(value.userTurnId),
      securePreviewReviewSchema.parse(value.previewReview),
    ]);
  if (value.userTurnId !== undefined)
    return JSON.stringify([
      'bound-user-turn-command-v1',
      target,
      value.body,
      value.mcpReview === undefined ? null : secureMcpReviewSchema.parse(value.mcpReview),
      id.parse(value.userTurnId),
    ]);
  if (value.mcpReview !== undefined)
    return JSON.stringify([
      'reviewed-mcp-command-v1',
      target,
      value.body,
      secureMcpReviewSchema.parse(value.mcpReview),
    ]);
  return target.product ? JSON.stringify(['mapped-command', target, value.body]) : value.body;
}
export function secureOriginal(operation: SecureCliOperation): SessionOriginalOperation {
  const command = hostCommandSchema.parse(JSON.parse(operation.body));
  return sessionOriginalOperationSchema.parse({
    kind:
      operation.kind === 'turn' || operation.kind === 'permission'
        ? 'mutation'
        : operation.kind === 'session-action'
          ? 'metadata'
          : operation.kind === 'attachment-upload' || operation.kind === 'attachment-remove'
            ? 'attachment'
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
export type SecureCatalogOperation = z.infer<typeof secureCatalogOperationSchema>;
export function secureCatalogOriginal(operation: SecureCatalogOperation) {
  return encryptedProductActionSchema.parse(JSON.parse(operation.body));
}
