import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Flock, LoroDoc, metas, mirror, putMeta } from '../model';
import { Journal } from '../bridge/journal';
import { assert, type RuntimeWorkspace } from '../protocol';
import type { AttachmentReference, ContentScope } from '../content-protocol';
import { ProjectHistoryStore } from './project-history';
import { projectDiffReferenceSchema } from '../project-content-protocol';
import { SessionSearchIndex, type SearchScope } from './session-search';
import { expireSessionInteractions } from '../bridge/session-interactions';
import { HostNotifications } from './host-notifications';
import { notificationScopeSchema } from '../notification-protocol';
import { SessionExecutionStore } from './session-execution';
import { SessionForkStore } from './session-fork';
import { SessionGithubStore } from './session-github';
import { SessionAgentStore, agentConfigSnapshot } from './session-agent';
import type { AgentConfig } from './agent';
import { TaskStore } from './session-tasks';

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
  tasks: TaskStore;
  meta: Flock;
  machine: Flock;
  workspace: RuntimeWorkspace;
  constructor(file: string, options: { now?: () => number; worktreeRoot?: string } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.journal = new Journal(file);
    this.projectHistory = new ProjectHistoryStore(this.journal.db);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.journal.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_state(key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, snapshot BLOB NOT NULL);
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
      PRAGMA user_version=1;
    `);
    this.sessionSearch = new SessionSearchIndex(this.journal.db);
    this.notifications = new HostNotifications(this.journal.db, options);
    this.forks = new SessionForkStore(this.journal.db);
    this.github = new SessionGithubStore(this.journal.db);
    this.agents = new SessionAgentStore(this.journal.db);
    this.tasks = new TaskStore(this.journal.db, options);
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
    this.machine = this.loadFlock('machine');
    const migrateAgentBindings = !this.load('agent-bindings-v1');
    // Freeze the configuration actually present before startup registration can
    // select a newer version. This cannot reconstruct pre-upgrade launch history.
    this.transaction(() => {
      this.rememberAgents();
      for (const [name, meta] of Object.entries(metas(this.meta))) {
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
    this.notifications.resolveAllApprovals();
    // A restart settles interrupted turns, but never starts a queued prompt.
    for (const row of this.journal.db.prepare('SELECT id FROM session').all()) {
      const id = String(row.id),
        doc = this.doc(id),
        view = mirror(doc, id);
      let interrupted = false,
        interactionsChanged = false;
      const meta = this.meta.get(['m', 'session-' + id, 'project']) as
        | { localProjectId?: string }
        | undefined;
      const scope = {
        workspaceId: this.workspace.id,
        userId: this.workspace.userId,
        machineId: this.workspace.machineId,
        localProjectId: meta?.localProjectId ?? '',
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
        this.transaction(() => {
          view.setState((state) => {
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
          if (interrupted || interactionsChanged) this.persist(id, doc);
        });
      } finally {
        view.dispose();
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
  searchSource(id: string) {
    const row = this.journal.db
      .prepare(
        'SELECT s.revision,length(d.snapshot) AS bytes FROM search_source s JOIN session d ON d.id=s.session_id WHERE s.session_id=?',
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
    this.machine.set(['localProject', id], { id, name: basename(rootPath), rootPath });
    this.saveMachine();
    return id;
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
