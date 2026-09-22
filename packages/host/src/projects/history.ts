import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { assert } from '@moor/protocol/protocol';
import type { ContentScope } from '@moor/protocol/content-protocol';
import type {
  ProjectContentIssue,
  ProjectDiffChange,
  ProjectDiffReference,
  ProjectSnapshotFileSummary,
} from '@moor/protocol/project-content-protocol';
import {
  compareProjectSnapshots,
  type ProjectSnapshot,
  type ProjectSnapshotFile,
} from './snapshot';
import type { FrozenSearchDiff } from '../sessions/search-index';

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
type SnapshotManifest = {
  storageVersion: 2;
  snapshot: Omit<ProjectSnapshot, 'files'> & {
    files: (Omit<ProjectSnapshotFile, 'text'> & { textBlob?: string })[];
  };
};
const textDigest = (text: string) =>
  'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
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
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(project_diff)')
        .all()
        .map((row) => row.name),
    );
    for (const [column, type] of [
      ['snapshot_format', 'INTEGER NOT NULL DEFAULT 1'],
      ['before_bytes', 'INTEGER'],
      ['after_bytes', 'INTEGER'],
    ])
      if (!columns.has(column)) db.exec(`ALTER TABLE project_diff ADD COLUMN ${column} ${type}`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS project_diff_legacy ON project_diff(snapshot_format) WHERE snapshot_format=1;
      CREATE TABLE IF NOT EXISTS project_snapshot_blob(id TEXT PRIMARY KEY,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_snapshot_reference(
        owner TEXT NOT NULL,side TEXT NOT NULL,path TEXT NOT NULL,blob_id TEXT NOT NULL,
        PRIMARY KEY(owner,side,path)
      );
      CREATE INDEX IF NOT EXISTS project_snapshot_blob_references ON project_snapshot_reference(blob_id);
      CREATE TRIGGER IF NOT EXISTS project_snapshot_blob_immutable BEFORE UPDATE ON project_snapshot_blob BEGIN
        SELECT RAISE(ABORT,'Historical file content is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS project_snapshot_blob_replace BEFORE INSERT ON project_snapshot_blob
        WHEN EXISTS(SELECT 1 FROM project_snapshot_blob WHERE id=NEW.id AND text<>NEW.text) BEGIN
        SELECT RAISE(ABORT,'Historical file content is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS project_snapshot_blob_referenced BEFORE DELETE ON project_snapshot_blob
        WHEN EXISTS(SELECT 1 FROM project_snapshot_reference WHERE blob_id=OLD.id) BEGIN
        SELECT RAISE(ABORT,'Historical file content is still referenced');
      END;
      CREATE TRIGGER IF NOT EXISTS project_snapshot_reference_exists BEFORE INSERT ON project_snapshot_reference
        WHEN NOT EXISTS(SELECT 1 FROM project_snapshot_blob WHERE id=NEW.blob_id) BEGIN
        SELECT RAISE(ABORT,'Historical file content is missing');
      END;
      CREATE TRIGGER IF NOT EXISTS project_snapshot_reference_update BEFORE UPDATE OF blob_id ON project_snapshot_reference
        WHEN NOT EXISTS(SELECT 1 FROM project_snapshot_blob WHERE id=NEW.blob_id) BEGIN
        SELECT RAISE(ABORT,'Historical file content is missing');
      END;
      CREATE TRIGGER IF NOT EXISTS project_snapshot_reference_delete AFTER DELETE ON project_diff BEGIN
        DELETE FROM project_snapshot_reference
          WHERE owner=json_array(OLD.workspace_id,OLD.user_id,OLD.machine_id,OLD.project_id,OLD.session_id,OLD.turn_id);
      END;
    `);
    // Upgrade only inline rows, once, and preserve public diff IDs/versions. A
    // failed conversion rolls back every manifest and blob written by this pass.
    this.atomic(() => {
      const legacy = db.prepare('SELECT rowid FROM project_diff WHERE snapshot_format=1').all();
      for (const { rowid } of legacy) {
        const row = db.prepare('SELECT * FROM project_diff WHERE rowid=?').get(rowid)!;
        const scope: ProjectHistoryScope = {
          workspaceId: String(row.workspace_id),
          userId: String(row.user_id),
          machineId: String(row.machine_id),
          localProjectId: String(row.project_id),
          sessionId: String(row.session_id),
        };
        const turnId = String(row.turn_id),
          before = this.decodeSnapshot(row.before_snapshot),
          after = this.decodeSnapshot(row.after_snapshot);
        db.prepare(
          `UPDATE project_diff SET before_snapshot=?,after_snapshot=?,before_bytes=?,after_bytes=?,snapshot_format=2 WHERE rowid=?`,
        ).run(
          before ? this.encodeSnapshot(scope, turnId, 'before', before) : null,
          after ? this.encodeSnapshot(scope, turnId, 'after', after) : null,
          before ? Buffer.byteLength(JSON.stringify(before), 'utf8') : null,
          after ? Buffer.byteLength(JSON.stringify(after), 'utf8') : null,
          rowid,
        );
      }
    });
  }
  private atomic<T>(work: () => T): T {
    // Savepoints compose with RuntimeStore's document/receipt transaction.
    this.db.exec('SAVEPOINT project_history_write');
    try {
      const result = work();
      this.db.exec('RELEASE project_history_write');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO project_history_write; RELEASE project_history_write');
      throw error;
    }
  }
  private encodeSnapshot(
    scope: ProjectHistoryScope,
    turnId: string,
    side: 'before' | 'after',
    snapshot: ProjectSnapshot,
  ) {
    const owner = JSON.stringify([...scopeValues(scope), turnId]);
    this.db
      .prepare('DELETE FROM project_snapshot_reference WHERE owner=? AND side=?')
      .run(owner, side);
    const files = snapshot.files.map(({ text, ...file }) => {
      if (text === undefined) return file;
      const digest = textDigest(text);
      this.db.prepare('INSERT OR IGNORE INTO project_snapshot_blob VALUES(?,?)').run(digest, text);
      assert(
        this.db.prepare('SELECT text FROM project_snapshot_blob WHERE id=?').get(digest)?.text ===
          text,
        503,
        '已保存的文件内容与摘要不匹配',
      );
      this.db
        .prepare('INSERT INTO project_snapshot_reference VALUES(?,?,?,?)')
        .run(owner, side, file.path, digest);
      return { ...file, textBlob: digest };
    });
    const manifest: SnapshotManifest = { storageVersion: 2, snapshot: { ...snapshot, files } };
    return JSON.stringify(manifest);
  }
  private decodeSnapshot(raw: unknown, paths?: ReadonlySet<string>): ProjectSnapshot | undefined {
    if (raw === null || raw === undefined) return undefined;
    const parsed = JSON.parse(String(raw)) as ProjectSnapshot | SnapshotManifest;
    if (!('storageVersion' in parsed)) return parsed;
    assert(parsed.storageVersion === 2, 503, '文件基线存储版本不受支持');
    return {
      ...parsed.snapshot,
      files: parsed.snapshot.files.map(({ textBlob, ...file }) => {
        if (textBlob === undefined || (paths && !paths.has(file.path))) return file;
        const content = this.db
          .prepare('SELECT text FROM project_snapshot_blob WHERE id=?')
          .get(textBlob);
        assert(
          typeof content?.text === 'string' && textDigest(content.text) === textBlob,
          503,
          '已保存的文件内容缺失或与摘要不匹配',
        );
        return { ...file, text: content.text };
      }),
    };
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
        'INSERT INTO project_diff(workspace_id,user_id,machine_id,project_id,session_id,turn_id,reference,snapshot_format) VALUES(?,?,?,?,?,?,?,2)',
      )
      .run(...scopeValues(scope), turnId, JSON.stringify(reference));
    return reference;
  }
  saveBefore(scope: ProjectHistoryScope, turnId: string, snapshot: ProjectSnapshot) {
    const row = this.row(scope, turnId);
    assert(row, 404, '回合文件基线不可用');
    if (row.before_snapshot !== null) {
      assert(
        isDeepStrictEqual(this.decodeSnapshot(row.before_snapshot), snapshot),
        409,
        '回合开始基线已经冻结',
      );
      return;
    }
    assert(
      (JSON.parse(String(row.reference)) as ProjectDiffReference).state === 'pending',
      409,
      '回合文件基线已经结束',
    );
    this.atomic(() => {
      const encoded = this.encodeSnapshot(scope, turnId, 'before', snapshot);
      this.db
        .prepare(
          'UPDATE project_diff SET before_snapshot=?,before_bytes=? WHERE ' +
            where +
            ' AND before_snapshot IS NULL',
        )
        .run(
          encoded,
          Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
          ...scopeValues(scope),
          turnId,
        );
    });
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
    const frozenBefore = this.decodeSnapshot(row.before_snapshot) ?? before;
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
    this.atomic(() => {
      this.db
        .prepare(
          'UPDATE project_diff SET reference=?,before_snapshot=?,after_snapshot=?,summary=?,before_bytes=?,after_bytes=? WHERE ' +
            where,
        )
        .run(
          JSON.stringify(reference),
          frozenBefore ? this.encodeSnapshot(scope, turnId, 'before', frozenBefore) : null,
          after ? this.encodeSnapshot(scope, turnId, 'after', after) : null,
          JSON.stringify(summary),
          frozenBefore ? Buffer.byteLength(JSON.stringify(frozenBefore), 'utf8') : null,
          after ? Buffer.byteLength(JSON.stringify(after), 'utf8') : null,
          ...scopeValues(scope),
          turnId,
        );
    });
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
      'SELECT reference,before_bytes+after_bytes+length(CAST(summary AS BLOB)) AS bytes FROM project_diff WHERE ' +
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
      const before = this.decodeSnapshot(
        row.before_snapshot,
        new Set(
          summary.changes
            .filter((change) => change.before)
            .map((change) => change.previousPath ?? change.path),
        ),
      )!;
      const after = this.decodeSnapshot(
        row.after_snapshot,
        new Set(summary.changes.filter((change) => change.after).map((change) => change.path)),
      )!;
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
    const before = this.decodeSnapshot(row.before_snapshot, new Set([change.previousPath ?? path]));
    const after = this.decodeSnapshot(row.after_snapshot, new Set([path]));
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
