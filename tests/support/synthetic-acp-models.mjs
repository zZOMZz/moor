// Deterministic test peer: no agent account, model request, shell or user files.
import readline from 'node:readline';
const settings = JSON.parse(process.argv[2] ?? '{}');
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (message, value) => send({ id: message.id, result: value });
let sessionId = 'synthetic-model-session',
  model = 'a',
  effort = 'low';
const options = () => [
  {
    id: 'selected_model',
    category: 'model',
    type: 'select',
    name: 'Model',
    currentValue: model,
    options: [
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
    ],
  },
  {
    id: 'effort',
    category: 'thought_level',
    type: 'select',
    name: 'Effort',
    currentValue: effort,
    options: (model === 'a' ? ['low'] : ['high', 'max']).map((value) => ({ value, name: value })),
  },
];
const update = (id, configOptions) =>
  send({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'config_option_update', configOptions } },
  });
function handle(message) {
  process.send?.({ kind: 'wire', message });
  const { method, params } = message;
  if (method === 'initialize')
    return result(message, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
  if (method === 'session/new' || method === 'session/load') {
    sessionId = params.sessionId ?? sessionId;
    const initial = options();
    if (settings.startupUpdate) {
      model = 'b';
      effort = 'high';
      update(sessionId, options());
    }
    return result(message, {
      ...(method === 'session/new' ? { sessionId } : {}),
      configOptions: initial,
    });
  }
  if (method === 'session/set_config_option') {
    if (settings.configError)
      return send({ id: message.id, error: { code: -32603, message: settings.configError } });
    if (params.configId === 'selected_model') {
      model = settings.rejectSelection ? 'a' : params.value;
      effort = model === 'a' ? 'low' : 'high';
    } else if (params.configId === 'effort') effort = params.value;
    else throw new Error('Unknown synthetic option');
    return result(message, { configOptions: settings.removeOptions ? [] : options() });
  }
  if (method === 'session/prompt') {
    if (settings.promptUpdate) {
      model = 'b';
      effort = 'max';
      update(settings.wrongSession ? 'unrelated-session' : sessionId, options());
    }
    return result(message, { stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') return;
  throw new Error('Unsupported synthetic method');
}
let held;
process.on('message', (message) => {
  if (message === 'release' && held) {
    const next = held;
    held = undefined;
    handle(next);
  }
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === settings.hold) {
    held = message;
    process.send?.({ kind: 'held', method: message.method });
  } else handle(message);
});
