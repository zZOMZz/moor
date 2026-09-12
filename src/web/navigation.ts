import type { RuntimeWorkspace } from '../protocol';
import type { Workspace } from '../catalog';
export type Device = { id: string; name: string; online: boolean; workspaces: RuntimeWorkspace[] };
export type Selection = {
  deviceId: string;
  workspaceId: string;
  sessionId: string;
  search: string;
  projectId: string;
  catalogWorkspaceId?: string;
  replicaId?: string;
};
export type SessionSummary = {
  id: string;
  title?: string;
  createdAt?: string;
  lastMessageAt?: number;
  project?: { kind?: string; localProjectId?: string };
  status?: { type?: string };
  isArchived?: boolean;
  isPinned?: boolean;
  metadataRevision?: number;
  replicaId?: string;
  projectId?: string;
  deviceName?: string;
};
export function resolveSelection(devices: Device[], saved?: Partial<Selection>) {
  const device = devices.find((d) => d.id === saved?.deviceId);
  if (!device) return undefined;
  const workspace =
    device.workspaces.find((w) => w.id === saved?.workspaceId) ?? device.workspaces[0];
  if (!workspace) return undefined;
  return {
    device,
    workspace,
    sessionId: workspace.id === saved?.workspaceId ? (saved.sessionId ?? '') : '',
    search: workspace.id === saved?.workspaceId ? (saved.search ?? '') : '',
    projectId: workspace.projects.some((p) => p.id === saved?.projectId) ? saved!.projectId! : '',
  };
}
export function catalogSessionList(list: SessionSummary[], workspace: Workspace, hostId: string) {
  const host = workspace.hosts.find((h) => h.id === hostId);
  return list.flatMap((s) => {
    const replica = workspace.replicas.find(
      (r) => r.hostId === hostId && r.localProjectId === s.project?.localProjectId,
    );
    return replica
      ? [{ ...s, replicaId: replica.id, projectId: replica.projectId, deviceName: host?.name }]
      : [];
  });
}
export function filterCatalogSessions(
  list: SessionSummary[],
  workspace: Workspace | undefined,
  search: string,
  projectId: string,
  archived = false,
) {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const projectNames = new Map(workspace?.projects.map((project) => [project.id, project.name]));
  const time = (s: SessionSummary) => s.lastMessageAt ?? (Date.parse(s.createdAt ?? '') || 0);
  return list
    .filter((s) => {
      if (Boolean(s.isArchived) !== archived || (projectId && s.projectId !== projectId))
        return false;
      const haystack =
        `${s.title ?? ''} ${projectNames.get(s.projectId ?? '') ?? ''} ${s.deviceName ?? ''}`.toLocaleLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned)) ||
        time(b) - time(a) ||
        `${a.replicaId}/${a.id}`.localeCompare(`${b.replicaId}/${b.id}`),
    );
}
export function filterSessions(
  list: SessionSummary[],
  workspace: RuntimeWorkspace | undefined,
  search: string,
  projectId: string,
) {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const time = (s: SessionSummary) => s.lastMessageAt ?? (Date.parse(s.createdAt ?? '') || 0);
  return list
    .filter((s) => {
      if (s.isArchived || (projectId && s.project?.localProjectId !== projectId)) return false;
      const project = workspace?.projects.find((p) => p.id === s.project?.localProjectId);
      const haystack = `${s.title ?? ''} ${project?.name ?? ''}`.toLocaleLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
}
