import { ACP_CAPABILITY_CACHE_VERSION, type AcpCapabilityCacheEntry } from '@lody/shared';
export const syntheticCapabilities: AcpCapabilityCacheEntry = {
  cliType: 'builtin',
  agentType: 'codex',
  cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
  provenance: 'runtime',
  fetchedAt: 1,
  models: [
    { modelId: 'model-a', name: 'Synthetic Model A' },
    { modelId: 'model-b', name: 'Synthetic Model B' },
  ],
  modes: [
    { id: 'read-only', name: 'Read-only' },
    { id: 'agent', name: 'Agent' },
    { id: 'agent-auto-review', name: 'Auto review' },
    { id: 'agent-full-access', name: 'Full access' },
  ],
  modelReasoningEfforts: { 'model-a': ['low', 'high'], 'model-b': ['medium'] },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'model-a',
      options: [
        { value: 'model-a', name: 'Synthetic Model A' },
        { value: 'model-b', name: 'Synthetic Model B' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ],
};
