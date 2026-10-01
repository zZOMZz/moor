import type { DatabaseSync } from 'node:sqlite';
import type {
  CatalogRecords,
  WorkspaceRow,
  Binding,
  Replica,
  ProjectRow,
} from '../../features/catalog/records';
export class SqliteCatalogRecords implements CatalogRecords {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_binding(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), device_id TEXT NOT NULL REFERENCES device(id), runtime_id TEXT NOT NULL, UNIQUE(device_id,runtime_id));
      CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), name TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_replica(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), host_id TEXT NOT NULL REFERENCES host_binding(id), local_id TEXT NOT NULL, UNIQUE(host_id,local_id));
      CREATE TABLE IF NOT EXISTS collaboration_access(workspace TEXT NOT NULL REFERENCES workspace(id), account TEXT NOT NULL REFERENCES account(id), role TEXT NOT NULL, PRIMARY KEY(workspace,account));
    `);
  }

  discover<T>(work: () => T): T {
    this.database.exec('SAVEPOINT catalog_discover');
    try {
      const r = work();
      this.database.exec('RELEASE catalog_discover');
      return r;
    } catch (error) {
      this.database.exec('ROLLBACK TO catalog_discover; RELEASE catalog_discover');
      throw error;
    }
  }
  move<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const r = work();
      this.database.exec('COMMIT');
      return r;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  owner(id: string) {
    const r = this.database.prepare('SELECT owner FROM workspace WHERE id=?').get(id);
    return r ? String(r.owner) : undefined;
  }
  memberRole(id: string, account: string) {
    return this.database
      .prepare('SELECT role FROM collaboration_access WHERE workspace=? AND account=?')
      .get(id, account)?.role;
  }
  members(id: string) {
    return this.database
      .prepare('SELECT account FROM collaboration_access WHERE workspace=?')
      .all(id)
      .map((r) => String(r.account));
  }
  hasAccount(id: string) {
    return !!this.database.prepare('SELECT 1 FROM account WHERE id=?').get(id);
  }
  removeMember(id: string, account: string) {
    this.database
      .prepare('DELETE FROM collaboration_access WHERE workspace=? AND account=?')
      .run(id, account);
  }
  setMember(id: string, account: string, role: string) {
    this.database
      .prepare(
        'INSERT INTO collaboration_access VALUES(?,?,?) ON CONFLICT(workspace,account) DO UPDATE SET role=excluded.role',
      )
      .run(id, account, role);
  }
  accessible(account: string) {
    return this.database
      .prepare(
        'SELECT w.id,w.owner FROM workspace w LEFT JOIN collaboration_access a ON a.workspace=w.id AND a.account=? WHERE w.owner=? OR a.account IS NOT NULL',
      )
      .all(account, account) as { id: string; owner: string }[];
  }
  defaultWorkspace(id: string, owner: string, name: string) {
    this.database.prepare('INSERT OR IGNORE INTO workspace VALUES(?,?,?)').run(id, owner, name);
  }
  workspace(owner: string, id: string) {
    return this.database
      .prepare('SELECT * FROM workspace WHERE id=? AND owner=?')
      .get(id, owner) as WorkspaceRow | undefined;
  }
  insertWorkspace(id: string, owner: string, name: string) {
    this.database.prepare('INSERT INTO workspace VALUES(?,?,?)').run(id, owner, name);
  }
  renameWorkspace(id: string, name: string) {
    this.database.prepare('UPDATE workspace SET name=? WHERE id=?').run(name, id);
  }
  preferredWorkspace(deviceId: string, owner: string) {
    const v = this.database
      .prepare('SELECT workspace_id FROM device WHERE id=? AND owner=?')
      .get(deviceId, owner)?.workspace_id;
    return typeof v === 'string' ? v : undefined;
  }
  insertBinding(r: Binding) {
    this.database
      .prepare('INSERT OR IGNORE INTO host_binding VALUES(?,?,?,?)')
      .run(r.id, r.workspace_id, r.device_id, r.runtime_id);
  }
  binding(id: string) {
    return this.database.prepare('SELECT * FROM host_binding WHERE id=?').get(id) as Binding;
  }
  ownedBinding(owner: string, workspaceId: string, id: string) {
    return this.database
      .prepare(
        'SELECT h.* FROM host_binding h JOIN device d ON d.id=h.device_id WHERE h.id=? AND h.workspace_id=? AND d.owner=? AND d.revoked=0',
      )
      .get(id, workspaceId, owner) as Binding | undefined;
  }
  replica(id: string) {
    return this.database.prepare('SELECT * FROM project_replica WHERE id=?').get(id) as
      | Replica
      | undefined;
  }
  project(workspaceId: string, id: string) {
    return this.database
      .prepare('SELECT * FROM project WHERE id=? AND workspace_id=?')
      .get(id, workspaceId) as ProjectRow | undefined;
  }
  insertProject(id: string, workspaceId: string, name: string, source: string) {
    this.database.prepare('INSERT INTO project VALUES(?,?,?,?)').run(id, workspaceId, name, source);
  }
  insertReplica(r: Replica) {
    this.database
      .prepare('INSERT INTO project_replica VALUES(?,?,?,?)')
      .run(r.id, r.project_id, r.host_id, r.local_id);
  }
  assignReplica(id: string, projectId: string) {
    this.database.prepare('UPDATE project_replica SET project_id=? WHERE id=?').run(projectId, id);
  }
  hostProjects(hostId: string) {
    return this.database
      .prepare(
        'SELECT DISTINCT p.* FROM project p JOIN project_replica r ON r.project_id=p.id WHERE r.host_id=?',
      )
      .all(hostId) as ProjectRow[];
  }
  moveReplicas(hostId: string, oldProjectId: string, projectId: string) {
    this.database
      .prepare('UPDATE project_replica SET project_id=? WHERE host_id=? AND project_id=?')
      .run(projectId, hostId, oldProjectId);
  }
  moveBinding(hostId: string, workspaceId: string) {
    this.database
      .prepare('UPDATE host_binding SET workspace_id=? WHERE id=?')
      .run(workspaceId, hostId);
  }
  workspaces(owner: string) {
    return this.database
      .prepare('SELECT * FROM workspace WHERE owner=? ORDER BY rowid')
      .all(owner) as WorkspaceRow[];
  }
  bindings(owner: string, workspaceId: string) {
    return this.database
      .prepare(
        'SELECT h.*,d.name,d.machine_id FROM host_binding h JOIN device d ON d.id=h.device_id WHERE h.workspace_id=? AND d.owner=? AND d.revoked=0 ORDER BY h.rowid',
      )
      .all(workspaceId, owner) as (Binding & { name: string; machine_id: string })[];
  }
  projects(workspaceId: string) {
    return this.database
      .prepare('SELECT * FROM project WHERE workspace_id=? ORDER BY rowid')
      .all(workspaceId) as ProjectRow[];
  }
  replicas(hostId: string) {
    return this.database
      .prepare('SELECT * FROM project_replica WHERE host_id=?')
      .all(hostId) as Replica[];
  }
}
