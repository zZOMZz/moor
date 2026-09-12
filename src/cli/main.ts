import { resolve } from 'node:path';
import { CliError, cliHelp, parseCliArgs } from './args';
import { CliState, defaultCliDirectory } from './state';
import { CliClient } from './client';
const controller = new AbortController();
process.once('SIGINT', () => {
  controller.abort();
  process.stdin.destroy();
});
let state: CliState | undefined,
  json = false,
  command = '';
try {
  const args = parseCliArgs(process.argv.slice(2));
  json = !!args.flags.json;
  command = args.group + ' ' + args.command;
  if (args.group === 'help') process.stdout.write(cliHelp);
  else {
    state = new CliState(
      args.flags['state-dir'] ? resolve(String(args.flags['state-dir'])) : defaultCliDirectory(),
    );
    const emit = (data: unknown) =>
      process.stdout.write(
        JSON.stringify({ cliVersion: 1, ok: true, command, data }, null, json ? undefined : 2) +
          '\n',
      );
    const client = new CliClient({
      state,
      stdin: process.stdin,
      signal: controller.signal,
      event: emit,
    });
    emit(await client.run(args));
  }
} catch (error) {
  const safe = controller.signal.aborted
    ? new CliError('interrupted', '等待或请求已中断；Agent 未被停止，原请求请手动核查。', 130)
    : error instanceof CliError
      ? error
      : new CliError('invalid', '输入、状态或服务器响应不可验证；未自动重试。', 1);
  const result = {
    cliVersion: 1,
    ok: false,
    command,
    error: {
      code: safe.code,
      message: safe.message,
      ...(safe.operationId ? { operationId: safe.operationId } : {}),
    },
  };
  process.stderr.write(JSON.stringify(result, null, json ? undefined : 2) + '\n');
  process.exitCode = safe.exitCode;
} finally {
  state?.close();
}
