import { actorSchema } from '@moor/protocol/attention';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import { mutationSchema, type Mutation } from '@moor/protocol/protocol';
import { runSelectionSchema } from '@moor/protocol/run-config';
import { sessionOriginalOperationSchema } from '@moor/protocol/session-control-protocol';
import {
  workspaceProjectTargetSchema,
  workspaceSourceSchema,
} from '@moor/protocol/workspace-client-protocol';
import { z } from 'zod';
import { workspaceAttachmentDraftSchema } from '../../features/attachments/workspace-attachments';
import { workspaceAttentionBucketSchema } from '../../features/attention/workspace-attention';
import { forkStoredSchema } from '../../features/fork/session-fork';
import { gitStoredSchema } from '../../features/git/git-workspace';
import { githubStoredSchema } from '../../features/github/github';
import { githubWriteStoredSchema } from '../../features/github/github-write';
import { interactionSavedSchema } from '../../features/interactions/interactions';
import { mcpReviewSchema, mcpStoredSchema } from '../../features/mcp/mcp';
import {
  previewAnnotationsStoredSchema,
  previewAnnotationSubmissionSchema,
  previewStoredSchema,
} from '../../features/preview/project-preview';
import { roleAppliedSchema, rolesStoredSchema } from '../../features/roles/roles';
import { taskReviewedSchema, tasksStoredSchema } from '../../features/tasks/tasks';
export async function mutationVersion(mutation: Mutation) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(mutationSchema.parse(mutation))),
  );
  return (
    'sha256:' +
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
export const interactionDocumentSchema = z
  .object({ revision: z.number().int().nonnegative().safe(), value: interactionSavedSchema })
  .strict();
export const scopeSchema = z
  .object({
    source: workspaceSourceSchema,
    target: workspaceProjectTargetSchema.omit({ sessionId: true }).strict(),
  })
  .strict();
export type WorkspaceScope = z.infer<typeof scopeSchema>;
export const draftSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    text: z.string().max(100000),
    selection: runSelectionSchema,
    actor: actorSchema.optional(),
  })
  .strict();
export type WorkspaceDraft = z.infer<typeof draftSchema>;
export const draftDocumentSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    sessionId: z.string(),
    value: draftSchema,
  })
  .strict();
export const operationSchema = z
  .object({
    original: sessionOriginalOperationSchema,
    mcpReview: mcpReviewSchema.optional(),
    taskReview: taskReviewedSchema.optional(),
    annotations: previewAnnotationSubmissionSchema.optional(),
    draft: z
      .object({
        sessionId: z.string(),
        revision: z.number().int().nonnegative().safe(),
        attachmentRevision: z.number().int().nonnegative().safe().optional(),
        mcpRevision: z.number().int().nonnegative().safe().optional(),
        taskRevision: z.number().int().nonnegative().safe().optional(),
        annotationRevision: z.number().int().nonnegative().safe().optional(),
      })
      .strict()
      .optional(),
    status: z.enum(['pending', 'confirmed', 'abandoned']),
  })
  .strict();
export type WorkspaceOperation = z.infer<typeof operationSchema>;
export const ledgerSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    revision: z.number().int().nonnegative().safe(),
    operations: z.array(operationSchema),
    attachments: z.record(workspaceAttachmentDraftSchema).optional(),
    interactions: z.record(interactionDocumentSchema).optional(),
    mcp: z.record(mcpStoredSchema).optional(),
    tasks: z.record(tasksStoredSchema).optional(),
    git: z.record(gitStoredSchema).optional(),
    github: z.record(githubStoredSchema).optional(),
    attention: z.record(workspaceAttentionBucketSchema).optional(),
    githubWrite: z.record(githubWriteStoredSchema).optional(),
    forks: z.record(forkStoredSchema).optional(),
    roles: z.record(rolesStoredSchema).optional(),
    roleApplied: z.record(roleAppliedSchema).optional(),
    previews: z.record(previewStoredSchema).optional(),
    annotations: z.record(previewAnnotationsStoredSchema).optional(),
  })
  .strict();
export type WorkspaceLedger = z.infer<typeof ledgerSchema>;
export function sessionPendingOperations(ledger: WorkspaceLedger | undefined, sessionId: string) {
  return (
    ledger?.operations.filter(
      (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
    ) ?? []
  );
}
export const storedLedgerSchema = ledgerSchema
  .extend({
    operations: z.array(operationSchema).max(512),
    // Version 1 originally mixed recoverable composer drafts into the reliable
    // operation ledger. Keep this field readable only long enough to migrate it.
    drafts: z.record(draftSchema).optional(),
  })
  .strict();
export const emptyDraft = (): WorkspaceDraft => ({ revision: 0, text: '', selection: {} });
export const conflict = () => Error('草稿或原操作已在另一页面改变，请重新读取后继续。');
export const keyFor = (scope: WorkspaceScope) =>
  canonical(['moor-desktop-ledger-v1', scopeSchema.parse(scope)]);
export const draftKeyFor = (scope: WorkspaceScope, sessionId: string) =>
  canonical([
    'moor-desktop-draft-v1',
    scopeSchema.parse(scope),
    workspaceProjectTargetSchema.parse({ ...scope.target, sessionId }).sessionId,
  ]);
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
