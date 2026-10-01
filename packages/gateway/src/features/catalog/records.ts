export type WorkspaceRow = { id: string; owner: string; name: string };
export type Binding = { id: string; workspace_id: string; device_id: string; runtime_id: string };
export type Replica = { id: string; project_id: string; host_id: string; local_id: string };
export type ProjectRow = { id: string; workspace_id: string; name: string; source: string };
export interface CatalogRecords {
  discover<T>(work: () => T): T;
  move<T>(work: () => T): T;
  owner(workspaceId: string): string | undefined;
  memberRole(workspaceId: string, account: string): unknown;
  members(workspaceId: string): string[];
  hasAccount(account: string): boolean;
  removeMember(workspaceId: string, account: string): void;
  setMember(workspaceId: string, account: string, role: string): void;
  accessible(account: string): { id: string; owner: string }[];
  defaultWorkspace(id: string, owner: string, name: string): void;
  workspace(owner: string, id: string): WorkspaceRow | undefined;
  insertWorkspace(id: string, owner: string, name: string): void;
  renameWorkspace(id: string, name: string): void;
  preferredWorkspace(deviceId: string, owner: string): string | undefined;
  insertBinding(binding: Binding): void;
  binding(id: string): Binding;
  ownedBinding(owner: string, workspaceId: string, id: string): Binding | undefined;
  replica(id: string): Replica | undefined;
  project(workspaceId: string, id: string): ProjectRow | undefined;
  insertProject(id: string, workspaceId: string, name: string, source: string): void;
  insertReplica(replica: Replica): void;
  assignReplica(replicaId: string, projectId: string): void;
  hostProjects(hostId: string): ProjectRow[];
  moveReplicas(hostId: string, oldProjectId: string, projectId: string): void;
  moveBinding(hostId: string, workspaceId: string): void;
  workspaces(owner: string): WorkspaceRow[];
  bindings(owner: string, workspaceId: string): (Binding & { name: string; machine_id: string })[];
  projects(workspaceId: string): ProjectRow[];
  replicas(hostId: string): Replica[];
}
export interface CatalogIdentity {
  uuid(): string;
  hash(value: string): string;
}
