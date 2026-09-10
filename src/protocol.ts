import { z } from 'zod';

export const PROTOCOL = 1;
export const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:-]+$/);
export const projectSchema = z.object({
  id,
  name: z.string().max(200),
  rootPath: z.string().max(4096),
});
export const agentSchema = z.object({
  id,
  name: z.string().max(200),
  cliType: z.string(),
  agentType: z.string(),
});
export const workspaceSchema = z.object({
  id,
  name: z.string(),
  userId: z.string(),
  machineId: id,
  projects: z.array(projectSchema).max(500),
  agents: z.array(agentSchema).max(100),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const helloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL),
  machineId: id,
  workspaces: z.array(workspaceSchema).max(20),
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
