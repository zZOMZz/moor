import { z } from 'zod';
const value = z.string().min(1).max(300);
export const runCapabilitiesSchema = z.object({
  models: z.array(z.object({ id: value, name: value, efforts: z.array(value).max(30) })).max(500),
  modes: z
    .array(z.object({ id: value, name: value, description: z.string().max(4000).optional() }))
    .max(100),
  effortConfigId: value.optional(),
});
export type RunCapabilities = z.infer<typeof runCapabilitiesSchema>;
export type RunSelection = { modelId?: string; reasoningEffort?: string; modeId?: string };
export function resolveRunSelection(selection: RunSelection, capabilities?: RunCapabilities) {
  const { modelId, reasoningEffort, modeId } = selection;
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
