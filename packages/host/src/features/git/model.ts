import { type GitRepositoryState } from '@moor/protocol/git-protocol';
export type DirectoryIdentity = { path: string; dev: string; ino: string };
export type GitPointerIdentity = { identity: DirectoryIdentity; hash: string };
export type GitConfigIdentity = { path: string; identity?: DirectoryIdentity; hash?: string };
export type GitRepository = {
  version: 1;
  id: string;
  projectRoot: string;
  rootPath: string;
  commonDir: string;
  gitDir: string;
  projectRelativePath: string;
  projectIdentity: DirectoryIdentity;
  rootIdentity: DirectoryIdentity;
  commonIdentity: DirectoryIdentity;
  gitDirIdentity: DirectoryIdentity;
  pointers: GitPointerIdentity[];
  configs: GitConfigIdentity[];
};
export type WorktreePlan = {
  targetPath: string;
  baseBranch: string;
  expectedOid: string;
  newBranch: string;
};
export type ManagedWorktree = {
  version: 1;
  repositoryId: string;
  plan: WorktreePlan;
  cwd: string;
  rootIdentity: DirectoryIdentity;
  cwdIdentity: DirectoryIdentity;
  gitDirIdentity: DirectoryIdentity;
  parentIdentity: DirectoryIdentity;
  gitFileIdentity: DirectoryIdentity;
  gitFileHash: string;
  pointers: GitPointerIdentity[];
  configs: GitConfigIdentity[];
};
export type WorktreeInspection =
  | { status: 'ready'; managed: ManagedWorktree; state: GitRepositoryState }
  | { status: 'missing' | 'unknown'; reason: string };
export type ProjectGitOptions = {
  assertCurrent?: () => void;
  onDispatched?: () => void;
  // Host-injected deterministic checkpoints; never supplied by a remote caller.
  checkpoint?: (
    stage: 'before-prepare' | 'after-prepare' | 'before-remove',
  ) => void | Promise<void>;
  outputBytes?: number;
};
