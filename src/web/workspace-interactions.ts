import type { WorkspaceClientState } from './workspace-controller';
import { questionItemSchema, steerItemSchema, interactionCapabilitiesSchema } from './interactions';

export function workspaceInteractionSnapshot(state: WorkspaceClientState) {
  const turns = state.session?.history.filter((turn) => turn.role === 'assistant') ?? [];
  const active = turns.filter((turn) => !turn.finished);
  const turn = active.length === 1 ? active[0] : undefined;
  const capabilities = (turn?.items ?? [])
    .flatMap((item: any) => {
      const value =
        item?.type === 'agent_features' &&
        interactionCapabilitiesSchema.safeParse(item.interactionCapabilities);
      return value && value.success ? [value.data] : [];
    })
    .at(-1);
  const questions = turns.flatMap((turn) =>
    (turn.items ?? []).flatMap((item) => {
      const value = questionItemSchema.safeParse(item);
      return value.success && value.data.request.expectedTurnId === turn.id ? [value.data] : [];
    }),
  );
  const steers = turns.flatMap((turn) =>
    (turn.items ?? []).flatMap((item) => {
      const value = steerItemSchema.safeParse(item);
      return value.success && value.data.expectedTurnId === turn.id ? [value.data] : [];
    }),
  );
  return {
    activeId: turn?.id,
    capabilities,
    questions,
    steers,
    finished: turns.filter((turn) => turn.finished).map((turn) => turn.id),
  };
}
