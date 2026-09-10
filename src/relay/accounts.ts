import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { assert, type Workspace } from '../protocol';
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
export class Store {
  db: DatabaseSync;
  constructor(
    file: string,
    public now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS account(id TEXT PRIMARY KEY,email TEXT UNIQUE,salt TEXT,password BLOB);
      CREATE TABLE IF NOT EXISTS login(token TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS pair(code TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS device(id TEXT PRIMARY KEY,owner TEXT,name TEXT,token TEXT UNIQUE,revoked INTEGER DEFAULT 0,machine_id TEXT,catalog TEXT DEFAULT '[]');
    `);
  }
  close() {
    this.db.close();
  }
  hasAccount() {
    return Boolean(this.db.prepare('SELECT 1 FROM account LIMIT 1').get());
  }
  async setup(email: string, password: string, owner = crypto.randomUUID() as string) {
    assert(!this.hasAccount(), 409, '账号已创建');
    assert(password.length >= 12 && password.length <= 1024, 400, '密码需要至少 12 个字符');
    const salt = token();
    const key = (await derive(password, salt, 64)) as Buffer;
    assert(!this.hasAccount(), 409, '账号已创建');
    this.db
      .prepare('INSERT INTO account VALUES(?,?,?,?)')
      .run(owner, email.toLowerCase(), salt, key);
    return this.createLogin(owner);
  }
  async login(email: string, password: string) {
    assert(password.length <= 1024, 400, '输入过长');
    const row = this.db
      .prepare('SELECT * FROM account WHERE email=?')
      .get(email.toLowerCase()) as any;
    const key = (await derive(password, row?.salt ?? 'invalid-login-salt', 64)) as Buffer;
    assert(row && timingSafeEqual(key, Buffer.from(row.password)), 401, '邮箱或密码错误');
    return this.createLogin(row.id);
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
  pair(owner: string) {
    const code = randomBytes(12).toString('base64url');
    this.db.prepare('INSERT INTO pair VALUES(?,?,?)').run(hash(code), owner, this.now() + 300000);
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
        .prepare('INSERT INTO device(id,owner,name,token) VALUES(?,?,?,?)')
        .run(id, pair.owner, name, hash(secret));
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
  bind(d: Device, machineId: string, workspaces: Workspace[]) {
    assert(!d.machine_id || d.machine_id === machineId, 409, '该配对已绑定另一台机器');
    assert(
      workspaces.every((w) => w.machineId === machineId),
      400,
      '工作区执行机器不匹配',
    );
    this.db.prepare('UPDATE device SET machine_id=? WHERE id=?').run(machineId, d.id);
  }
  workspace(d: Device, ws: string): Workspace {
    const w = (JSON.parse(d.catalog) as Workspace[]).find((w) => w.id === ws);
    assert(w, 404, '工作区不可用');
    return w;
  }
}
