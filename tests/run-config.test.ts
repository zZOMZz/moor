import test from 'node:test';
import strict from 'node:assert/strict';
import { agentOptions } from '../src/bridge/agent-options';
import { resolveRunSelection } from '../src/run-config';
import { syntheticCapabilities as capability } from './support/agent-capabilities';
const agent = { cliType: 'builtin', agentType: 'codex' };
test('runtime capabilities preserve model-specific effort and native approval modes', () => {
  const options = agentOptions(agent, capability)!;
  strict.deepEqual(
    resolveRunSelection(
      { modelId: 'model-b', reasoningEffort: 'medium', modeId: 'agent' },
      options,
    ),
    {
      modelId: 'model-b',
      modeId: 'agent',
      configOptionValues: { reasoning_effort: 'medium' },
    },
  );
  strict.throws(() =>
    resolveRunSelection({ modelId: 'model-b', reasoningEffort: 'high' }, options),
  );
  strict.throws(() => resolveRunSelection({ modelId: 'unavailable' }, options));
  strict.throws(() => resolveRunSelection({ modeId: 'unavailable' }, options));
  strict.throws(() => resolveRunSelection({ reasoningEffort: 'high' }, options));
  strict.deepEqual(resolveRunSelection({}), {});
});
test('snapshot efforts apply only to measured model; stale and provisional capabilities are omitted', () => {
  const options = agentOptions(agent, { ...capability, modelReasoningEfforts: undefined })!;
  strict.deepEqual(options.models[0].efforts, ['low', 'high']);
  strict.deepEqual(options.models[1].efforts, []);
  strict.equal(agentOptions(agent, { ...capability, cacheVersion: 0 }), undefined);
  strict.equal(agentOptions(agent, { ...capability, provenance: undefined }), undefined);
  strict.equal(agentOptions({ ...agent, agentType: 'claude' }, capability), undefined);
});
test('thought-level category maps another agent effort field without exposing unrelated options', () => {
  const options = agentOptions(agent, {
    ...capability,
    configOptions: capability.configOptions!.map((o) =>
      o.id === 'reasoning_effort' ? { ...o, id: 'effort' } : o,
    ),
  })!;
  strict.deepEqual(
    resolveRunSelection({ modelId: 'model-a', reasoningEffort: 'high' }, options)
      .configOptionValues,
    { effort: 'high' },
  );
});
