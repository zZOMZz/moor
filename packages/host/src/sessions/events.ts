import {
  accountRateLimitSchema,
  runtimeFeatureReportSchema,
  sessionEventSchema,
  sessionEventStateSchema,
  type AccountRateLimit,
  type RuntimeFeatureReport,
  type SessionEvent,
  type SessionEventState,
} from '@moor/protocol/session-events';
import { applySessionEvent } from '@moor/session/session-events';

export {
  accountRateLimitSchema,
  applySessionEvent,
  runtimeFeatureReportSchema,
  sessionEventSchema,
  sessionEventStateSchema,
};
export type { AccountRateLimit, RuntimeFeatureReport, SessionEvent, SessionEventState };

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
    case 'usage_update': {
      return result({
        ...common,
        kind: 'context-usage',
        used: update.used,
        size: update.size,
        ...(update.cost == null ? {} : { cost: update.cost }),
      });
    }
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
