import { AppError } from './protocol';

export const agentModelFailures = {
  programVersion:
    '所选模型要求更新的 Codex 执行程序。请在执行电脑核对 Moor 实际使用的程序来源与版本，然后刷新模型选项。',
  accountModel: '当前 Codex 账号不支持所选模型。请刷新可用模型并重新选择；原指令不会自动重发。',
} as const;

// Only recognize known error categories; never forward paths, credentials or
// arbitrary upstream diagnostic text through the capability endpoint.
export function identifyAgentModelFailure(error: unknown): AppError | undefined {
  if (!(error instanceof Error)) return;
  const message = error.message.slice(0, 16384);
  if (Object.values(agentModelFailures).some((value) => message === value))
    return new AppError(502, message);
  if (/requires a newer version of Codex/i.test(message))
    return new AppError(502, agentModelFailures.programVersion);
  if (/not supported when using Codex with a ChatGPT account/i.test(message))
    return new AppError(502, agentModelFailures.accountModel);
}

export function publicAgentFailure(error: unknown, fallback: string): string {
  return error instanceof Error &&
    Object.values(agentModelFailures).some((value) => error.message === value)
    ? error.message
    : fallback;
}
