import { runCapabilitiesSchema, type RunCapabilities } from '@moor/protocol/run-config';
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
    ...(current ? { currentModelId: current } : {}),
    ...((mode?.currentValue ?? response.modes?.currentModeId)
      ? { currentModeId: mode?.currentValue ?? response.modes.currentModeId }
      : {}),
    ...(effort?.currentValue ? { currentReasoningEffort: effort.currentValue } : {}),
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

// ACP sends the full configuration on every change. Replacing it avoids retaining
// a previous model's effort choices when an option disappears.
export class AcpConfiguration {
  private response: any;
  private initialModel?: string;
  constructor(
    response: any,
    private sessionKind: 'new' | 'loaded',
  ) {
    this.response = structuredClone(response);
    if (sessionKind === 'new') this.initialModel = capabilities(response).currentModelId;
  }
  get modelConfigId(): string {
    return (
      this.response.configOptions?.find(
        (o: any) => o.type === 'select' && (o.category === 'model' || o.id === 'model'),
      )?.id ?? 'model'
    );
  }
  replace(configOptions: unknown) {
    const next = {
      ...this.response,
      configOptions,
      // A legacy catalogue can still supply choices, but its old current value
      // is no longer an observation after a configuration change.
      ...(this.response.models
        ? { models: { ...this.response.models, currentModelId: undefined } }
        : {}),
    };
    capabilities(next); // Reject invalid data before changing the live observation.
    this.response = next;
  }
  validateValues(values: Record<string, unknown>, confirmed = false) {
    for (const [id, value] of Object.entries(values)) {
      const option = this.response.configOptions?.find((o: any) => o.id === id);
      const allowed = (option?.options ?? []).flatMap((o: any) => o.options ?? [o]);
      if (
        option?.type !== 'select' ||
        !allowed.some((o: any) => o.value === value) ||
        (confirmed && option.currentValue !== value)
      )
        throw new Error('当前 Agent 配置不支持所选选项，请刷新模型与运行设置');
    }
  }
  mode(modeId: string) {
    this.response = {
      ...this.response,
      modes: { ...this.response.modes, currentModeId: modeId },
      configOptions: this.response.configOptions?.map((o: any) =>
        o.category === 'mode' || o.id === 'mode' ? { ...o, currentValue: modeId } : o,
      ),
    };
  }
  get capabilities(): RunCapabilities {
    return {
      ...capabilities(this.response),
      sessionKind: this.sessionKind,
      ...(this.initialModel ? { defaultModelId: this.initialModel } : {}),
    };
  }
}
