export type ProjectSnapshotIssue = {
  reason:
    | 'policy-excluded'
    | 'git-unavailable'
    | 'git-failed'
    | 'directory-ignore-unavailable'
    | 'invalid-path'
    | 'symlink'
    | 'nonregular'
    | 'unavailable'
    | 'changed'
    | 'entry-limit'
    | 'depth-limit'
    | 'oversize'
    | 'read-budget'
    | 'change-limit'
    | 'incomplete-baseline'
    | 'enumeration-changed'
    | 'issue-limit';
  path?: string;
  count?: number;
};
export type ProjectTreeEntry = { path: string; type: 'file' | 'directory'; size: number };
export type ProjectFileTree = {
  entries: ProjectTreeEntry[];
  source: 'git' | 'directory';
  partial: boolean;
  enumerationComplete: boolean;
  issues: ProjectSnapshotIssue[];
};
export type ProjectSnapshotFile = {
  path: string;
  size: number;
  state: 'text' | 'binary' | 'oversize' | 'unavailable';
  // Metadata fingerprints can detect some changes to unread files, but never
  // assert equality of their contents. Only version is a content digest.
  metadataVersion: string;
  version?: string;
  mediaType?: 'text/plain' | 'application/octet-stream';
  text?: string;
};
export type ProjectSnapshot = Omit<ProjectFileTree, 'entries'> & {
  version: 1;
  files: ProjectSnapshotFile[];
  bytesRead: number;
};
export type ProjectSnapshotChange = {
  path: string;
  previousPath?: string;
  kind: 'added' | 'deleted' | 'modified' | 'renamed';
  before: ProjectSnapshotFile | null;
  after: ProjectSnapshotFile | null;
};
export type ProjectSnapshotDiff = {
  version: 1;
  basis: 'project-snapshot';
  changes: ProjectSnapshotChange[];
  partial: boolean;
  issues: ProjectSnapshotIssue[];
};
