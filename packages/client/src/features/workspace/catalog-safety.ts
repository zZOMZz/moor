export type CatalogDataScope = {
  owner: string;
  origin: string;
  deviceId: string;
  workspaceId: string;
  machineId?: string;
  localProjectId?: string;
  replicaId?: string;
  catalogWorkspaceId: string;
  catalogProjectIds: string[];
};
export interface CatalogSafetyPort {
  assertSettled(scope: CatalogDataScope): Promise<void>;
}
