import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import {
  gitActionSchema,
  gitStateReadSchema,
  gitStateResultSchema,
  validateGitOperationResult,
  type GitOperation,
  type GitStateResult,
  type SessionExecution,
} from '../git-protocol';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { GitWorkspaceController, gitWorkspaceKey } from './git-workspace';
import { SecureScopedStorage, secureGitTarget, sameSecureRuntime } from './secure-scoped-storage';

const same = (a: unknown, b: unknown) => productCanonicalJson(a) === productCanonicalJson(b);
const copy = structuredClone;
export type SecureGitMethod = 'git-state' | 'git-action' | 'git-operations';
export type SecureGitContext = {
  target: SecureCliTarget | null;
  online: boolean;
  generation: number;
};
export type SecureGitOpenOptions = {
  newSession: boolean;
  resource?: {
    parentTarget: SecureCliTarget;
    childSessionId: string;
    sourceTarget?: SecureCliTarget;
  };
};
export type SecureGitDependencies = {
  context(): SecureGitContext;
  storage: SecureScopedStorage;
  request(
    target: SecureCliTarget,
    method: SecureGitMethod,
    params: unknown,
    current: () => void,
  ): Promise<unknown>;
  resourceRequest?(
    parentTarget: SecureCliTarget,
    childId: string,
    method: SecureGitMethod,
    params: unknown,
    current: () => void,
    sourceTarget?: SecureCliTarget,
    originalTarget?: SecureCliTarget,
  ): Promise<unknown>;
  /** Runs inside the execution lock, before staging any new directory operation. */
  beforeWrite(target: SecureCliTarget, current: () => void): Promise<void>;
  beforeResourceWrite?(
    parentTarget: SecureCliTarget,
    childId: string,
    current: () => void,
    sourceTarget?: SecureCliTarget,
  ): Promise<void>;
  /** Uses the visible parent context when inspecting a Fork child resource. */
  changed?(target: SecureCliTarget, current: () => void): Promise<void> | void;
  /** These callbacks run after releasing the execution lock, with the original Git target. */
  onPrepared?(
    target: SecureCliTarget,
    execution: SessionExecution,
    current: () => void,
  ): Promise<void> | void;
  onRefresh?(
    target: SecureCliTarget,
    state: GitStateResult,
    current: () => void,
  ): Promise<void> | void;
  onNewSession?(target: SecureCliTarget, current: () => void): Promise<void> | void;
  onWrite?(target: SecureCliTarget, current: () => void): Promise<void> | void;
  uuid?(): string;
};
type BoundContext = SecureGitContext & { target: SecureCliTarget };
type BoundOperation = {
  context: BoundContext;
  target: SecureCliTarget;
  panel: number;
  current: () => void;
};
export type SecureGitReview = {
  target: SecureCliTarget;
  contextTarget: SecureCliTarget;
  generation: number;
  panel: number;
  mode: 'read' | 'recovery';
  material: string;
};
type Recovery = { id: string; target: SecureCliTarget; controller: GitWorkspaceController };
export type SecureGitRecovery = {
  id: string;
  target: SecureCliTarget;
  pending: GitWorkspaceController['pending'];
  receipt: GitWorkspaceController['receipt'];
  state: GitWorkspaceController['state'];
  error: string;
};
export type SecureGitState = {
  target: SecureCliTarget;
  online: boolean;
  options: SecureGitOpenOptions;
  mode: SecureGitReview['mode'];
  review: SecureGitReview;
  git: GitWorkspaceController;
  recoveries: SecureGitRecovery[];
  opening: boolean;
  working: boolean;
  error: string;
};
function alive(current: () => void) {
  try {
    current();
    return true;
  } catch {
    return false;
  }
}
function data(controller: GitWorkspaceController) {
  return copy({
    target: controller.target,
    state: controller.state,
    receipt: controller.receipt,
    pending: controller.pending,
    loaded: controller.loaded,
    loadError: controller.loadError,
    execution: controller.execution,
  });
}
/** Original mappings remain authoritative until an explicit original-operation recovery. */
export async function readSecureGitExecutionBlock(
  storage: SecureScopedStorage,
  target: SecureCliTarget,
  current: () => void,
): Promise<string | null> {
  for (const row of await storage.list(target, current)) {
    const projected = secureGitTarget(row.target);
    if (row.key !== gitWorkspaceKey(projected)) continue;
    const controller = new GitWorkspaceController(projected, {
      ...storage.forTarget(row.target, current),
      current: () => alive(current),
      changed() {},
      request: async () => {
        throw Error('恢复本机 Git 记录不能执行远端请求。');
      },
    });
    await controller.load();
    current();
    if (controller.pending) return '存在原 Git 工作目录操作待确认，请先核查或封存原操作。';
    if (same(row.target, target) && controller.execution && controller.execution.status !== 'ready')
      return '当前工作目录不可用，请在 Git 面板重新读取并确认目录状态。';
  }
  current();
  return null;
}

