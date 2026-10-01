import { z } from 'zod';
export const agentProgramCheckSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.number().int().nonnegative(),
    versionStatus: z.enum(['reported', 'unavailable', 'not-applicable']),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/)
      .max(100)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.versionStatus === 'reported') === (value.version !== undefined),
    '版本确认状态与版本值不匹配',
  );
export type AgentProgramCheck = z.infer<typeof agentProgramCheckSchema>;
export type LocalAgentProgram = {
  source: 'custom' | 'local' | 'adapter';
  path: string;
  adapterName?: string;
  adapterVersion?: string;
  fingerprint: string;
};
