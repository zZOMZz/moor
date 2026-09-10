import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeWorkspace } from '../protocol';
import { assert } from '../protocol';
import type { Workspace, ProjectSource } from '../catalog';

type Binding = { id: string; workspace_id: string; device_id: string; runtime_id: string };
type Replica = { id: string; project_id: string; host_id: string; local_id: string };
const stableId = (kind: string, ...parts: string[]) =>
  kind + '-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

// Only organization metadata is durable here; no session index, CRDT body or credentials.
export class Catalog {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_binding(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), device_id TEXT NOT NULL REFERENCES device(id), runtime_id TEXT NOT NULL, UNIQUE(device_id,runtime_id));
      CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), name TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_replica(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), host_id TEXT NOT NULL REFERENCES host_binding(id), local_id TEXT NOT NULL, UNIQUE(host_id,local_id));
    `);
  }
  defaultWorkspace(owner: string) {
    const id = stableId('space', owner);
    this.db.prepare('INSERT OR IGNORE INTO workspace VALUES(?,?,?)').run(id, owner, '个人工作区');
    return id;
  }
  workspace(owner: string, id: string) {
    const row = this.db.prepare('SELECT * FROM workspace WHERE id=? AND owner=?').get(id, owner);
    assert(row, 404, '工作区不可用');
    return row;
  }
  create(owner: string, name: string) {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO workspace VALUES(?,?,?)').run(id, owner, name);
    return { id, name };
  }
  rename(owner: string, id: string, name: string) {
    this.workspace(owner, id);
    this.db.prepare('UPDATE workspace SET name=? WHERE id=?').run(name, id);
  }
  discover(owner: string, deviceId: string, workspaces: RuntimeWorkspace[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const preferred = this.db
        .prepare('SELECT workspace_id FROM device WHERE id=? AND owner=?')
        .get(deviceId, owner)?.workspace_id;
      const fallback =
        typeof preferred === 'string'
          ? String(this.workspace(owner, preferred).id)
          : this.defaultWorkspace(owner);
      for (const ws of workspaces) {
        const hostId = stableId('host', deviceId, ws.id);
        this.db
          .prepare('INSERT OR IGNORE INTO host_binding VALUES(?,?,?,?)')
          .run(hostId, fallback, deviceId, ws.id);
        const binding = this.db
          .prepare('SELECT * FROM host_binding WHERE id=?')
          .get(hostId) as Binding;
        for (const local of ws.projects) {
          const replicaId = stableId('copy', hostId, local.id);
          if (this.db.prepare('SELECT 1 FROM project_replica WHERE id=?').get(replicaId)) continue;
          // Never infer cross-host identity from a name, local id or path.
          const projectId = stableId('project', hostId, local.id);
          this.db
            .prepare('INSERT INTO project VALUES(?,?,?,?)')
            .run(projectId, binding.workspace_id, local.name, '{"kind":"local"}');
          this.db
            .prepare('INSERT INTO project_replica VALUES(?,?,?,?)')
            .run(replicaId, projectId, hostId, local.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  binding(owner: string, workspaceId: string, hostId: string): Binding {
    this.workspace(owner, workspaceId);
    const row = this.db
      .prepare(
        `SELECT h.* FROM host_binding h JOIN device d ON d.id=h.device_id
      WHERE h.id=? AND h.workspace_id=? AND d.owner=? AND d.revoked=0`,
      )
      .get(hostId, workspaceId, owner) as Binding | undefined;
    assert(row, 404, '主机不属于该工作区');
    return row;
  }
  replica(owner: string, workspaceId: string, replicaId: string) {
    const row = this.db.prepare('SELECT * FROM project_replica WHERE id=?').get(replicaId) as
      | Replica
      | undefined;
    assert(row, 404, '项目副本不可用');
    const host = this.binding(owner, workspaceId, row.host_id);
    const project = this.db
      .prepare('SELECT * FROM project WHERE id=? AND workspace_id=?')
      .get(row.project_id, workspaceId);
    assert(project, 404, '项目不属于该工作区');
    return { ...row, host };
  }
  createProject(owner: string, workspaceId: string, name: string, source: ProjectSource) {
    this.workspace(owner, workspaceId);
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO project VALUES(?,?,?,?)')
      .run(id, workspaceId, name, JSON.stringify(source));
    return { id, name, source };
  }
  assign(owner: string, workspaceId: string, replicaId: string, projectId: string) {
    this.replica(owner, workspaceId, replicaId);
    assert(
      this.db
        .prepare('SELECT 1 FROM project WHERE id=? AND workspace_id=?')
        .get(projectId, workspaceId),
      404,
      '目标项目不可用',
    );
    this.db.prepare('UPDATE project_replica SET project_id=? WHERE id=?').run(projectId, replicaId);
  }
  moveHost(owner: string, workspaceId: string, hostId: string, targetWorkspaceId: string) {
    this.binding(owner, workspaceId, hostId);
    this.workspace(owner, targetWorkspaceId);
    if (workspaceId === targetWorkspaceId) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Split logical projects when only one host moves. Runtime sessions and paths stay put.
      const projects = this.db
        .prepare(
          `SELECT DISTINCT p.* FROM project p JOIN project_replica r ON r.project_id=p.id WHERE r.host_id=?`,
        )
        .all(hostId);
      for (const p of projects) {
        const id = crypto.randomUUID();
        this.db
          .prepare('INSERT INTO project VALUES(?,?,?,?)')
          .run(id, targetWorkspaceId, p.name, p.source);
        this.db
          .prepare('UPDATE project_replica SET project_id=? WHERE host_id=? AND project_id=?')
          .run(id, hostId, p.id);
      }
      this.db
        .prepare('UPDATE host_binding SET workspace_id=? WHERE id=?')
        .run(targetWorkspaceId, hostId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  list(owner: string, live: (deviceId: string) => RuntimeWorkspace[]): Workspace[] {
    this.defaultWorkspace(owner);
    return this.db
      .prepare('SELECT * FROM workspace WHERE owner=? ORDER BY rowid')
      .all(owner)
      .map((space) => {
        const bindings = this.db
          .prepare(
            `SELECT h.*,d.name,d.machine_id FROM host_binding h JOIN device d ON d.id=h.device_id WHERE h.workspace_id=? AND d.owner=? AND d.revoked=0 ORDER BY h.rowid`,
          )
          .all(space.id, owner);
        const hosts = bindings.map((h) => {
          const runtime = live(String(h.device_id)).find((w) => w.id === h.runtime_id);
          return {
            id: String(h.id),
            deviceId: String(h.device_id),
            machineId: String(h.machine_id),
            runtimeWorkspaceId: String(h.runtime_id),
            name: String(h.name),
            online: !!runtime,
            agents: runtime?.agents ?? [],
          };
        });
        const projects = this.db
          .prepare('SELECT * FROM project WHERE workspace_id=? ORDER BY rowid')
          .all(space.id)
          .map((p) => ({
            id: String(p.id),
            name: String(p.name),
            source: JSON.parse(String(p.source)) as ProjectSource,
          }));
        const replicas = hosts.flatMap((h) => {
          const runtime = live(h.deviceId).find((w) => w.id === h.runtimeWorkspaceId);
          return (
            this.db.prepare('SELECT * FROM project_replica WHERE host_id=?').all(h.id) as Replica[]
          ).map((r) => {
            const local = runtime?.projects.find((p) => p.id === r.local_id);
            return {
              id: r.id,
              projectId: r.project_id,
              hostId: h.id,
              localProjectId: r.local_id,
              rootPath: local?.rootPath,
              available: !!local,
            };
          });
        });
        return { id: String(space.id), name: String(space.name), hosts, projects, replicas };
      });
  }
}
