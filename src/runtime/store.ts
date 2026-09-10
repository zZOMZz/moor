import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { Flock, LoroDoc, mirror, putMeta } from '../model';
import { Journal } from '../bridge/journal';
import type { RuntimeWorkspace } from '../protocol';

// One host-owned database commits documents, metadata and delivery receipts together.
export class RuntimeStore {
  journal: Journal;
  meta: Flock;
  machine: Flock;
  workspace: RuntimeWorkspace;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.journal = new Journal(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.journal.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_state(key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, snapshot BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_session(id TEXT PRIMARY KEY, native_id TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    const identity = this.load('identity');
    this.workspace = identity
      ? JSON.parse(Buffer.from(identity).toString())
      : {
          id: 'host_' + randomUUID(),
          name: '本机工作区',
          userId: 'local:' + randomUUID(),
          machineId: 'machine_' + randomUUID(),
          projects: [],
          agents: [],
        };
    this.meta = this.loadFlock('meta');
    this.machine = this.loadFlock('machine');
    this.save('identity', Buffer.from(JSON.stringify(this.workspace)));
    // A restart settles interrupted turns, but never starts a queued prompt.
    for (const row of this.journal.db.prepare('SELECT id FROM session').all()) {
      const id = String(row.id),
        doc = this.doc(id),
        view = mirror(doc, id);
      let interrupted = false;
      view.setState((state) => {
        for (const turn of state.history)
          if (turn.role === 'assistant' && !turn.finished) {
            turn.finished = true;
            turn.status = 'failed';
            (turn.items ??= []).push({
              type: 'system_notice',
              name: 'chat_failed',
              message: '执行主机已重启；回合已中断，请手动发送新的指令。',
            });
            interrupted = true;
          }
      });
      view.dispose();
      if (interrupted) {
        putMeta(this.meta, 'session-' + id, { status: { type: 'idle' } });
        this.persist(id, doc);
      }
    }
  }
  load(key: string) {
    return this.journal.db.prepare('SELECT value FROM runtime_state WHERE key=?').get(key)
      ?.value as Uint8Array | undefined;
  }
  save(key: string, bytes: Uint8Array) {
    this.journal.db.prepare('INSERT OR REPLACE INTO runtime_state VALUES(?,?)').run(key, bytes);
  }
  loadFlock(key: string) {
    const bytes = this.load(key);
    return bytes ? Flock.fromFile(bytes) : new Flock();
  }
  doc(id: string) {
    const doc = new LoroDoc();
    const row = this.journal.db.prepare('SELECT snapshot FROM session WHERE id=?').get(id);
    if (row) doc.import(row.snapshot as Uint8Array);
    return doc;
  }
  transaction<T>(fn: () => T): T {
    this.journal.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.journal.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.journal.db.exec('ROLLBACK');
      throw error;
    }
  }
  persist(id: string, doc: LoroDoc) {
    doc.commit();
    this.journal.db
      .prepare('INSERT OR REPLACE INTO session VALUES(?,?)')
      .run(id, doc.export({ mode: 'snapshot' }));
    this.save('meta', this.meta.exportFile());
  }
  registerProject(path: string) {
    const rootPath = realpathSync(path);
    if (!statSync(rootPath).isDirectory()) throw new Error('项目必须是本机目录');
    const id = 'project_' + createHash('sha256').update(rootPath).digest('hex').slice(0, 24);
    this.machine.set(['localProject', id], { id, name: basename(rootPath), rootPath });
    this.saveMachine();
    return id;
  }
  saveMachine() {
    this.machine.commit();
    this.save('machine', this.machine.exportFile());
  }
  nativeSession(id: string) {
    return this.journal.db.prepare('SELECT native_id FROM agent_session WHERE id=?').get(id)
      ?.native_id as string | undefined;
  }
  setNativeSession(id: string, nativeId: string) {
    this.journal.db.prepare('INSERT OR REPLACE INTO agent_session VALUES(?,?)').run(id, nativeId);
  }
  close() {
    this.journal.close();
  }
}
