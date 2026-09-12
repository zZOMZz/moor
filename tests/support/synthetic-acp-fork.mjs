// Deterministic stdio ACP peer; it never invokes an Agent or accesses user data.
import readline from 'node:readline';
const [adapter = 'codex-acp', version = '1.11.0', variant = 'success'] = process.argv.slice(2);
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, value) =>
  send({ method: 'session/update', params: { sessionId, update: value } });
const assistant = (messageId, extra = {}) => ({
  sessionUpdate: 'agent_message_chunk',
  ...(messageId ? { messageId } : {}),
  content: { type: 'text', text: 'Synthetic answer' },
  ...extra,
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line),
    { method, id, params } = message;
  process.send?.({ kind: 'wire', message });
  if (method === 'initialize')
    return send({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: '@agentclientprotocol/' + adapter, version },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: variant === 'no-capability' ? {} : { fork: {} },
        },
      },
    });
  if (method === 'session/new' || method === 'session/load') {
    const sessionId = params.sessionId ?? 'native-synthetic';
    if (sessionId === 'native-child' && variant === 'child-load-error')
      return send({ id, error: { code: -32603, message: 'Synthetic child load failure' } });
    update(sessionId, assistant('historical-message'));
    return send({ id, result: method === 'session/new' ? { sessionId } : {} });
  }
  if (method === 'session/fork') {
    if (variant === 'exit-after-fork') return process.exit(0);
    if (variant === 'fork-error')
      return send({ id, error: { code: -32603, message: 'Synthetic lost result' } });
    return send({
      id,
      result: { sessionId: variant === 'same-id' ? params.sessionId : 'native-child' },
    });
  }
  if (method === 'session/prompt') {
    const scenario = params.prompt[0].text;
    if (scenario === 'foreign') update('foreign-session', assistant('foreign-message'));
    else if (scenario === 'subagent')
      update(
        params.sessionId,
        assistant('child-message', { _meta: { claudeCode: { parentToolUseId: 'child-tool' } } }),
      );
    else
      update(
        params.sessionId,
        assistant(scenario === 'missing' ? undefined : 'native-message-' + scenario),
      );
    if (scenario === 'tool-after')
      update(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool',
        status: 'completed',
      });
    if (scenario === 'thought-after')
      update(params.sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'next-message',
        content: { type: 'text', text: 'Synthetic thought' },
      });
    return send({
      id,
      result: {
        stopReason:
          scenario === 'cancelled'
            ? 'cancelled'
            : scenario === 'failed'
              ? 'max_tokens'
              : 'end_turn',
      },
    });
  }
  if (method === 'session/cancel') return;
  if (method && id !== undefined)
    send({ id, error: { code: -32601, message: 'Unknown synthetic method' } });
});
