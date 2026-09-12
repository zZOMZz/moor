import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { id } from '../protocol';
import { contentScopeSchema } from '../content-protocol';
import {
  SEARCH_LIMITS,
  searchEntrySchema,
  searchQuerySchema,
  type SearchEntry,
  type SearchHit,
} from '../search-protocol';
import { searchExcerpt, type SearchDocument } from '../session-search-document';
export {
  sessionSearchDocument,
  type SearchDocument,
  type FrozenSearchDiff,
} from '../session-search-document';

const searchScopeSchema = contentScopeSchema
  .extend({
    userId: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => !/[\x00-\x1f\x7f]/u.test(value)),
    machineId: id,
  })
  .strict();
export type SearchScope = z.infer<typeof searchScopeSchema>;
const scopeValues = (scope: SearchScope) => [
  scope.workspaceId,
  scope.userId,
  scope.machineId,
  scope.localProjectId,
  scope.sessionId,
];
const scopeWhere = 'workspace_id=? AND user_id=? AND machine_id=? AND project_id=?';
// A complete scope prefix leaves rowid as the final index ordering. Binding one
// session at a time avoids a global MATCH/sort before the result LIMIT applies.
export const SESSION_SEARCH_SCAN_SQL = `SELECT * FROM search_entry INDEXED BY search_scope WHERE ${scopeWhere} AND session_id=? ORDER BY id DESC LIMIT ?`;
export class SessionSearchIndex {
  private candidates: number;
  private scanBytes: number;
  constructor(
    private db: DatabaseSync,
    limits: { candidates?: number; scanBytes?: number } = {},
  ) {
    this.candidates = z
      .number()
      .int()
      .min(1)
      .max(SEARCH_LIMITS.candidates)
      .parse(limits.candidates ?? SEARCH_LIMITS.candidates);
    this.scanBytes = z
      .number()
      .int()
      .min(1)
      .max(SEARCH_LIMITS.scanBytes)
      .parse(limits.scanBytes ?? SEARCH_LIMITS.scanBytes);
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_document(
        workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,
        project_id TEXT NOT NULL,session_id TEXT NOT NULL,partial INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,user_id,machine_id,project_id,session_id)
      );
      CREATE TABLE IF NOT EXISTS search_entry(
        id INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,item_index INTEGER NOT NULL,kind TEXT NOT NULL,path TEXT,body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_scope ON search_entry(workspace_id,user_id,machine_id,project_id,session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(body,tokenize='trigram');
    `);
    if (
      !db
        .prepare('PRAGMA table_info(search_entry)')
        .all()
        .some((column) => column.name === 'body')
    ) {
      // Search data is derived. Rebuild the earlier preview index without
      // touching source sessions, operation receipts or saved snapshots.
      db.exec('SAVEPOINT moor_search_upgrade');
      try {
        db.exec(`ALTER TABLE search_entry ADD COLUMN body TEXT NOT NULL DEFAULT '';
          DELETE FROM search_text; DELETE FROM search_entry; DELETE FROM search_document;
          RELEASE moor_search_upgrade;`);
      } catch (error) {
        db.exec('ROLLBACK TO moor_search_upgrade; RELEASE moor_search_upgrade');
        throw error;
      }
    }
  }
  /** Nested savepoints keep a replacement atomic inside or outside RuntimeStore's transaction. */
  replace(scope: SearchScope, document: SearchDocument) {
    const values = scopeValues(searchScopeSchema.parse(scope));
    const parsed = z
      .object({
        entries: z.array(searchEntrySchema).max(SEARCH_LIMITS.entries),
        partial: z.boolean(),
      })
      .strict()
      .parse(document);
    if (
      parsed.entries.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0) >
      SEARCH_LIMITS.documentBytes
    )
      throw new Error('搜索索引超过单会话限制');
    this.db.exec('SAVEPOINT moor_search_replace');
    try {
      this.db
        .prepare(
          `DELETE FROM search_text WHERE rowid IN (SELECT id FROM search_entry WHERE ${scopeWhere} AND session_id=?)`,
        )
        .run(...values);
      this.db
        .prepare(`DELETE FROM search_entry WHERE ${scopeWhere} AND session_id=?`)
        .run(...values);
      const insert = this.db.prepare(
        'INSERT INTO search_entry(workspace_id,user_id,machine_id,project_id,session_id,turn_id,item_index,kind,path,body) VALUES(?,?,?,?,?,?,?,?,?,?)',
      );
      const content = this.db.prepare('INSERT INTO search_text(rowid,body) VALUES(?,?)');
      for (const entry of parsed.entries) {
        const row = insert.run(
          ...values,
          entry.turnId,
          entry.itemIndex,
          entry.kind,
          entry.path ?? null,
          entry.text,
        );
        // Match the browser's literal Unicode folding exactly. SQLite's native
        // fold alone differs for characters such as U+0130 (dotted capital I).
        content.run(row.lastInsertRowid, entry.text.toLowerCase());
      }
      this.db
        .prepare('INSERT OR REPLACE INTO search_document VALUES(?,?,?,?,?,?)')
        .run(...values, parsed.partial ? 1 : 0);
      this.db.exec('RELEASE moor_search_replace');
    } catch (error) {
      this.db.exec('ROLLBACK TO moor_search_replace; RELEASE moor_search_replace');
      throw error;
    }
  }
  search(
    scope: SearchScope,
    query: string,
    range: 'session' | 'project',
    limit = 30,
    allowedSessionIds?: readonly string[],
  ): { hits: SearchHit[]; more: boolean; partial: boolean } {
    const parsedScope = searchScopeSchema.parse(scope),
      text = searchQuerySchema.parse(query);
    z.enum(['session', 'project']).parse(range);
    z.number().int().min(1).max(SEARCH_LIMITS.results).parse(limit);
    const allowed =
      allowedSessionIds === undefined ? undefined : z.array(id).max(5000).parse(allowedSessionIds);
    if (allowed?.length === 0) return { hits: [], more: false, partial: false };
    const terms = [...new Set(text.toLowerCase().split(/\s+/u))],
      project = scopeValues(parsedScope).slice(0, 4);
    const hits: SearchHit[] = [];
    let more = false,
      partial = false,
      examined = 0,
      bytes = 0;
    let sessions: string[];
    if (range === 'session') {
      sessions = !allowed || allowed.includes(parsedScope.sessionId) ? [parsedScope.sessionId] : [];
    } else if (allowed) sessions = [...new Set(allowed)];
    else {
      sessions = this.db
        .prepare(
          `SELECT session_id FROM search_document WHERE ${scopeWhere} ORDER BY session_id LIMIT 5001`,
        )
        .all(...project)
        .map((row) => String(row.session_id));
      if (sessions.length > 5000) {
        partial = true;
        sessions.length = 5000;
      }
    }
    const document = this.db.prepare(
      `SELECT partial FROM search_document WHERE ${scopeWhere} AND session_id=?`,
    );
    for (const sessionId of sessions)
      partial ||= document.get(...project, sessionId)?.partial === 1;
    const scan = this.db.prepare(SESSION_SEARCH_SCAN_SQL);
    sessions: for (const sessionId of sessions) {
      const rows = scan.iterate(...project, sessionId, this.candidates - examined + 1);
      try {
        for (const row of rows) {
          const body = String(row.body);
          bytes += Buffer.byteLength(body);
          if (++examined > this.candidates || bytes > this.scanBytes) {
            partial = true;
            break sessions;
          }
          // The bound applies before matching to long and short terms alike.
          // Original bodies give the same Unicode semantics as offline search.
          const folded = body.toLowerCase();
          if (!terms.every((term) => folded.includes(term))) continue;
          if (hits.length === limit) {
            more = true;
            break sessions;
          }
          hits.push({
            sessionId: String(row.session_id),
            turnId: String(row.turn_id),
            itemIndex: Number(row.item_index),
            kind: row.kind as SearchHit['kind'],
            ...(row.path === null ? {} : { path: String(row.path) }),
            excerpt: searchExcerpt(body, folded.indexOf(terms[0]!)),
          });
        }
      } finally {
        rows.return?.();
      }
    }
    return { hits, more, partial };
  }
}
