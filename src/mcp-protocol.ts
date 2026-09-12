import { z } from 'zod';
import { id } from './protocol';
import { contentScopeSchema } from './content-protocol';

export const MCP_FEATURE = 'session-mcp-v1';
export const MCP_LIMITS = {
  servers: 100,
  selected: 8,
  requestBytes: 64 * 1024,
  responseBytes: 512 * 1024,
} as const;
const label = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\x00-\x1f\x7f]+$/u)
  .refine((value) => !!value.trim());
export const mcpTransportSchema = z.enum(['stdio', 'http', 'sse']);
// IDs identify immutable, host-private configuration versions. No connection
// parameters or credentials can be supplied by a shared session document.
export const mcpServerIdsSchema = z
  .array(id)
  .max(MCP_LIMITS.selected)
  .refine((values) => new Set(values).size === values.length, 'MCP 选择不能重复');
export const mcpServerViewSchema = z
  .object({
    id,
    name: label,
    description: z.string().max(2000),
    transport: mcpTransportSchema,
  })
  .strict();
const base = contentScopeSchema.extend({ mcpVersion: z.literal(1) });
export const mcpReadSchema = base.strict();
export const mcpReadResultSchema = base
  .extend({
    confirmed: z.literal(true),
    catalogRevision: z.number().int().nonnegative().safe(),
    servers: z.array(mcpServerViewSchema).max(MCP_LIMITS.servers),
  })
  .strict();
export type McpRead = z.infer<typeof mcpReadSchema>;
export type McpReadResult = z.infer<typeof mcpReadResultSchema>;
export type McpServerView = z.infer<typeof mcpServerViewSchema>;
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export function validateMcpRead(value: unknown, request: McpRead): McpReadResult {
  const result = mcpReadResultSchema.parse(value);
  if (
    result.workspaceId !== request.workspaceId ||
    result.localProjectId !== request.localProjectId ||
    result.sessionId !== request.sessionId ||
    new Set(result.servers.map((server) => server.id)).size !== result.servers.length
  )
    throw new Error('MCP 目录不属于当前会话范围');
  return result;
}
