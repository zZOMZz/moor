export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 2,
    public operationId?: string,
  ) {
    super(message);
  }
}
const commands: Record<string, readonly string[]> = {
  auth: ['login', 'status', 'logout'],
  targets: ['list', 'use'],
  session: [
    'create',
    'list',
    'read',
    'send',
    'stop',
    'archive',
    'restore',
    'rename',
    'pin',
    'unpin',
  ],
  operation: ['list', 'inspect', 'retry', 'abandon'],
  config: ['show'],
};
const booleans = new Set(['json', 'stdin', 'follow', 'wait', 'help']);
const values = new Set([
  'state-dir',
  'connection',
  'server',
  'workspace',
  'replica',
  'session',
  'agent',
  'file',
  'model',
  'effort',
  'mode',
  'timeout',
  'turn',
]);
export type CliArgs = {
  group: string;
  command: string;
  positional?: string;
  flags: Record<string, string | true>;
};
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const flags: Record<string, string | true> = {},
    words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.startsWith('--')) {
      const name = argument.slice(2);
      if (name === 'password' || name === 'token' || name === 'secret' || name.includes('='))
        throw new CliError(
          'usage',
          '不接受命令行凭据或 --name=value；正文和登录资料请用 --stdin 或 --file。',
        );
      if (Object.hasOwn(flags, name)) throw new CliError('usage', '命令选项重复。');
      if (booleans.has(name)) flags[name] = true;
      else if (values.has(name)) {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new CliError('usage', '命令选项缺少值。');
        flags[name] = value;
      } else throw new CliError('usage', '未知命令选项；使用 --help 查看支持的命令。');
    } else words.push(argument);
  }
  if (flags.help) return { group: 'help', command: 'show', flags };
  const [group, command, positional] = words;
  if (!group || !command || !commands[group]?.includes(command) || words.length > 3)
    throw new CliError('usage', '请指定受支持的命令，例如 targets list；使用 --help 查看帮助。');
  if (
    positional &&
    (!['operation', 'session'].includes(group) || !/^[A-Za-z0-9_:-]{1,160}$/.test(positional))
  )
    throw new CliError('usage', '位置参数只接受会话或操作编号；正文请用 --stdin 或 --file。');
  if (flags.stdin && flags.file) throw new CliError('usage', '--stdin 与 --file 只能选一项。');
  if (flags.connection && flags.server)
    throw new CliError('usage', '--connection 与 --server 只能选一项。');
  if (
    flags.timeout &&
    (!/^\d+$/.test(String(flags.timeout)) ||
      Number(flags.timeout) < 1 ||
      Number(flags.timeout) > 86400000)
  )
    throw new CliError('usage', '等待时限必须是 1 至 86400000 毫秒。');
  if ((flags.follow || flags.wait) && group !== 'session')
    throw new CliError('usage', '--follow/--wait 仅用于会话读取、发送或停止后的等待。');
  const allowed = new Set(['json', 'state-dir']);
  if (group !== 'config' && !(group === 'operation' && command === 'list')) {
    allowed.add('connection');
    allowed.add('server');
  }
  if (group === 'auth' && command === 'login' && flags.connection && (flags.stdin || flags.file))
    throw new CliError('usage', '本机连接登录不接受远程登录资料。');
  if ((group === 'targets' && command === 'use') || group === 'session')
    for (const name of ['workspace', 'replica', 'session']) allowed.add(name);
  if (
    (group === 'auth' && command === 'login') ||
    (group === 'session' && ['create', 'send', 'rename'].includes(command))
  )
    for (const name of ['stdin', 'file']) allowed.add(name);
  if (group === 'session' && ['create', 'send'].includes(command)) allowed.add('agent');
  if (group === 'session' && command === 'send')
    for (const name of ['model', 'effort', 'mode']) allowed.add(name);
  if (group === 'session' && command === 'stop') allowed.add('turn');
  if (group === 'session' && ['read', 'send', 'stop'].includes(command))
    for (const name of ['wait', 'follow', 'timeout']) allowed.add(name);
  if (Object.keys(flags).some((name) => !allowed.has(name)))
    throw new CliError('usage', '此命令不接受指定选项。');
  if (flags.timeout && !flags.wait && !flags.follow)
    throw new CliError('usage', '--timeout 需要与 --wait 或 --follow 一起使用。');
  if (
    positional &&
    ((group === 'session' && ['create', 'list'].includes(command)) || command === 'list')
  )
    throw new CliError('usage', '此命令不接受位置参数。');
  if (group === 'operation' && command !== 'list' && !positional)
    throw new CliError('usage', '请指定原操作编号。');
  if (positional && flags.session) throw new CliError('usage', '请只用一处指定会话编号。');
  return { group, command, positional, flags };
}
export const cliHelp = `Moor CLI (cliVersion 1)
  auth login --server https://relay.example --stdin   输入 {"email":"...","password":"..."}
  auth status | auth logout
  targets list | targets use --workspace ID --replica ID
  session create --agent ID [--stdin | --file PATH]  可选标题文本
  session list | session read [ID] [--follow | --wait] [--timeout MS]
  session send [ID] --stdin | --file PATH [--model ID] [--effort ID] [--mode ID] [--wait]
  session stop [ID] [--turn ID] [--wait]
  session archive|restore|pin|unpin [ID]
  session rename [ID] --stdin | --file PATH
  operation list | operation inspect|retry|abandon ID
  config show
通用：--json、--state-dir PATH、--connection PATH
默认不会发送恢复的请求；重试与结束只作用于原编号。等待超时或 Ctrl-C 不停止 Agent。
`;
