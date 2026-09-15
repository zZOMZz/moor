// A test-only ACP peer. It records supplied MCP descriptions without starting
// a server or contacting any configured endpoint or real Agent account.
import readline from 'node:readline';
const settings = JSON.parse(process.argv[2] ?? '{}');
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (message, value) => send({ id: message.id, result: value });
let held,
  descriptors = [],
  promptId;
const replies = new Map();
function ask(id, method, params) {
  const waiting = new Promise((resolve) => replies.set(id, resolve));
  send({ id, method, params });
  return waiting;
}
const update = (sessionId, value) =>
  send({
    method: 'session/update',
    params: { sessionId, update: value },
  });
async function handle(message) {
  const { method, params } = message;
  if (method === 'initialize')
    return result(message, {
      protocolVersion: 1,
      agentInfo: {
        name: settings.name ?? '@agentclientprotocol/codex-acp',
        version: settings.version ?? '1.11.0',
      },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { fork: {} },
        mcpCapabilities: settings.capabilities ?? { http: true, sse: true },
      },
    });
  if (method === 'session/new' || method === 'session/load') {
    descriptors = params.mcpServers;
    if (settings.scenario === 'open-error') throw new Error(JSON.stringify(descriptors));
    return result(message, {
      ...(method === 'session/new' ? { sessionId: settings.nativeId ?? 'synthetic-native' } : {}),
      models: {
        currentModelId: 'model',
        availableModels: [
          {
            modelId: 'model',
            name: settings.echoCapabilities ? 'synthetic-header-secret' : 'Synthetic',
          },
        ],
      },
      modes: { currentModeId: 'mode', availableModes: [{ id: 'mode', name: 'Synthetic' }] },
    });
  }
  if (method === 'session/set_mode') return result(message, {});
  if (method === 'session/fork') return result(message, { sessionId: 'synthetic-fork-child' });
  if (method === 'session/set_config_option') {
    if (settings.scenario === 'config-error') throw new Error(JSON.stringify(descriptors));
    return result(message, { configOptions: [] });
  }
  if (method === 'session/prompt') {
    promptId = message.id;
    if (settings.scenario === 'prompt-error') throw new Error(JSON.stringify(descriptors));
    if (settings.scenario === 'attachment-echo') {
      const privateBytes = Buffer.from(JSON.stringify(descriptors) + settings.extraEcho);
      const binary = Buffer.concat([
        Buffer.from([0, 255, 137, 0]),
        privateBytes,
        Buffer.from([255, 0]),
      ]).toString('base64');
      const blocks = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///synthetic/private.txt',
            mimeType: 'text/plain',
            blob: privateBytes.toString('base64'),
          },
        },
        { type: 'image', mimeType: 'image/png', data: binary },
        { type: 'audio', mimeType: 'audio/wav', data: binary },
        {
          type: 'resource',
          resource: {
            uri: 'file:///synthetic/clean.txt',
            mimeType: 'text/plain',
            blob: Buffer.from('Synthetic clean artifact').toString('base64'),
          },
        },
      ];
      for (const content of blocks)
        update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content });
      update(params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'synthetic-attachments',
        title: 'Synthetic artifacts',
        status: 'completed',
        content: blocks.map((content) => ({ type: 'content', content })),
      });
    }
    if (['echo', 'private-identifiers', 'permission-hold'].includes(settings.scenario)) {
      const text = JSON.stringify(descriptors) + (settings.extraEcho ?? '');
      update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      });
      update(params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'synthetic-tool',
        title: text,
        status: 'pending',
        rawInput: { [text]: text },
      });
      update(params.sessionId, {
        sessionUpdate: 'plan',
        entries: [{ content: text, priority: 'high', status: 'pending' }],
      });
      const permission = await ask('synthetic-permission', 'session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'synthetic-tool', title: text },
        options: [
          {
            optionId: settings.scenario === 'private-identifiers' ? text : 'allow',
            name: text,
            kind: 'allow_once',
          },
        ],
      });
      process.send?.({ kind: 'permission-result', value: permission });
      const question = await ask('synthetic-question', 'elicitation/create', {
        mode: 'form',
        sessionId: params.sessionId,
        message: text,
        requestedSchema: {
          type: 'object',
          properties: {
            [settings.scenario === 'private-identifiers' ? 'synthetic-argument-secret' : 'answer']:
              {
                type: 'string',
                title: 'synthetic-argument-secret',
              },
          },
        },
      });
      process.send?.({ kind: 'question-result', value: question });
    }
    if (settings.scenario === 'hold-prompt') return;
    return result(message, { stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') {
    if (promptId !== undefined) send({ id: promptId, result: { stopReason: 'cancelled' } });
    promptId = undefined;
    return;
  }
  throw new Error('Unsupported synthetic method');
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
  } else if (message?.kind === 'emit') update('synthetic-native', message.update);
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  process.send?.({ kind: 'wire', message });
  if (!message.method) {
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  } else if (message.method === settings.held) held = message;
  else run(message);
});
