import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  attentionContextSchema,
  type AttentionActor,
  type AttentionContext,
} from '@moor/protocol/attention';
import { assert } from '@moor/protocol/protocol';
import type { Accounts } from '../accounts/service';
import type { GatewayConnections } from '../authority/routing';
import type { WorkspaceCatalog } from '../catalog/service';
type AttentionMethod =
  | 'attention-list'
  | 'attention-items'
  | 'attention-detail'
  | 'attention-seen'
  | 'attention-disposition'
  | 'attention-permission'
  | 'attention-continue';
export class GatewayAttention {
  constructor(
    private readonly accounts: Pick<Accounts, 'owner' | 'device'>,
    private readonly catalog: Pick<WorkspaceCatalog, 'replica'>,
    private readonly live: GatewayConnections,
    private readonly actor: (owner: string) => AttentionActor,
    private readonly dispatch: (
      device: string,
      method: AttentionMethod,
      workspace: string,
      params: unknown,
      project: string,
      context: AttentionContext,
    ) => Promise<unknown>,
  ) {}
  prepare(
    owner: string,
    secret: string,
    workspaceId: string,
    replicaId: string,
    sessionId: string | undefined,
    serviceCurrent: () => boolean,
  ) {
    const replica = this.catalog.replica(owner, workspaceId, replicaId),
      host = replica.host;
    const originalConnection = this.live.connection(host.device_id)?.version;
    const runtime = this.live
      .connection(host.device_id)
      ?.workspaces.find((item) => item.id === host.runtime_id);
    assert(runtime, 409, '项目副本离线或已从主机移除');
    const current = (method: AttentionMethod, continueFeature: string) => {
      assert(serviceCurrent(), 409, '待办请求所属服务已变化，请重新读取');
      assert(this.accounts.owner(secret) === owner, 401, '待办请求所属登录已失效');
      this.accounts.device(owner!, host.device_id);
      const connected = this.live.connection(host.device_id);
      assert(
        this.live.online(host.device_id) &&
          connected &&
          connected.version === originalConnection &&
          connected.attentionReady &&
          connected.workspaces.find((item) => item.id === host.runtime_id) === runtime &&
          runtime.features?.includes(ATTENTION_FEATURE) &&
          runtime.features?.includes(ACTOR_FEATURE) &&
          (method !== 'attention-continue' ||
            (runtime.features?.includes(FOLLOWUP_FEATURE) &&
              runtime.features.includes(continueFeature))),
        409,
        '待办请求所属执行连接已变化，请重新读取',
      );
      const currentReplica = this.catalog.replica(owner!, workspaceId, replica.id);
      assert(
        currentReplica.project_id === replica.project_id &&
          currentReplica.local_id === replica.local_id &&
          currentReplica.host.id === host.id &&
          currentReplica.host.workspace_id === host.workspace_id &&
          currentReplica.host.runtime_id === host.runtime_id &&
          currentReplica.host.device_id === host.device_id,
        409,
        '待办请求所属项目副本已变化，请重新读取',
      );
    };
    assert(
      this.live.connection(host.device_id)?.attentionReady &&
        runtime.features?.includes(ATTENTION_FEATURE) &&
        runtime.features?.includes(ACTOR_FEATURE),
      409,
      '请先升级并连接支持待办工作台的执行电脑',
    );
    const context = attentionContextSchema.parse({
      actor: this.actor(owner!),
      executionDeviceId: host.device_id,
      machineId: runtime.machineId,
      catalogWorkspaceId: workspaceId,
      projectId: replica.project_id,
      replicaId: replica.id,
      runtimeWorkspaceId: host.runtime_id,
      localProjectId: replica.local_id,
      ...(sessionId ? { sessionId } : {}),
    });
    return { context, current, host, replica };
  }
  async respond(
    boundary: ReturnType<GatewayAttention['prepare']>,
    method: AttentionMethod,
    params: unknown,
    continueFeature: string,
  ) {
    const { current, host, replica, context } = boundary;
    current(method, continueFeature);
    try {
      return await this.dispatch(
        host.device_id,
        method,
        host.runtime_id,
        params,
        replica.local_id,
        context,
      );
    } finally {
      current(method, continueFeature);
    }
  }
}
