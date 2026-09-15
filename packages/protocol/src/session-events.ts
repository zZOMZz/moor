import { z } from 'zod';

// Moor owns these records. ACP extension metadata is never copied into shared state.
const label = z.string().min(1).max(300);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionalCount = count.nullish().transform((value) => value ?? undefined);
const entries = z
  .array(
    z.object({
      content: z.string().min(1).max(16000),
      priority: z.enum(['high', 'medium', 'low']),
      status: z.enum(['pending', 'in_progress', 'completed']),
    }),
  )
  .max(500);
const command = z.object({
  name: label.refine((value) => !/[\s\x00-\x1f\x7f]/u.test(value), 'Invalid command name'),
  description: z.string().max(16000),
  input: z
    .object({ hint: z.string().max(4000) })
    .nullish()
    .transform((value) => value ?? undefined),
});
const commands = z
  .array(command)
  .max(500)
  .refine((values) => new Set(values.map((value) => value.name)).size === values.length);
const cost = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
});
const rateLimitStatus = z.enum(['allowed', 'allowed_warning', 'rejected']);
const rateLimitWindow = z.enum([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
]);
const overageDisabledReason = z.enum([
  'overage_not_provisioned',
  'org_level_disabled',
  'org_level_disabled_until',
  'out_of_credits',
  'seat_tier_level_disabled',
  'member_level_disabled',
  'seat_tier_zero_credit_limit',
  'group_zero_credit_limit',
  'member_zero_credit_limit',
  'org_service_level_disabled',
  'no_limits_configured',
  'fetch_error',
  'unknown',
]);
const resetTime = z.number().int().nonnegative().max(253402300799);
/** Historical display schema only. Current ACP normalization never creates it. */
export const accountRateLimitSchema = z
  .object({
    source: z.literal('claude-agent-acp'),
    adapterVersion: z.literal('0.76.0'),
    status: rateLimitStatus,
    rateLimitType: rateLimitWindow.optional(),
    utilization: z.number().finite().min(0).max(1).optional(),
    resetsAt: resetTime.optional(),
    overageStatus: rateLimitStatus.optional(),
    overageResetsAt: resetTime.optional(),
    overageDisabledReason: overageDisabledReason.optional(),
  })
  .strict();
export type AccountRateLimit = z.infer<typeof accountRateLimitSchema>;
const planContent = z.discriminatedUnion('format', [
  z.object({ format: z.literal('items'), entries }),
  z.object({ format: z.literal('markdown'), text: z.string().max(256 * 1024) }),
  // A file plan is an opaque reference, never permission to read or fetch its URI.
  // Resolving it requires the normal host file boundary and a project-relative path.
  z.object({ format: z.literal('file'), uri: z.string().min(1).max(4000) }),
]);
const base = { version: z.literal(1), source: z.literal('acp') };
export const sessionEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('commands'), commands }),
  z.object({
    ...base,
    kind: z.literal('plan'),
    // Absent ID identifies the legacy single plan; it cannot collide with an Agent ID.
    planId: label.optional(),
    content: planContent,
  }),
  z.object({ ...base, kind: z.literal('plan-removed'), planId: label }),
  z.object({
    ...base,
    kind: z.literal('context-usage'),
    used: count,
    size: count,
    cost: cost.optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('token-usage'),
    // SDK 1.4.0 labels this turn usage but describes counters as cumulative.
    // Preserve that uncertainty: report the source fields without summing turns.
    scope: z.literal('agent-reported'),
    totalTokens: count,
    inputTokens: count,
    outputTokens: count,
    thoughtTokens: optionalCount,
    cachedReadTokens: optionalCount,
    cachedWriteTokens: optionalCount,
  }),
  // Read compatibility for sessions written before Claude execution was removed.
  z.object({ ...base, kind: z.literal('account-rate-limit'), rateLimit: accountRateLimitSchema }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export const sessionEventStateSchema = z.object({
  version: z.literal(1),
  commands: commands.optional(),
  planObserved: z.boolean().optional(),
  plans: z.array(z.object({ planId: label.optional(), content: planContent })).max(100),
  contextUsage: sessionEventSchema.options[3].optional(),
  tokenUsage: sessionEventSchema.options[4].optional(),
  rateLimits: z.array(accountRateLimitSchema).max(7).optional(),
});
export type SessionEventState = z.infer<typeof sessionEventStateSchema>;

export const runtimeFeatureReportSchema = z.object({
  version: z.literal(1),
  source: z.literal('acp'),
  prompt: z.object({
    text: z.literal(true),
    resourceLink: z.literal(true),
    image: z.boolean(),
    audio: z.boolean(),
    embeddedContext: z.boolean(),
  }),
  loadSession: z.boolean(),
  forkSession: z.boolean(),
  // The pinned SDK has no steer method. Unknown _meta claims cannot enable it.
  steer: z.literal(false),
  observed: z.object({
    commands: z.boolean(),
    plan: z.boolean(),
    contextUsage: z.boolean(),
    tokenUsage: z.boolean(),
    formQuestions: z.boolean(),
  }),
});
export type RuntimeFeatureReport = z.infer<typeof runtimeFeatureReportSchema>;
