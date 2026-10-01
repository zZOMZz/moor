import {
  type GithubBranch,
  type GithubCheck,
  type GithubComment,
  type GithubIssue,
  type GithubItemSummary,
  type GithubPage,
  type GithubPull,
  type GithubRepository,
  type GithubStatusesPage,
} from '@moor/protocol/github-protocol';
import type { GithubWriteOutcome } from '@moor/protocol/github-write-protocol';
import {
  type GithubPullFile,
  type GithubReviewComment,
} from '@moor/protocol/github-write-protocol';
export type GitHubRepositoryTarget = {
  owner: string;
  repo: string;
  repositoryId: number;
};
export type GitHubClientErrorCode =
  | 'invalid-request'
  | 'credentials'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'redirect'
  | 'stale'
  | 'timeout'
  | 'cancelled'
  | 'too-large'
  | 'invalid-response'
  | 'network'
  | 'unavailable';
type ListOptions = {
  page?: number;
  state?: 'open' | 'closed' | 'all';
};
export interface GithubReader {
  getUser(): Promise<{
    id: number;
    login: string;
  }>;
  getRepository(target: {
    owner: string;
    repo: string;
    repositoryId?: number;
  }): Promise<GithubRepository>;
  getBranch(target: GitHubRepositoryTarget, branch: string): Promise<GithubBranch>;
  listBranches(
    target: GitHubRepositoryTarget,
    options?: {
      page?: number;
    },
  ): Promise<GithubPage<GithubBranch>>;
  listIssues(
    target: GitHubRepositoryTarget,
    options?: ListOptions,
  ): Promise<GithubPage<GithubItemSummary>>;
  getIssue(target: GitHubRepositoryTarget, number: number): Promise<GithubIssue>;
  listPulls(
    target: GitHubRepositoryTarget,
    options?: ListOptions,
  ): Promise<GithubPage<GithubItemSummary>>;
  getPull(target: GitHubRepositoryTarget, number: number): Promise<GithubPull>;
  listComments(
    target: GitHubRepositoryTarget,
    number: number,
    options?: {
      page?: number;
    },
  ): Promise<GithubPage<GithubComment>>;
  listChecks(
    target: GitHubRepositoryTarget,
    headSha: string,
    options?: {
      page?: number;
    },
  ): Promise<GithubPage<GithubCheck>>;
  getCombinedStatus(
    target: GitHubRepositoryTarget,
    headSha: string,
    options?: {
      page?: number;
    },
  ): Promise<GithubStatusesPage>;
}
export type GitHubRecovery<T> = {
  value: T;
  authorId: number | null;
  marker?: string;
  bodyVersion: string;
};
export interface GithubWriter {
  listPullFiles(
    target: GitHubRepositoryTarget,
    number: number,
    options?: {
      page?: number;
    },
  ): Promise<GithubPage<GithubPullFile>>;
  listRecoveryReviewComments(
    target: GitHubRepositoryTarget,
    number: number,
    options?: {
      page?: number;
    },
  ): Promise<GithubPage<GitHubRecovery<GithubReviewComment>>>;
  listReviewComments(
    target: GitHubRepositoryTarget,
    number: number,
    options?: {
      page?: number;
    },
  ): Promise<GithubPage<GithubReviewComment>>;
  listRecoveryIssueComments(
    target: GitHubRepositoryTarget,
    number: number,
    options?: {
      page?: number;
    },
  ): Promise<GithubPage<GitHubRecovery<GithubComment>>>;
  getIssueComment(
    target: GitHubRepositoryTarget,
    number: number,
    commentId: number,
  ): Promise<GitHubRecovery<GithubComment>>;
  getReviewComment(
    target: GitHubRepositoryTarget,
    number: number,
    commentId: number,
  ): Promise<GitHubRecovery<GithubReviewComment>>;
  getRecoveryPull(
    target: GitHubRepositoryTarget,
    number: number,
  ): Promise<GitHubRecovery<GithubPull>>;
  getPull(target: GitHubRepositoryTarget, number: number): Promise<GithubPull>;
  listRecoveryPulls(
    target: GitHubRepositoryTarget,
    options: {
      headBranch: string;
      baseBranch: string;
      page?: number;
    },
  ): Promise<GithubPage<GitHubRecovery<GithubPull>>>;
  createIssueComment(
    target: GitHubRepositoryTarget,
    number: number,
    options: {
      body: string;
    },
  ): Promise<GithubWriteOutcome>;
  createReviewComment(
    target: GitHubRepositoryTarget,
    number: number,
    options: GitHubReviewCommentInput,
  ): Promise<GithubWriteOutcome>;
  replyReviewComment(
    target: GitHubRepositoryTarget,
    number: number,
    commentId: number,
    options: {
      body: string;
    },
  ): Promise<GithubWriteOutcome>;
  createPull(
    target: GitHubRepositoryTarget,
    options: GitHubCreatePullInput,
  ): Promise<GithubWriteOutcome>;
  updatePull(
    target: GitHubRepositoryTarget,
    number: number,
    options: GitHubUpdatePullInput,
  ): Promise<GithubWriteOutcome>;
  mergePull(
    target: GitHubRepositoryTarget,
    number: number,
    options: GitHubMergePullInput,
  ): Promise<GithubWriteOutcome>;
}

export type GitHubReviewCommentInput = {
  body: string;
  commitSha: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
};
export type GitHubCreatePullInput = {
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
};
export type GitHubUpdatePullInput = {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  baseBranch?: string;
};
export type GitHubMergePullInput = {
  headSha: string;
  method: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
};
export type GithubConnection = { token: string; assertCurrent?: () => void; signal?: AbortSignal };
export type GithubWriteConnection = GithubConnection & {
  beforeDispatch?: () => void | Promise<void>;
  onResult?: (result: GithubWriteOutcome) => void | Promise<void>;
};
export type GithubProjectAuthority = {
  localProjectId: string;
  owner: string;
  repo: string;
  token: string;
  credentialId: string;
  repositoryId: number;
  version: string;
  writesEnabled?: boolean;
};
export interface GithubAuthority {
  getProject(localProjectId: string): GithubProjectAuthority;
  isCurrent(value: GithubProjectAuthority): boolean;
}
export type GithubReaderFactory = (connection: GithubConnection) => GithubReader;
export type GithubWriterFactory = (connection: GithubWriteConnection) => GithubWriter;
