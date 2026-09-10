import {
  getAcpCapabilityCacheEntryAuthority,
  summarizeAgentRunConfigCapabilities,
  isAcpThoughtLevelConfigOption,
  type AcpCapabilityCacheEntry,
  type BuiltinRuntimeOverrides,
} from '@lody/shared';
import { runCapabilitiesSchema, type RunCapabilities } from '../run-config';
export function agentOptions(
  agent: { cliType: string; agentType: string; runtimeOverrides?: BuiltinRuntimeOverrides },
  capability: AcpCapabilityCacheEntry | undefined,
): RunCapabilities | undefined {
  if (
    !capability ||
    capability.cliType !== agent.cliType ||
    capability.agentType !== agent.agentType ||
    getAcpCapabilityCacheEntryAuthority(capability, agent.runtimeOverrides) !== 'authoritative'
  )
    return;
  const summary = summarizeAgentRunConfigCapabilities(capability);
  const effort = capability.configOptions?.find(
    (o) => o.type === 'select' && isAcpThoughtLevelConfigOption(o),
  );
  const mode = capability.configOptions?.find(
    (o) => o.type === 'select' && (o.category === 'mode' || o.id === 'mode'),
  );
  const result = runCapabilitiesSchema.safeParse({
    models: summary.models.map((m) => ({
      id: m.id,
      name: m.name,
      efforts: effort
        ? (m.reasoningEffortValues ??
          (summary.measuredForModelId === m.id ? summary.reasoningEffortValues : []))
        : [],
    })),
    modes: mode
      ? mode.options.map((m) => ({ id: m.value, name: m.name, description: m.description }))
      : capability.modes,
    ...(effort ? { effortConfigId: effort.id } : {}),
  });
  return result.success ? result.data : undefined;
}
