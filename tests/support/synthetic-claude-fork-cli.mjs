// Claude SDK transport peer used only with synthetic native session fixtures.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const report = (value) =>
  appendFileSync(process.env.MOOR_SYNTHETIC_CLI_REPORT, JSON.stringify(value) + '\n');
report({ kind: 'launch', cwd: process.cwd(), args: process.argv.slice(2) });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'control_request') {
    report({ kind: 'control', subtype: value.request.subtype });
    const response =
      value.request.subtype === 'initialize'
        ? {
            commands: [],
            agents: [],
            models: [
              {
                value: 'synthetic-model',
                displayName: 'Synthetic',
                description: 'Synthetic model',
              },
            ],
            account: { apiKeySource: 'env', tokenSource: 'none' },
          }
        : value.request.subtype === 'get_session_info'
          ? { model: 'synthetic-model' }
          : {};
    process.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: value.request_id, response },
      }) + '\n',
    );
  } else if (value.type === 'user') {
    report({ kind: 'unexpected-prompt' });
    process.exitCode = 2;
  }
});
