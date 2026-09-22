import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Flock, LoroDoc, metas, mirror, putMeta, VersionVector } from '@moor/session/model';
import { Journal } from './journal';
import { AttentionStore } from './attention-store';
import { assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import type { AttachmentReference, ContentScope } from '@moor/protocol/content-protocol';
import { ProjectHistoryStore } from '../projects/history';
import { projectDiffReferenceSchema } from '@moor/protocol/project-content-protocol';
import { SessionSearchIndex, type SearchScope } from '../sessions/search-index';
import { expireSessionInteractions } from '../sessions/interactions';
import { HostNotifications } from '../integrations/host-notifications';
import { notificationScopeSchema } from '@moor/protocol/notification-protocol';
import { SessionExecutionStore } from '../sessions/execution';
import { SessionForkStore } from '../sessions/fork';
import { SessionGithubStore } from '../sessions/github';
import { SessionAgentStore, agentConfigSnapshot } from '../sessions/agent';
import type { AgentConfig } from '../agents/driver';
import { RetiredTaskRecords } from './retired-tasks';
import { SessionMetadataIndex } from './session-metadata';

export type AttachmentScope = ContentScope & { userId: string; machineId: string };
export type StoredAttachment = {
  reference: AttachmentReference;
  bytes?: Buffer;
  referenced: boolean;
};
const attachmentScopeValues = (scope: AttachmentScope) => [
  scope.workspaceId,
  scope.userId,
  scope.machineId,
  scope.localProjectId,
  scope.sessionId,
];

// One host-owned database commits documents, metadata and delivery receipts together.
export class RuntimeStore {
  journal: Journal;
  projectHistory: ProjectHistoryStore;
  sessionSearch: SessionSearchIndex;
  notifications: HostNotifications;
  executions: SessionExecutionStore;
  forks: SessionForkStore;
  github: SessionGithubStore;
  agents: SessionAgentStore;
  tasks: RetiredTaskRecords;
  sessionPages: SessionMetadataIndex;
  meta: Flock;
  machine: Flock;
  workspace: RuntimeWorkspace;
  attention: AttentionStore;
  private readonly outputCheckpoint: { updates: number; bytes: number };
  private readonly documentBases = new WeakMap<LoroDoc, { id: string; version?: Uint8Array }>();
  private afterCommit: (() => void)[] | undefined;
  constructor(
    file: string,
    options: {
      now?: () => number;
      worktreeRoot?: string;
      /** Host-injected limits; never accepted from a remote request. */
      outputCheckpoint?: { updates: number; bytes: number };
    } = {},
  ) {
    this.outputCheckpoint = options.outputCheckpoint ?? { updates: 512, bytes: 1024 * 1024 };
    for (const value of Object.values(this.outputCheckpoint))
      assert(Number.isSafeInteger(value) && value > 0, 500, '输出检查点限制无效');
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.journal = new Journal(file);
    try {
      this.projectHistory = new ProjectHistoryStore(this.journal.db);
    } catch (error) {
      this.journal.close();
      throw error;
    }
    if (file !== ':memory:') chmodSync(file, 0o600);
    const recoveryIndexPresent = this.journal.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_recovery'")
      .get();
    this.journal.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_state(key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, snapshot BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS session_checkpoint(session_id TEXT PRIMARY KEY,version BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS session_delta(
        session_id TEXT NOT NULL,sequence INTEGER NOT NULL,update_bytes BLOB NOT NULL,version BLOB NOT NULL,
        PRIMARY KEY(session_id,sequence)
      );
      CREATE TRIGGER IF NOT EXISTS session_checkpoint_insert AFTER INSERT ON session BEGIN
        DELETE FROM session_checkpoint WHERE session_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS session_checkpoint_update AFTER UPDATE OF snapshot ON session BEGIN
        DELETE FROM session_checkpoint WHERE session_id=NEW.id;
      END;
      CREATE TABLE IF NOT EXISTS session_recovery(session_id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS session_recovery_insert AFTER INSERT ON session BEGIN
        INSERT OR IGNORE INTO session_recovery VALUES(NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS session_recovery_update AFTER UPDATE OF snapshot ON session BEGIN
        INSERT OR IGNORE INTO session_recovery VALUES(NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS session_recovery_delete AFTER DELETE ON session BEGIN
        DELETE FROM session_recovery WHERE session_id=OLD.id;
      END;
      CREATE TABLE IF NOT EXISTS agent_session(id TEXT PRIMARY KEY, native_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachment_scope(
        workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, machine_id TEXT NOT NULL,
        project_id TEXT NOT NULL, session_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS attachment(
        workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, machine_id TEXT NOT NULL,
        project_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
        reference TEXT NOT NULL, bytes BLOB, referenced INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(workspace_id,user_id,machine_id,project_id,session_id,id)
      );
      CREATE TABLE IF NOT EXISTS search_source(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS search_index_version(
        workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,
        project_id TEXT NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,projection_version INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,user_id,machine_id,project_id,session_id)
      );
      INSERT OR IGNORE INTO search_source SELECT id,1 FROM session;
      CREATE TRIGGER IF NOT EXISTS search_source_insert AFTER INSERT ON session BEGIN
        INSERT INTO search_source VALUES(NEW.id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS search_source_update AFTER UPDATE OF snapshot ON session BEGIN
        INSERT INTO search_source VALUES(NEW.id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS session_delta_insert AFTER INSERT ON session_delta BEGIN
        INSERT INTO search_source VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
        INSERT OR IGNORE INTO session_recovery VALUES(NEW.session_id);
      END;
      PRAGMA user_version=1;
    `);
    this.sessionSearch = new SessionSearchIndex(this.journal.db);
    this.notifications = new HostNotifications(this.journal.db, options);
    this.forks = new SessionForkStore(this.journal.db);
    this.github = new SessionGithubStore(this.journal.db);
    this.agents = new SessionAgentStore(this.journal.db);
    this.tasks = new RetiredTaskRecords(this.journal.db);
    this.executions = new SessionExecutionStore(
      this.journal.db,
      options.worktreeRoot ??
        (file === ':memory:' ? undefined : join(dirname(resolve(file)), 'worktrees')),
    );
    const nativeColumns = this.journal.db.prepare('PRAGMA table_info(agent_session)').all();
    if (!nativeColumns.some((column) => column.name === 'execution_id'))
      this.journal.db.exec(
        "ALTER TABLE agent_session ADD COLUMN execution_id TEXT NOT NULL DEFAULT 'shared'",
      );
    if (!nativeColumns.some((column) => column.name === 'execution_revision'))
      this.journal.db.exec(
        'ALTER TABLE agent_session ADD COLUMN execution_revision INTEGER NOT NULL DEFAULT 0',
      );
    const migrateNativeAgent = !nativeColumns.some((column) => column.name === 'agent_version_id');
    if (migrateNativeAgent)
      this.journal.db.exec('ALTER TABLE agent_session ADD COLUMN agent_version_id TEXT');
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
    try {
      this.sessionPages = new SessionMetadataIndex(this.journal.db, () => this.loadFlock('meta'));
    } catch (error) {
      this.journal.close();
      throw error;
    }
    this.machine = this.loadFlock('machine');
    const migrateAgentBindings = !this.load('agent-bindings-v1');
    // Freeze the configuration actually present before startup registration can
    // select a newer version. This cannot reconstruct pre-upgrade launch history.
    this.transaction(() => {
      this.rememberAgents();
      for (const [name, meta] of Object.entries(migrateAgentBindings ? metas(this.meta) : {})) {
        const project = meta.project as { kind?: string; localProjectId?: string } | undefined;
        if (
          !name.startsWith('session-') ||
          meta.id !== name.slice(8) ||
          meta.userId !== this.workspace.userId ||
          meta.machineId !== this.workspace.machineId ||
          project?.kind !== 'local' ||
          !project.localProjectId ||
          typeof meta.agentConfigId !== 'string'
        )
          continue;
        const scope = {
          workspaceId: this.workspace.id,
          userId: this.workspace.userId,
          machineId: this.workspace.machineId,
          localProjectId: project.localProjectId,
          sessionId: String(meta.id),
        };
        if (!this.attachmentScopeMatches(scope)) continue;
        const stored = this.agents.binding(scope);
        if (!stored && !migrateAgentBindings) continue;
        const agent = stored ?? this.agents.get(meta.agentConfigId);
        if (
          !agent ||
          agent.id !== meta.agentConfigId ||
          agent.machineId !== scope.machineId ||
          agent.cliType !== meta.cliType ||
          agent.agentType !== meta.agentType
        )
          continue;
        this.agents.bind(scope, agent);
        if (migrateAgentBindings)
          this.journal.db
            .prepare(
              'UPDATE agent_session SET agent_version_id=? WHERE id=? AND agent_version_id IS NULL',
            )
            .run(agent.id, scope.sessionId);
      }
      this.save('agent-bindings-v1', Buffer.from('1'));
    });
    this.save('identity', Buffer.from(JSON.stringify(this.workspace)));
    try {
      // Establish the historical boundary before interrupted turns become new
      // terminal facts. A restart never recreates an executable permission.
      this.attention = new AttentionStore(this, options.now);
      this.transaction(() => {
        // Existing snapshots need one recovery/identity migration. Later writes
        // register themselves atomically, including writes by older host versions.
        if (!recoveryIndexPresent || !this.load('session-recovery-v1'))
          this.journal.db.exec('INSERT OR IGNORE INTO session_recovery SELECT id FROM session');
        this.attention.invalidatePermissions();
        this.notifications.resolveAllApprovals();
        for (const row of this.journal.db
          .prepare('SELECT session_id FROM session_recovery ORDER BY session_id')
          .all()) {
          const id = String(row.session_id),
            doc = this.doc(id),
            view = mirror(doc, id),
            localProjectId = (this.meta.get(['m', 'session-' + id, 'project']) as any)
              ?.localProjectId;
          let interrupted = false,
            interactionsChanged = false,
            identityChanged = false;
          const scope = {
            workspaceId: this.workspace.id,
            userId: this.workspace.userId,
            machineId: this.workspace.machineId,
            localProjectId: typeof localProjectId === 'string' ? localProjectId : '',
            sessionId: id,
          };
          const registered = this.machine.get(['localProject', scope.localProjectId]) as
            | { id?: string }
            | undefined;
          const canNotify =
            registered?.id === scope.localProjectId &&
            this.meta.get(['m', 'session-' + id, 'id']) === id &&
            this.meta.get(['m', 'session-' + id, 'userId']) === scope.userId &&
            this.meta.get(['m', 'session-' + id, 'machineId']) === scope.machineId &&
            this.attachmentScopeMatches(scope);
          try {
            view.setState((state) => {
              // Legacy identity repair is a startup migration, never a read-side write.
              if (canNotify && !state.session.id) {
                state.session.id = id;
                identityChanged = true;
              }
              for (const turn of state.history) {
                if (turn.role === 'assistant')
                  interactionsChanged = expireSessionInteractions(turn) || interactionsChanged;
                if (turn.role === 'assistant' && !turn.finished) {
                  turn.finished = true;
                  turn.status = 'failed';
                  if (projectDiffReferenceSchema.safeParse(turn.fileDiff).success) {
                    const reference = this.projectHistory.interrupt(scope, turn.id);
                    if (reference) turn.fileDiff = reference;
                  }
                  (turn.items ??= []).push({
                    type: 'system_notice',
                    name: 'chat_failed',
                    message: '执行主机已重启；回合已中断，请手动发送新的指令。',
                  });
                  if (typeof localProjectId === 'string')
                    this.attention.recordOutcome({
                      sessionId: id,
                      assistantTurnId: turn.id,
                      userTurnId: turn.userTurnId ?? '',
                      localProjectId,
                      cause: 'host_restarted',
                      summary: this.attention.summary(turn.items),
                    });
                  interrupted = true;
                  const notificationScope = notificationScopeSchema.safeParse({
                    ...scope,
                    turnId: turn.id,
                  });
                  if (canNotify && notificationScope.success)
                    this.notifications.record(notificationScope.data, 'failed');
                }
              }
            });
            if (interrupted) putMeta(this.meta, 'session-' + id, { status: { type: 'idle' } });
            if (interrupted || interactionsChanged || identityChanged) this.persist(id, doc);
            this.journal.db.prepare('DELETE FROM session_recovery WHERE session_id=?').run(id);
          } finally {
            view.dispose();
            doc.free();
          }
        }
        this.save('session-recovery-v1', Buffer.from('1'));
      });
    } catch (error) {
      this.journal.close();
      throw error;
    }
  }
  load(key: string) {
    return this.journal.db.prepare('SELECT value FROM runtime_state WHERE key=?').get(key)
      ?.value as Uint8Array | undefined;
  }
  save(key: string, bytes: Uint8Array) {
    this.journal.db.prepare('INSERT OR REPLACE INTO runtime_state VALUES(?,?)').run(key, bytes);
  }
  saveMetadata(flock: Flock, sessionIds: readonly string[]) {
    const write = () => {
      this.sessionPages.ensureCurrent();
      this.save('meta', flock.exportFile());
      this.sessionPages.update(flock, sessionIds);
    };
    if (this.journal.db.isTransaction) write();
    else this.transaction(write);
  }
  loadFlock(key: string) {
    const bytes = this.load(key);
    return bytes ? Flock.fromFile(bytes) : new Flock();
  }
  doc(id: string) {
    const doc = new LoroDoc();
    try {
      const row = this.journal.db.prepare('SELECT snapshot FROM session WHERE id=?').get(id);
      if (row) doc.import(row.snapshot as Uint8Array);
      for (const update of this.journal.db
        .prepare(
          'SELECT update_bytes,version FROM session_delta WHERE session_id=? ORDER BY sequence',
        )
        .all(id)) {
        assert(row, 503, '会话输出缺少历史检查点');
        const imported = doc.import(update.update_bytes as Uint8Array);
        assert(
          !imported.pending?.size &&
            Buffer.from(doc.version().encode()).equals(update.version as Uint8Array),
          503,
          '会话输出增量不完整或版本不匹配',
        );
      }
      this.documentBases.set(doc, { id, version: row ? this.documentVersion(doc) : undefined });
      return doc;
    } catch (error) {
      doc.free();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    this.journal.db.exec('BEGIN IMMEDIATE');
    const committed: (() => void)[] = [];
    this.afterCommit = committed;
    try {
      const result = fn();
      this.journal.db.exec('COMMIT');
      for (const remember of committed) remember();
      return result;
    } catch (error) {
      if (this.journal.db.isTransaction) this.journal.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.afterCommit = undefined;
    }
  }
  private documentVersion(doc: LoroDoc) {
    const version = doc.version();
    try {
      return version.encode();
    } finally {
      version.free();
    }
  }
  private rememberDocument(id: string, doc: LoroDoc) {
    const version = this.documentVersion(doc);
    const remember = () => this.documentBases.set(doc, { id, version });
    if (this.afterCommit) this.afterCommit.push(remember);
    // A transaction opened outside RuntimeStore must reread its document after
    // commit. Do not advance an in-memory base before an unknown outer commit.
    else if (!this.journal.db.isTransaction) remember();
  }
  private durableVersion(id: string): Uint8Array | undefined {
    const header =
      this.journal.db
        .prepare(
          'SELECT version FROM session_delta WHERE session_id=? ORDER BY sequence DESC LIMIT 1',
        )
        .get(id) ??
      this.journal.db.prepare('SELECT version FROM session_checkpoint WHERE session_id=?').get(id);
    if (header) return header.version as Uint8Array;
    // Legacy databases have a snapshot but no version header. Read its actual
    // version without rewriting it or assuming an empty persistence baseline.
    const row = this.journal.db.prepare('SELECT snapshot FROM session WHERE id=?').get(id);
    if (!row) return undefined;
    const original = new LoroDoc();
    try {
      original.import(row.snapshot as Uint8Array);
      return this.documentVersion(original);
    } finally {
      original.free();
    }
  }
  private matchesBase(actual: Uint8Array | undefined, expected: Uint8Array | undefined) {
    if (actual) return expected !== undefined && Buffer.from(actual).equals(expected);
    if (!expected) return true;
    const version = VersionVector.decode(expected);
    try {
      return version.toJSON().size === 0;
    } finally {
      version.free();
    }
  }
  persist(id: string, doc: LoroDoc, from?: VersionVector) {
    const remembered = this.documentBases.get(doc);
    const expected = from?.encode() ?? (remembered?.id === id ? remembered.version : undefined);
    doc.commit();
    const view = mirror(doc, id);
    let needsRecovery: boolean;
    try {
      const state = view.getState();
      needsRecovery =
        !state.session.id ||
        state.history.some(
          (turn) =>
            turn.role === 'assistant' &&
            (!turn.finished ||
              turn.items?.some(
                (item) =>
                  item !== null &&
                  typeof item === 'object' &&
                  'type' in item &&
                  'status' in item &&
                  (item.type === 'question' || item.type === 'steer') &&
                  item.status === 'pending',
              )),
        );
    } finally {
      view.dispose();
    }
    const write = () => {
      this.checkpoint(id, doc, expected);
      this.saveMetadata(this.meta, [id]);
      // The trigger conservatively tracks every snapshot. Only the writer that
      // has inspected that exact document may omit a settled session at startup.
      if (!needsRecovery)
        this.journal.db.prepare('DELETE FROM session_recovery WHERE session_id=?').run(id);
      this.rememberDocument(id, doc);
    };
    if (this.journal.db.isTransaction) write();
    else this.transaction(write);
  }
  private checkpoint(id: string, doc: LoroDoc, expected: Uint8Array | undefined) {
    const durable = this.durableVersion(id);
    assert(
      this.matchesBase(durable, expected),
      409,
      '检查点原持久版本已变化，不能覆盖已经保存的输出',
    );
    const tail = this.journal.db
      .prepare(
        'SELECT sequence,version FROM session_delta WHERE session_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(id);
    if (durable) {
      const stored = VersionVector.decode(durable);
      const current = doc.version();
      try {
        const order = current.compare(stored);
        assert(order !== undefined && order >= 0, 409, '检查点未包含已经保存的输出');
      } finally {
        stored.free();
        current.free();
      }
    }
    this.journal.db
      .prepare('INSERT OR REPLACE INTO session VALUES(?,?)')
      .run(id, doc.export({ mode: 'snapshot' }));
    this.journal.db
      .prepare('INSERT OR REPLACE INTO session_checkpoint VALUES(?,?)')
      .run(id, doc.version().encode());
    if (tail)
      this.journal.db
        .prepare('DELETE FROM session_delta WHERE session_id=? AND sequence<=?')
        .run(id, tail.sequence);
  }
  /** Persist exact CRDT operations before publishing output. The base must still
   * be the durable head; a stale candidate cannot overwrite a newer tail. */
  persistOutput(id: string, candidate: LoroDoc, from: VersionVector) {
    candidate.commit();
    assert(candidate.getMap('session').get('id') === id, 409, '输出会话身份不匹配');
    const write = () => {
      assert(
        this.journal.db.prepare('SELECT 1 FROM session WHERE id=?').get(id),
        409,
        '会话检查点不存在',
      );
      const previous = this.journal.db
        .prepare(
          'SELECT sequence,version FROM session_delta WHERE session_id=? ORDER BY sequence DESC LIMIT 1',
        )
        .get(id);
      const head = this.durableVersion(id)!;
      const expected = from.encode();
      assert(this.matchesBase(head, expected), 409, '持久会话已更新，不能覆盖新的输出');
      if (Buffer.from(candidate.version().encode()).equals(head)) return;
      const update = candidate.export({ mode: 'update', from });
      const tail = this.journal.db
        .prepare(
          'SELECT COUNT(*) AS count,COALESCE(SUM(length(update_bytes)),0) AS bytes FROM session_delta WHERE session_id=?',
        )
        .get(id)!;
      if (
        Number(tail.count) + 1 >= this.outputCheckpoint.updates ||
        Number(tail.bytes) + update.byteLength >= this.outputCheckpoint.bytes
      ) {
        // Snapshot, tail removal, search revision and recovery registration share
        // the caller's transaction. Preserve history for old client version vectors.
        this.checkpoint(id, candidate, expected);
      } else {
        this.journal.db
          .prepare('INSERT INTO session_delta VALUES(?,?,?,?)')
          .run(id, Number(previous?.sequence ?? 0) + 1, update, candidate.version().encode());
      }
      this.rememberDocument(id, candidate);
    };
    if (this.journal.db.isTransaction) write();
    else this.transaction(write);
  }
  searchSource(id: string) {
    const row = this.journal.db
      .prepare(
        'SELECT s.revision,length(d.snapshot)+COALESCE((SELECT SUM(length(update_bytes)) FROM session_delta WHERE session_id=s.session_id),0) AS bytes FROM search_source s JOIN session d ON d.id=s.session_id WHERE s.session_id=?',
      )
      .get(id);
    return row ? { revision: Number(row.revision), bytes: Number(row.bytes) } : undefined;
  }
  searchIndexVersion(scope: SearchScope) {
    const row = this.journal.db
      .prepare(
        'SELECT v.revision,v.projection_version FROM search_index_version v JOIN search_document d USING(workspace_id,user_id,machine_id,project_id,session_id) WHERE v.workspace_id=? AND v.user_id=? AND v.machine_id=? AND v.project_id=? AND v.session_id=?',
      )
      .get(...attachmentScopeValues(scope));
    return row
      ? { revision: Number(row.revision), projectionVersion: Number(row.projection_version) }
      : undefined;
  }
  markSearchIndexed(scope: SearchScope, revision: number, projectionVersion: number) {
    assert(this.searchSource(scope.sessionId)?.revision === revision, 409, '会话在索引期间已更新');
    this.journal.db
      .prepare('INSERT OR REPLACE INTO search_index_version VALUES(?,?,?,?,?,?,?)')
      .run(...attachmentScopeValues(scope), revision, projectionVersion);
  }
  registerProject(path: string) {
    const rootPath = realpathSync(path);
    if (!statSync(rootPath).isDirectory()) throw new Error('项目必须是本机目录');
    const id = 'project_' + createHash('sha256').update(rootPath).digest('hex').slice(0, 24);
    const previous = this.machine;
    this.machine = Flock.fromFile(previous.exportFile());
    try {
      return this.transaction(() => {
        if (!this.machine.get(['localProject', id])) {
          this.machine.set(['localProject', id], { id, name: basename(rootPath), rootPath });
          this.saveMachine();
        }
        return id;
      });
    } catch (error) {
      this.machine = previous;
      throw error;
    }
  }
  saveMachine() {
    this.rememberAgents();
    this.machine.commit();
    this.save('machine', this.machine.exportFile());
  }
  private rememberAgents() {
    for (const row of this.machine.scan({ prefix: ['agentConfig'] })) {
      const config = row.value as AgentConfig;
      assert(row.key[1] === config.id, 409, 'Agent 配置版本编号不匹配');
      this.agents.remember(config);
    }
  }
  // Local registration advances a private preset pointer; sessions keep version IDs.
  registerAgent(presetId: string, config: AgentConfig, registered?: (next: AgentConfig) => void) {
    const previous = this.machine;
    this.machine = Flock.fromFile(previous.exportFile());
    try {
      return this.transaction(() => {
        const currentId = this.machine.get(['agentPreset', presetId]);
        const current = this.agents.get(typeof currentId === 'string' ? currentId : config.id);
        const candidate = agentConfigSnapshot({ ...config, id: current?.id ?? config.id });
        assert(candidate.machineId === this.workspace.machineId, 409, 'Agent 配置不属于本机');
        const next =
          current && !isDeepStrictEqual(current, candidate)
            ? { ...candidate, id: 'agent_' + randomUUID() }
            : candidate;
        this.agents.remember(next);
        this.machine.set(['agentConfig', next.id], next as never);
        this.machine.set(['agentPreset', presetId], next.id);
        this.machine.set(['retiredAgent', next.id], false);
        if (
          current &&
          current.id !== next.id &&
          !this.machine.scan({ prefix: ['agentPreset'] }).some((row) => row.value === current.id)
        )
          this.machine.set(['retiredAgent', current.id], true);
        registered?.(next);
        this.saveMachine();
        return next;
      });
    } catch (error) {
      this.machine = previous;
      throw error;
    }
  }
  hasNativeSession(id: string) {
    return !!this.journal.db.prepare('SELECT 1 FROM agent_session WHERE id=?').get(id);
  }
  nativeSession(
    id: string,
    execution = { executionId: 'shared', executionRevision: 0 },
    agentId?: string,
  ) {
    const row = this.journal.db.prepare('SELECT * FROM agent_session WHERE id=?').get(id);
    if (!row) return;
    assert(
      row.execution_id === execution.executionId &&
        row.execution_revision === execution.executionRevision,
      409,
      '原生 Agent 上下文属于其他执行目录，不能恢复',
    );
    const binding = this.agents.bySession(id);
    const expectedAgent = agentId ?? binding?.config.id;
    if (expectedAgent)
      assert(
        row.agent_version_id === expectedAgent && (!binding || binding.config.id === expectedAgent),
        409,
        '原生 Agent 上下文属于其他配置版本，不能恢复',
      );
    return row.native_id as string;
  }
  setNativeSession(
    id: string,
    nativeId: string,
    execution = { executionId: 'shared', executionRevision: 0 },
    agentId?: string,
  ) {
    const binding = this.agents.bySession(id);
    const expectedAgent = agentId ?? binding?.config.id;
    assert(!agentId || binding?.config.id === agentId, 409, 'Agent 会话配置版本尚未固定');
    this.nativeSession(id, execution, expectedAgent);
    this.journal.db
      .prepare(
        'INSERT OR REPLACE INTO agent_session(id,native_id,execution_id,execution_revision,agent_version_id) VALUES(?,?,?,?,?)',
      )
      .run(id, nativeId, execution.executionId, execution.executionRevision, expectedAgent ?? null);
  }
  attachmentScopeMatches(scope: AttachmentScope) {
    const row = this.journal.db
      .prepare('SELECT * FROM attachment_scope WHERE session_id=?')
      .get(scope.sessionId);
    return (
      !row ||
      (row.workspace_id === scope.workspaceId &&
        row.user_id === scope.userId &&
        row.machine_id === scope.machineId &&
        row.project_id === scope.localProjectId)
    );
  }
  reserveAttachmentScope(scope: AttachmentScope) {
    assert(this.attachmentScopeMatches(scope), 404, '附件会话不属于该项目副本');
    this.journal.db
      .prepare('INSERT OR IGNORE INTO attachment_scope VALUES(?,?,?,?,?)')
      .run(...attachmentScopeValues(scope));
  }
  attachment(scope: AttachmentScope, id: string): StoredAttachment | undefined {
    const row = this.journal.db
      .prepare(
        'SELECT reference,bytes,referenced FROM attachment WHERE workspace_id=? AND user_id=? AND machine_id=? AND project_id=? AND session_id=? AND id=?',
      )
      .get(...attachmentScopeValues(scope), id);
    return row
      ? {
          reference: JSON.parse(String(row.reference)),
          bytes: row.bytes === null ? undefined : Buffer.from(row.bytes as Uint8Array),
          referenced: row.referenced === 1,
        }
      : undefined;
  }
  generatedAttachment(scope: AttachmentScope, reference: AttachmentReference) {
    const row = this.journal.db
      .prepare(
        "SELECT reference FROM attachment WHERE workspace_id=? AND user_id=? AND machine_id=? AND project_id=? AND session_id=? AND referenced=1 AND bytes IS NOT NULL AND id GLOB 'attachment_*' AND json_extract(reference,'$.name')=? AND json_extract(reference,'$.content.version')=? AND json_extract(reference,'$.content.mediaType')=? LIMIT 1",
      )
      .get(
        ...attachmentScopeValues(scope),
        reference.name,
        reference.content.version,
        reference.content.mediaType,
      );
    return row ? (JSON.parse(String(row.reference)) as AttachmentReference) : undefined;
  }
  attachmentBytes(scope: AttachmentScope) {
    return Number(
      this.journal.db
        .prepare(
          'SELECT coalesce(sum(length(bytes)),0) AS size FROM attachment WHERE workspace_id=? AND user_id=? AND machine_id=? AND project_id=? AND session_id=?',
        )
        .get(...attachmentScopeValues(scope))!.size,
    );
  }
  saveAttachment(scope: AttachmentScope, reference: AttachmentReference, bytes: Buffer) {
    this.journal.db
      .prepare(
        'INSERT INTO attachment(workspace_id,user_id,machine_id,project_id,session_id,id,reference,bytes) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        ...attachmentScopeValues(scope),
        reference.attachmentId,
        JSON.stringify(reference),
        bytes,
      );
  }
  removeAttachment(scope: AttachmentScope, id: string) {
    this.journal.db
      .prepare(
        'UPDATE attachment SET bytes=NULL WHERE workspace_id=? AND user_id=? AND machine_id=? AND project_id=? AND session_id=? AND id=? AND referenced=0',
      )
      .run(...attachmentScopeValues(scope), id);
  }
  referenceAttachment(scope: AttachmentScope, id: string) {
    this.journal.db
      .prepare(
        'UPDATE attachment SET referenced=1 WHERE workspace_id=? AND user_id=? AND machine_id=? AND project_id=? AND session_id=? AND id=? AND bytes IS NOT NULL',
      )
      .run(...attachmentScopeValues(scope), id);
  }
  close() {
    this.journal.close();
  }
}
