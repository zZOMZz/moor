import { z } from 'zod';
import { AGENT_MODEL_OPTIONS_FEATURE } from '../protocol';
import { selectionFromInput, runSelectionSchema, type RunSelection } from '../run-config';
import { publicAgentFailure } from '../agent-errors';
import { SecureRunOptionsStore, type SecureRunOptions } from './secure-run-options';
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
  ATTACHMENT_OPERATIONS_FEATURE,
} from '../session-control-protocol';
import { agentSchema, sessionActionSchema } from '../protocol';
import { SecureStore, type SecureAuthority } from './secure-store';
import { PERMISSION_REVIEW_FEATURE } from '../permission-review';
import { validateHostResponse } from '../host-response';
import { ATTACHMENTS_FEATURE } from '../attachment-protocol';
import type { AttachmentReference } from '../content-protocol';
import { SecureAttachments, type SecureAttachmentDraft } from './secure-attachments';
import { SKILLS_FEATURE } from '../skills-protocol';
import { MCP_FEATURE } from '../mcp-protocol';
import type { SecureMcpDraft } from './secure-mcp';
import { SECURE_TURN_AUTHORITY_FEATURE } from '../task-protocol';
import { GITHUB_FEATURE, SECURE_GITHUB_AUTHORITY_FEATURE } from '../github-protocol';
import { GITHUB_WRITE_FEATURE } from '../github-write-protocol';
import {
  SecureScopedStorage,
  sameSecureRuntime,
  sameSecureRuntimeProject,
} from './secure-scoped-storage';
import { ApiError } from './api';
import type { PreviewAnnotation } from './project-preview';
import { readSecureGithubExecutionBlock } from './secure-github';
import { readSecureGitExecutionBlock } from './secure-git';
import {
  readSecureForkExecutionBlock,
  readSecureForkResource,
  readSecureForkChild,
  readSecureForkOperation,
} from './secure-fork';
import {
  GIT_WORKTREE_FEATURE,
  SECURE_GIT_OPERATIONS_FEATURE,
  type GitStateResult,
} from '../git-protocol';
import { SESSION_FORK_FEATURE, SECURE_FORK_OPERATIONS_FEATURE } from '../fork-protocol';
import { attachmentBytes } from './attachments';

export type SecureExtensionMethod =
  | 'git-state'
  | 'git-action'
  | 'git-operations'
  | 'fork-options'
  | 'fork-action'
  | 'fork-operations'
  | 'github-read'
  | 'github-action'
  | 'github-abandon'
  | 'github-write-read'
  | 'github-write-action'
  | 'github-write-inspect'
  | 'github-write-abandon';
const extensionMethods = new Set<SecureExtensionMethod>([
  'git-state',
  'git-action',
  'git-operations',
  'fork-options',
  'fork-action',
  'fork-operations',
  'github-read',
  'github-action',
  'github-abandon',
  'github-write-read',
  'github-write-action',
  'github-write-inspect',
  'github-write-abandon',
]);
const extensionRecovery = new Set<SecureExtensionMethod>([
  'git-operations',
  'fork-operations',
  'github-abandon',
  'github-write-inspect',
  'github-write-abandon',
]);

export type SecureContentReadMethod =
  | 'read-project-tree'
  | 'file-content'
  | 'read-turn-diff'
  | 'read-diff-file'
  | 'read-attachment'
  | 'skills-read';
