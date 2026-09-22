import { z } from 'zod';
import { id, mutationSchema } from './protocol';
import { contentScopeSchema } from './content-protocol';
import { promptAttachmentsSchema } from './attachment-protocol';
import { runSelectionSchema } from './run-config';
import { permissionOutcomeSchema } from './permission-review';

export const SESSION_INTENTS_FEATURE = 'session-intents-v1';
export const SESSION_INTENT_LIMITS = {
  requestBytes: 1024 * 1024,
  responseBytes: 64 * 1024,
} as const;

// workspaceId retains its v3 wire meaning. All fields here describe the exact
// execution identity; the authenticated transport binds its account and device.
const intentScope = contentScopeSchema.extend({
  intentVersion: z.literal(1),
  sessionId: id.regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(160),
  machineId: id,
  operationId: id,
});

/** The Host supplies document edits, timestamps and execution state. */
export const sendTurnSchema = intentScope
  .extend({
    expectedTurnId: id.nullable(),
    agentId: id,
    turnId: id,
    prompt: z.string().max(100000),
    selection: runSelectionSchema,
    attachments: promptAttachmentsSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.prompt.trim() && input.attachments.length === 0)
      context.addIssue({ code: 'custom', message: '指令需要文本或已确认的附件' });
    if (input.turnId === input.expectedTurnId)
      context.addIssue({ code: 'custom', message: '新用户回合不能复用上一回合编号' });
  });

/** A decision cannot alter any other part of the tool, turn or session. */
export const respondPermissionSchema = intentScope
  .extend({
    expectedTurnId: id,
    requestId: id,
    permissionReview: mutationSchema.shape.permissionReview.unwrap(),
    outcome: permissionOutcomeSchema,
  })
  .strict();

export type SendTurn = z.infer<typeof sendTurnSchema>;
export type RespondPermission = z.infer<typeof respondPermissionSchema>;
export const sessionIntentCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send-turn'), value: sendTurnSchema }).strict(),
  z.object({ kind: z.literal('respond-permission'), value: respondPermissionSchema }).strict(),
]);
export type SessionIntentCommand = z.infer<typeof sessionIntentCommandSchema>;
