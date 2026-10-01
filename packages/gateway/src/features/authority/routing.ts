import {
  HOST_UPGRADE_REQUIRED,
  RETIRED_RECORDS_FEATURE,
  RETIRED_SESSION_FEATURE,
} from '@moor/protocol/connection-authority';
import { hostCommandSchema, type HostCommand } from '@moor/protocol/host-command';
import { validateHostResponse } from '@moor/protocol/host-response';
import {
  NOTIFICATIONS_FEATURE,
  type HostNotificationEvent,
} from '@moor/protocol/notification-protocol';
import { AppError, assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import { SESSION_PAGE_FEATURE } from '@moor/protocol/session-page';
import { sameValue as isDeepStrictEqual } from '@moor/protocol/value-equality';
import { workspaceReplicaContextSchema } from '@moor/protocol/workspace-catalog';
import type { Accounts } from '../accounts/service';
import type { WorkspaceCatalog } from '../catalog/service';

/** Connection version is opaque identity evidence, never a transport handle. */
export interface GatewayConnections {
  connection(
    device: string,
  ): { version: string; attentionReady: boolean; workspaces: RuntimeWorkspace[] } | undefined;
  online(device: string): boolean;
  closed(): boolean;
}
export class GatewayRouting {
  constructor(
    private readonly accounts: Pick<Accounts, 'snapshot' | 'owner' | 'device' | 'authorityId'>,
    private readonly catalog: Pick<WorkspaceCatalog, 'replica' | 'list'>,
    private readonly live: GatewayConnections,
    private readonly hash: (text: string) => string,
    private readonly dispatch: (
      device: string,
      command: HostCommand,
      owner: string,
    ) => Promise<unknown>,
    private readonly kind: 'local' | 'relay',
  ) {}
  actor(accountId: string) {
    return { kind: this.kind, authorityId: this.accounts.authorityId, accountId };
  }
  replicaContext(owner: string, workspaceId: string, replicaId: string) {
    // All database and live-connection reads complete synchronously in one snapshot.
    // The version describes this mapping, not a lease or permission to execute it.
    return this.accounts.snapshot('replica', () => {
      const replica = this.catalog.replica(owner, workspaceId, replicaId);
      const host = replica.host;
      const device = this.accounts.device(owner, host.device_id);
      const connection = this.live.connection(host.device_id);
      const runtime = connection?.workspaces.find((value) => value.id === host.runtime_id);
      const project = runtime?.projects.find((value) => value.id === replica.local_id);
      assert(
        this.live.online(host.device_id) &&
          connection &&
          runtime &&
          project &&
          device.machine_id === runtime.machineId,
        409,
        '项目副本离线或执行身份已变化',
      );
      const connectionVersion = connection.version;
      const target = {
        owner,
        deviceId: host.device_id,
        userId: runtime.userId,
        machineId: runtime.machineId,
        workspaceId: runtime.id,
        localProjectId: replica.local_id,
        catalogWorkspaceId: workspaceId,
        catalogProjectId: replica.project_id,
        replicaId: replica.id,
      };
      const result = workspaceReplicaContextSchema.parse({
        version: 1,
        identity: { owner, actor: this.actor(owner) },
        target,
        mappingVersion: this.hash(
          JSON.stringify([target, host.id, project.rootPath, connectionVersion]),
        ),
        runtime: { ...runtime, projects: [project] },
      });
      return result;
    });
  }
  notificationRoute(owner: string, deviceId: string, event: HostNotificationEvent) {
    assert(!this.live.closed() && this.live.online(deviceId), 409, '通知主机不在线');
    const device = this.accounts.device(owner, deviceId);
    const workspace = this.live
      .connection(deviceId)
      ?.workspaces.find((workspace) => workspace.id === event.workspaceId);
    assert(
      workspace &&
        workspace.userId === event.userId &&
        workspace.machineId === event.machineId &&
        device.machine_id === event.machineId &&
        workspace.features?.includes(NOTIFICATIONS_FEATURE) &&
        workspace.projects.some((project) => project.id === event.localProjectId),
      403,
      '通知执行范围不匹配',
    );
    const spaces = this.catalog.list(owner, (id) =>
      this.live.online(id) ? this.live.connection(id)!.workspaces : [],
    );
    for (const space of spaces) {
      const host = space.hosts.find(
        (host) =>
          host.deviceId === deviceId &&
          host.runtimeWorkspaceId === event.workspaceId &&
          host.machineId === event.machineId,
      );
      const replica =
        host &&
        space.replicas.find(
          (replica) =>
            replica.hostId === host.id &&
            replica.localProjectId === event.localProjectId &&
            replica.available,
        );
      if (replica) return { catalogWorkspaceId: space.id, replicaId: replica.id };
    }
    throw new AppError(403, '通知项目副本已不可用');
  }
  sessionBoundary(
    owner: string,
    secret: string,
    deviceId: string,
    runtime: RuntimeWorkspace,
    localProjectId?: string,
    catalogueCurrent?: () => void,
  ) {
    const snapshot = structuredClone(runtime),
      connectionVersion = this.live.connection(deviceId)?.version;
    // Legacy device and host-wide list requests have no single project route.
    // Pin every registered project and its current catalogue assignment.
    const mappings = () =>
      this.catalog
        .list(owner!, (device) =>
          this.live.online(device) ? this.live.connection(device)!.workspaces : [],
        )
        .flatMap((space) =>
          space.hosts
            .filter((host) => host.deviceId === deviceId && host.runtimeWorkspaceId === snapshot.id)
            .flatMap((host) =>
              space.replicas
                .filter(
                  (replica) =>
                    replica.hostId === host.id &&
                    (!localProjectId || replica.localProjectId === localProjectId),
                )
                .map((replica) => [
                  space.id,
                  host.id,
                  replica.id,
                  replica.projectId,
                  replica.localProjectId,
                ]),
            ),
        );
    // Replica routes already pin their exact mapping. Only the legacy
    // device/host-wide route needs to enumerate all of its assignments.
    const originalMappings = catalogueCurrent && localProjectId ? undefined : mappings();
    const current = (feature?: string) => {
      assert(!this.live.closed(), 409, '执行服务正在关闭');
      assert(this.accounts.owner(secret) === owner, 401, '请先登录');
      assert(
        this.live.online(deviceId) && this.live.connection(deviceId)?.version === connectionVersion,
        409,
        '执行主机连接已变化，请核查原操作',
      );
      const device = this.accounts.device(owner!, deviceId);
      const active = this.live.connection(deviceId)?.workspaces.find((w) => w.id === snapshot.id);
      const projects = (w: RuntimeWorkspace) =>
        w.projects.filter((p) => !localProjectId || p.id === localProjectId);
      assert(
        this.live.online(deviceId) &&
          this.live.connection(deviceId)?.version === connectionVersion &&
          active?.userId === snapshot.userId &&
          active?.machineId === snapshot.machineId &&
          device.machine_id === snapshot.machineId &&
          isDeepStrictEqual(projects(active), projects(snapshot)) &&
          (!localProjectId || active.projects.some((p) => p.id === localProjectId)) &&
          (!feature || active.features?.includes(feature)),
        409,
        '会话请求的执行范围已变化，请重新读取',
      );
      catalogueCurrent?.();
      if (originalMappings)
        assert(
          isDeepStrictEqual(mappings(), originalMappings),
          409,
          '会话请求的项目归属已变化，请重新读取',
        );
      return active;
    };
    current();
    return { deviceId, runtime: snapshot, current };
  }
  async sessionResponse(
    owner: string,
    boundary: ReturnType<GatewayRouting['sessionBoundary']>,
    method: 'sessions' | 'sessions-page' | 'session' | 'mutate' | 'session-action' | 'cancel',
    input: any,
    localProjectId?: string,
  ) {
    const feature =
      method === 'session-action'
        ? 'session-actions'
        : method === 'sessions-page'
          ? SESSION_PAGE_FEATURE
          : method === 'mutate' && input.kind === 'turn'
            ? RETIRED_RECORDS_FEATURE
            : undefined;
    const command = hostCommandSchema.parse({
      method,
      workspaceId: boundary.runtime.id,
      localProjectId,
      params: input,
    });
    if (method === 'mutate' && input.kind === 'turn')
      assert(
        boundary.runtime.features?.includes(RETIRED_RECORDS_FEATURE),
        409,
        HOST_UPGRADE_REQUIRED,
      );
    boundary.current(feature);
    let raw: unknown, failed: { error: unknown } | undefined;
    try {
      raw = await this.dispatch(boundary.deviceId, command, owner);
    } catch (error) {
      failed = { error };
    }
    // Errors are deliveries too: no raw host diagnostic crosses a revoked scope.
    boundary.current(feature);
    if (failed) {
      const error = failed.error;
      throw new AppError(
        error instanceof AppError &&
          [400, 401, 403, 404, 409, 410, 413, 429, 504].includes(error.status)
          ? error.status
          : 502,
        error instanceof AppError && error.status === 410
          ? RETIRED_SESSION_FEATURE
          : method === 'session' || method === 'sessions' || method === 'sessions-page'
            ? '会话读取失败，请手动重新读取'
            : '会话操作未能确认，请手动查询或重试原操作',
        method !== 'cancel' && error instanceof AppError && error.rejected,
      );
    }
    const result = await validateHostResponse(raw, {
      command,
      workspace: boundary.runtime,
      current: () => boundary.current(feature),
    });
    boundary.current(feature);
    return result;
  }
}