/** Finite encrypted transport around the existing directory controller; never calls retry(). */
export class SecureGitController {
  #context?: BoundContext;
  #target?: SecureCliTarget;
  #options: SecureGitOpenOptions = { newSession: false };
  #git?: GitWorkspaceController;
  #recoveries: Recovery[] = [];
  #panel = 0;
  #mode: SecureGitReview['mode'] = 'read';
  #opening = false;
  #working = false;
  #error = '';
  #beforeActionState?: GitStateResult;
  #listeners = new Set<() => void>();
  constructor(private readonly dependencies: SecureGitDependencies) {}
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  #bind(): BoundContext {
    const context = this.dependencies.context();
    if (!context.target || !Number.isSafeInteger(context.generation) || context.generation < 0)
      throw Error('请先打开已确认的项目会话。');
    const target = secureTargetSchema.parse(context.target);
    secureGitTarget(target);
    return { target, generation: context.generation, online: context.online === true };
  }
  #matches(context: BoundContext) {
    try {
      return same(context, this.#bind());
    } catch {
      return false;
    }
  }
  #current(context: BoundContext, panel: number) {
    if (this.#context !== context || panel !== this.#panel || !this.#matches(context))
      throw Error('Git 面板、执行目标或连接已改变，请重新打开并审阅。');
  }
  #recoveryData(): SecureGitRecovery[] {
    return this.#recoveries.map(({ id, target, controller }) =>
      copy({
        id,
        target,
        pending: controller.pending,
        receipt: controller.receipt,
        state: controller.state,
        error: controller.loadError || controller.error,
      }),
    );
  }
  #material() {
    return productCanonicalJson({
      options: this.#options,
      git: this.#git && data(this.#git),
      recoveries: this.#recoveryData(),
    });
  }
  #resourcePending() {
    return Boolean(
      this.#git?.pending || this.#recoveries.some((entry) => entry.controller.pending),
    );
  }
  async #notifyRefresh(target: SecureCliTarget, git: GitWorkspaceController, current: () => void) {
    current();
    if (!git.state || git.source !== 'host') return;
    // A removed directory is not the original operation receipt. Keep the Fork
    // resource proof available until every original Git mapping is reconciled.
    if (
      this.#options.resource &&
      git.state.execution.status === 'removed' &&
      this.#resourcePending()
    )
      return;
    await this.dependencies.onRefresh?.(copy(target), copy(git.state), current);
    current();
  }
  get state(): SecureGitState | null {
    const context = this.#context,
      target = this.#target,
      git = this.#git;
    if (!context || !target || !git || !this.#matches(context)) return null;
    const working = this.#working || this.#opening;
    return {
      target: copy(target),
      online: context.online,
      options: copy(this.#options),
      mode: this.#mode,
      review: {
        target: copy(target),
        contextTarget: copy(context.target),
        generation: context.generation,
        panel: this.#panel,
        mode: this.#mode,
        material: this.#material(),
      },
      git: {
        ...data(git),
        source: git.source,
        error: this.#error || git.error,
        busy: working || git.busy,
        blocked: working || git.blocked,
      } as GitWorkspaceController,
      recoveries: this.#recoveryData(),
      opening: this.#opening,
      working,
      error: this.#error,
    };
  }
  close() {
    this.#context = undefined;
    this.#target = undefined;
    this.#git = undefined;
    this.#recoveries = [];
    this.#panel++;
    this.#opening = false;
    this.#working = false;
    this.#beforeActionState = undefined;
    this.#error = '';
    this.#mode = 'read';
    this.#emit();
  }
  sync() {
    if (this.#context && !this.#matches(this.#context)) this.close();
  }
  dispose() {
    this.close();
    this.#listeners.clear();
  }
  #assert(review: SecureGitReview, online = true): BoundOperation {
    const context = this.#context,
      target = this.#target;
    if (!context || !target || !this.#git) throw Error('请重新打开 Git 面板。');
    this.#current(context, review.panel);
    if (
      !same(review.target, target) ||
      !same(review.contextTarget, context.target) ||
      review.generation !== context.generation ||
      review.mode !== this.#mode ||
      review.material !== this.#material()
    )
      throw Error('Git 审阅内容已改变，请查看当前目录和原操作后重试。');
    if (this.#opening || this.#working) throw Error('正在恢复或核对 Git 状态，请稍后操作。');
    if (
      this.#options.resource &&
      this.#git.execution?.status === 'removed' &&
      !this.#resourcePending()
    )
      throw Error('此 Fork 保留目录已确认结束，请关闭资源面板。');
    if (online && !context.online) throw Error('执行电脑离线；原记录已保留，连接后请手动操作。');
    return {
      context,
      target,
      panel: this.#panel,
      current: () => this.#current(context, review.panel),
    };
  }
  async #request(
    target: SecureCliTarget,
    method: SecureGitMethod,
    params: unknown,
    context: BoundContext,
    panel: number,
  ) {
    const current = () => this.#current(context, panel);
    current();
    if (!context.online) throw Error('执行电脑离线，连接后请手动操作。');
    if (!same(target, this.#target) && method !== 'git-operations')
      throw Error('旧项目映射只能核查或封存原操作。');
    const resource = this.#options.resource;
    let result: unknown;
    if (resource) {
      if (
        (!same(target, this.#target) && method !== 'git-operations') ||
        !this.dependencies.resourceRequest
      )
        throw Error('此 Fork 资源没有匹配的可信请求入口。');
      result = await this.dependencies.resourceRequest(
        copy(resource.parentTarget),
        resource.childSessionId,
        method,
        copy(params),
        current,
        copy(resource.sourceTarget),
        copy(target),
      );
    } else result = await this.dependencies.request(copy(target), method, copy(params), current);
    current();
    return result;
  }
  #controller(target: SecureCliTarget, context: BoundContext, panel: number) {
    const current = () => this.#current(context, panel),
      storage = this.dependencies.storage.forTarget(target, current);
    const prefix = `/api/workspaces/${target.product!.catalogWorkspaceId}/replicas/${target.product!.replicaId}/git/`;
    return new GitWorkspaceController(secureGitTarget(target), {
      ...storage,
      compareWrite: async (...args) => {
        const saved = await storage.compareWrite(...args);
        current();
        if (saved) await this.dependencies.changed?.(copy(context.target), current);
        current();
        return saved;
      },
      current: () => alive(current),
      changed: () => {
        if (alive(current)) this.#emit();
      },
      uuid: this.dependencies.uuid,
      request: async (path, input) => {
        current();
        const method =
          path === prefix + 'state'
            ? 'git-state'
            : path === prefix + 'action'
              ? 'git-action'
              : undefined;
        if (!method) throw Error('不支持的 Git 请求。');
        const params = (method === 'git-state' ? gitStateReadSchema : gitActionSchema).parse(input);
        if (
          params.workspaceId !== target.workspaceId ||
          params.localProjectId !== target.localProjectId ||
          params.sessionId !== target.sessionId
        )
          throw Error('Git 请求不属于原执行范围。');
        // The legacy action methods reread state before staging. Freeze all displayed
        // repository/execution fields instead of silently accepting a changed directory.
        const reviewed = this.#beforeActionState;
        if (method === 'git-action') {
          if (!reviewed) throw Error('此 Git 操作尚未经当前目录审阅。');
          this.#beforeActionState = undefined;
        }
        const result = await this.#request(target, method, params, context, panel);
        if (
          method === 'git-state' &&
          reviewed &&
          !same(gitStateResultSchema.parse(result), gitStateResultSchema.parse(reviewed))
        )
          throw Error('Git 目录或仓库状态已改变，尚未发送操作；请重新读取并审阅。');
        return result;
      },
    });
  }
  async #loadRecovery(context: BoundContext, panel: number) {
    const current = () => this.#current(context, panel),
      target = this.#target!,
      entries: Recovery[] = [];
    for (const row of await this.dependencies.storage.list(target, current)) {
      if (same(row.target, target) || row.key !== gitWorkspaceKey(secureGitTarget(row.target)))
        continue;
      const controller = this.#controller(row.target, context, panel);
      await controller.load();
      current();
      if (controller.pending || controller.receipt)
        entries.push({
          id: productCanonicalJson(row.target),
          target: copy(row.target),
          controller,
        });
    }
    current();
    this.#recoveries = entries;
  }
  async open(input: SecureCliTarget, options: SecureGitOpenOptions = { newSession: false }) {
    const context = this.#bind(),
      target = secureTargetSchema.parse(input),
      resource = options.resource;
    secureGitTarget(target);
    if (resource) {
      const parent = secureTargetSchema.parse(resource.parentTarget);
      if (
        options.newSession ||
        !same(parent, context.target) ||
        resource.childSessionId === parent.sessionId ||
        !same(target, { ...parent, sessionId: resource.childSessionId })
      )
        throw Error('Fork 资源必须保留原父会话与已确认的子会话身份。');
      if (
        resource.sourceTarget &&
        !sameSecureRuntime(parent, secureTargetSchema.parse(resource.sourceTarget))
      )
        throw Error('Fork 原资源证据不属于当前父会话执行身份。');
      if (!this.dependencies.resourceRequest || !this.dependencies.beforeResourceWrite)
        throw Error('此客户端尚未提供 Fork 资源验证入口。');
    } else if (!same(target, context.target)) throw Error('项目会话已改变，请重新打开 Git。');
    this.close();
    this.#context = context;
    this.#target = target;
    this.#options = copy(options);
    this.#opening = true;
    const panel = this.#panel,
      current = () => this.#current(context, panel),
      git = (this.#git = this.#controller(target, context, panel));
    this.#emit();
    try {
      await git.load();
      current();
      await this.#loadRecovery(context, panel);
      current();
      await this.dependencies.changed?.(copy(context.target), current);
      current();
      if (context.online) await git.refresh();
      current();
      await this.#notifyRefresh(target, git, current);
      current();
    } catch (error) {
      if (alive(current)) this.#error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (alive(current)) {
        this.#opening = false;
        this.#emit();
      }
    }
  }
  async #run(
    review: SecureGitReview,
    task: (bound: BoundOperation) => Promise<void>,
    online = true,
  ) {
    const bound = this.#assert(review, online);
    this.#working = true;
    this.#error = '';
    this.#emit();
    try {
      await task(bound);
      bound.current();
    } catch (error) {
      if (alive(bound.current))
        this.#error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (alive(bound.current)) {
        this.#working = false;
        this.#beforeActionState = undefined;
        this.#emit();
      }
    }
  }
  async show(review: SecureGitReview, mode: SecureGitReview['mode']) {
    this.#assert(review, false);
    this.#mode = mode;
    this.#error = '';
    this.#emit();
  }
  refresh(review: SecureGitReview) {
    return this.#run(
      review,
      async ({ context, target, panel, current }) => {
        await this.#loadRecovery(context, panel);
        current();
        if (review.mode === 'read') {
          await this.#git!.refresh();
          current();
        }
        await this.dependencies.changed?.(copy(context.target), current);
        current();
        if (review.mode === 'read') await this.#notifyRefresh(target, this.#git!, current);
      },
      review.mode === 'read',
    );
  }
  #action(
    review: SecureGitReview,
    action: 'prepare' | 'remove' | 'detach',
    args?: { branch: string; oid: string; name: string },
  ) {
    return this.#run(review, async ({ context, target, current }) => {
      const git = this.#git!,
        displayed = copy(git.state),
        previousReceipt = copy(git.receipt);
      if (review.mode !== 'read' || !displayed || !git.loaded || git.pending || git.loadError)
        throw Error('请先读取并确认当前 Git 目录与原操作。');
      if (action === 'prepare' && !this.#options.newSession)
        throw Error('仅可为已确认的空会话准备独立目录。');
      try {
        await this.dependencies.storage.exclusive(target, 'execution', current, async () => {
          current();
          if (review.material !== this.#material()) throw Error('Git 审阅已改变，请重新确认。');
          const resource = this.#options.resource;
          if (resource)
            await this.dependencies.beforeResourceWrite!(
              copy(resource.parentTarget),
              resource.childSessionId,
              current,
              copy(resource.sourceTarget),
            );
          else await this.dependencies.beforeWrite(copy(target), current);
          current();
          this.#beforeActionState = displayed;
          if (action === 'prepare') await git.prepare(args!.branch, args!.oid, args!.name);
          else if (action === 'remove') await git.remove();
          else await git.detach();
          current();
        });
      } finally {
        // Receipt persistence precedes downstream refresh; a refresh failure must not
        // erase the accepted execution or repeat the directory operation.
        if (alive(current)) {
          this.#beforeActionState = undefined;
          await this.dependencies.changed?.(copy(context.target), current);
          current();
          if (git.receipt?.phase === 'accepted' && !same(git.receipt, previousReceipt)) {
            if (action === 'prepare')
              await this.dependencies.onPrepared?.(
                copy(target),
                copy(git.receipt.execution),
                current,
              );
            current();
          }
          await this.#notifyRefresh(target, git, current);
        }
      }
    });
  }
  prepare(review: SecureGitReview, branch: string, oid: string, name: string) {
    return this.#action(review, 'prepare', { branch, oid, name });
  }
  remove(review: SecureGitReview) {
    return this.#action(review, 'remove');
  }
  detach(review: SecureGitReview) {
    return this.#action(review, 'detach');
  }
  recover(review: SecureGitReview, action: GitOperation['action'], id?: string) {
    return this.#run(review, async ({ context, target, panel, current }) => {
      const entry =
        id === undefined
          ? { target, controller: this.#git! }
          : this.#recoveries.find((item) => item.id === id);
      if (!entry?.controller.pending) throw Error('没有此已展示的原 Git 待确认操作。');
      if ((id === undefined) !== (review.mode === 'read'))
        throw Error('请在对应的原操作面板核查。');
      const original = copy(entry.controller.pending),
        originalTarget = copy(entry.target),
        key = gitWorkspaceKey(secureGitTarget(originalTarget));
      await this.dependencies.storage.exclusive(originalTarget, 'execution', current, async () => {
        const raw = await this.dependencies.storage.read(originalTarget, key, current);
        if (
          !raw ||
          typeof raw !== 'object' ||
          !('pending' in raw) ||
          !same(raw.pending, original) ||
          !('cacheRevision' in raw) ||
          typeof raw.cacheRevision !== 'number'
        )
          throw Error('原 Git 记录已被其他页面更新，请重新打开核查。');
        const request = { action, request: original.request };
        const result = await validateGitOperationResult(
          await this.#request(originalTarget, 'git-operations', request, context, panel),
          request,
        );
        current();
        if (!result.found) {
          this.#error = '主机尚未记录此原操作；不会重新发送，可明确封存原请求。';
          return;
        }
        const receipt = result.receipt;
        const value = {
          ...raw,
          cacheRevision: raw.cacheRevision + 1,
          receipt,
          pending: receipt.phase === 'unknown' ? original : undefined,
        };
        if (
          !(await this.dependencies.storage.compareWrite(
            originalTarget,
            key,
            raw.cacheRevision,
            value,
            current,
          ))
        )
          throw Error('原 Git 记录已被其他页面更新，请重新打开核查。');
        current();
        await entry.controller.load();
        current();
        if (receipt.phase === 'unknown')
          this.#error = receipt.message || '原操作仍待主机核查，未重新执行。';
        await this.dependencies.changed?.(copy(context.target), current);
        current();
      });
      current();
      // Only the current mapping can read the resulting directory. Historical mappings
      // remain recovery-only and are never rebound to the current product route.
      if (same(originalTarget, target) && !entry.controller.pending) {
        await entry.controller.refresh();
        current();
        await this.#notifyRefresh(target, entry.controller, current);
        current();
      } else if (this.#options.resource) await this.#notifyRefresh(target, this.#git!, current);
    });
  }
  navigate(review: SecureGitReview, destination: 'write' | 'new-session') {
    return this.#run(
      review,
      async ({ target, current }) => {
        if (this.#options.resource) throw Error('请关闭子会话资源面板后回到原会话操作。');
        if (destination === 'write') await this.dependencies.onWrite?.(copy(target), current);
        else await this.dependencies.onNewSession?.(copy(target), current);
      },
      false,
    );
  }
}
