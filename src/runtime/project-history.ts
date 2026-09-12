import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { assert } from '../protocol';
import type { ContentScope } from '../content-protocol';
import type {
  ProjectContentIssue,
  ProjectDiffChange,
  ProjectDiffReference,
  ProjectSnapshotFileSummary,
} from '../project-content-protocol';
import {
  compareProjectSnapshots,
  type ProjectSnapshot,
  type ProjectSnapshotFile,
} from './project-snapshot';
import type { FrozenSearchDiff } from './session-search';

export type ProjectHistoryScope = ContentScope & { userId: string; machineId: string };
export type StoredProjectDiff = {
  reference: ProjectDiffReference;
  changes: ProjectDiffChange[];
  partial: boolean;
  issues: ProjectContentIssue[];
};
const scopeValues = (scope: ProjectHistoryScope) => [
  scope.workspaceId,
  scope.userId,
  scope.machineId,
  scope.localProjectId,
  scope.sessionId,
];
const where =
  'workspace_id=? AND user_id=? AND machine_id=? AND project_id=? AND session_id=? AND turn_id=?';
export function snapshotFileSummary(
  file: ProjectSnapshotFile | null,
): ProjectSnapshotFileSummary | null {
  if (!file) return null;
  return {
    path: file.path,
    size: file.size,
    state: file.state,
    ...(file.version ? { version: file.version } : {}),
    ...(file.mediaType ? { mediaType: file.mediaType } : {}),
  };
}
export function snapshotFileContent(file: ProjectSnapshotFile | null) {
  const summary = snapshotFileSummary(file);
  return summary ? { ...summary, ...(file?.text !== undefined ? { text: file.text } : {}) } : null;
}
export class ProjectHistoryStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_diff(
      workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,
      project_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
      reference TEXT NOT NULL,before_snapshot TEXT,after_snapshot TEXT,summary TEXT,
      PRIMARY KEY(workspace_id,user_id,machine_id,project_id,session_id,turn_id)
    )`);
  }
  row(scope: ProjectHistoryScope, turnId: string) {
    return this.db
      .prepare('SELECT * FROM project_diff WHERE ' + where)
      .get(...scopeValues(scope), turnId);
  }
  begin(scope: ProjectHistoryScope, turnId: string): ProjectDiffReference {
    const reference: ProjectDiffReference = {
      contentVersion: 1,
      basis: 'project-snapshot',
      turnId,
      diffId: 'diff_' + randomUUID(),
      state: 'pending',
      changeCount: 0,
    };
    this.db
      .prepare(
        'INSERT INTO project_diff(workspace_id,user_id,machine_id,project_id,session_id,turn_id,reference) VALUES(?,?,?,?,?,?,?)',
      )
      .run(...scopeValues(scope), turnId, JSON.stringify(reference));
    return reference;
  }
  saveBefore(scope: ProjectHistoryScope, turnId: string, snapshot: ProjectSnapshot) {
    const row = this.row(scope, turnId);
    assert(row, 404, '回合文件基线不可用');
    const encoded = JSON.stringify(snapshot);
    if (row.before_snapshot !== null) {
      assert(row.before_snapshot === encoded, 409, '回合开始基线已经冻结');
      return;
    }
    assert(
      (JSON.parse(String(row.reference)) as ProjectDiffReference).state === 'pending',
      409,
      '回合文件基线已经结束',
    );
    this.db
      .prepare(
        'UPDATE project_diff SET before_snapshot=? WHERE ' + where + ' AND before_snapshot IS NULL',
      )
      .run(encoded, ...scopeValues(scope), turnId);
  }
  finish(
    scope: ProjectHistoryScope,
    turnId: string,
    before: ProjectSnapshot | undefined,
    after: ProjectSnapshot | undefined,
    failures: ProjectContentIssue[] = [],
    interrupted = false,
  ): ProjectDiffReference {
    const row = this.row(scope, turnId);
    assert(row, 404, '回合文件基线不可用');
    const original = JSON.parse(String(row.reference)) as ProjectDiffReference;
    if (original.state !== 'pending') return original;
    const frozenBefore = row.before_snapshot
      ? (JSON.parse(String(row.before_snapshot)) as ProjectSnapshot)
      : before;
    const diff = frozenBefore && after ? compareProjectSnapshots(frozenBefore, after) : undefined;
    const issues: ProjectContentIssue[] = [...(diff?.issues ?? []), ...failures].slice(0, 99);
    if (!frozenBefore || !after)
      issues.push({ reason: interrupted ? 'interrupted' : 'capture-failed' });
    const changes: ProjectDiffChange[] = (diff?.changes ?? []).map((change) => ({
      ...change,
      before: snapshotFileSummary(change.before),
      after: snapshotFileSummary(change.after),
    }));
    const state = interrupted
      ? 'interrupted'
      : !diff
        ? 'unavailable'
        : diff.partial || issues.length
          ? 'partial'
          : 'ready';
    const version =
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify([scope, turnId, frozenBefore ?? null, after ?? null, issues]))
        .digest('hex');
    const reference: ProjectDiffReference = {
      ...original,
      state,
      version,
      changeCount: changes.length,
    };
    const summary: StoredProjectDiff = { reference, changes, partial: state !== 'ready', issues };
    this.db
      .prepare(
        'UPDATE project_diff SET reference=?,before_snapshot=?,after_snapshot=?,summary=? WHERE ' +
          where,
      )
      .run(
        JSON.stringify(reference),
        frozenBefore ? JSON.stringify(frozenBefore) : null,
        after ? JSON.stringify(after) : null,
        JSON.stringify(summary),
        ...scopeValues(scope),
        turnId,
      );
    return reference;
  }
  interrupt(scope: ProjectHistoryScope, turnId: string) {
    return this.row(scope, turnId)
      ? this.finish(scope, turnId, undefined, undefined, [{ reason: 'interrupted' }], true)
      : undefined;
  }
  read(scope: ProjectHistoryScope, turnId: string): StoredProjectDiff | undefined {
    const row = this.row(scope, turnId);
    if (!row) return;
    return row.summary
      ? JSON.parse(String(row.summary))
      : { reference: JSON.parse(String(row.reference)), changes: [], partial: true, issues: [] };
  }
  /** Search consumes only the exact snapshots referenced by the saved session. */
  searchDiffs(
    scope: ProjectHistoryScope,
    anchors: readonly { reference: ProjectDiffReference; itemIndex: number }[],
    maxBytes: number,
  ): { diffs: FrozenSearchDiff[]; bytes: number; partial: boolean; budgetExceeded: boolean } {
    const result = {
      diffs: [] as FrozenSearchDiff[],
      bytes: 0,
      partial: false,
      budgetExceeded: false,
    };
    const sizes = this.db.prepare(
      'SELECT reference,length(CAST(before_snapshot AS BLOB))+length(CAST(after_snapshot AS BLOB))+length(CAST(summary AS BLOB)) AS bytes FROM project_diff WHERE ' +
        where,
    );
    for (const { reference, itemIndex } of anchors) {
      const header = sizes.get(...scopeValues(scope), reference.turnId);
      if (
        !header ||
        !['ready', 'partial'].includes(reference.state) ||
        !isDeepStrictEqual(reference, JSON.parse(String(header.reference)))
      ) {
        result.partial = true;
        continue;
      }
      const bytes = Number(header.bytes);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        result.partial = true;
        continue;
      }
      if (result.bytes + bytes > maxBytes) {
        result.partial = result.budgetExceeded = true;
        continue;
      }
      result.bytes += bytes;
      const row = this.row(scope, reference.turnId)!;
      const summary = JSON.parse(String(row.summary)) as StoredProjectDiff;
      const before = JSON.parse(String(row.before_snapshot)) as ProjectSnapshot;
      const after = JSON.parse(String(row.after_snapshot)) as ProjectSnapshot;
      const previous = new Map(before.files.map((file) => [file.path, file]));
      const next = new Map(after.files.map((file) => [file.path, file]));
      const changes = summary.changes.flatMap((change) => {
        const oldFile = change.before ? previous.get(change.previousPath ?? change.path) : null;
        const newFile = change.after ? next.get(change.path) : null;
        if ((change.before && !oldFile) || (change.after && !newFile)) {
          result.partial = true;
          return [];
        }
        return [{ ...change, before: oldFile ?? null, after: newFile ?? null }];
      });
      result.partial ||= summary.partial;
      result.diffs.push({
        frozen: true,
        turnId: reference.turnId,
        itemIndex,
        diff: {
          version: 1,
          basis: 'project-snapshot',
          changes,
          partial: summary.partial,
          issues: [],
        },
      });
    }
    return result;
  }
  readFile(scope: ProjectHistoryScope, turnId: string, path: string, knownVersion?: string) {
    const row = this.row(scope, turnId),
      summary = this.read(scope, turnId);
    assert(
      row && summary && summary.reference.state !== 'pending',
      409,
      '回合文件变更尚未完成采集',
    );
    assert(
      !knownVersion || knownVersion === summary.reference.version,
      409,
      '回合文件变更版本不匹配',
    );
    const change = summary.changes.find((item) => item.path === path);
    assert(change, 404, '该文件不在已保存的回合变更中');
    const before = row.before_snapshot
      ? (JSON.parse(String(row.before_snapshot)) as ProjectSnapshot)
      : undefined;
    const after = row.after_snapshot
      ? (JSON.parse(String(row.after_snapshot)) as ProjectSnapshot)
      : undefined;
    const previous = change.before
      ? before?.files.find((file) => file.path === (change.previousPath ?? path))
      : null;
    const next = change.after ? after?.files.find((file) => file.path === path) : null;
    assert((!change.before || previous) && (!change.after || next), 404, '已保存的文件基线不可用');
    return {
      reference: summary.reference,
      before: snapshotFileContent(previous ?? null),
      after: snapshotFileContent(next ?? null),
      partial: summary.partial,
      issues: summary.issues,
    };
  }
}
