import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError, assert, id } from '../protocol';
import type { AgentConfig } from './agent';
import type { AttachmentScope } from './store';

const scopeSchema = z.object({
  workspaceId: id,
  userId: z.string().min(1).max(200),
  machineId: id,
  localProjectId: id,
  sessionId: id,
});
const argument = z
  .string()
  .max(65536)
  .refine((value) => !value.includes('\0'));
const configSchema = z.object({
  id,
  name: z.string().max(200),
  cliType: z.string().min(1).max(200),
  agentType: z.string().min(1).max(200),
  machineId: id,
  runtimeOverrides: z.object({ codexPath: z.string().min(1).max(4096).optional() }).optional(),
  customAcp: z
    .object({ command: z.string().min(1).max(4096), args: z.array(argument).max(256) })
    .optional(),
});

function scopeCopy(value: AttachmentScope): AttachmentScope {
  const parsed = scopeSchema.safeParse(value);
  assert(parsed.success, 409, 'Agent 会话绑定范围无效');
  return parsed.data;
}
export function agentConfigSnapshot(value: AgentConfig): AgentConfig {
  // Runtime catalogues may carry capability caches. They never identify a launch
  // version and must not turn a refreshed observation into a configuration edit.
  const parsed = configSchema.safeParse(value);
  assert(parsed.success, 409, 'Agent 配置版本无效');
  const config = parsed.data;
  if (!config.runtimeOverrides?.codexPath) delete config.runtimeOverrides;
  const serialized = JSON.stringify(config);
  assert(Buffer.byteLength(serialized, 'utf8') <= 1024 * 1024, 409, 'Agent 配置版本过大');
  // Optional undefined properties are absent in the durable representation too.
  return JSON.parse(serialized);
}

/** Private launch snapshots; callers alone project safe catalogue fields. */
export class SessionAgentStore {
  private sequence = 0;
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_agent_version(id TEXT PRIMARY KEY,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_agent_binding(
        session_id TEXT PRIMARY KEY,scope TEXT NOT NULL,agent_id TEXT NOT NULL
          REFERENCES session_agent_version(id)
      );
    `);
  }
  get(agentId: string): AgentConfig | undefined {
    assert(id.safeParse(agentId).success, 409, 'Agent 配置版本编号无效');
    const row = this.db.prepare('SELECT config FROM session_agent_version WHERE id=?').get(agentId);
    if (!row) return;
    let config: AgentConfig;
    try {
      config = agentConfigSnapshot(JSON.parse(String(row.config)));
    } catch {
      throw new AppError(409, 'Agent 配置版本无法安全读取');
    }
    assert(config.id === agentId, 409, 'Agent 配置版本编号不匹配');
    return config;
  }
  remember(value: AgentConfig): AgentConfig {
    const config = agentConfigSnapshot(value),
      existing = this.get(config.id);
    if (existing) {
      assert(isDeepStrictEqual(existing, config), 409, 'Agent 配置版本已固定，修改需要新的编号');
      return existing;
    }
    this.db
      .prepare('INSERT INTO session_agent_version(id,config) VALUES(?,?)')
      .run(config.id, JSON.stringify(config));
    return agentConfigSnapshot(config);
  }
  bySession(sessionId: string): { scope: AttachmentScope; config: AgentConfig } | undefined {
    assert(id.safeParse(sessionId).success, 409, 'Agent 会话绑定编号无效');
    const row = this.db
      .prepare('SELECT scope,agent_id FROM session_agent_binding WHERE session_id=?')
      .get(sessionId);
    if (!row) return;
    let scope: AttachmentScope;
    try {
      scope = scopeCopy(JSON.parse(String(row.scope)));
    } catch {
      throw new AppError(409, 'Agent 会话绑定无法安全读取');
    }
    const config = this.get(String(row.agent_id));
    assert(
      config && scope.sessionId === sessionId && scope.machineId === config.machineId,
      409,
      'Agent 会话绑定已损坏',
    );
    return { scope, config };
  }
  binding(value: AttachmentScope): AgentConfig | undefined {
    const scope = scopeCopy(value),
      prior = this.bySession(scope.sessionId);
    if (!prior) return;
    assert(isDeepStrictEqual(prior.scope, scope), 409, 'Agent 会话绑定属于另一执行范围');
    return prior.config;
  }
  bind(value: AttachmentScope, input: AgentConfig): AgentConfig {
    const scope = scopeCopy(value),
      config = agentConfigSnapshot(input);
    assert(config.machineId === scope.machineId, 409, 'Agent 配置不属于当前执行主机');
    const previous = this.binding(scope);
    if (previous) {
      assert(isDeepStrictEqual(previous, config), 409, '已有会话的 Agent 配置版本不可改变');
      return previous;
    }
    // Keep both inserts atomic independently and inside a caller's receipt/doc
    // transaction. Releasing a savepoint never commits an outer transaction.
    const savepoint = 'session_agent_' + ++this.sequence;
    this.db.exec('SAVEPOINT ' + savepoint);
    try {
      const remembered = this.remember(config);
      this.db
        .prepare('INSERT INTO session_agent_binding(session_id,scope,agent_id) VALUES(?,?,?)')
        .run(scope.sessionId, JSON.stringify(scope), remembered.id);
      this.db.exec('RELEASE ' + savepoint);
      return remembered;
    } catch (error) {
      this.db.exec('ROLLBACK TO ' + savepoint);
      this.db.exec('RELEASE ' + savepoint);
      throw error;
    }
  }
  assertCurrent(scope: AttachmentScope, config: AgentConfig): void {
    const current = this.binding(scope);
    assert(
      current && isDeepStrictEqual(current, agentConfigSnapshot(config)),
      409,
      'Agent 会话配置版本不匹配',
    );
  }
}
