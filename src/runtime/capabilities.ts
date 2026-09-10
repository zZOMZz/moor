import { runCapabilitiesSchema, type RunCapabilities } from '../run-config';
// Only ACP-advertised choices are exposed; effort choices belong to the current model.
export function capabilities(response: any): RunCapabilities {
  const select = (category: string) =>
    response.configOptions?.find(
      (o: any) => o.type === 'select' && (o.category === category || o.id === category),
    );
  const options = (o: any): any[] => (o?.options ?? []).flatMap((v: any) => v.options ?? [v]);
  const models = select('model'),
    effort = select('thought_level') ?? select('reasoning_effort'),
    mode = select('mode');
  const current = models?.currentValue ?? response.models?.currentModelId;
  return runCapabilitiesSchema.parse({
    models: (models
      ? options(models).map((m: any) => ({ id: m.value, name: m.name }))
      : (response.models?.availableModels ?? []).map((m: any) => ({ id: m.modelId, name: m.name }))
    ).map((m: any) => ({
      ...m,
      efforts: m.id === current ? options(effort).map((e: any) => e.value) : [],
    })),
    modes: mode
      ? options(mode).map((m: any) => ({ id: m.value, name: m.name }))
      : (response.modes?.availableModes ?? []),
    ...(effort ? { effortConfigId: effort.id } : {}),
  });
}
