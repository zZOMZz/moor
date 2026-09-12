import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  existsSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { id } from '../protocol';
import { CliError } from './args';
export const cliTargetSchema = z
  .object({
    serverKey: z.string().min(1).max(2048),
    owner: z.string().min(1).max(1000),
    deviceId: id,
    userId: z.string().min(1).max(1000),
    machineId: id,
    workspaceId: id,
    localProjectId: id,
    catalogWorkspaceId: id,
    replicaId: id,
    sessionId: id.optional(),
  })
  .strict();
export type CliTarget = z.infer<typeof cliTargetSchema>;
const operationSchema = z
  .object({
    operationId: id,
    kind: z.enum(['turn', 'create', 'stop', 'session-action']),
    target: cliTargetSchema.extend({ sessionId: id }),
    path: z
      .string()
      .regex(/^\/api\/workspaces\/[A-Za-z0-9_:-]+\/replicas\/[A-Za-z0-9_:-]+\//)
      .max(2000),
    body: z.string().max(48 * 1024 * 1024),
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    state: z.enum(['pending', 'ending', 'accepted', 'abandoned', 'rejected']),
    createdAt: z.string().datetime(),
    receipt: z.unknown().optional(),
  })
  .strict();
export type CliOperation = z.infer<typeof operationSchema>;
export type CliConnection = { origin: string; cookie: string; owner: string };
export function requestVersion(body: string) {
  return 'sha256:' + createHash('sha256').update(body).digest('hex');
}
const identityKeys = [
  'serverKey',
  'owner',
  'deviceId',
  'userId',
  'machineId',
  'workspaceId',
  'localProjectId',
  'sessionId',
] as const;
const pendingClause = "json_extract(value,'$.state') IN ('pending','ending')";
const identityColumns = identityKeys.map((key) => "json_extract(value,'$.target." + key + "')");
export function sameCliIdentity(a: CliTarget, b: CliTarget) {
  return identityKeys.every((key) => a[key] === b[key]);
}
function privateFile(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (!directory && stat.nlink !== 1) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new CliError('private-state', 'CLI 状态必须是当前用户独占的私有目录和普通文件。', 1);
}
export function cliAncestorAllowed(
  stat: Pick<Stats, 'uid' | 'mode'>,
  uid = process.getuid?.() ?? 0,
) {
  return (
    (stat.uid === 0 || stat.uid === uid) &&
    ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0)
  );
}
export function defaultCliDirectory() {
  return join(homedir(), '.moor-cli-v1');
}
export class CliState {
  readonly directory: string;
  private db: DatabaseSync;
  private identities: {
    path: string;
    dev: number;
    ino: number;
    uid: number;
    mode: number;
    directory: boolean;
  }[] = [];
  assertCurrent() {
    for (const saved of this.identities) {
      const current = lstatSync(saved.path);
      if (
        current.isSymbolicLink() ||
        current.dev !== saved.dev ||
        current.ino !== saved.ino ||
        current.uid !== saved.uid ||
        current.mode !== saved.mode ||
        (saved.directory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1)
      )
        throw new CliError('private-state', 'CLI 私有目录或数据库已改变；未继续请求。', 1);
    }
  }
  assertOutsideProjects(roots: readonly string[]) {
    for (const project of roots) {
      const root = existsSync(project) ? realpathSync(project) : resolve(project),
        part = relative(root, this.directory);
      if (part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part)))
        throw new CliError('private-state', 'CLI 私有状态目录必须位于项目目录之外。', 1);
    }
  }

  constructor(
    directory = defaultCliDirectory(),
    options: { projectRoots?: readonly string[] } = {},
  ) {
    if (!isAbsolute(directory))
      throw new CliError('private-state', 'CLI 状态目录必须使用绝对路径。', 1);
    directory = resolve(directory);
    const paths: string[] = [];
    let current = directory;
    while (true) {
      paths.unshift(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !cliAncestorAllowed(stat))
        throw new CliError(
          'private-state',
          'CLI 状态目录的祖先不能为符号链接或允许其他用户改写。',
          1,
        );
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateFile(directory, true);
    this.directory = realpathSync(directory);
    this.assertOutsideProjects(options.projectRoots ?? []);
    const file = join(this.directory, 'moor-cli-v1.sqlite');
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    privateFile(file, false);
    this.identities = [...paths, file].map((path) => {
      const stat = lstatSync(path);
      return {
        path,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        mode: stat.mode,
        directory: path !== file,
      };
    });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS setting_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0)); INSERT OR IGNORE INTO setting_revision VALUES(1,0);' +
        'CREATE INDEX IF NOT EXISTS pending_identity ON outbox (' +
        identityColumns.join(',') +
        ') WHERE ' +
        pendingClause +
        ';',
    );
  }
  close() {
    this.db.close();
  }
  get<T>(key: string): T | undefined {
    this.assertCurrent();
    const row = this.db.prepare('SELECT value FROM setting WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  set(key: string, value: unknown) {
    this.compareAndSetSettings(this.settingsRevision(), { [key]: value });
  }
  settingsRevision() {
    this.assertCurrent();
    const revision = this.db
      .prepare('SELECT revision FROM setting_revision WHERE id=1')
      .get()?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
      throw new CliError('private-state', 'CLI 状态版本不可验证。', 1);
    return revision;
  }
  /** One durable CAS for credentials and their pending handoff; every setting write advances it. */
  compareAndSetSettings(expectedRevision: number, updates: Record<string, unknown>) {
    this.assertCurrent();
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new CliError('private-state', 'CLI 状态版本不可验证。', 1);
    const serialized = Object.entries(updates).map(
      ([key, value]) => [key, value === undefined ? undefined : JSON.stringify(value)] as const,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.settingsRevision() !== expectedRevision)
        throw new CliError('conflict', 'CLI 状态已改变，请重新检查当前登录。', 4);
      for (const [key, value] of serialized) {
        if (value === undefined) this.db.prepare('DELETE FROM setting WHERE key=?').run(key);
        else
          this.db
            .prepare(
              'INSERT INTO setting VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            )
            .run(key, value);
      }
      this.db.prepare('UPDATE setting_revision SET revision=revision+1 WHERE id=1').run();
      this.assertCurrent();
      this.db.exec('COMMIT');
      return expectedRevision + 1;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  target() {
    const value = this.get('target');
    return value === undefined ? undefined : cliTargetSchema.parse(value);
  }
  setTarget(value: CliTarget) {
    this.set('target', cliTargetSchema.parse(value));
  }
  operation(operationId: string) {
    this.assertCurrent();
    const row = this.db.prepare('SELECT value FROM outbox WHERE id=?').get(id.parse(operationId));
    if (!row) return;
    const value = operationSchema.parse(JSON.parse(String(row.value)));
    if (value.operationId !== operationId || value.requestVersion !== requestVersion(value.body))
      throw new CliError('corrupt-outbox', '原操作记录校验失败；未发送。', 1);
    return value;
  }
  operationSummaries(limit = 100) {
    this.assertCurrent();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new CliError('usage', '操作列表上限必须是 1 至 100。');
    const rows = this.db
      .prepare(
        "SELECT json_set(json_remove(value,'$.body','$.receipt'),'$.receiptStatus',json_extract(value,'$.receipt.status')) AS value FROM outbox ORDER BY rowid DESC LIMIT ?",
      )
      .all(limit + 1);
    const schema = operationSchema.omit({ body: true, receipt: true }).extend({
      receiptStatus: z.enum(['accepted', 'abandoned', 'stopping', 'interrupted']).nullable(),
    });
    return {
      operations: rows.slice(0, limit).map((row) => schema.parse(JSON.parse(String(row.value)))),
      limit,
      truncated: rows.length > limit,
    };
  }
  operations() {
    this.assertCurrent();
    return this.db
      .prepare('SELECT id FROM outbox ORDER BY rowid DESC')
      .all()
      .map((row) => this.operation(String(row.id))!);
  }
  stage(
    input: Omit<CliOperation, 'requestVersion' | 'state' | 'createdAt'>,
    now = new Date().toISOString(),
  ) {
    const value = operationSchema.parse({
      ...input,
      requestVersion: requestVersion(input.body),
      state: 'pending',
      createdAt: now,
    });
    const parsed = JSON.parse(value.body);
    if (
      parsed.operationId !== value.operationId ||
      parsed.workspaceId !== value.target.workspaceId ||
      parsed.sessionId !== value.target.sessionId ||
      (parsed.localProjectId !== undefined && parsed.localProjectId !== value.target.localProjectId)
    )
      throw new CliError('scope', '请求与原操作范围不匹配。', 5);
    this.assertCurrent();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.operation(value.operationId);
      if (previous) {
        if (
          previous.body !== value.body ||
          previous.kind !== value.kind ||
          !sameCliIdentity(previous.target, value.target)
        )
          throw new CliError('operation-conflict', '原操作编号已用于另一请求。', 5);
        this.db.exec('COMMIT');
        return previous;
      }
      if (value.kind !== 'stop') {
        const blocking = this.db
          .prepare(
            'SELECT id FROM outbox WHERE ' +
              pendingClause +
              ' AND ' +
              identityColumns.map((column) => column + '=?').join(' AND ') +
              ' LIMIT 1',
          )
          .get(...identityKeys.map((key) => value.target[key]));
        if (blocking)
          throw new CliError(
            'pending',
            '请先核查此会话的原操作；停止当前回合仍可单独使用。',
            6,
            String(blocking.id),
          );
      }
      this.db
        .prepare('INSERT INTO outbox VALUES(?,?)')
        .run(value.operationId, JSON.stringify(value));
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  transition(
    operationId: string,
    from: readonly CliOperation['state'][],
    state: CliOperation['state'],
    receipt?: unknown,
  ) {
    this.assertCurrent();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.operation(operationId);
      if (!prior || !from.includes(prior.state))
        throw new CliError('operation-conflict', '原操作状态已改变，请先核查。', 5);
      const next = operationSchema.parse({
        ...prior,
        state,
        ...(receipt === undefined ? {} : { receipt }),
      });
      this.db
        .prepare('UPDATE outbox SET value=? WHERE id=?')
        .run(JSON.stringify(next), operationId);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
