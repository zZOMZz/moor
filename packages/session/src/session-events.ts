import type { SessionEvent, SessionEventState } from '@moor/protocol/session-events';

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
    case 'account-rate-limit':
      return {
        ...state,
        rateLimits: [
          ...(state.rateLimits ?? []).filter(
            (previous) => previous.rateLimitType !== event.rateLimit.rateLimitType,
          ),
          event.rateLimit,
        ],
      };
    case 'token-usage':
      return { ...state, tokenUsage: event };
  }
}
