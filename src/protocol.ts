import { z } from 'zod';
import { runCapabilitiesSchema } from './run-config';

export const PROTOCOL = 3;
export const AGENT_VERSIONS_FEATURE = 'agent-versions-v1';
export const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:-]+$/);
export const localProjectSchema = z.object({
  id,
  name: z.string().max(200),
  rootPath: z.string().max(4096),
});
export const agentSchema = z.object({
  id,
  name: z.string().max(200),
  cliType: z.string(),
  agentType: z.string(),
  runConfig: runCapabilitiesSchema.optional(),
  inputCapabilities: z
    .object({ image: z.boolean(), audio: z.boolean(), embeddedContext: z.boolean() })
    .strict()
    .optional(),
});
// Execution-host scope; product workspaces organize these independently.
export const runtimeWorkspaceSchema = z.object({
  id,
  name: z.string(),
  userId: z.string(),
  machineId: id,
  projects: z.array(localProjectSchema).max(500),
  agents: z.array(agentSchema).max(100),
  features: z.array(id).max(20).optional(),
});
export type RuntimeWorkspace = z.infer<typeof runtimeWorkspaceSchema>;
export const helloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL),
  machineId: id,
  workspaces: z.array(runtimeWorkspaceSchema).max(20),
});
export const mutationSchema = z.object({
  operationId: id,
  sessionId: id,
  workspaceId: id,
  kind: z.enum(['turn', 'permission']),
  expectedTurnId: z.string().nullable(),
  requestId: z.string().optional(),
  update: z.string().max(44000000),
  metaBundle: z.unknown().optional(),
});
export type Mutation = z.infer<typeof mutationSchema>;
const sessionActionBase = z.object({
  operationId: id,
  workspaceId: id,
  sessionId: id,
  localProjectId: id,
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
});
export const sessionActionSchema = z.discriminatedUnion('action', [
  sessionActionBase
    .extend({ action: z.literal('rename'), title: z.string().trim().min(1).max(200) })
    .strict(),
  sessionActionBase.extend({ action: z.literal('archive') }).strict(),
  sessionActionBase.extend({ action: z.literal('restore') }).strict(),
  sessionActionBase.extend({ action: z.literal('pin') }).strict(),
  sessionActionBase.extend({ action: z.literal('unpin') }).strict(),
]);
export type SessionAction = z.infer<typeof sessionActionSchema>;
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public rejected = false,
  ) {
    super(message);
  }
}
export function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new AppError(status, message);
}
