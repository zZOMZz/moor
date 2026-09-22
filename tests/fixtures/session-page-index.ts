import { DatabaseSync } from 'node:sqlite';
import { Flock, putMeta } from '@moor/session/model';
import { SessionMetadataIndex } from '@moor/host/persistence/session-metadata';
import type { SessionMetadata } from '@moor/protocol/session-responses';

/** Mutable synthetic metadata, persisted through the actual SQL projection. */
export function syntheticSessionPageIndex(rows: SessionMetadata[]) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value BLOB NOT NULL)');
  let flock = new Flock();
  const index = new SessionMetadataIndex(db, () => flock),
    known = new Set<string>();
  return {
    index,
    close: () => db.close(),
    sync() {
      const next = new Flock();
      for (const row of rows) {
        putMeta(next, 'session-' + row.id, row);
        known.add(row.id);
      }
      db.exec('BEGIN');
      try {
        index.update(next, [...known]);
        db.exec('COMMIT');
        flock = next;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
