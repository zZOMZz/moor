import { assert, id } from '@moor/protocol/protocol';
import { z } from 'zod';
import type { AgentConfig } from './driver';

const argument = z
  .string()
  .max(65536)
  .refine((value) => !value.includes('\0'));
const configSchema = z.object({
  id,
  name: z.string().max(200),
  cliType: z.string().min(1).max(200),
  agentType: z.string().min(1).max(200),
  machineId: id,
  runtimeOverrides: z.object({ codexPath: z.string().min(1).max(4096).optional() }).optional(),
  customAcp: z
    .object({ command: z.string().min(1).max(4096), args: z.array(argument).max(256) })
    .optional(),
});

export function agentConfigSnapshot(value: AgentConfig): AgentConfig {
  // Runtime catalogues may carry capability caches. They never identify a launch
  // version and must not turn a refreshed observation into a configuration edit.
  const parsed = configSchema.safeParse(value);
  assert(parsed.success, 409, 'Agent 配置版本无效');
  const config = parsed.data;
  if (!config.runtimeOverrides?.codexPath) delete config.runtimeOverrides;
  const serialized = JSON.stringify(config);
  assert(new TextEncoder().encode(serialized).byteLength <= 1024 * 1024, 409, 'Agent 配置版本过大');
  // Optional undefined properties are absent in the durable representation too.
  return JSON.parse(serialized);
}
