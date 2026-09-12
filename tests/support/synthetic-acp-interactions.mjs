// Deterministic ACP peer controlled through a test-only IPC channel.
import readline from 'node:readline';
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let promptId, heldSteerId;
const nativeId = 'native-synthetic';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  process.send?.({ kind: 'wire', message });
  if (message.method === 'initialize')
    return send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: {
          name: process.argv[2] ?? '@agentclientprotocol/claude-agent-acp',
          version: process.argv[3] ?? '0.76.0',
        },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true,
            audio: true,
            embeddedContext: true,
          },
          sessionCapabilities: { fork: {} },
        },
        _meta: { steering: { supported: true } },
      },
    });
  if (message.method === 'session/new' || message.method === 'session/load') {
    const id = message.params.sessionId ?? nativeId;
    for (const sessionId of ['unrelated-native', id])
      send({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: sessionId === id ? 'review' : 'unrelated',
                description: 'Synthetic command',
              },
            ],
          },
        },
      });
    send({
      method: 'session/update',
      params: {
        sessionId: id,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Historical replay must not become a new reply',
          },
        },
      },
    });
    return send({
      id: message.id,
      result: message.method === 'session/new' ? { sessionId: id } : {},
    });
  }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    return;
  }
  if (message.method === 'session/cancel') {
    if (promptId !== undefined) send({ id: promptId, result: { stopReason: 'cancelled' } });
    promptId = undefined;
    return;
  }
  if (message.method === '_session/steering') {
    const text = message.params.prompt[0].text;
    if (text === 'hold-steer') {
      heldSteerId = message.id;
      return;
    }
    return send({
      id: message.id,
      result:
        text === 'native-race'
          ? { outcome: 'promptRequired', reason: 'noRunningTurn' }
          : text === 'violated-contract'
            ? { outcome: 'startedNewTurn' }
            : { outcome: 'injected' },
    });
  }
  if (message.method && message.id !== undefined)
    send({
      id: message.id,
      error: { code: -32601, message: 'Unsupported synthetic method' },
    });
});
process.on('message', (control) => {
  if (control.kind === 'emit')
    send({
      method: 'session/update',
      params: {
        sessionId: control.sessionId ?? nativeId,
        update: control.update,
      },
    });
  else if (control.kind === 'ask')
    send({
      id: control.id,
      method: 'elicitation/create',
      params: control.params,
    });
  else if (control.kind === 'finish') {
    if (promptId !== undefined)
      send({
        id: promptId,
        result: {
          stopReason: 'end_turn',
          ...(control.usage ? { usage: control.usage } : {}),
        },
      });
    promptId = undefined;
  } else if (control.kind === 'finish-steer') {
    send({ id: heldSteerId, result: { outcome: 'injected' } });
    heldSteerId = undefined;
  }
});
