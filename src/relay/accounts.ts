import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { assert, type RuntimeWorkspace } from '../protocol';
import { Catalog } from './catalog';
import type { GoogleIdentity } from './google-oidc';
const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export type Device = {
  id: string;
  owner: string;
  name: string;
  revoked: number;
  machine_id: string | null;
  catalog: string;
};
type Account = {
  id: string;
  email: string;
  salt: string | null;
  password: Uint8Array | null;
};
const hasStoredPassword = (
  row: Account | undefined,
): row is Account & {
  salt: string;
  password: Uint8Array;
} =>
  typeof row?.salt === 'string' &&
  row.salt.length > 0 &&
  row.salt.length <= 1024 &&
  row.password instanceof Uint8Array &&
  row.password.byteLength === 64;
const samePassword = (a: Account | undefined, b: Account | undefined) =>
  hasStoredPassword(a) &&
  hasStoredPassword(b) &&
  a.id === b.id &&
  a.email === b.email &&
  a.salt === b.salt &&
  timingSafeEqual(a.password, b.password);
function assertGoogleIdentity(identity: GoogleIdentity) {
  assert(
    identity?.issuer === 'https://accounts.google.com' &&
      typeof identity.subject === 'string' &&
      /^[\x21-\x7e]{1,255}$/.test(identity.subject) &&
      identity.emailVerified === true &&
      typeof identity.email === 'string' &&
      identity.email.length <= 320 &&
      /^[^\s\x00-\x1f\x7f@]+@[^\s\x00-\x1f\x7f@]+$/.test(identity.email),
    401,
    'Google 身份未能确认，请重新登录',
  );
}
export class Store {
  db: DatabaseSync;
  catalog: Catalog;
  constructor(
    file: string,
    public now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS account(id TEXT PRIMARY KEY,email TEXT UNIQUE,salt TEXT,password BLOB);
      CREATE TABLE IF NOT EXISTS external_identity(
        issuer TEXT NOT NULL CHECK(issuer='https://accounts.google.com'),
        subject TEXT NOT NULL,
        owner TEXT NOT NULL UNIQUE REFERENCES account(id) ON DELETE CASCADE,
        verified_email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(issuer,subject)
      );
      CREATE TABLE IF NOT EXISTS login(token TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS pair(code TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS device(id TEXT PRIMARY KEY,owner TEXT,name TEXT,token TEXT UNIQUE,revoked INTEGER DEFAULT 0,machine_id TEXT,catalog TEXT DEFAULT '[]');
    `);
    this.catalog = new Catalog(this.db);
    for (const table of ['pair', 'device'])
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((c) => c.name === 'workspace_id')
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
  }
  close() {
    this.db.close();
  }
  hasAccount() {
    return Boolean(this.db.prepare('SELECT 1 FROM account LIMIT 1').get());
  }
  private account(owner: string) {
    return this.db.prepare('SELECT * FROM account WHERE id=?').get(owner) as Account | undefined;
  }
  private transaction<T>(work: () => T): T {
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
  hasPassword(owner: string) {
    return hasStoredPassword(this.account(owner));
  }
  private async checkPassword(row: Account | undefined, password: string) {
    const validInput = typeof password === 'string' && password.length <= 1024;
    const key = (await derive(
      validInput ? password : '',
      hasStoredPassword(row) ? row.salt : 'invalid-login-salt',
      64,
    )) as Buffer;
    const matches = timingSafeEqual(key, hasStoredPassword(row) ? row.password : Buffer.alloc(64));
    assert(validInput && hasStoredPassword(row) && matches, 401, '邮箱或密码错误');
    assert(samePassword(row, this.account(row.id)), 401, '邮箱或密码错误');
  }
  async verifyPassword(owner: string, password: string): Promise<void> {
    const row = this.account(owner);
    await this.checkPassword(row, password);
    assert(samePassword(row, this.account(owner)), 401, '邮箱或密码错误');
  }
  async setup(email: string, password: string, owner = crypto.randomUUID() as string) {
    assert(!this.hasAccount(), 409, '账号已创建');
    assert(password.length >= 12 && password.length <= 1024, 400, '密码需要至少 12 个字符');
    const salt = token();
    const key = (await derive(password, salt, 64)) as Buffer;
    return this.transaction(() => {
      assert(!this.hasAccount(), 409, '账号已创建');
      this.db
        .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,?,?)')
        .run(owner, email.toLowerCase(), salt, key);
      return this.createLogin(owner);
    });
  }
  async login(email: string, password: string) {
    const row = this.db.prepare('SELECT * FROM account WHERE email=?').get(email.toLowerCase()) as
      | Account
      | undefined;
    await this.checkPassword(row, password);
    assert(row && samePassword(row, this.account(row.id)), 401, '邮箱或密码错误');
    return this.createLogin(row.id);
  }
  googleIdentity(owner: string): { email: string } | null {
    const row = this.db
      .prepare('SELECT verified_email FROM external_identity WHERE owner=?')
      .get(owner);
    return row ? { email: String(row.verified_email) } : null;
  }
  private insertGoogle(owner: string, identity: GoogleIdentity) {
    assert(this.account(owner), 404, '账号不存在');
    assert(
      !this.db.prepare('SELECT 1 FROM external_identity WHERE owner=?').get(owner) &&
        !this.db
          .prepare('SELECT 1 FROM external_identity WHERE issuer=? AND subject=?')
          .get(identity.issuer, identity.subject),
      409,
      'Google 账号已关联，请先核对当前账号',
    );
    const now = this.now();
    this.db
      .prepare('INSERT INTO external_identity VALUES(?,?,?,?,?,?)')
      .run(identity.issuer, identity.subject, owner, identity.email, now, now);
  }
  setupGoogle(identity: GoogleIdentity, owner = crypto.randomUUID() as string): string {
    assertGoogleIdentity(identity);
    return this.transaction(() => {
      assert(!this.hasAccount(), 409, '账号已创建');
      this.db
        .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
        .run(owner, identity.email.toLowerCase());
      this.insertGoogle(owner, identity);
      return this.createLogin(owner);
    });
  }
  linkGoogle(owner: string, identity: GoogleIdentity): void {
    assertGoogleIdentity(identity);
    this.transaction(() => this.insertGoogle(owner, identity));
  }
  loginGoogle(identity: GoogleIdentity): string {
    assertGoogleIdentity(identity);
    return this.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT a.id FROM external_identity e JOIN account a ON a.id=e.owner WHERE e.issuer=? AND e.subject=?',
        )
        .get(identity.issuer, identity.subject);
      assert(row, 401, 'Google 账号尚未关联，请使用原登录方式');
      this.db
        .prepare('UPDATE external_identity SET verified_email=?,updated_at=? WHERE owner=?')
        .run(identity.email, this.now(), row.id);
      return this.createLogin(String(row.id));
    });
  }
  unlinkGoogle(owner: string): void {
    this.transaction(() => {
      assert(this.hasPassword(owner), 409, '请先设置可用的本地密码，才能解除 Google 关联');
      assert(this.googleIdentity(owner), 404, 'Google 账号尚未关联');
      this.db.prepare('DELETE FROM external_identity WHERE owner=?').run(owner);
    });
  }
  /** Private operator recovery only. Never expose this method through an HTTP route. */
  async resetPassword(email: string, password: string): Promise<void> {
    assert(z.string().email().max(200).safeParse(email).success, 400, '登录邮箱无效');
    assert(
      typeof password === 'string' && password.length >= 12 && password.length <= 1024,
      400,
      '密码需要至少 12 个字符',
    );
    const accounts = this.db.prepare('SELECT * FROM account LIMIT 2').all() as Account[];
    assert(accounts.length === 1, 409, '恢复密码需要已有的唯一个人账号');
    const before = accounts[0]!;
    const salt = token(),
      key = (await derive(password, salt, 64)) as Buffer;
    this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM account LIMIT 2').all() as Account[];
      assert(
        current.length === 1 && isDeepStrictEqual(current[0], before),
        409,
        '账号已改变，请重新执行密码恢复',
      );
      this.db
        .prepare('UPDATE account SET email=?,salt=?,password=? WHERE id=?')
        .run(email.toLowerCase(), salt, key, before.id);
      this.db.prepare('DELETE FROM login').run();
      this.db.prepare('DELETE FROM pair').run();
    });
  }
  createLogin(owner: string) {
    const secret = token();
    this.db
      .prepare('INSERT INTO login VALUES(?,?,?)')
      .run(hash(secret), owner, this.now() + 30 * 86400000);
    return secret;
  }
  owner(secret: string) {
    const r = this.db
      .prepare('SELECT owner FROM login WHERE token=? AND expires>?')
      .get(hash(secret), this.now()) as any;
    assert(r, 401, '请先登录');
    return r.owner as string;
  }
  logout(secret: string) {
    this.db.prepare('DELETE FROM login WHERE token=?').run(hash(secret));
  }
  pair(owner: string, workspaceId?: string) {
    if (workspaceId) this.catalog.workspace(owner, workspaceId);
    const code = randomBytes(12).toString('base64url');
    this.db
      .prepare('INSERT INTO pair(code,owner,expires,workspace_id) VALUES(?,?,?,?)')
      .run(hash(code), owner, this.now() + 300000, workspaceId ?? null);
    return code;
  }
  redeem(code: string, name: string, id = crypto.randomUUID() as string) {
    const pair = this.db
      .prepare('SELECT * FROM pair WHERE code=? AND expires>?')
      .get(hash(code), this.now()) as any;
    assert(pair, 401, '配对码已失效');
    const secret = token();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM pair WHERE code=?').run(hash(code));
      this.db
        .prepare('INSERT INTO device(id,owner,name,token,workspace_id) VALUES(?,?,?,?,?)')
        .run(id, pair.owner, name, hash(secret), pair.workspace_id ?? null);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { id, token: secret };
  }
  deviceToken(secret: string) {
    const d = this.db
      .prepare('SELECT * FROM device WHERE token=? AND revoked=0')
      .get(hash(secret)) as Device;
    assert(d, 401, '设备凭证无效或已撤销');
    return d;
  }
  device(owner: string, id: string) {
    const d = this.db
      .prepare('SELECT * FROM device WHERE id=? AND owner=? AND revoked=0')
      .get(id, owner) as Device;
    assert(d, 404, '设备不可用');
    return d;
  }
  devices(owner: string) {
    return this.db
      .prepare('SELECT id,name,machine_id,catalog FROM device WHERE owner=? AND revoked=0')
      .all(owner);
  }
  revoke(owner: string, id: string) {
    this.device(owner, id);
    this.db.prepare('UPDATE device SET revoked=1 WHERE id=?').run(id);
  }
  localDevice(owner: string, name: string) {
    const id = 'local-machine',
      secret = token();
    this.db
      .prepare(
        `INSERT INTO device(id,owner,name,token) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,token=excluded.token,revoked=0 WHERE device.owner=excluded.owner`,
      )
      .run(id, owner, name, hash(secret));
    return { id, token: secret };
  }
  bind(d: Device, machineId: string, workspaces: RuntimeWorkspace[]) {
    assert(!d.machine_id || d.machine_id === machineId, 409, '该配对已绑定另一台机器');
    assert(
      workspaces.every((w) => w.machineId === machineId),
      400,
      '工作区执行机器不匹配',
    );
    this.db.prepare('UPDATE device SET machine_id=? WHERE id=?').run(machineId, d.id);
    this.catalog.discover(d.owner, d.id, workspaces);
  }
}
