// Synthetic ACP peer with real loopback MCP HTTP; no native Agent or account.
import readline from 'node:readline';
const [capability = 'true', heldMethod = '', scenario = 'success'] = process.argv.slice(2);
let held, descriptor;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (message, value) => send({ id: message.id, result: value });
async function mcp(method, params, notification = false) {
  const response = await fetch(descriptor.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(notification ? {} : { id: method }),
      method,
      ...(params ? { params } : {}),
    }),
  });
  if (response.status === 202) return;
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
async function handle(message) {
  const { method, params } = message;
  if (method === 'initialize')
    return result(message, {
      protocolVersion: 1,
      agentInfo: { name: '@agentclientprotocol/codex-acp', version: '1.11.0' },
      agentCapabilities: {
        loadSession: true,
        ...(capability === 'missing'
          ? {}
          : { mcpCapabilities: { http: capability === 'true', sse: false } }),
      },
    });
  if (method === 'session/new' || method === 'session/load') {
    descriptor = params.mcpServers?.[0];
    if (scenario === 'startup-error')
      throw new Error(descriptor.url + ':' + descriptor.headers[0].value);
    if (scenario === 'mcp') {
      await mcp('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'synthetic-agent', version: '1' },
      });
      await mcp('notifications/initialized', undefined, true);
      process.send?.({ kind: 'tools', value: await mcp('tools/list') });
    }
    return result(message, {
      ...(method === 'session/new' ? { sessionId: 'synthetic-native' } : {}),
      models: {
        currentModelId: 'model',
        availableModels: [{ modelId: 'model', name: 'Synthetic' }],
      },
      modes: { currentModeId: 'mode', availableModes: [{ id: 'mode', name: 'Synthetic' }] },
    });
  }
  if (method === 'session/set_config_option') return result(message, { configOptions: [] });
  if (method === 'session/set_mode') return result(message, {});
  if (method === 'session/prompt') {
    if (scenario === 'mcp')
      process.send?.({
        kind: 'tool-result',
        value: await mcp('tools/call', {
          name: 'moor_task_create',
          arguments: { grantId: 'grant', taskId: 'task', operationId: 'operation' },
        }),
      });
    if (scenario === 'prompt-error')
      throw new Error(descriptor.url + ':' + descriptor.headers[0].value);
    if (scenario === 'echo')
      send({
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: descriptor.url + ' ' + descriptor.headers[0].value },
          },
        },
      });
    return result(message, { stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') return;
  throw new Error('Synthetic method unavailable');
}
function run(message) {
  void handle(message).catch((error) =>
    send({ id: message.id, error: { code: -32603, message: error.message } }),
  );
}
process.on('message', (message) => {
  if (message === 'release' && held) {
    const value = held;
    held = undefined;
    run(value);
  }
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  process.send?.({ kind: 'wire', message });
  if (message.method === heldMethod) held = message;
  else run(message);
});
