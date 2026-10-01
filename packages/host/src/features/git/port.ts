import type { GitRepositoryState } from '@moor/protocol/git-protocol';
import type {
  GitRepository,
  ManagedWorktree,
  WorktreePlan,
  WorktreeInspection,
  ProjectGitOptions,
} from './model';
/** These operations always receive the immutable repository/directory identity and guarded dispatch hooks. */
export interface ProjectGitPort {
  readProjectGit(
    rootPath: string,
    options?: ProjectGitOptions,
  ): Promise<{ state: GitRepositoryState; repository?: GitRepository }>;
  prepareProjectWorktree(
    repository: GitRepository,
    plan: WorktreePlan,
    options?: ProjectGitOptions,
  ): Promise<ManagedWorktree>;
  inspectProjectWorktree(
    repository: GitRepository,
    value: ManagedWorktree | WorktreePlan,
    options?: ProjectGitOptions,
  ): Promise<WorktreeInspection>;
  removeProjectWorktree(
    repository: GitRepository,
    managed: ManagedWorktree,
    input: { expectedStateVersion: string },
    options?: ProjectGitOptions,
  ): Promise<{ removed: true }>;
}
