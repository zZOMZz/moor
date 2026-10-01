import { GithubWriteFailure } from './failure';
/** The marker belongs to the frozen original write and survives read-only recovery. */
export function githubOperationBody(body: string, marker: string): string {
  const value = body + `\n\n<!-- moor-operation:${marker} -->`;
  if (!/^sha256:[a-f0-9]{64}$/.test(marker) || value.length > 12500 || value.includes('\0'))
    throw new GithubWriteFailure('invalid-request', 400, 'GitHub 操作参数无效。', true);
  return value;
}
