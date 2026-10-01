import type { GithubWriteOutcome } from '@moor/protocol/github-write-protocol';
import { AppError } from '@moor/protocol/protocol';
import type { GitHubClientErrorCode } from './ports';
export class GithubWriteFailure extends AppError {
  constructor(
    public code: GitHubClientErrorCode,
    status: number,
    message: string,
    rejected: boolean,
    public retryAfterSeconds?: number,
    public rateLimitResetAt?: number,
    public knownResult?: GithubWriteOutcome,
  ) {
    super(status, message, rejected);
  }
}
