import { z } from 'zod';
import { approvalModeSchema } from './run-config';
import { accountUsageSchema } from './agent-usage';

export const AGENT_CONTROLS_FEATURE = 'agent-controls-v1';
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:-]+$/);
export const agentControlsScopeSchema = z
  .object({ agentId: id, sessionId: id.optional() })
  .strict();
export const agentUsageRequestSchema = agentControlsScopeSchema
  .extend({ refresh: z.boolean().optional() })
  .strict();
export type AgentUsageRequest = z.infer<typeof agentUsageRequestSchema>;
export const runPreferencesRequestSchema = z.discriminatedUnion('action', [
  agentControlsScopeSchema.extend({ action: z.literal('read') }).strict(),
  agentControlsScopeSchema
    .extend({
      action: z.literal('save'),
      modeId: approvalModeSchema,
      expectedRevision: z.number().int().nonnegative().safe(),
    })
    .strict(),
]);
export type RunPreferencesRequest = z.infer<typeof runPreferencesRequestSchema>;
export const runPreferencesSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    modeId: approvalModeSchema,
  })
  .strict();
export type RunPreferences = z.infer<typeof runPreferencesSchema>;
export const agentControlsResponseScopeSchema = z
  .object({
    workspaceId: id,
    userId: z.string().min(1).max(1000),
    machineId: id,
    localProjectId: id,
    sessionId: id.optional(),
    agentId: id,
  })
  .strict();
export const runPreferencesResponseSchema = z
  .object({ scope: agentControlsResponseScopeSchema, preferences: runPreferencesSchema })
  .strict();
export const agentUsageResponseSchema = z
  .object({ scope: agentControlsResponseScopeSchema, usage: accountUsageSchema })
  .strict();