export type SecureContentContext = {
  target: SecureCliTarget | null;
  online: boolean;
  generation: number;
};
export type SecureSendReview = {
  target: SecureCliTarget;
  attachments: SecureAttachmentDraft[];
  mcpDraft?: SecureMcpDraft | null;
  previewAnnotations?: PreviewAnnotation[];
  runOptions?: SecureRunOptions;
};
const contentReadMethods: ReadonlySet<string> = new Set<SecureContentReadMethod>([
  'read-project-tree',
  'file-content',
  'read-turn-diff',
  'read-diff-file',
  'read-attachment',
  'skills-read',
]);

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
  attachmentDraft: SecureAttachmentDraft[];
  mcpDraft: SecureMcpDraft | null;
  previewAnnotations: PreviewAnnotation[];
  extensionBlock: string | null;
  permissionReviews: SecurePermissionReview[];
  notice: string | null;
  busy: boolean;
  runOptions?: SecureRunOptions;
  modelOptionsError?: string;
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
  attachmentDraft: [],
  mcpDraft: null,
  previewAnnotations: [],
  extensionBlock: null,
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
  #attachments: SecureAttachments;
  readonly extensionStorage: SecureScopedStorage;
  #runOptions: SecureRunOptionsStore;
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
    this.#attachments = new SecureAttachments(this.#store);
    this.extensionStorage = new SecureScopedStorage(this.#store);
    this.#runOptions = new SecureRunOptionsStore(this.extensionStorage);
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  get state(): SecureWorkspaceState {
    return structuredClone(this.#state);
  }
  get contentContext(): SecureContentContext {
    const unavailable = { target: null, online: false, generation: this.#generation };
    try {
      this.#current(this.#generation);
      const target = this.#draftTarget;
      if (
        !target ||
        target.sessionId !== this.#state.session?.meta.id ||
        !same(this.#authority(), {
          origin: target.origin,
          owner: target.owner,
          rootKeyId: target.rootKeyId,
          clientDeviceId: target.clientDeviceId,
        })
      )
        return unavailable;
      let online = false;
      try {
        online = same(target, this.#target(target.sessionId));
      } catch {
        // Explicit disconnect keeps only the already-read, account-bound cache target.
      }
      return { target: structuredClone(target), online, generation: this.#generation };
    } catch {
      return unavailable;
    }
  }
  async contentRequest(
    inputTarget: SecureCliTarget,
    method: SecureContentReadMethod,
    params: unknown,
  ): Promise<unknown> {
    const target = secureTargetSchema.parse(structuredClone(inputTarget));
    if (!contentReadMethods.has(method)) throw Error('此入口只允许读取已选会话的内容和扩展目录。');
    const context = this.contentContext,
      lease = this.#lease();
    if (!context.online || !same(context.target, target))
      throw Error('内容目标已改变，请重新选择并读取当前会话。');
    const command = this.#command(target, method, structuredClone(params)),
      request = command.params as Record<string, unknown>;
    if (
      request.workspaceId !== target.workspaceId ||
      request.localProjectId !== target.localProjectId ||
      request.sessionId !== target.sessionId
    )
      throw Error('内容请求与当前执行范围不匹配。');
    const workspace = this.#state.catalog?.workspaces.find(
      (entry) => entry.id === target.workspaceId,
    );
    if (!workspace) throw Error('执行主机目录尚未确认。');
    const feature = method === 'skills-read' ? SKILLS_FEATURE : undefined;
    if (feature && !workspace.features?.includes(feature))
      throw Error('执行主机尚未提供此扩展目录能力，请升级主机后重新核对目录。');
    const current = () => {
      this.#current(lease.generation);
      const now = this.contentContext;
      if (!now.online || !same(now.target, target)) throw Error('内容目标已改变，请重新读取。');
    };
    const raw = await this.#execute(lease, target, command);
    return validateHostResponse(raw, { command, workspace, current });
  }
  /** Finite extension methods, with original mapped scope retained during manual recovery. */
  async scopedRequest(
    inputTarget: SecureCliTarget,
    method: SecureExtensionMethod,
    params: unknown,
    reviewedCurrent: () => void,
  ): Promise<unknown> {
    const target = secureTargetSchema.parse(structuredClone(inputTarget));
    if (!extensionMethods.has(method)) throw Error('不支持的加密扩展操作。');
    const lease = this.#lease(),
      shown = structuredClone(this.contentContext),
      frozen = structuredClone(params);
    const baseCurrent = () => {
      this.#current(lease.generation);
      reviewedCurrent();
      if (!shown.online || !shown.target || !same(shown, this.contentContext))
        throw Error('扩展所属会话或连接已改变，请重新核对原操作。');
    };
    baseCurrent();
    let provenChildRecovery = false;
    if (
      method === 'fork-operations' &&
      shown.target &&
      !sameSecureRuntime(target, shown.target) &&
      sameSecureRuntimeProject(target, shown.target)
    ) {
      const original = await readSecureForkOperation(
        this.extensionStorage,
        target,
        shown.target.sessionId,
        baseCurrent,
      );
      baseCurrent();
      const command = this.#command(target, method, frozen);
      if (command.method !== 'fork-operations' || !same(command.params.request, original.request))
        throw Error('子会话恢复与已保存的原 Fork 请求不匹配。');
      provenChildRecovery = true;
    }
    const current = () => {
      baseCurrent();
      if (
        !(
          same(target, shown.target) ||
          (extensionRecovery.has(method) && sameSecureRuntime(target, shown.target!)) ||
          provenChildRecovery
        )
      )
        throw Error('扩展所属会话或连接已改变，请重新核对原操作。');
    };
    current();
    return this.#scopedDispatch(target, method, frozen, current);
  }
  #extensionFeatures(method: SecureExtensionMethod): readonly string[] {
    if (method.startsWith('git-')) return [GIT_WORKTREE_FEATURE, SECURE_GIT_OPERATIONS_FEATURE];
    if (method.startsWith('fork-')) return [SESSION_FORK_FEATURE, SECURE_FORK_OPERATIONS_FEATURE];
    return [
      method.startsWith('github-write-') ? GITHUB_WRITE_FEATURE : GITHUB_FEATURE,
      SECURE_GITHUB_AUTHORITY_FEATURE,
    ];
  }
  #extensionWorkspace(target: SecureCliTarget, method: SecureExtensionMethod) {
    const workspace = this.#state.catalog?.workspaces.find(
      (entry) => entry.id === target.workspaceId,
    );
    if (
      !workspace ||
      workspace.userId !== target.userId ||
      workspace.machineId !== target.machineId
    )
      throw Error('执行主机目录尚未确认。');
    if (this.#extensionFeatures(method).some((feature) => !workspace.features?.includes(feature)))
      throw Error('此主机尚未提供完整的加密扩展授权，请升级主机后重新连接。');
    return workspace;
  }
  async #scopedDispatch(
    target: SecureCliTarget,
    method: SecureExtensionMethod,
    params: unknown,
    current: () => void,
  ) {
    current();
    const lease = this.#lease(),
      command = this.#command(target, method, structuredClone(params));
    const request = command.params as Record<string, unknown>;
    const scoped = 'request' in request ? (request.request as Record<string, unknown>) : request;
    if (
      scoped.workspaceId !== target.workspaceId ||
      scoped.localProjectId !== target.localProjectId ||
      scoped.sessionId !== target.sessionId
    )
      throw Error('扩展请求与原执行范围不匹配。');
    const workspace = this.#extensionWorkspace(target, method);
    try {
      current();
      const raw = await this.#execute(lease, target, command);
      current();
      return await validateHostResponse(raw, { command, workspace, current });
    } catch (error) {
      current();
      if (error instanceof RequestFailure)
        throw new ApiError(error.message, error.rejected ? 409 : 0, error.rejected);
      throw error;
    }
  }
  async #executionBlock(target: SecureCliTarget, current: () => void) {
    const blocks = await Promise.all([
      readSecureGithubExecutionBlock(this.extensionStorage, target, current),
      readSecureGitExecutionBlock(this.extensionStorage, target, current),
      readSecureForkExecutionBlock(this.extensionStorage, target, current),
    ]);
    current();
    return blocks.find((block) => !!block) ?? null;
  }
  async #beforeScopedWrite(
    target: SecureCliTarget,
    method: SecureExtensionMethod,
    current: () => void,
  ) {
    current();
    this.#extensionWorkspace(target, method);
    const block = await this.#executionBlock(target, current);
    if (block) throw Error(block);
    const operations = await this.#store.list(target);
    current();
    if (
      operations.some(
        (operation) =>
          sameSecureRuntime(operation.target, target) &&
          ['pending', 'ending'].includes(operation.state),
      )
    )
      throw Error('请先核查原会话操作，再执行新的项目写入。');
  }
  async beforeExtensionWrite(inputTarget: SecureCliTarget, reviewedCurrent: () => void) {
    const target = secureTargetSchema.parse(inputTarget),
      generation = this.#generation;
    const current = () => {
      this.#current(generation);
      reviewedCurrent();
      const context = this.contentContext;
      if (!context.online || !same(context.target, target)) throw Error('写入的执行范围已改变。');
    };
    current();
    return this.#beforeScopedWrite(target, 'github-action', current);
  }
  async beforeWorkspaceWrite(
    inputTarget: SecureCliTarget,
    kind: 'git' | 'fork',
    reviewed: () => void,
  ) {
    const target = secureTargetSchema.parse(structuredClone(inputTarget)),
      generation = this.#generation;
    const current = () => {
      this.#current(generation);
      reviewed();
      if (!this.contentContext.online || !same(target, this.contentContext.target))
        throw Error('工作目录或 Fork 的执行范围已改变。');
    };
    return this.#beforeScopedWrite(target, kind === 'git' ? 'git-action' : 'fork-action', current);
  }
  async #workspaceResource(
    parentInput: SecureCliTarget,
    childId: string,
    reviewed: () => void,
    sourceInput: SecureCliTarget = parentInput,
  ) {
    const parent = secureTargetSchema.parse(structuredClone(parentInput)),
      source = secureTargetSchema.parse(structuredClone(sourceInput)),
      generation = this.#generation;
    const current = () => {
      this.#current(generation);
      reviewed();
      if (
        !this.contentContext.online ||
        !same(parent, this.contentContext.target) ||
        !sameSecureRuntime(source, parent) ||
        childId === parent.sessionId
      )
        throw Error('Fork 保留目录所属源会话或映射已改变。');
    };
    current();
    const resource = await readSecureForkResource(this.extensionStorage, source, childId, current);
    current();
    if (!resource?.receipt.execution?.executionId)
      throw Error('未找到经过确认的原 Fork 工作目录。');
    return {
      target: secureTargetSchema.parse({ ...parent, sessionId: childId }),
      resource,
      current,
    };
  }
  /** A retained Fork directory can exist without a child session. Authority comes from its original receipt. */
  async workspaceResourceRequest(
    parent: SecureCliTarget,
    childId: string,
    method: 'git-state' | 'git-action' | 'git-operations',
    params: unknown,
    reviewed: () => void,
    source: SecureCliTarget = parent,
    originalTarget?: SecureCliTarget,
  ): Promise<unknown> {
    if (!['git-state', 'git-action', 'git-operations'].includes(method))
      throw Error('不支持的目录恢复操作。');
    const { target, resource, current } = await this.#workspaceResource(
      parent,
      childId,
      reviewed,
      source,
    );
    const dispatched = originalTarget
      ? secureTargetSchema.parse(structuredClone(originalTarget))
      : target;
    if (
      !same(target, dispatched) &&
      !(method === 'git-operations' && sameSecureRuntime(target, dispatched))
    )
      throw Error('目录原操作的恢复范围不匹配。');
    const frozen = structuredClone(params);
    if (method === 'git-action') {
      const command = this.#command(target, method, frozen);
      if (
        command.method !== 'git-action' ||
        command.params.action === 'prepare' ||
        command.params.executionId !== resource.receipt.execution!.executionId
      )
        throw Error('目录清理与原 Fork 资源不匹配。');
    }
    const result = await this.#scopedDispatch(dispatched, method, frozen, current);
    current();
    const value = result as {
      execution?: GitStateResult['execution'];
      receipt?: { execution?: GitStateResult['execution'] };
    };
    const execution = value.execution ?? value.receipt?.execution;
    if (execution && execution.executionId !== resource.receipt.execution!.executionId)
      throw Error('主机返回的目录与原 Fork 资源不匹配。');
    return result;
  }
  async beforeWorkspaceResourceWrite(
    parent: SecureCliTarget,
    childId: string,
    reviewed: () => void,
    source: SecureCliTarget = parent,
  ) {
    const { target, current } = await this.#workspaceResource(parent, childId, reviewed, source);
    return this.#beforeScopedWrite(target, 'git-action', current);
  }
  async openForkChild(sourceInput: SecureCliTarget, childId: string, reviewed: () => void) {
    const source = secureTargetSchema.parse(structuredClone(sourceInput)),
      generation = this.#generation,
      shown = structuredClone(this.contentContext);
    const current = () => {
      this.#current(generation);
      reviewed();
      if (
        !shown.online ||
        !shown.target ||
        !same(shown, this.contentContext) ||
        !sameSecureRuntime(source, shown.target)
      )
        throw Error('Fork 源会话已改变。');
    };
    current();
    await readSecureForkChild(this.extensionStorage, source, childId, current);
    current();
    await this.openSession(childId);
    await this.refreshSessions();
  }
  async openForkSource(input: SecureCliTarget, sourceId: string) {
    const target = secureTargetSchema.parse(structuredClone(input));
    if (
      !this.contentContext.online ||
      !same(target, this.contentContext.target) ||
      this.#state.session?.meta.forkOrigin?.sourceSessionId !== sourceId
    )
      throw Error('Fork 来源已改变，请重新读取会话。');
    await this.openSession(sourceId);
  }
  async refreshExtensionRecords(inputTarget: SecureCliTarget, reviewed: () => void) {
    const target = secureTargetSchema.parse(inputTarget),
      generation = this.#generation;
    const current = () => {
      this.#current(generation);
      reviewed();
      if (!same(target, this.contentContext.target)) throw Error('扩展记录的显示目标已改变。');
    };
    current();
    const block = await this.#executionBlock(target, current);
    current();
    this.#state.extensionBlock = block;
    this.#emit();
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
      attachmentDraft: [],
      mcpDraft: null,
      previewAnnotations: [],
      extensionBlock: null,
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
    if (this.#draftTarget) {
      const target = this.#draftTarget;
      const attachments = await this.#attachments.read(target, current);
      const block = await this.#executionBlock(target, current);
      current();
      if (!same(target, this.contentContext.target))
        throw Error('附件草稿目标已改变，请重新读取。');
      this.#state.attachmentDraft = attachments;
      this.#state.extensionBlock = block;
    }
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
      attachmentDraft: [],
      mcpDraft: null,
      previewAnnotations: [],
      extensionBlock: null,
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
    this.#state.runOptions = undefined;
    this.#state.modelOptionsError = undefined;
    this.#state.attachmentDraft = [];
    this.#state.mcpDraft = null;
    this.#state.previewAnnotations = [];
    this.#state.extensionBlock = null;
    return this.#run(async (current) => {
      const lease = this.#lease(),
        target = this.#target(sessionId);
      const read = readClientSession(
        await this.#execute(lease, target, this.#command(target, 'session', { sessionId })),
        scope(target),
      );
      const draft = await this.#store.readDraft(target);
      const attachments = await this.#attachments.read(target, current);
      const block = await this.#executionBlock(target, current);
      const lastInput = read.history.findLast((turn) => turn.role === 'user');
      const parsedInput = z
        .object({
          modelId: z.string().optional(),
          modeId: z.string().optional(),
          configOptionValues: z.unknown().optional(),
        })
        .safeParse(lastInput?.inputConfig ?? {});
      if (!parsedInput.success) throw Error('历史模型设置无法读取，请核对会话。');
      const runOptions = await this.#runOptions.read(
        target,
        lastInput?.id ?? '',
        selectionFromInput(parsedInput.data, read.agent?.runConfig),
        current,
      );
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
      this.#state.attachmentDraft = attachments;
      this.#state.extensionBlock = block;
      this.#state.runOptions = runOptions;
      if (
        this.#state.catalog?.workspaces
          .find((w) => w.id === target.workspaceId)
          ?.features?.includes(AGENT_MODEL_OPTIONS_FEATURE)
      ) {
        try {
          await this.#refreshAgentOptions(target, current, false);
        } catch (error) {
          current();
          this.#state.modelOptionsError = publicAgentFailure(
            error,
            '模型选项暂不可读取；原选择保留，请刷新选项或检查执行电脑。',
          );
        }
      }
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
  async appendInstruction(inputTarget: SecureCliTarget, instruction: string, reviewed: () => void) {
    const target = secureTargetSchema.parse(structuredClone(inputTarget));
    const text = z.string().min(1).max(100000).parse(instruction);
    return this.#run(async (current) => {
      const checked = () => {
        current();
        reviewed();
        if (!same(target, this.contentContext.target))
          throw Error('说明所属会话已改变，请重新审阅后加入草稿。');
      };
      checked();
      const expected = await this.#store.readDraft(target);
      checked();
      const next = expected ? expected + '\n\n' + text : text;
      await this.#store.saveDraft(target, expected, next, checked);
      checked();
      this.#state.draft = next;
      this.#state.notice = '已将完整说明加入本机草稿，请检查后手动发送。';
    });
  }
  #requireMcp(workspaceId: string) {
    const features = this.#state.catalog?.workspaces.find(
      (entry) => entry.id === workspaceId,
    )?.features;
    if (!features?.includes(MCP_FEATURE) || !features.includes(SECURE_TURN_AUTHORITY_FEATURE))
      throw Error('执行主机尚不支持完整的加密回合授权，请升级主机后重新核对目录。');
  }
  #attachmentTarget(): SecureCliTarget {
    const { target } = this.contentContext;
    if (!target) throw Error('请先选择并读取会话，再操作附件。');
    return target;
  }
  #requireAttachments(workspaceId: string) {
    const features = this.#state.catalog?.workspaces.find(
      (entry) => entry.id === workspaceId,
    )?.features;
    if (
      !features?.includes(ATTACHMENTS_FEATURE) ||
      !features.includes(ATTACHMENT_OPERATIONS_FEATURE)
    )
      throw Error('执行主机尚未提供附件能力，请升级主机后重新核对目录。');
  }
  async addAttachments(files: readonly File[]) {
    const selected = [...files];
    return this.#run(async (current) => {
      const target = this.#attachmentTarget();
      const items = await this.#attachments.addFiles(
        target,
        this.#state.attachmentDraft,
        selected,
        current,
      );
      current();
      this.#state.attachmentDraft = items;
    });
  }
  async removeAttachment(attachmentId: string) {
    return this.#write(async (current) => {
      const target = this.#attachmentTarget(),
        items = this.#state.attachmentDraft;
      const item = items.find((entry) => entry.reference.attachmentId === attachmentId);
      if (!item) throw Error('此附件草稿已经改变，请重新读取。');
      if (item.status === 'pending') throw Error('请先用原操作重试确认此附件结果。');
      if (item.status === 'draft') {
        this.#state.attachmentDraft = await this.#attachments.removeDraft(
          target,
          items,
          attachmentId,
          current,
        );
        return;
      }
      const lease = this.#lease();
      if (!same(target, this.#target(target.sessionId)))
        throw Error('附件目标已改变，请重新读取。');
      this.#requireAttachments(target.workspaceId);
      const operation = await this.#attachments.stage(
        target,
        attachmentId,
        'remove',
        this.#uuid(),
        this.#now(),
        current,
      );
      await this.#operations(current);
      this.#emit();
      await this.#deliver(lease, operation, true, current);
    });
  }
  async readAttachment(reference: AttachmentReference) {
    const context = this.contentContext,
      target = this.#attachmentTarget(),
      shown = structuredClone(reference);
    const current = () => {
      this.#current(context.generation);
      if (!same(target, this.contentContext.target))
        throw Error('附件显示目标已改变，请重新读取。');
    };
    return this.#attachments.readContent(
      target,
      shown,
      current,
      context.online
        ? () =>
            this.contentRequest(target, 'read-attachment', {
              contentVersion: 1,
              workspaceId: target.workspaceId,
              localProjectId: target.localProjectId,
              sessionId: target.sessionId,
              attachmentId: shown.attachmentId,
            })
        : undefined,
    );
  }
  async refreshAgentOptions(inputTarget: SecureCliTarget) {
    const shown = secureTargetSchema.parse(structuredClone(inputTarget));
    if (!same(shown, this.contentContext.target))
      throw Error('能力检查目标已改变，请重新核对当前会话。');
    return this.#run(async (current) => {
      try {
        await this.#refreshAgentOptions(shown, current);
      } catch (error) {
        current();
        this.#state.modelOptionsError = publicAgentFailure(
          error,
          '模型选项暂不可读取；原选择保留，请刷新选项或检查执行电脑。',
        );
        throw error;
      }
    });
  }
  async saveRunSelection(inputTarget: SecureCliTarget, selection: RunSelection) {
    const shown = secureTargetSchema.parse(structuredClone(inputTarget)),
      selected = runSelectionSchema.parse(selection);
    return this.#run(async (current) => {
      if (!same(shown, this.#attachmentTarget()) || !this.#state.runOptions)
        throw Error('模型设置目标已改变，请重新读取会话。');
      this.#state.runOptions = await this.#runOptions.save(
        shown,
        this.#state.runOptions,
        selected,
        current,
      );
      current();
    });
  }
  async #refreshAgentOptions(shown: SecureCliTarget, current: () => void, announce = true) {
    const target = this.#attachmentTarget(),
      lease = this.#lease(),
      read = this.#state.session!;
    if (!same(target, shown) || !same(target, this.#target(target.sessionId)))
      throw Error('能力检查目标已改变，请重新核对当前会话。');
    const workspace = this.#state.catalog!.workspaces.find(
      (entry) => entry.id === target.workspaceId,
    )!;
    const command = this.#command(target, 'agent-options', {
      agentId: read.meta.agentConfigId,
      sessionId: target.sessionId,
      ...(workspace.features?.includes(AGENT_MODEL_OPTIONS_FEATURE) &&
      this.#state.runOptions?.selection.modelId
        ? { modelId: this.#state.runOptions.selection.modelId }
        : {}),
    });
    const raw = await this.#execute(lease, target, command);
    const updated = await validateHostResponse(raw, { command, workspace, current });
    current();
    this.#state.session = { ...read, agent: agentSchema.parse(updated) };
    if (this.#state.runOptions?.inherited) {
      const last = read.history.findLast((turn) => turn.role === 'user');
      const input = z
        .object({
          modelId: z.string().optional(),
          modeId: z.string().optional(),
          configOptionValues: z.unknown().optional(),
        })
        .safeParse(last?.inputConfig ?? {});
      if (input.success)
        this.#state.runOptions.selection = JSON.parse(
          JSON.stringify(selectionFromInput(input.data, this.#state.session.agent?.runConfig)),
        );
    }
    this.#state.modelOptionsError = undefined;
    if (announce) this.#state.notice = '已读取此会话固定 Agent 的能力，未发送指令。';
  }
  async #write(task: (current: () => void) => Promise<void>) {
    if (this.#mutation) throw Error('已有原操作正在处理，请等待或手动核查。');
    this.#mutation = true;
    try {
      await this.#run(async (current) => {
        const target = this.contentContext.target;
        if (target)
          await this.extensionStorage.exclusive(target, 'execution', current, () => task(current));
        else await task(current);
      });
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
    if (operation.mcpReview?.servers.length) this.#requireMcp(operation.target.workspaceId);
    if (operation.kind === 'permission')
      this.#requirePermissionSupport(operation.target.workspaceId);
    const attachment = ['attachment-upload', 'attachment-remove'].includes(operation.kind);
    if (attachment) this.#requireAttachments(operation.target.workspaceId);
    try {
      const raw = await this.#store.dispatch(operation, current, (original) =>
        this.#execute(lease, original.target, hostCommandSchema.parse(JSON.parse(original.body))),
      );
      current();
      if (attachment) {
        const next = await this.#attachments.confirm(operation, raw, current);
        current();
        this.#state.notice = '主机已确认附件操作。';
        return next;
      }
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
      } else if (original.kind === 'metadata') {
        const result = validateSessionActionReceipt(original.value, raw);
        receipt = result;
        if (!result.accepted) state = 'abandoned';
      } else throw Error('附件原操作必须按完整附件回执确认。');
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
  async send(prompt: string, review?: SecureSendReview) {
    const shown = review ? structuredClone(review) : undefined;
    return this.#write(async (current) => {
      const lease = this.#lease(),
        prior = this.#state.session;
      if (!prior) throw Error('请先读取会话。');
      if (this.#state.modelOptionsError) throw Error(this.#state.modelOptionsError);
      const target = this.#target(prior.meta.id);
      const shownRunOptions = shown?.runOptions ?? this.#state.runOptions;
      if (!same(shownRunOptions ?? null, this.#state.runOptions ?? null))
        throw Error('模型草稿已改变，请重新核对后发送。');
      if (shownRunOptions) await this.#runOptions.verify(target, shownRunOptions, current);
      const shownAttachments = shown?.attachments ?? [];
      if (
        (shown && !same(target, secureTargetSchema.parse(shown.target))) ||
        !same(shownAttachments, this.#state.attachmentDraft)
      )
        throw Error('发送目标或已审阅的附件已改变，请重新核对后发送。');
      if (shown?.mcpDraft?.review?.servers.length || shown?.previewAnnotations?.length)
        throw Error('本回合额外 MCP 和网页标注已移除，请重新打开会话。');
      const extensionBlock = await this.#executionBlock(target, current);
      if (extensionBlock) throw Error(extensionBlock);
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
      if (
        shownRunOptions &&
        shownRunOptions.baseTurnId !==
          (read.history.findLast((turn) => turn.role === 'user')?.id ?? '')
      )
        throw Error('会话已更新，请重新读取并核对模型选择。');
      const currentAttachments = await this.#attachments.read(target, current);
      current();
      if (!same(shownAttachments, currentAttachments))
        throw Error('附件草稿已在另一页面改变，请重新读取并核对后发送。');
      if (shownAttachments.some((item) => item.status === 'pending'))
        throw Error('请先用原操作重试确认附件结果，再手动发送。');
      if (shownAttachments.length) this.#requireAttachments(target.workspaceId);
      const references = shownAttachments.map((item) => item.reference);
      // Validate the reviewed prompt and Agent capabilities before uploading any bytes.
      const turnInput = {
        scope: scope(target),
        read,
        agent: read.agent,
        ...(shownRunOptions ? { selection: shownRunOptions.selection } : {}),
        prompt,
        attachments: references,
        operationId: this.#uuid(),
        turnId: this.#uuid(),
        peerId: this.#uuid().replaceAll('-', '').slice(0, 16),
        now: this.#now(),
      };
      buildSessionTurn(turnInput);
      for (const item of shownAttachments) {
        if (item.status === 'uploaded') continue;
        const operation = await this.#attachments.stage(
          target,
          item.reference.attachmentId,
          'upload',
          this.#uuid(),
          this.#now(),
          current,
        );
        await this.#operations(current);
        this.#emit();
        const result = await this.#deliver(lease, operation, true, current);
        if (result?.state !== 'accepted') return;
      }
      const uploaded = await this.#attachments.read(target, current);
      current();
      if (
        references.some(
          (reference) =>
            !uploaded.some((item) => item.status === 'uploaded' && same(item.reference, reference)),
        )
      )
        throw Error('已审阅的附件状态已改变，请重新核对后发送。');
      const latestBlock = await this.#executionBlock(target, current);
      if (latestBlock) throw Error(latestBlock);
      if (shownRunOptions) await this.#runOptions.verify(target, shownRunOptions, current);
      const mutation = buildSessionTurn(turnInput);
      const operation = await this.#store.stage(
        {
          operationId: turnInput.operationId,
          kind: 'turn',
          userTurnId: turnInput.turnId,
          target,
          body: JSON.stringify(this.#command(target, 'mutate', mutation)),
        },
        turnInput.now,
        current,
      );
      current();
      if (operation.state !== 'pending') throw Error('原操作编号已完成，不会再次发送。');
      await this.#operations(current);
      this.#emit();
      const result = await this.#deliver(lease, operation, true, current);
      if (result?.state === 'accepted' && references.length) {
        this.#state.attachmentDraft = await this.#attachments.forget(target, references, current);
        current();
      }
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
      if (operation.mcpReview?.servers.length) this.#requireMcp(operation.target.workspaceId);
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
      if (['attachment-upload', 'attachment-remove'].includes(operation.kind))
        this.#requireAttachments(operation.target.workspaceId);
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
