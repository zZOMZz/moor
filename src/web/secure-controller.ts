import { z } from 'zod';
import { hostCommandSchema, type HostCommand } from '../bridge/host-command';
import {
  desktopSecureRequestSchema,
  desktopSecureResultSchema,
  desktopSecureStatusSchema,
  type DesktopSecureRequest,
  type DesktopSecureStatus,
} from '../security/desktop-client-protocol';
import {
  encryptedCatalogSchema,
  type EncryptedCatalog,
} from '../security/encrypted-bridge-protocol';
import {
  productCanonicalJson,
  type EncryptedProductTarget,
} from '../security/encrypted-product-catalog';
import {
  secureOriginal,
  secureTargetSchema,
  type SecureCliOperation,
  type SecureCliTarget,
} from '../cli/secure-operation';
import {
  buildSessionTurn,
  readClientSession,
  buildSessionPermission,
  sessionPermissionReviews,
  sessionPermissionOutcomeSchema,
  type SessionPermissionReview,
  type SessionPermissionOutcome,
} from '../session-client';
import {
  mutationReceiptSchema,
  sessionListSchema,
  validateSessionActionReceipt,
  type SessionMetadata,
} from '../session-responses';
import {
  sessionControlActionSchema,
  sessionOperationSchema,
  validateSessionControlReceipt,
  validateSessionOperationResult,
} from '../session-control-protocol';
import { sessionActionSchema } from '../protocol';
import { SecureStore, type SecureAuthority } from './secure-store';
import { PERMISSION_REVIEW_FEATURE } from '../permission-review';

export type SecurePermissionReview = { target: SecureCliTarget; request: SessionPermissionReview };
export type SecureWorkspaceState = {
  status: DesktopSecureStatus | null;
  hostId: string | null;
  catalog: Extract<EncryptedCatalog, { catalogVersion: 2 }> | null;
  replicaId: string | null;
  sessions: SessionMetadata[];
  session: ReturnType<typeof readClientSession> | null;
  operations: SecureCliOperation[];
  draft: string;
  permissionReviews: SecurePermissionReview[];
  notice: string | null;
  busy: boolean;
};
type DeviceRequest = Extract<
  DesktopSecureRequest,
  { action: 'device-pair' | 'device-renew' | 'device-cancel' | 'device-accept' }
>;
type Lease = { generation: number; connectionId: string; hostId: string };
const empty = (): SecureWorkspaceState => ({
  status: null,
  hostId: null,
  catalog: null,
  replicaId: null,
  sessions: [],
  session: null,
  operations: [],
  draft: '',
  permissionReviews: [],
  notice: null,
  busy: false,
});
const scope = (target: SecureCliTarget) => ({
  controlVersion: 1 as const,
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  userId: target.userId,
  machineId: target.machineId,
  sessionId: target.sessionId,
});
const same = (a: unknown, b: unknown) => productCanonicalJson(a) === productCanonicalJson(b);
const PERMISSION_UNSUPPORTED = '此执行主机尚不支持精确审批内容核对，请升级执行主机后重新连接。';
const UNKNOWN = '原操作结果待确认；记录已保存在本机。请手动核查，重连不会自动重发。';
class RequestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rejected: boolean,
  ) {
    super(message);
  }
}

