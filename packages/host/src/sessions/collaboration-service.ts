import { randomUUID } from 'node:crypto';
import { actorKey, type AttentionActor } from '@moor/protocol/attention';
import { assert } from '@moor/protocol/protocol';
import {
  collaborationContextSchema,
  collaborationKey,
  collaborationMemberSchema,
  collaborationReadInputSchema,
  collaborationMethodSchema,
  collaborationSyncRequestSchema,
  taskExecutionTargetSchema,
  type CollaborationContext,
  type CollaborationScope,
  type TaskExecutionTarget,
} from '@moor/protocol/collaboration-protocol';
import { CollaborationStore } from '@moor/sync/store';
import { CollaborationExecutionPlane } from './collaboration';
import { CollaborationCoordinator } from './collaboration-coordinator';
import type { HostWorkspace } from './workspace';

type Connection = { owner: AttentionActor; deviceId: string; current(): void };
/** Composition root: reads, state replication and control have distinct entry points and lifetimes. */
export class HostCollaborationService {
  readonly #stores = new Map<string, CollaborationStore>();
  readonly #coordinators = new Map<string, CollaborationCoordinator>();
  readonly #connections = new Map<string, Connection>();
  readonly #executors = new Map<
    string,
    { scope: CollaborationScope; executor: CollaborationExecutionPlane }
  >();
  readonly #recovered = new Set<string>();
  readonly #activations = new Map<string, Promise<void>>();
  #closed = false;
  constructor(
    private readonly host: HostWorkspace,
    private readonly now = Date.now,
  ) {
    CollaborationStore.prepare(host.store.journal.db);
  }
  private store(authorityId: string) {
    let store = this.#stores.get(authorityId);
    if (!store) {
      store = new CollaborationStore(this.host.store.journal.db, authorityId, this.now, true);
      store.subscribe(({ scope, authored }) => {
        // Only execution coordination interprets submitted/withdrawn intents.
        if (authored && this.#executors.has(collaborationKey(scope)))
          this.coordinator(authorityId).reconcile(scope);
        this.host.sessionChanged(scope.sessionId);
      });
      this.#stores.set(authorityId, store);
    }
    return store;
  }
  private coordinator(authorityId: string) {
    let coordinator = this.#coordinators.get(authorityId);
    if (!coordinator) {
      coordinator = new CollaborationCoordinator(this.store(authorityId));
      this.#coordinators.set(authorityId, coordinator);
    }
    return coordinator;
  }
  private scope(context: CollaborationContext): CollaborationScope {
    return {
      authorityId: context.actor.authorityId,
      workspaceId: context.catalogWorkspaceId,
      projectId: context.projectId,
      sessionId: context.sessionId,
    };
  }
  private current(context: CollaborationContext, current: () => void) {
    current();
    const workspace = this.host.workspace;
    assert(
      !this.#closed &&
        context.actor.authorityId === context.ownerActor.authorityId &&
        context.actor.kind === context.ownerActor.kind &&
        workspace.id === context.runtimeWorkspaceId &&
        workspace.machineId === context.machineId,
      403,
      '协作身份与执行工作区不匹配',
    );
    this.host.checkProject(context.sessionId, context.localProjectId);
  }
  private activate(scope: CollaborationScope, target: TaskExecutionTarget): Promise<void> {
    const key = collaborationKey(scope),
      pending = this.#activations.get(key);
    if (pending) return pending;
    const activation = Promise.resolve()
      .then(() => this.activateOnce(scope, target))
      .finally(() => {
        if (this.#activations.get(key) === activation) this.#activations.delete(key);
      });
    this.#activations.set(key, activation);
    return activation;
  }
  private async activateOnce(scope: CollaborationScope, target: TaskExecutionTarget) {
    const key = collaborationKey(scope);
    if (this.#executors.has(key)) return;
    const connection = this.#connections.get(
      JSON.stringify([scope.authorityId, target.executionDeviceId]),
    );
    assert(connection, 409, '执行主机的协作连接尚未就绪');
    connection.current();
    const coordinator = this.coordinator(scope.authorityId);
    const executor = new CollaborationExecutionPlane({
      host: this.host,
      queue: coordinator.queue,
      scope,
      target,
      current: () => connection.current(),
      reconcile: () => coordinator.reconcile(scope),
      uuid: randomUUID,
      now: this.now,
    });
    if (!this.#recovered.has(key)) {
      // Recover only this private ledger. An unrelated ordinary turn may already be active.
      coordinator.queue.interruptExecution(scope, target);
      this.#recovered.add(key);
    }
    assert(!this.#closed, 409, '协作主机已关闭');
    this.#executors.set(key, { scope, executor });
    coordinator.reconcile(scope);
  }
  async execute(
    method: string,
    raw: unknown,
    rawContext: CollaborationContext,
    current: () => void,
  ) {
    const command = collaborationMethodSchema.parse(method),
      context = collaborationContextSchema.parse(rawContext);
    this.current(context, current);
    const scope = this.scope(context),
      store = this.store(scope.authorityId),
      isOwner = actorKey(context.actor) === actorKey(context.ownerActor);
    if (command === 'collaboration-enable') {
      assert(isOwner, 403, '只有所有者可以开启共享');
      collaborationReadInputSchema.parse(raw);
      const read = await this.host.read(context.sessionId, undefined, context.localProjectId);
      this.current(context, current);
      const target = taskExecutionTargetSchema.parse({
        executionDeviceId: context.executionDeviceId,
        workspaceId: this.host.workspace.id,
        userId: this.host.workspace.userId,
        machineId: this.host.workspace.machineId,
        localProjectId: context.localProjectId,
        sessionId: context.sessionId,
        agentId: read.meta.agentConfigId,
      });
      if (!store.hasWorkspace(scope.workspaceId))
        store.createWorkspace(context.ownerActor, scope.workspaceId);
      store.registerSession(context.actor, scope, target);
      await this.activate(scope, target);
      this.wake(context.sessionId);
      this.current(context, current);
      return { scope, target, role: 'owner' as const, enabled: true, session: read };
    }
    if (command === 'collaboration-read') {
      collaborationReadInputSchema.parse(raw);
      // No registration, document migration, coordinator creation, recovery or wakeup.
      const enabled = store.registered(scope);
      const role = enabled
        ? store.authorizeRead(context.actor, scope)
        : (assert(isOwner, 403, '共享会话尚未由所有者启用'), 'owner' as const);
      const read = await this.host.read(context.sessionId, undefined, context.localProjectId);
      this.current(context, current);
      const target = taskExecutionTargetSchema.parse({
        executionDeviceId: context.executionDeviceId,
        workspaceId: this.host.workspace.id,
        userId: this.host.workspace.userId,
        machineId: this.host.workspace.machineId,
        localProjectId: context.localProjectId,
        sessionId: context.sessionId,
        agentId: read.meta.agentConfigId,
      });
      if (enabled)
        assert(
          JSON.stringify(store.target(scope)) === JSON.stringify(target),
          409,
          '共享会话执行绑定已变化',
        );
      return { scope, target, role, enabled, session: read };
    }
    store.authorizeRead(context.actor, scope);
    let result: unknown;
    if (command === 'collaboration-sync') {
      const request = collaborationSyncRequestSchema.parse(raw);
      assert(
        collaborationKey(request.scope) === collaborationKey(scope),
        403,
        '同步请求与原路由不匹配',
      );
      result = store.sync(context.actor, request);
    } else if (command === 'collaboration-member') {
      assert(isOwner, 403, '只有工作区所有者可以管理协作成员');
      const member = collaborationMemberSchema.parse(raw);
      store.setMember(
        context.actor,
        scope.workspaceId,
        { ...context.actor, accountId: member.accountId },
        member.role,
      );
      result = { confirmed: true, ...member };
    } else {
      result = this.coordinator(scope.authorityId).offer(context.actor, scope, raw);
      this.wake(context.sessionId);
    }
    this.current(context, current);
    return result;
  }
  wake(sessionId?: string) {
    if (this.#closed) return;
    for (const [key, { scope, executor }] of this.#executors) {
      if (sessionId && scope.sessionId !== sessionId) continue;
      void executor.wake().catch(() => {
        executor.close();
        if (this.#executors.get(key)?.executor === executor) this.#executors.delete(key);
      });
    }
  }
  async resume(owner: AttentionActor, executionDeviceId: string, current: () => void) {
    const connectionKey = JSON.stringify([owner.authorityId, executionDeviceId]);
    const existing = this.#connections.get(connectionKey);
    if (existing) {
      assert(actorKey(existing.owner) === actorKey(owner), 403, '协作连接所有者已变化');
      existing.current = current;
    } else this.#connections.set(connectionKey, { owner, deviceId: executionDeviceId, current });
    const store = this.store(owner.authorityId);
    for (const { scope, target } of store.sessions()) {
      if (
        target.executionDeviceId !== executionDeviceId ||
        target.workspaceId !== this.host.workspace.id
      )
        continue;
      current();
      store.migrate(scope);
      await this.activate(scope, target);
    }
    this.wake();
  }
  close() {
    this.#closed = true;
    for (const { executor } of this.#executors.values()) executor.close();
    this.#executors.clear();
    this.#connections.clear();
    this.#stores.clear();
    this.#coordinators.clear();
  }
}
