import type {
  ProjectContentIssue,
  ProjectDiffChange,
  ProjectDiffFileResult,
  ProjectDiffReference,
} from '@moor/protocol/project-content-protocol';
import type { FrozenSearchDiff } from '@moor/session/session-search-document';
import type { AttachmentScope } from '../attachments/model';
import type { ProjectSnapshot } from '../files/model';
import type { PersistedValue } from './metadata';
export type ProjectHistoryScope = AttachmentScope;
export type StoredProjectDiff = {
  reference: ProjectDiffReference;
  changes: ProjectDiffChange[];
  partial: boolean;
  issues: ProjectContentIssue[];
};
export interface ProjectHistoryPersistence {
  row(scope: ProjectHistoryScope, turnId: string): Record<string, PersistedValue> | undefined;
  begin(scope: ProjectHistoryScope, turnId: string): ProjectDiffReference;
  saveBefore(scope: ProjectHistoryScope, turnId: string, snapshot: ProjectSnapshot): void;
  finish(
    scope: ProjectHistoryScope,
    turnId: string,
    before: ProjectSnapshot | undefined,
    after: ProjectSnapshot | undefined,
    failures?: ProjectContentIssue[],
    interrupted?: boolean,
  ): ProjectDiffReference;
  interrupt(scope: ProjectHistoryScope, turnId: string): ProjectDiffReference | undefined;
  read(scope: ProjectHistoryScope, turnId: string): StoredProjectDiff | undefined;
  searchDiffs(
    scope: ProjectHistoryScope,
    anchors: readonly { reference: ProjectDiffReference; itemIndex: number }[],
    maxBytes: number,
  ): { diffs: FrozenSearchDiff[]; bytes: number; partial: boolean; budgetExceeded: boolean };
  readFile(
    scope: ProjectHistoryScope,
    turnId: string,
    path: string,
    knownVersion?: string,
  ): Pick<ProjectDiffFileResult, 'reference' | 'before' | 'after' | 'partial' | 'issues'>;
}
