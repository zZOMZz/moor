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
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventResult =
  | { status: 'accepted'; event: SessionEvent }
  | { status: 'ignored'; reason: 'unknown-event' | 'invalid-event' | 'missing-usage' };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function result(value: unknown): SessionEventResult {
  const parsed = sessionEventSchema.safeParse(value);
  return parsed.success
    ? { status: 'accepted', event: parsed.data }
    : { status: 'ignored', reason: 'invalid-event' };
}

/** Normalize only M3 informational updates; other handlers may process text/tools. */
export function normalizeSessionEvent(value: unknown): SessionEventResult {
  const update = object(value);
  if (!update) return { status: 'ignored', reason: 'invalid-event' };
  const common = { version: 1, source: 'acp' };
  switch (update.sessionUpdate) {
    case 'available_commands_update':
      return result({ ...common, kind: 'commands', commands: update.availableCommands });
    case 'plan':
      return result({
        ...common,
        kind: 'plan',
        content: { format: 'items', entries: update.entries },
      });
    case 'plan_update': {
      const plan = object(update.plan);
      if (!plan || typeof plan.planId !== 'string')
        return { status: 'ignored', reason: 'invalid-event' };
      return result({
        ...common,
        kind: 'plan',
        planId: plan.planId,
        content:
          plan.type === 'items'
            ? { format: 'items', entries: plan.entries }
            : plan.type === 'markdown'
              ? { format: 'markdown', text: plan.content }
              : plan.type === 'file'
                ? { format: 'file', uri: plan.uri }
                : undefined,
      });
    }
    case 'plan_removed':
      return result({ ...common, kind: 'plan-removed', planId: update.planId });
    case 'usage_update':
      return result({
        ...common,
        kind: 'context-usage',
        used: update.used,
        size: update.size,
        ...(update.cost == null ? {} : { cost: update.cost }),
      });
    default:
      return { status: 'ignored', reason: 'unknown-event' };
  }
}

/** Call once with the actual prompt response; absent usage stays unavailable. */
export function normalizePromptUsage(value: unknown): SessionEventResult {
  const response = object(value);
  if (!response) return { status: 'ignored', reason: 'invalid-event' };
  if (response.usage == null) return { status: 'ignored', reason: 'missing-usage' };
  const usage = object(response.usage);
  if (!usage) return { status: 'ignored', reason: 'invalid-event' };
  return result({
    ...usage,
    version: 1,
    source: 'acp',
    kind: 'token-usage',
    scope: 'agent-reported',
  });
}

export const sessionEventStateSchema = z.object({
  version: z.literal(1),
  commands: commands.optional(),
  planObserved: z.boolean().optional(),
  plans: z.array(z.object({ planId: label.optional(), content: planContent })).max(100),
  contextUsage: sessionEventSchema.options[3].optional(),
  tokenUsage: sessionEventSchema.options[4].optional(),
});
export type SessionEventState = z.infer<typeof sessionEventStateSchema>;

/** Apply snapshots without mutating history or accumulating cumulative usage. */
export function applySessionEvent(
  previous: SessionEventState | undefined,
  event: SessionEvent,
): SessionEventState {
  const state = previous ?? { version: 1, plans: [] };
  switch (event.kind) {
    case 'commands':
      return { ...state, commands: event.commands };
    case 'plan': {
      const index = state.plans.findIndex((plan) => plan.planId === event.planId);
      const plan = { planId: event.planId, content: event.content };
      // Keep the newest 100 named plans. This bounds current display state only;
      // persisted turn events can still retain the host's historical record.
      const plans =
        index < 0
          ? [...state.plans.slice(-99), plan]
          : state.plans.map((current, i) => (i === index ? plan : current));
      return { ...state, plans, planObserved: true };
    }
    case 'plan-removed':
      return {
        ...state,
        plans: state.plans.filter((plan) => plan.planId !== event.planId),
        planObserved: true,
      };
    case 'context-usage':
      return { ...state, contextUsage: event };
    case 'token-usage':
      return { ...state, tokenUsage: event };
  }
}

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

/** Explicit initialization flags and validated observations are separate evidence. */
export function runtimeFeatureReport(
  initialization: unknown,
  state?: SessionEventState,
  observedFormQuestion = false,
): RuntimeFeatureReport {
  const advertised = object(object(initialization)?.agentCapabilities);
  const prompt = object(advertised?.promptCapabilities);
  const session = object(advertised?.sessionCapabilities);
  return {
    version: 1,
    source: 'acp',
    prompt: {
      text: true,
      resourceLink: true,
      image: prompt?.image === true,
      audio: prompt?.audio === true,
      embeddedContext: prompt?.embeddedContext === true,
    },
    loadSession: advertised?.loadSession === true,
    forkSession: object(session?.fork) !== undefined,
    steer: false,
    observed: {
      commands: state?.commands !== undefined,
      plan: state?.planObserved === true,
      contextUsage: state?.contextUsage !== undefined,
      tokenUsage: state?.tokenUsage !== undefined,
      formQuestions: observedFormQuestion === true,
    },
  };
}
