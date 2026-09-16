import { z } from 'zod';

export const AGENT_USAGE_FEATURE = 'agent-usage-v1';
export const MOOR_USAGE_READ = '_moor/account/rate_limits/read';
export const MOOR_USAGE_UPDATED = '_moor/account/rate_limits/updated';
export const USAGE_CACHE_MS = 60_000;
const text = z.string().min(1).max(300);
const timestamp = z.number().int().nonnegative().max(253402300799);
const windowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: timestamp.nullable().optional(),
});
const bucketSchema = z.object({
  limitId: text.nullish(),
  limitName: text.nullish(),
  normalModelSlug: text.nullish(),
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
  planType: text.nullish(),
});
/** Explicit allowlist: raw account, credential and provider extension fields never cross the host. */
export const agentUsageUpdateSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative().safe(),
    status: z.enum(['ready', 'unknown', 'unsupported', 'signed-out', 'failed']),
    accountKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    partial: z.boolean().optional(),
    rateLimits: bucketSchema.optional(),
    rateLimitsByLimitId: z
      .record(text, bucketSchema)
      .refine((v) => Object.keys(v).length <= 100)
      .nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.status === 'ready' && (!v.accountKey || (!v.rateLimits && !v.rateLimitsByLimitId)))
      ctx.addIssue({ code: 'custom', message: 'Missing account usage snapshot' });
  });
export type AgentUsageUpdate = z.infer<typeof agentUsageUpdateSchema>;
export const accountUsageSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['ready', 'unknown', 'unsupported', 'signed-out', 'failed']),
    observedAt: z.number().int().nonnegative().safe().optional(),
    buckets: z
      .array(
        z.object({
          id: text,
          name: text.optional(),
          model: text.optional(),
          plan: text.optional(),
          primary: windowSchema.optional(),
          secondary: windowSchema.optional(),
        }),
      )
      .max(100),
  })
  .strict();
export type AccountUsage = z.infer<typeof accountUsageSchema>;
export function projectAccountUsage(update: AgentUsageUpdate, observedAt: number): AccountUsage {
  const buckets = Object.entries(update.rateLimitsByLimitId ?? {});
  if (!buckets.length && update.rateLimits)
    buckets.push([update.rateLimits.limitId ?? 'codex', update.rateLimits]);
  return accountUsageSchema.parse({
    version: 1,
    status: update.status,
    observedAt,
    buckets:
      update.status === 'ready'
        ? buckets.map(([id, b]) => ({
            id,
            ...(b.limitName ? { name: b.limitName } : {}),
            ...(b.normalModelSlug ? { model: b.normalModelSlug } : {}),
            ...(b.planType ? { plan: b.planType } : {}),
            ...(b.primary ? { primary: b.primary } : {}),
            ...(b.secondary ? { secondary: b.secondary } : {}),
          }))
        : [],
  });
}
