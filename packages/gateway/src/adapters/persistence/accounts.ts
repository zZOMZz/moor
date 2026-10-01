import { DatabaseSync } from 'node:sqlite';
import type {
  Account,
  Device,
  AccountsRecords,
  ExternalIdentity,
} from '../../features/accounts/ports';
export class SqliteAccountRecords implements AccountsRecords {
  readonly database: DatabaseSync;
  readonly authorityId: string;
  constructor(file: string) {
    this.database = new DatabaseSync(file);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
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
      CREATE TABLE IF NOT EXISTS account_invitation(token TEXT PRIMARY KEY,creator TEXT NOT NULL REFERENCES account(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pair(code TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS device(id TEXT PRIMARY KEY,owner TEXT,name TEXT,token TEXT UNIQUE,revoked INTEGER DEFAULT 0,machine_id TEXT,catalog TEXT DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS service_identity(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    this.database
      .prepare('INSERT OR IGNORE INTO service_identity VALUES(?,?)')
      .run('authority', crypto.randomUUID());
    this.authorityId = String(
      this.database.prepare('SELECT value FROM service_identity WHERE key=?').get('authority')!
        .value,
    );
    for (const table of ['pair', 'device'])
      if (
        !this.database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((c) => c.name === 'workspace_id')
      )
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
    if (
      !this.database
        .prepare('PRAGMA table_info(device)')
        .all()
        .some((c) => c.name === 'name_revision')
    )
      this.database.exec('ALTER TABLE device ADD COLUMN name_revision INTEGER NOT NULL DEFAULT 0');
  }

  close() {
    this.database.close();
  }
  snapshot<T>(name: 'replica' | 'catalog' | 'logout', work: () => T): T {
    const label = {
      replica: 'workspace_replica_context',
      catalog: 'workspace_catalog_snapshot',
      logout: 'moor_logout',
    }[name];
    this.database.exec('SAVEPOINT ' + label);
    try {
      const result = work();
      this.database.exec('RELEASE ' + label);
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK TO ' + label + '; RELEASE ' + label);
      throw error;
    }
  }
  atomic<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  anyAccount() {
    return !!this.database.prepare('SELECT 1 FROM account LIMIT 1').get();
  }
  account(owner: string) {
    return this.database.prepare('SELECT * FROM account WHERE id=?').get(owner) as
      | Account
      | undefined;
  }
  accountByEmail(email: string) {
    return this.database.prepare('SELECT * FROM account WHERE email=?').get(email) as
      | Account
      | undefined;
  }
  firstAccounts() {
    return this.database.prepare('SELECT * FROM account LIMIT 2').all() as Account[];
  }
  insertAccount(row: Account) {
    this.database
      .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,?,?)')
      .run(row.id, row.email, row.salt, row.password);
  }
  password(owner: string, email: string, salt: string, password: Uint8Array) {
    this.database
      .prepare('UPDATE account SET email=?,salt=?,password=? WHERE id=?')
      .run(email, salt, password, owner);
  }
  pruneInvitations(now: number) {
    this.database.prepare('DELETE FROM account_invitation WHERE expires<=?').run(now);
  }
  invitationCount(owner: string) {
    return Number(
      this.database
        .prepare('SELECT count(*) AS n FROM account_invitation WHERE creator=?')
        .get(owner)!.n,
    );
  }
  invite(hash: string, creator: string, expires: number) {
    this.database
      .prepare('INSERT INTO account_invitation VALUES(?,?,?)')
      .run(hash, creator, expires);
  }
  invitation(hash: string, now: number) {
    return this.database
      .prepare('SELECT creator FROM account_invitation WHERE token=? AND expires>?')
      .get(hash, now) as { creator: string } | undefined;
  }
  removeInvitation(hash: string) {
    this.database.prepare('DELETE FROM account_invitation WHERE token=?').run(hash);
  }
  google(owner: string) {
    const row = this.database
      .prepare('SELECT verified_email FROM external_identity WHERE owner=?')
      .get(owner);
    return row ? { email: String(row.verified_email) } : undefined;
  }
  googleOwner(issuer: string, subject: string) {
    const row = this.database
      .prepare(
        'SELECT a.id FROM external_identity e JOIN account a ON a.id=e.owner WHERE e.issuer=? AND e.subject=?',
      )
      .get(issuer, subject);
    return row ? String(row.id) : undefined;
  }
  insertGoogle(owner: string, identity: ExternalIdentity, now: number) {
    this.database
      .prepare('INSERT INTO external_identity VALUES(?,?,?,?,?,?)')
      .run(identity.issuer, identity.subject, owner, identity.email, now, now);
  }
  updateGoogle(owner: string, email: string, now: number) {
    this.database
      .prepare('UPDATE external_identity SET verified_email=?,updated_at=? WHERE owner=?')
      .run(email, now, owner);
  }
  unlinkGoogle(owner: string) {
    this.database.prepare('DELETE FROM external_identity WHERE owner=?').run(owner);
  }
  login(hash: string, owner: string, expires: number) {
    this.database.prepare('INSERT INTO login VALUES(?,?,?)').run(hash, owner, expires);
  }
  loginOwner(hash: string, now: number) {
    const row = this.database
      .prepare('SELECT owner FROM login WHERE token=? AND expires>?')
      .get(hash, now);
    return row ? String(row.owner) : undefined;
  }
  removeLogin(hash: string) {
    this.database.prepare('DELETE FROM login WHERE token=?').run(hash);
  }
  clearLogins() {
    this.database.prepare('DELETE FROM login').run();
  }
  clearPairs() {
    this.database.prepare('DELETE FROM pair').run();
  }
  pair(hash: string, owner: string, expires: number, workspaceId: string | null) {
    this.database
      .prepare('INSERT INTO pair(code,owner,expires,workspace_id) VALUES(?,?,?,?)')
      .run(hash, owner, expires, workspaceId);
  }
  pairing(hash: string, now: number) {
    return this.database.prepare('SELECT * FROM pair WHERE code=? AND expires>?').get(hash, now) as
      | { owner: string; workspace_id: string | null }
      | undefined;
  }
  removePair(hash: string) {
    this.database.prepare('DELETE FROM pair WHERE code=?').run(hash);
  }
  insertDevice(id: string, owner: string, name: string, hash: string, workspaceId: string | null) {
    this.database
      .prepare('INSERT INTO device(id,owner,name,token,workspace_id) VALUES(?,?,?,?,?)')
      .run(id, owner, name, hash, workspaceId);
  }
  deviceByToken(hash: string) {
    return this.database.prepare('SELECT * FROM device WHERE token=? AND revoked=0').get(hash) as
      | Device
      | undefined;
  }
  device(owner: string, id: string) {
    return this.database
      .prepare('SELECT * FROM device WHERE id=? AND owner=? AND revoked=0')
      .get(id, owner) as Device | undefined;
  }
  devices(owner: string) {
    return this.database
      .prepare('SELECT id,name,machine_id,catalog FROM device WHERE owner=? AND revoked=0')
      .all(owner) as Pick<Device, 'id' | 'name' | 'machine_id' | 'catalog'>[];
  }
  revokeDevice(id: string) {
    this.database.prepare('UPDATE device SET revoked=1 WHERE id=?').run(id);
  }
  localDevice(id: string, owner: string, name: string, hash: string) {
    this.database
      .prepare(
        'INSERT INTO device(id,owner,name,token) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,revoked=0 WHERE device.owner=excluded.owner',
      )
      .run(id, owner, name, hash);
  }
  renameDevice(id: string, name: string, revision: number) {
    this.database
      .prepare('UPDATE device SET name=?,name_revision=? WHERE id=?')
      .run(name, revision, id);
  }
  bindDevice(id: string, machineId: string) {
    this.database.prepare('UPDATE device SET machine_id=? WHERE id=?').run(machineId, id);
  }
}
