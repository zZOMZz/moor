import { z } from 'zod';
const value = z.string().min(1).max(300);
export const runCapabilitiesSchema = z.object({
  models: z
    .array(
      z.object({
        id: value,
        name: value,
        efforts: z.array(value).max(30),
        description: z.string().max(4000).optional(),
        defaultEffort: value.optional(),
      }),
    )
    .max(500),
  modes: z
    .array(z.object({ id: value, name: value, description: z.string().max(4000).optional() }))
    .max(100),
  effortConfigId: value.optional(),
  currentModelId: value.optional(),
  currentModeId: value.optional(),
  currentReasoningEffort: value.optional(),
  // The initial model observed on a new session, not a guessed catalogue default.
  defaultModelId: value.optional(),
  sessionKind: z.enum(['new', 'loaded']).optional(),
});
export type RunCapabilities = z.infer<typeof runCapabilitiesSchema>;
export const runSelectionSchema = z
  .object({
    modelId: value.optional(),
    reasoningEffort: value.optional(),
    modeId: value.optional(),
  })
  .strict();
export type RunSelection = z.infer<typeof runSelectionSchema>;
export const approvalModeSchema = z.enum([
  'moor-read-only',
  'moor-agent',
  'moor-auto-review',
  'moor-full-access',
]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
const legacyModes: Record<string, ApprovalMode> = {
  'read-only': 'moor-agent',
  agent: 'moor-auto-review',
  'agent-auto-review': 'moor-auto-review',
  'agent-full-access': 'moor-full-access',
};
/** Interpret legacy IDs only when the adapter advertises Moor's explicit presets. */
export function canonicalMode(modeId: string | undefined, capabilities?: RunCapabilities) {
  if (!modeId) return undefined;
  const canonical = legacyModes[modeId];
  return canonical && capabilities?.modes.some((m) => m.id === canonical) ? canonical : modeId;
}
export function changeRunSelection(
  selection: RunSelection,
  key: keyof RunSelection,
  value: string,
  capabilities?: RunCapabilities,
): RunSelection {
  const next = { ...selection, [key]: value || undefined };
  if (key === 'modelId') {
    const model = capabilities?.models.find((m) => m.id === value);
    if (!model?.efforts.includes(next.reasoningEffort ?? ''))
      next.reasoningEffort = model?.efforts.includes(model.defaultEffort ?? '')
        ? model.defaultEffort
        : undefined;
  }
  return next;
}
export function resolveRunSelection(selection: RunSelection, capabilities?: RunCapabilities) {
  const { modelId, reasoningEffort } = selection;
  const modeId = canonicalMode(selection.modeId, capabilities);
  const model = capabilities?.models.find((m) => m.id === modelId);
  if (modelId && !model) throw new Error('所选模型已不可用，请重新选择或刷新模型选项');
  if (modeId && !capabilities?.modes.some((m) => m.id === modeId))
    throw new Error('所选审批模式已不可用，请重新选择');
  if (
    reasoningEffort &&
    (!capabilities?.effortConfigId || !model?.efforts.includes(reasoningEffort))
  )
    throw new Error('当前模型不支持所选 effort，请重新选择');
  return {
    ...(modelId ? { modelId } : {}),
    ...(modeId ? { modeId } : {}),
    ...(reasoningEffort
      ? { configOptionValues: { [capabilities!.effortConfigId!]: reasoningEffort } }
      : {}),
  };
}
export function selectionFromInput(
  input: { modelId?: string; modeId?: string; configOptionValues?: unknown } | undefined,
  capabilities?: RunCapabilities,
): RunSelection {
  const effort = capabilities?.effortConfigId
    ? (input?.configOptionValues as Record<string, unknown> | undefined)?.[
        capabilities.effortConfigId
      ]
    : undefined;
  return {
    modelId: input?.modelId,
    modeId: input?.modeId,
    ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
  };
}

/** Fill only absent draft values with observations or a frozen new-session default. */
export function initializeRunSelection(
  selection: RunSelection,
  capabilities: RunCapabilities | undefined,
  options: {
    fresh: boolean;
    initialModeId?: string;
    initialModelId?: string;
    initialReasoningEffort?: string;
    legacyCodex?: boolean;
  },
): RunSelection {
  const modelId =
    selection.modelId ||
    (options.fresh
      ? options.initialModelId || capabilities?.defaultModelId
      : capabilities?.sessionKind === 'loaded'
        ? capabilities.currentModelId
        : undefined);
  const model = capabilities?.models.find((m) => m.id === modelId);
  const modeId = canonicalMode(
    selection.modeId ||
      options.initialModeId ||
      (options.legacyCodex && !options.fresh ? 'agent' : undefined),
    capabilities,
  );
  const reasoningEffort =
    selection.reasoningEffort ||
    (options.fresh && modelId === options.initialModelId
      ? options.initialReasoningEffort
      : undefined) ||
    (modelId && modelId === capabilities?.currentModelId
      ? capabilities?.currentReasoningEffort
      : undefined) ||
    model?.defaultEffort;
  return {
    ...(modelId ? { modelId } : {}),
    ...(modeId ? { modeId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