/** All execution is an explicit user action. Selection/connection changes invalidate in-flight views. */
export class SecureWorkspaceController {
  #state = empty();
  #draftTarget: SecureCliTarget | null = null;
  #generation = 0;
  #closed = false;
  #working = 0;
  #mutation = false;
  #listeners = new Set<(state: SecureWorkspaceState) => void>();
  #request: (request: DesktopSecureRequest) => Promise<unknown>;
  #account: () => { origin: string; owner: string } | null;
  #store: SecureStore;
  #uuid: () => string;
  #now: () => string;
  constructor(options: {
    request: (request: DesktopSecureRequest) => Promise<unknown>;
    account: () => { origin: string; owner: string } | null;
    store?: SecureStore;
    uuid?: () => string;
    now?: () => string;
  }) {
    this.#request = options.request;
    this.#account = options.account;
    this.#store = options.store ?? new SecureStore();
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  get state(): SecureWorkspaceState {
    return structuredClone(this.#state);
  }
  subscribe(listener: (state: SecureWorkspaceState) => void) {
    this.#listeners.add(listener);
    listener(this.state);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #emit() {
    if (!this.#closed) for (const listener of this.#listeners) listener(this.state);
  }
  #current(generation: number) {
    if (this.#closed || generation !== this.#generation)
      throw Error('当前账号、连接或选择已改变，请重新读取。');
    const device = this.#state.status?.device,
      account = this.#account();
    if (
      device &&
      device.phase !== 'empty' &&
      device.phase !== 'cancelled' &&
      (!account ||
        account.owner !== device.pin.accountId ||
        account.origin !== device.pin.serverOrigin)
    )
      throw Error('当前登录账号与本机配对身份不匹配，未读取原操作。');
  }
  #clearSelection() {
    this.#generation++;
    this.#draftTarget = null;
    Object.assign(this.#state, {
      hostId: null,
      catalog: null,
      replicaId: null,
      sessions: [],
      session: null,
      draft: '',
      permissionReviews: [],
    });
  }
  async #run(task: (current: () => void) => Promise<void>, generation = this.#generation) {
    this.#current(generation);
    this.#working++;
    this.#state.busy = true;
    this.#state.notice = null;
    this.#emit();
    const current = () => this.#current(generation);
    try {
      await task(current);
    } catch (error) {
      if (!this.#closed && generation === this.#generation)
        this.#state.notice = error instanceof Error ? error.message : '请求未确认，请重新核对。';
      throw error;
    } finally {
      this.#working--;
      this.#state.busy = this.#working > 0;
      this.#emit();
    }
  }
  async #rpc(request: DesktopSecureRequest) {
    const parsed = desktopSecureRequestSchema.parse(request);
    const result = desktopSecureResultSchema.parse(await this.#request(parsed));
    if (!result.ok)
      throw new RequestFailure(result.error.code, result.error.message, result.error.rejected);
    return result.value;
  }
  #authority(): SecureAuthority {
    const device = this.#state.status?.device;
    if (!device || device.phase === 'empty' || device.phase === 'cancelled')
      throw Error('请先完成当前设备配对。');
    const account = this.#account();
    if (
      !account ||
      account.origin !== device.pin.serverOrigin ||
      account.owner !== device.pin.accountId
    )
      throw Error('当前登录账号与本机配对身份不匹配，未读取原操作。');
    return {
      origin: device.pin.serverOrigin,
      owner: device.pin.accountId,
      rootKeyId: device.pin.rootKeyId,
      clientDeviceId: device.deviceId,
    };
  }
  async #operations(current: () => void) {
    const device = this.#state.status?.device;
    if (!device || device.phase === 'empty' || device.phase === 'cancelled') {
      this.#state.operations = [];
      return;
    }
    const authority = this.#authority();
    const operations = await this.#store.list(authority);
    current();
    if (!same(authority, this.#authority())) throw Error('当前账号已改变。');
    this.#state.operations = operations;
  }
  #lease(): Lease {
    const status = this.#state.status,
      hostId = this.#state.hostId;
    if (
      !status?.connection ||
      status.device.phase !== 'active' ||
      !hostId ||
      !status.connection.hosts.some((host) => host.deviceId === hostId)
    )
      throw Error('请显式连接并选择主机。');
    return { generation: this.#generation, connectionId: status.connection.connectionId, hostId };
  }
  #target(sessionId: string): SecureCliTarget {
    const lease = this.#lease(),
      catalog = this.#state.catalog;
    const replica = catalog?.products.replicas.find(
      (entry) => entry.id === this.#state.replicaId && entry.available,
    );
    if (!replica || !catalog) throw Error('请选择此主机已确认的产品副本。');
    return secureTargetSchema.parse({
      ...this.#authority(),
      hostDeviceId: lease.hostId,
      workspaceId: replica.runtimeWorkspaceId,
      localProjectId: replica.localProjectId,
      userId: replica.userId,
      machineId: replica.machineId,
      sessionId,
      product: {
        catalogWorkspaceId: replica.catalogWorkspaceId,
        projectId: replica.projectId,
        replicaId: replica.id,
        revision: replica.revision,
      },
    });
  }
  #command(target: SecureCliTarget, method: HostCommand['method'], params: unknown) {
    return hostCommandSchema.parse({
      method,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      params,
    });
  }
  #permissionSupported(workspaceId: string) {
    return (
      this.#state.catalog?.workspaces
        .find((workspace) => workspace.id === workspaceId)
        ?.features?.includes(PERMISSION_REVIEW_FEATURE) === true
    );
  }
  #requirePermissionSupport(workspaceId: string) {
    if (!this.#permissionSupported(workspaceId)) throw Error(PERMISSION_UNSUPPORTED);
  }
  async #execute(lease: Lease, target: SecureCliTarget, command: HostCommand) {
    this.#current(lease.generation);
    const value = await this.#rpc({
      action: 'execute',
      connectionId: lease.connectionId,
      hostId: target.hostDeviceId,
      target: target.product as EncryptedProductTarget,
      command,
    });
    this.#current(lease.generation);
    return value;
  }
  async refreshStatus() {
    return this.#run(async (current) => {
      const status = desktopSecureStatusSchema.parse(await this.#rpc({ action: 'status' }));
      current();
      const authority = (value: DesktopSecureStatus | null) =>
        value ? [value.device, value.connection?.connectionId ?? null] : null;
      if (!same(authority(status), authority(this.#state.status))) {
        const offlineSameDevice =
          status.connection === null &&
          status.device.phase === 'active' &&
          same(status.device, this.#state.status?.device);
        if (offlineSameDevice) this.#generation++;
        else this.#clearSelection();
        this.#state.status = status;
        const generation = this.#generation;
        await this.#operations(() => this.#current(generation));
        return;
      }
      this.#state.status = status;
      await this.#operations(current);
    });
  }
  async device(request: DeviceRequest) {
    this.#clearSelection();
    const generation = this.#generation;
    return this.#run(async (current) => {
      const status = desktopSecureStatusSchema.parse(await this.#rpc(request));
      current();
      this.#state.status = status;
      await this.#operations(current);
    }, generation);
  }
  async connect() {
    this.#clearSelection();
    return this.#run(async (current) => {
      const status = desktopSecureStatusSchema.parse(await this.#rpc({ action: 'connect' }));
      current();
      this.#state.status = status;
      await this.#operations(current);
    });
  }
  async disconnect() {
    const connectionId = this.#state.status?.connection?.connectionId;
    // Keep the already read, account-bound local view and draft after an explicit disconnect.
    this.#generation++;
    this.#state.status = this.#state.status
      ? { ...this.#state.status, connecting: false, connection: null }
      : null;
    return this.#run(async (current) => {
      if (connectionId) {
        await this.#rpc({ action: 'disconnect', connectionId });
        current();
      }
    });
  }
  async selectHost(hostId: string) {
    this.#clearSelection();
    this.#state.hostId = hostId;
    return this.#run(async (current) => {
      const lease = this.#lease();
      const catalog = encryptedCatalogSchema.parse(
        await this.#rpc({ action: 'catalog', connectionId: lease.connectionId, hostId }),
      );
      current();
      if (catalog.catalogVersion !== 2) throw Error('此桌面入口要求主机提供确认后的产品副本目录。');
      const authority = this.#authority();
      if (
        !same(catalog.products.authority, {
          serverOrigin: authority.origin,
          accountId: authority.owner,
          rootKeyId: authority.rootKeyId,
          hostDeviceId: hostId,
        })
      )
        throw Error('主机产品目录与当前账号、根或设备不匹配。');
      this.#state.catalog = catalog;
    });
  }
  async selectReplica(replicaId: string) {
    this.#generation++;
    this.#draftTarget = null;
    Object.assign(this.#state, {
      replicaId,
      sessions: [],
      session: null,
      draft: '',
      permissionReviews: [],
    });
    return this.refreshSessions();
  }
  async refreshSessions() {
    return this.#run(async (current) => {
      const lease = this.#lease(),
        target = this.#target('list');
      const sessions = sessionListSchema.parse(
        await this.#execute(lease, target, this.#command(target, 'sessions', {})),
      );
      current();
      if (
        sessions.some(
          (entry) =>
            entry.userId !== target.userId ||
            entry.machineId !== target.machineId ||
            entry.project.localProjectId !== target.localProjectId,
        )
      )
        throw Error('会话列表与所选执行范围不匹配。');
      this.#state.sessions = sessions;
    });
  }
  async openSession(sessionId: string) {
    this.#generation++;
    this.#draftTarget = null;
    this.#state.session = null;
    this.#state.permissionReviews = [];
    this.#state.draft = '';
    return this.#run(async (current) => {
      const lease = this.#lease(),
        target = this.#target(sessionId);
      const read = readClientSession(
        await this.#execute(lease, target, this.#command(target, 'session', { sessionId })),
        scope(target),
      );
      const draft = await this.#store.readDraft(target);
      current();
      this.#state.session = read;
      const reviews = sessionPermissionReviews(read, scope(target));
      this.#state.permissionReviews = this.#permissionSupported(target.workspaceId)
        ? reviews.map((request) => ({ target: structuredClone(target), request }))
        : [];
      if (reviews.length && !this.#permissionSupported(target.workspaceId))
        this.#state.notice = PERMISSION_UNSUPPORTED;
      this.#draftTarget = structuredClone(target);
      this.#state.draft = draft;
    });
  }
  async refreshSession() {
    const sessionId = this.#state.session?.meta.id;
    if (!sessionId) throw Error('请先选择会话。');
    return this.openSession(sessionId);
  }
  async refreshOperations() {
    return this.#run((current) => this.#operations(current));
  }
  async saveDraft(text: string) {
    return this.#run(async (current) => {
      const id = this.#state.session?.meta.id;
      if (!id) throw Error('请先选择会话。');
      const target = this.#draftTarget,
        expected = this.#state.draft;
      if (
        !target ||
        target.sessionId !== id ||
        !same(this.#authority(), {
          origin: target.origin,
          owner: target.owner,
          rootKeyId: target.rootKeyId,
          clientDeviceId: target.clientDeviceId,
        })
      )
        throw Error('离线草稿与当前账号或已读会话不匹配。');
      await this.#store.saveDraft(target, expected, text, current);
      current();
      this.#state.draft = text;
    });
  }
  async #write(task: (current: () => void) => Promise<void>) {
    if (this.#mutation) throw Error('已有原操作正在处理，请等待或手动核查。');
    this.#mutation = true;
    try {
      await this.#run(task);
    } finally {
      this.#mutation = false;
    }
  }
  async #stage(
    target: SecureCliTarget,
    kind: SecureCliOperation['kind'],
    command: HostCommand,
    current: () => void,
  ) {
    current();
    const operation = await this.#store.stage(
      {
        operationId: z.string().parse((command.params as { operationId: string }).operationId),
        kind,
        target,
        body: JSON.stringify(command),
      },
      this.#now(),
      current,
    );
    current();
    if (operation.state !== 'pending') throw Error('原操作编号已完成，不会再次发送。');
    await this.#operations(current);
    this.#emit();
    return operation;
  }
  async #deliver(lease: Lease, operation: SecureCliOperation, first: boolean, current: () => void) {
    if (operation.kind === 'permission')
      this.#requirePermissionSupport(operation.target.workspaceId);
    try {
      const raw = await this.#store.dispatch(operation, current, (original) =>
        this.#execute(lease, original.target, hostCommandSchema.parse(JSON.parse(original.body))),
      );
      current();
      const original = secureOriginal(operation);
      let receipt: unknown,
        state: SecureCliOperation['state'] = 'accepted';
      if (original.kind === 'control') {
        const result = validateSessionControlReceipt(raw, scope(operation.target), original);
        receipt = result;
        if (result.status === 'stopping') state = 'pending';
        else if (result.status === 'abandoned') state = 'abandoned';
      } else if (original.kind === 'mutation') {
        const result = mutationReceiptSchema.parse(raw);
        if (result.operationId !== operation.operationId) throw Error('主机确认与原操作不匹配。');
        receipt = result;
        if (!result.accepted) state = 'abandoned';
      } else {
        const result = validateSessionActionReceipt(original.value, raw);
        receipt = result;
        if (!result.accepted) state = 'abandoned';
      }
      const next = await this.#store.transition(operation, ['pending'], state, receipt, current);
      current();
      this.#state.notice =
        state === 'pending'
          ? UNKNOWN
          : state === 'accepted'
            ? '主机已确认原操作。请刷新查看最新会话。'
            : '主机已确认封存原操作。';
      return next;
    } catch (error) {
      current();
      if (first && error instanceof RequestFailure && error.code === 'host' && error.rejected) {
        await this.#store.transition(operation, ['pending'], 'rejected', undefined, current);
        this.#state.notice = '主机明确拒绝了本次新操作；原记录已保留。';
      } else this.#state.notice = UNKNOWN;
      return null;
    } finally {
      await this.#operations(current);
    }
  }
  async createSession(agentId: string, title?: string) {
    return this.#write(async (current) => {
      const lease = this.#lease(),
        target = this.#target(this.#uuid());
      const workspace = this.#state.catalog?.workspaces.find(
        (entry) => entry.id === target.workspaceId,
      );
      if (!workspace?.agents.some((agent) => agent.id === agentId))
        throw Error('请选择所选主机目录中的固定 Agent 版本。');
      const action = sessionControlActionSchema.parse({
        ...scope(target),
        action: 'create',
        operationId: this.#uuid(),
        agentId,
        ...(title?.trim() ? { title: title.trim() } : {}),
      });
      const operation = await this.#stage(
        target,
        'create',
        this.#command(target, 'session-control', action),
        current,
      );
      await this.#deliver(lease, operation, true, current);
    });
  }
  async send(prompt: string) {
    return this.#write(async (current) => {
      const lease = this.#lease(),
        prior = this.#state.session;
      if (!prior) throw Error('请先读取会话。');
      const target = this.#target(prior.meta.id);
      const read = readClientSession(
        await this.#execute(
          lease,
          target,
          this.#command(target, 'session', { sessionId: target.sessionId }),
        ),
        scope(target),
      );
      current();
      if (!read.agent) throw Error('主机未提供此会话的固定 Agent 版本。');
      const action = buildSessionTurn({
        scope: scope(target),
        read,
        agent: read.agent,
        prompt,
        operationId: this.#uuid(),
        turnId: this.#uuid(),
        peerId: this.#uuid().replaceAll('-', '').slice(0, 16),
        now: this.#now(),
      });
      const operation = await this.#stage(
        target,
        'turn',
        this.#command(target, 'mutate', action),
        current,
      );
      const result = await this.#deliver(lease, operation, true, current);
      if (result?.state === 'accepted' && this.#state.draft === prompt) {
        await this.#store.saveDraft(target, prompt, '', current);
        current();
        this.#state.draft = '';
      }
    });
  }
  async respondPermission(review: SecurePermissionReview, selected: SessionPermissionOutcome) {
    // Freeze the render-time material synchronously, before a read or lock can yield.
    const shown = structuredClone(review),
      outcome = sessionPermissionOutcomeSchema.parse(selected);
    return this.#write(async (current) => {
      const lease = this.#lease(),
        read = this.#state.session;
      if (!read) throw Error('请先读取并审阅本次审批。');
      const target = this.#target(read.meta.id);
      this.#requirePermissionSupport(target.workspaceId);
      if (
        !same(target, secureTargetSchema.parse(shown.target)) ||
        !this.#state.permissionReviews.some((entry) => same(entry, shown))
      )
        throw Error('审批回合、请求或操作内容已改变，请重新读取并审阅。');
      const fresh = await this.#execute(
        lease,
        target,
        this.#command(target, 'session', { sessionId: target.sessionId }),
      );
      current();
      // Current renderer state can also advance while the read is in flight.
      if (!this.#state.permissionReviews.some((entry) => same(entry, shown)))
        throw Error('审批内容已改变，请重新审阅。');
      const mutation = buildSessionPermission({
        scope: scope(target),
        read: fresh,
        review: shown.request,
        outcome,
        operationId: this.#uuid(),
      });
      const operation = await this.#stage(
        target,
        'permission',
        this.#command(target, 'mutate', mutation),
        current,
      );
      await this.#deliver(lease, operation, true, current);
    });
  }
  async stop() {
    return this.#write(async (current) => {
      const lease = this.#lease(),
        prior = this.#state.session;
      if (!prior) throw Error('请先读取会话。');
      const shown = prior.history.filter((turn) => turn.role === 'assistant' && !turn.finished);
      if (shown.length !== 1) throw Error('当前显示中没有唯一的活动回合，请重新读取。');
      const shownTurnId = shown[0].id;
      const target = this.#target(prior.meta.id);
      const read = readClientSession(
        await this.#execute(
          lease,
          target,
          this.#command(target, 'session', { sessionId: target.sessionId }),
        ),
        scope(target),
      );
      current();
      const active = read.history.filter((turn) => turn.role === 'assistant' && !turn.finished);
      if (active.length !== 1 || active[0].id !== shownTurnId)
        throw Error('活动回合已改变，请重新读取后确认停止。');
      const action = sessionControlActionSchema.parse({
        ...scope(target),
        action: 'stop',
        operationId: this.#uuid(),
        turnId: active[0].id,
      });
      const operation = await this.#stage(
        target,
        'stop',
        this.#command(target, 'session-control', action),
        current,
      );
      await this.#deliver(lease, operation, true, current);
    });
  }
  async metadata(action: 'rename' | 'archive' | 'restore' | 'pin' | 'unpin', title?: string) {
    return this.#write(async (current) => {
      const lease = this.#lease(),
        read = this.#state.session;
      if (!read) throw Error('请先读取会话。');
      const target = this.#target(read.meta.id);
      const request = sessionActionSchema.parse({
        action,
        operationId: this.#uuid(),
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        expectedRevision: read.meta.metadataRevision ?? 0,
        ...(action === 'rename' ? { title: title?.trim() } : {}),
      });
      const operation = await this.#stage(
        target,
        'session-action',
        this.#command(target, 'session-action', request),
        current,
      );
      await this.#deliver(lease, operation, true, current);
    });
  }
  async recover(operationId: string, action: 'inspect' | 'retry' | 'abandon') {
    return this.#write(async (current) => {
      const lease = this.#lease();
      await this.#operations(current);
      let operation = this.#state.operations.find((entry) => entry.operationId === operationId);
      if (!operation || operation.target.hostDeviceId !== lease.hostId)
        throw Error('请先选择原操作的主机。');
      const workspace = this.#state.catalog?.workspaces.find(
        (entry) => entry.id === operation!.target.workspaceId,
      );
      if (
        !workspace ||
        workspace.userId !== operation.target.userId ||
        workspace.machineId !== operation.target.machineId ||
        !workspace.projects.some((entry) => entry.id === operation!.target.localProjectId)
      )
        throw Error('原操作执行范围已改变，未重新绑定。');
      if (operation.kind === 'permission')
        this.#requirePermissionSupport(operation.target.workspaceId);
      if (action === 'retry') {
        if (operation.state === 'ending') throw Error('已请求封存的原操作只能继续核查或封存。');
        if (operation.state !== 'pending') return;
        await this.#deliver(lease, operation, false, current);
        return;
      }
      if (action === 'abandon' && !['pending', 'ending'].includes(operation.state)) return;
      if (action === 'abandon' && operation.state === 'pending')
        operation = await this.#store.transition(
          operation,
          ['pending'],
          'ending',
          undefined,
          current,
        );
      const request = sessionOperationSchema.parse({
        ...scope(operation.target),
        action,
        request: secureOriginal(operation),
      });
      try {
        const result = validateSessionOperationResult(
          await this.#execute(
            lease,
            operation.target,
            this.#command(operation.target, 'session-operations', request),
          ),
          request,
        );
        current();
        if (
          result.found &&
          ['accepted', 'abandoned', 'interrupted'].includes(result.receipt.status) &&
          ['pending', 'ending'].includes(operation.state)
        )
          await this.#store.transition(
            operation,
            ['pending', 'ending'],
            result.receipt.status === 'abandoned' ? 'abandoned' : 'accepted',
            result.receipt,
            current,
          );
        this.#state.notice = !result.found
          ? '主机未找到此原操作；可手动重试原请求或请求封存。'
          : result.receipt.status === 'stopping'
            ? '主机正在停止原回合，请稍后手动核查。'
            : '主机已确认原操作状态。';
      } catch {
        current();
        this.#state.notice = UNKNOWN;
      } finally {
        await this.#operations(current);
      }
    });
  }
  invalidate() {
    this.#generation++;
    this.#draftTarget = null;
    this.#state = empty();
    this.#emit();
  }
  close() {
    this.invalidate();
    this.#closed = true;
    this.#listeners.clear();
    this.#store.close();
  }
}
