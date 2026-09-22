import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Flock, metas } from '@moor/session/model';
import { assert } from '@moor/protocol/protocol';
import { sessionMetadataSchema, type SessionMetadata } from '@moor/protocol/session-responses';
import type { SessionPageRequest } from '@moor/protocol/session-page';

export type SessionPagePosition = { pin: number; time: number; id: string };
export type MetadataScope = { userId: string; machineId: string; localProjectId: string };
const fields = Object.keys(sessionMetadataSchema.shape);
const scopeValues = (scope: MetadataScope) => [scope.userId, scope.machineId, scope.localProjectId];

/** A disposable projection of Flock metadata, never a delivery or execution authority. */
export class SessionMetadataIndex {
  constructor(
    private readonly db: DatabaseSync,
    private readonly load: () => Flock,
  ) {
    const existed = ['session_metadata', 'session_metadata_version'].every((name) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_metadata_state(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),current INTEGER NOT NULL,generation TEXT NOT NULL
      );
      INSERT OR IGNORE INTO session_metadata_state VALUES(1,0,'');
      CREATE TABLE IF NOT EXISTS session_metadata(
        session_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,project_id TEXT NOT NULL,
        archived INTEGER NOT NULL,pin_rank INTEGER NOT NULL,activity_rank REAL NOT NULL,
        title_lower TEXT NOT NULL,id_lower TEXT NOT NULL,valid INTEGER NOT NULL,metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_metadata_active ON session_metadata(
        user_id,machine_id,project_id,archived,pin_rank,activity_rank,session_id
      );
      CREATE INDEX IF NOT EXISTS session_metadata_all ON session_metadata(
        user_id,machine_id,project_id,pin_rank,activity_rank,session_id
      );
      CREATE INDEX IF NOT EXISTS session_metadata_valid ON session_metadata(user_id,machine_id,project_id,valid);
      CREATE TABLE IF NOT EXISTS session_metadata_version(
        user_id TEXT NOT NULL,machine_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,
        PRIMARY KEY(user_id,machine_id,project_id)
      );
      CREATE TRIGGER IF NOT EXISTS session_metadata_source_insert AFTER INSERT ON runtime_state WHEN NEW.key='meta' BEGIN
        UPDATE session_metadata_state SET current=0 WHERE singleton=1;
      END;
      CREATE TRIGGER IF NOT EXISTS session_metadata_source_update AFTER UPDATE ON runtime_state WHEN NEW.key='meta' BEGIN
        UPDATE session_metadata_state SET current=0 WHERE singleton=1;
      END;
      CREATE TRIGGER IF NOT EXISTS session_metadata_source_delete AFTER DELETE ON runtime_state WHEN OLD.key='meta' BEGIN
        UPDATE session_metadata_state SET current=0 WHERE singleton=1;
      END;
    `);
    if (!existed) db.exec('UPDATE session_metadata_state SET current=0 WHERE singleton=1');
    this.ensureCurrent();
  }
  private atomic<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  ensureCurrent() {
    if (
      this.db.prepare('SELECT current FROM session_metadata_state WHERE singleton=1').get()
        ?.current === 1
    )
      return;
    this.atomic(() => {
      this.db.exec('DELETE FROM session_metadata; DELETE FROM session_metadata_version;');
      for (const [name, value] of Object.entries(metas(this.load())))
        if (name.startsWith('session-')) this.updateRow(name.slice(8), value);
      this.db
        .prepare('UPDATE session_metadata_state SET current=1,generation=? WHERE singleton=1')
        .run(randomUUID());
    });
  }
  private advance(scope: MetadataScope) {
    this.db
      .prepare(
        `INSERT INTO session_metadata_version VALUES(?,?,?,1)
      ON CONFLICT(user_id,machine_id,project_id) DO UPDATE SET revision=revision+1`,
      )
      .run(...scopeValues(scope));
  }
  private updateRow(sessionId: string, raw: Record<string, unknown>) {
    const previous = this.db
      .prepare('SELECT * FROM session_metadata WHERE session_id=?')
      .get(sessionId);
    const project = raw.project as { kind?: string; localProjectId?: unknown } | undefined;
    let next: { scope: MetadataScope; value?: SessionMetadata; text: string } | undefined;
    if (
      raw.id &&
      typeof raw.userId === 'string' &&
      typeof raw.machineId === 'string' &&
      project?.kind === 'local' &&
      typeof project.localProjectId === 'string'
    ) {
      const parsed = sessionMetadataSchema.safeParse(raw);
      const value = parsed.success && parsed.data.id === sessionId ? parsed.data : undefined;
      next = {
        scope: {
          userId: raw.userId,
          machineId: raw.machineId,
          localProjectId: project.localProjectId,
        },
        value,
        text: value ? JSON.stringify(value) : '{}',
      };
    }
    if (
      previous &&
      next &&
      previous.user_id === next.scope.userId &&
      previous.machine_id === next.scope.machineId &&
      previous.project_id === next.scope.localProjectId &&
      previous.metadata === next.text &&
      previous.valid === Number(!!next.value)
    )
      return;
    if (previous) {
      this.db.prepare('DELETE FROM session_metadata WHERE session_id=?').run(sessionId);
      this.advance({
        userId: String(previous.user_id),
        machineId: String(previous.machine_id),
        localProjectId: String(previous.project_id),
      });
    }
    if (!next) return;
    const value = next.value;
    this.db
      .prepare('INSERT INTO session_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        sessionId,
        ...scopeValues(next.scope),
        Number(value?.isArchived === true),
        value?.isPinned === true ? 0 : 1,
        -(value?.lastMessageAt ?? 0),
        (value?.title ?? '').toLowerCase(),
        sessionId.toLowerCase(),
        Number(!!value),
        next.text,
      );
    if (
      !previous ||
      previous.user_id !== next.scope.userId ||
      previous.machine_id !== next.scope.machineId ||
      previous.project_id !== next.scope.localProjectId
    )
      this.advance(next.scope);
  }
  /** Called inside the same transaction that writes the corresponding Flock bytes. */
  update(flock: Flock, ids: readonly string[]) {
    assert(this.db.isTransaction, 500, '会话目录必须与元数据一起提交');
    for (const id of new Set(ids)) {
      const raw: Record<string, unknown> = {};
      for (const field of fields) {
        const value = flock.get(['m', 'session-' + id, field]);
        if (value !== undefined) raw[field] = value;
      }
      this.updateRow(id, raw);
    }
    this.db.exec('UPDATE session_metadata_state SET current=1 WHERE singleton=1');
  }
  version(scope: MetadataScope) {
    this.ensureCurrent();
    const generation = this.db
      .prepare('SELECT generation FROM session_metadata_state WHERE singleton=1')
      .get()!.generation;
    const revision =
      this.db
        .prepare(
          'SELECT revision FROM session_metadata_version WHERE user_id=? AND machine_id=? AND project_id=?',
        )
        .get(...scopeValues(scope))?.revision ?? 0;
    return [generation, revision];
  }
  snapshot<T>(read: () => T): T {
    this.ensureCurrent();
    this.db.exec('SAVEPOINT session_metadata_read');
    try {
      const result = read();
      this.db.exec('RELEASE session_metadata_read');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO session_metadata_read; RELEASE session_metadata_read');
      throw error;
    }
  }
  page(scope: MetadataScope, request: SessionPageRequest, position?: SessionPagePosition) {
    this.ensureCurrent();
    assert(
      !this.db
        .prepare(
          'SELECT 1 FROM session_metadata WHERE user_id=? AND machine_id=? AND project_id=? AND valid=0 LIMIT 1',
        )
        .get(...scopeValues(scope)),
      502,
      '会话目录包含不可验证的元数据',
    );
    const where = ['user_id=?', 'machine_id=?', 'project_id=?'];
    const values: (string | number)[] = scopeValues(scope);
    if (request.archived !== 'all') {
      where.push('archived=?');
      values.push(Number(request.archived === 'archived'));
    }
    if (request.pinned !== 'all') {
      where.push('pin_rank=?');
      values.push(request.pinned === 'pinned' ? 0 : 1);
    }
    if (request.query) {
      where.push('(instr(title_lower,?)>0 OR instr(id_lower,?)>0)');
      values.push(request.query.toLowerCase(), request.query.toLowerCase());
    }
    if (position) {
      assert(
        this.db
          .prepare(
            `SELECT 1 FROM session_metadata WHERE ${where.join(' AND ')} AND pin_rank=? AND activity_rank=? AND session_id=? LIMIT 1`,
          )
          .get(...values, position.pin, position.time, position.id),
        409,
        '会话分页位置已失效，请从第一页重新读取',
      );
      where.push('(pin_rank,activity_rank,session_id)>(?,?,?)');
      values.push(position.pin, position.time, position.id);
    }
    return this.db
      .prepare(
        `SELECT metadata,pin_rank,activity_rank,session_id FROM session_metadata WHERE ${where.join(' AND ')}
      ORDER BY pin_rank,activity_rank,session_id LIMIT ?`,
      )
      .all(...values, request.limit + 1)
      .map((row) => {
        const item = sessionMetadataSchema.parse(JSON.parse(String(row.metadata)));
        assert(
          item.id === row.session_id &&
            item.userId === scope.userId &&
            item.machineId === scope.machineId &&
            item.project.localProjectId === scope.localProjectId,
          502,
          '会话目录投影身份不可验证',
        );
        return {
          item,
          position: {
            pin: Number(row.pin_rank),
            time: Number(row.activity_rank),
            id: String(row.session_id),
          },
        };
      });
  }
}
