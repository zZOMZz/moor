import { type GitRepository } from './model';
export type GitCommitFile = {
  path: string;
  kind: 'add' | 'modify' | 'delete';
  version: string;
  byteLength: number;
  mode: '100644' | '100755' | null;
  binary: boolean;
  truncated: boolean;
  beforeText?: string;
  afterText?: string;
};
export type GitCommitCandidate = {
  version: string;
  repository: GitRepository;
  branch: string;
  parentOid: string;
  indexVersion: string;
  files: GitCommitFile[];
};
export type GitCommitIdentity = { name: string; email: string };
export type GitObject = { oid: string; type: 'blob' | 'tree' | 'commit'; data: string };
export type GitCommitPlan = {
  version: 1;
  candidate: GitCommitCandidate;
  oid: string;
  treeOid: string;
  message: string;
  author: GitCommitIdentity;
  timestamp: number;
  objects: GitObject[];
  indexBefore: string;
  indexAfter: string;
};
export type GitActionOptions = {
  assertCurrent?: () => void;
  // Must persist the original plan before this callback returns. It runs once,
  // immediately before the first mutation; callers never replay a dispatched plan.
  onDispatched?: () => void | Promise<void>;
  checkpoint?: (
    stage:
      | 'before-plan-file'
      | 'after-plan-file'
      | 'before-commit'
      | 'after-objects'
      | 'after-ref'
      | 'before-push'
      | 'after-push',
    path?: string,
  ) => void | Promise<void>;
};
export type GitPushPlan = {
  version: 1;
  repository: GitRepository;
  branch: string;
  headOid: string;
  remote: { owner: string; repo: string; repositoryId: number };
  expectedRemoteOid: string | null;
};
export type GitPushTransport = {
  advertise(): Promise<Uint8Array>;
  receive(body: Uint8Array): Promise<Uint8Array>;
};
export type GitPushOptions = GitActionOptions & {
  token: string;
  transport?: GitPushTransport;
  fetch?: typeof fetch;
};
