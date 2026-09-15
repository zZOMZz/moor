// Deterministic ACP fixture. No accounts, models, project reads or timers.
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let pending;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    return send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'Synthetic CLI fixture', version: '1' },
        authMethods: [],
      },
    });
  if (message.method === 'session/new')
    return send({ id: message.id, result: { sessionId: 'synthetic-cli-native' } });
  if (message.method === 'session/load') return send({ id: message.id, result: {} });
  if (message.method === 'session/prompt') {
    const holding = message.params.prompt.some((item) => item.text?.includes('hold-for-stop'));
    send({
      method: 'session/update',
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: holding ? 'synthetic-holding' : '合成 CLI 往返完成。' },
        },
      },
    });
    if (holding) pending = message;
    else send({ id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (message.method === 'session/cancel') {
    if (pending) send({ id: pending.id, result: { stopReason: 'cancelled' } });
    pending = undefined;
    return;
  }
  if (message.id !== undefined)
    send({ id: message.id, error: { code: -32601, message: 'Unsupported synthetic method' } });
});
