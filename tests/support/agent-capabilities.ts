import type { RunCapabilities } from '../../src/run-config';
export const syntheticCapabilities: RunCapabilities = {
  models: [
    { id: 'model-a', name: 'Synthetic Model A', efforts: ['low', 'high'] },
    { id: 'model-b', name: 'Synthetic Model B', efforts: ['medium'] },
  ],
  modes: [
    { id: 'read-only', name: 'Read-only' },
    { id: 'agent', name: 'Agent' },
    { id: 'agent-auto-review', name: 'Auto review' },
    { id: 'agent-full-access', name: 'Full access' },
  ],
  effortConfigId: 'reasoning_effort',
};
