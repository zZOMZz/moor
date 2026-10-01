import type { ProjectSource, Workspace } from '@moor/protocol/catalog';
import {
  collaborationRoleSchema,
  type CollaborationRole,
} from '@moor/protocol/collaboration-protocol';
import { assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import type { Binding, CatalogIdentity, CatalogRecords, Replica } from './records';
// Only organization metadata is durable here; no session index, CRDT body or credentials.
export class WorkspaceCatalog {
  constructor(
    private readonly records: CatalogRecords,
    private readonly identity: CatalogIdentity,
  ) {}

  private stableId(kind: string, ...parts: string[]) {
    return kind + '-' + this.identity.hash(JSON.stringify(parts)).slice(0, 32);
  }
  collaborationAccess(account: string, workspaceId: string) {
    const workspace = ((owner) => (owner ? { owner } : undefined))(this.records.owner(workspaceId));
    assert(workspace, 404, '共享工作区不可用');
    const owner = String(workspace.owner);
    if (owner === account) return { owner, role: 'owner' as const };
    const member = ((role) => (role === undefined ? undefined : { role }))(
      this.records.memberRole(workspaceId, account),
    );
    assert(member, 403, '没有共享工作区访问权限');
    return { owner, role: collaborationRoleSchema.parse(member.role) };
  }
  collaborationMembers(workspaceId: string): string[] {
    return this.records
      .members(workspaceId)
      .map((account) => ({ account }))
      .map((row) => String(row.account));
  }
  grantCollaboration(
    owner: string,
    workspaceId: string,
    account: string,
    role: CollaborationRole | null,
  ) {
    this.workspace(owner, workspaceId);
    assert(account !== owner && role !== 'owner', 400, '不能通过成员接口更改所有者');
    assert(this.records.hasAccount(account), 404, '协作账号不存在');
    if (role === null) this.records.removeMember(workspaceId, account);
    else this.records.setMember(workspaceId, account, collaborationRoleSchema.parse(role));
  }
  collaborationList(account: string, live: (deviceId: string) => RuntimeWorkspace[]) {
    const spaces = this.records.accessible(account);
    return spaces.flatMap((space) =>
      this.list(String(space.owner), live, false)
        .filter((entry) => entry.id === space.id)
        .map((entry) => ({ ...entry, role: this.collaborationAccess(account, entry.id).role })),
    );
  }
  defaultWorkspace(owner: string) {
    const id = this.stableId('space', owner);
    this.records.defaultWorkspace(id, owner, '个人工作区');
    return id;
  }
  workspace(owner: string, id: string) {
    const row = this.records.workspace(owner, id);
    assert(row, 404, '工作区不可用');
    return row;
  }
  create(owner: string, name: string) {
    const id = this.identity.uuid();
    this.records.insertWorkspace(id, owner, name);
    return { id, name };
  }
  rename(owner: string, id: string, name: string) {
    this.workspace(owner, id);
    this.records.renameWorkspace(id, name);
  }
  discover(owner: string, deviceId: string, workspaces: RuntimeWorkspace[]) {
    this.records.discover(() => {
      const preferred = { workspace_id: this.records.preferredWorkspace(deviceId, owner) }
        ?.workspace_id;
      const fallback =
        typeof preferred === 'string'
          ? String(this.workspace(owner, preferred).id)
          : this.defaultWorkspace(owner);
      for (const ws of workspaces) {
        const hostId = this.stableId('host', deviceId, ws.id);
        this.records.insertBinding({
          id: hostId,
          workspace_id: fallback,
          device_id: deviceId,
          runtime_id: ws.id,
        });
        const binding = this.records.binding(hostId) as Binding;
        for (const local of ws.projects) {
          const replicaId = this.stableId('copy', hostId, local.id);
          if (this.records.replica(replicaId)) continue;
          // Never infer cross-host identity from a name, local id or path.
          const projectId = this.stableId('project', hostId, local.id);
          this.records.insertProject(
            projectId,
            binding.workspace_id,
            local.name,
            '{"kind":"local"}',
          );
          this.records.insertReplica({
            id: replicaId,
            project_id: projectId,
            host_id: hostId,
            local_id: local.id,
          });
        }
      }
    });
  }
  binding(owner: string, workspaceId: string, hostId: string): Binding {
    this.workspace(owner, workspaceId);
    const row = this.records.ownedBinding(owner, workspaceId, hostId) as Binding | undefined;
    assert(row, 404, '主机不属于该工作区');
    return row;
  }
  replica(owner: string, workspaceId: string, replicaId: string) {
    const row = this.records.replica(replicaId) as Replica | undefined;
    assert(row, 404, '项目副本不可用');
    const host = this.binding(owner, workspaceId, row.host_id);
    const project = this.records.project(workspaceId, row.project_id);
    assert(project, 404, '项目不属于该工作区');
    return { ...row, host };
  }
  createProject(owner: string, workspaceId: string, name: string, source: ProjectSource) {
    this.workspace(owner, workspaceId);
    const id = this.identity.uuid();
    this.records.insertProject(id, workspaceId, name, JSON.stringify(source));
    return { id, name, source };
  }
  assign(owner: string, workspaceId: string, replicaId: string, projectId: string) {
    this.replica(owner, workspaceId, replicaId);
    assert(this.records.project(workspaceId, projectId), 404, '目标项目不可用');
    this.records.assignReplica(replicaId, projectId);
  }
  moveHost(owner: string, workspaceId: string, hostId: string, targetWorkspaceId: string) {
    this.binding(owner, workspaceId, hostId);
    this.workspace(owner, targetWorkspaceId);
    if (workspaceId === targetWorkspaceId) return;
    this.records.move(() => {
      // Split logical projects when only one host moves. Runtime sessions and paths stay put.
      const projects = this.records.hostProjects(hostId);
      for (const p of projects) {
        const id = this.identity.uuid();
        this.records.insertProject(id, targetWorkspaceId, p.name, p.source);
        this.records.moveReplicas(hostId, String(p.id), id);
      }
      this.records.moveBinding(hostId, targetWorkspaceId);
    });
  }
  list(
    owner: string,
    live: (deviceId: string) => RuntimeWorkspace[],
    initialize = true,
  ): Workspace[] {
    if (initialize) this.defaultWorkspace(owner);
    return this.records.workspaces(owner).map((space) => {
      const bindings = this.records.bindings(owner, String(space.id));
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
      const projects = this.records.projects(String(space.id)).map((p) => ({
        id: String(p.id),
        name: String(p.name),
        source: JSON.parse(String(p.source)) as ProjectSource,
      }));
      const replicas = hosts.flatMap((h) => {
        const runtime = live(h.deviceId).find((w) => w.id === h.runtimeWorkspaceId);
        return (this.records.replicas(h.id) as Replica[]).map((r) => {
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
