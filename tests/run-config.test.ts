import test from 'node:test';
import strict from 'node:assert/strict';
import { capabilities } from '../src/runtime/capabilities';
import { resolveRunSelection } from '../src/run-config';
import { syntheticCapabilities } from './support/agent-capabilities';
test('host capabilities preserve model-specific effort and native approval modes', () => {
  strict.deepEqual(
    resolveRunSelection(
      { modelId: 'model-b', reasoningEffort: 'medium', modeId: 'agent' },
      syntheticCapabilities,
    ),
    { modelId: 'model-b', modeId: 'agent', configOptionValues: { reasoning_effort: 'medium' } },
  );
  for (const choice of [
    { modelId: 'model-b', reasoningEffort: 'high' },
    { modelId: 'missing' },
    { modeId: 'missing' },
    { reasoningEffort: 'high' },
  ])
    strict.throws(() => resolveRunSelection(choice, syntheticCapabilities));
  strict.deepEqual(resolveRunSelection({}), {});
});
test('ACP grouped model options are normalized and effort applies only to the measured model', () => {
  const result = capabilities({
    configOptions: [
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          {
            group: 'vendor',
            options: [
              { value: 'a', name: 'A' },
              { value: 'b', name: 'B' },
            ],
          },
        ],
      },
      {
        id: 'effort',
        category: 'thought_level',
        type: 'select',
        options: [{ value: 'low', name: 'Low' }],
      },
      {
        id: 'mode',
        category: 'mode',
        type: 'select',
        options: [{ value: 'agent', name: 'Agent' }],
      },
    ],
  });
  strict.deepEqual(result.models, [
    { id: 'a', name: 'A', efforts: ['low'] },
    { id: 'b', name: 'B', efforts: [] },
  ]);
  strict.deepEqual(
    resolveRunSelection({ modelId: 'a', reasoningEffort: 'low' }, result).configOptionValues,
    { effort: 'low' },
  );
  strict.deepEqual(capabilities({}), { models: [], modes: [] });
});
