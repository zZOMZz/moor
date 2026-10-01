import type { AttentionActor } from '@moor/protocol/attention';
import {
  COLLABORATION_FEATURE,
  collaborationContextSchema,
  collaborationKey,
  collaborationMemberSchema,
  collaborationOfferReceiptSchema,
  collaborationOfferSchema,
  collaborationReadResponseSchema,
  collaborationSyncRequestSchema,
  validateCollaborationSyncResponse,
  type CollaborationContext,
} from '@moor/protocol/collaboration-protocol';
import { assert, id } from '@moor/protocol/protocol';
import { sameValue as isDeepStrictEqual } from '@moor/protocol/value-equality';
import { z } from 'zod';
import type { Accounts } from '../accounts/service';
import type { GatewayConnections } from '../authority/routing';
import type { WorkspaceCatalog } from '../catalog/service';
type CollaborationAction = 'read' | 'sync' | 'member' | 'enable' | 'offer';
type CollaborationCommand = {
  method: `collaboration-${CollaborationAction}`;
  workspaceId: string;
  localProjectId: string;
  params: unknown;
  authorityOwner: string;
  context: CollaborationContext;
};
export class GatewayCollaboration {
  constructor(
    private readonly accounts: Pick<Accounts, 'owner' | 'device' | 'hasOwner'>,
    private readonly catalog: Pick<
      WorkspaceCatalog,
      'collaborationAccess' | 'replica' | 'grantCollaboration'
    >,
    private readonly live: GatewayConnections,
    private readonly actor: (owner: string) => AttentionActor,
    private readonly dispatch: (device: string, command: CollaborationCommand) => Promise<unknown>,
    private readonly membershipChanged: (
      owner: string,
      device: string,
      runtime: string,
      member: string,
    ) => void,
  ) {}
  prepare(
    owner: string,
    secret: string,
    workspaceId: string,
    replicaId: string,
    sessionId: string,
  ) {
    const access = this.catalog.collaborationAccess(owner!, workspaceId!),
      replica = this.catalog.replica(access.owner, workspaceId!, replicaId!),
      host = replica.host,
      connectionVersion = this.live.connection(host.device_id)?.version,
      runtime = this.live
        .connection(host.device_id)
        ?.workspaces.find((entry) => entry.id === host.runtime_id);
    assert(
      runtime &&
        this.live.online(host.device_id) &&
        this.live.connection(host.device_id)?.attentionReady &&
        runtime.features?.includes(COLLABORATION_FEATURE),
      409,
      '共享会话主机离线或尚未支持协作',
    );
    const context = collaborationContextSchema.parse({
      actor: this.actor(owner!),
      ownerActor: this.actor(access.owner),
      executionDeviceId: host.device_id,
      machineId: runtime.machineId,
      catalogWorkspaceId: workspaceId,
      projectId: replica.project_id,
      replicaId,
      runtimeWorkspaceId: runtime.id,
      localProjectId: replica.local_id,
      sessionId,
    });
    const scope = {
      authorityId: context.actor.authorityId,
      workspaceId: workspaceId!,
      projectId: replica.project_id,
      sessionId: sessionId!,
    };
    const current = () => {
      assert(!this.live.closed() && this.accounts.owner(secret) === owner, 401, '协作登录已失效');
      assert(
        isDeepStrictEqual(this.catalog.collaborationAccess(owner!, workspaceId!), access),
        403,
        '协作权限已变化',
      );
      this.accounts.device(access.owner, host.device_id);
      assert(
        this.live.online(host.device_id) &&
          this.live.connection(host.device_id)?.version === connectionVersion &&
          isDeepStrictEqual(
            this.catalog.replica(access.owner, workspaceId!, replicaId!),
            replica,
          ) &&
          isDeepStrictEqual(
            this.live
              .connection(host.device_id)
              ?.workspaces.find((entry) => entry.id === runtime.id),
            runtime,
          ),
        409,
        '协作请求的主机或项目绑定已变化',
      );
    };
    current();
    return {
      access,
      replica,
      host,
      runtime,
      context,
      scope,
      current,
      owner,
      workspaceId,
      sessionId,
    };
  }
  async forward(
    boundary: ReturnType<GatewayCollaboration['prepare']>,
    action: CollaborationAction,
    rawInput: unknown,
  ) {
    const {
      access,
      replica,
      host,
      runtime,
      context,
      scope,
      current,
      owner,
      workspaceId,
      sessionId,
    } = boundary;
    let input: unknown = {};
    if (action === 'sync' || action === 'offer') {
      input =
        action === 'sync'
          ? collaborationSyncRequestSchema.parse(rawInput)
          : collaborationOfferSchema.parse(rawInput);
      assert(
        collaborationKey((input as { scope: typeof scope }).scope) === collaborationKey(scope),
        400,
        action === 'sync' ? '同步范围与原路由不匹配' : 'RPC 意图与原路由不匹配',
      );
    } else if (action === 'enable') {
      assert(access.role === 'owner', 403, '只有所有者可以开启共享');
      input = z.object({}).strict().parse(rawInput);
    } else if (action === 'member') {
      assert(access.role === 'owner', 403, '只有所有者可以管理协作成员');
      const member = collaborationMemberSchema.parse(rawInput);
      assert(
        member.accountId !== owner && this.accounts.hasOwner(member.accountId),
        404,
        '协作账号不可用',
      );
      input = member;
    }
    current();
    let raw: unknown, failure: unknown;
    try {
      raw = await this.dispatch(host.device_id, {
        method: `collaboration-${action}`,
        workspaceId: runtime.id,
        params: input,
        localProjectId: replica.local_id,
        authorityOwner: access.owner,
        context,
      });
    } catch (error) {
      failure = error;
    }
    current();
    if (failure) throw failure;
    if (action === 'sync') {
      return validateCollaborationSyncResponse(raw, collaborationSyncRequestSchema.parse(input));
    }
    if (action === 'member') {
      const member = collaborationMemberSchema.parse(input),
        result = z
          .object({
            confirmed: z.literal(true),
            accountId: id,
            role: collaborationMemberSchema.shape.role,
          })
          .strict()
          .parse(raw);
      assert(
        result.accountId === member.accountId && result.role === member.role,
        502,
        '成员授权回执不匹配',
      );
      this.catalog.grantCollaboration(access.owner, workspaceId!, member.accountId, member.role);
      this.membershipChanged(access.owner, host.device_id, runtime.id, member.accountId);
      return result;
    }
    if (action === 'offer') {
      const offer = collaborationOfferSchema.parse(input),
        receipt = collaborationOfferReceiptSchema.parse(raw);
      assert(
        receipt.operationId === offer.operationId &&
          collaborationKey(receipt.scope) === collaborationKey(scope),
        502,
        'RPC 送达回执与原意图不匹配',
      );
      return receipt;
    }
    const result = collaborationReadResponseSchema.parse(raw),
      target = result.target;
    assert(
      collaborationKey(result.scope) === collaborationKey(scope) &&
        target.executionDeviceId === host.device_id &&
        target.workspaceId === runtime.id &&
        target.machineId === runtime.machineId &&
        target.userId === runtime.userId &&
        target.localProjectId === replica.local_id &&
        target.sessionId === sessionId &&
        result.session.meta.id === sessionId &&
        result.session.meta.userId === runtime.userId &&
        result.session.meta.machineId === runtime.machineId &&
        result.session.meta.project.localProjectId === replica.local_id &&
        result.session.meta.agentConfigId === target.agentId,
      502,
      '共享会话响应不属于原执行范围',
    );
    return result;
  }
}
