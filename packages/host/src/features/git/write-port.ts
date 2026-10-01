import type { ProjectGitPort } from './port';
import type {
  GitActionOptions,
  GitCommitCandidate,
  GitCommitPlan,
  GitCommitIdentity,
  GitPushPlan,
  GitPushOptions,
} from './write-model';
export interface ProjectGitWritePort extends Pick<ProjectGitPort, 'readProjectGit'> {
  inspectCommitCandidate(
    cwd: string,
    paths: string[],
    options?: GitActionOptions,
  ): Promise<GitCommitCandidate>;
  planProjectCommit(
    candidate: GitCommitCandidate,
    input: { message: string; author: GitCommitIdentity; timestamp: number },
    options?: GitActionOptions,
  ): Promise<GitCommitPlan>;
  commitProject(plan: GitCommitPlan, options?: GitActionOptions): Promise<{ oid: string }>;
  inspectProjectCommit(
    plan: GitCommitPlan,
    options?: GitActionOptions,
  ): Promise<{ status: 'accepted' | 'not-applied' | 'unknown'; oid: string; indexReady: boolean }>;
  inspectProjectPush(
    plan: GitPushPlan,
    options: GitPushOptions,
  ): Promise<{ status: 'accepted' | 'not-applied' | 'unknown'; remoteOid: string | null }>;
  pushProject(plan: GitPushPlan, options: GitPushOptions): Promise<{ oid: string }>;
}
