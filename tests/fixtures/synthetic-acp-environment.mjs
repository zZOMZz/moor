// A real stdio ACP peer that only reads its synthetic Git execution location.
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';

const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let sessionId = 'synthetic-environment',
  requestedCwd;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    return send({
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
    });
  if (message.method === 'session/new' || message.method === 'session/load') {
    requestedCwd = message.params.cwd;
    sessionId = message.params.sessionId ?? sessionId;
    return send({
      id: message.id,
      result: message.method === 'session/new' ? { sessionId } : {},
    });
  }
  if (message.method === 'session/prompt') {
    const gitTopLevel = execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: JSON.stringify({
              cwd: process.cwd(),
              requestedCwd,
              gitTopLevel,
              gitKeys: Object.keys(process.env).filter((key) =>
                key.toUpperCase().startsWith('GIT_'),
              ),
              syntheticAuth: process.env.MOOR_SYNTHETIC_AUTH,
              codexPath: process.env.CODEX_PATH,
              hasPath: Boolean(process.env.PATH),
            }),
          },
        },
      },
    });
    return send({ id: message.id, result: { stopReason: 'end_turn' } });
  }
  if (message.id !== undefined)
    send({ id: message.id, error: { code: -32601, message: 'Unsupported synthetic method' } });
});
