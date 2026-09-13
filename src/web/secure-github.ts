import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { githubActionSchema, githubReadSchema, type GithubBranch } from '../github-protocol';
import {
  githubWriteAbandonSchema,
  githubWriteActionSchema,
  githubWriteInspectSchema,
  githubWriteReadSchema,
} from '../github-write-protocol';
import { GithubController, githubKey, type GithubDetail } from './github';
import {
  GithubWriteController,
  githubWriteDraftSchema,
  githubWriteKey,
  type GithubWriteDraft,
} from './github-write';
import { SecureScopedStorage, secureGitTarget } from './secure-scoped-storage';

const canonical = productCanonicalJson;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const copy = structuredClone;
export type SecureGithubMethod =
  | 'github-read'
  | 'github-action'
  | 'github-abandon'
  | 'github-write-read'
  | 'github-write-action'
  | 'github-write-inspect'
  | 'github-write-abandon';
export type SecureGithubContext = {
  target: SecureCliTarget | null;
  online: boolean;
  generation: number;
};
export type SecureGithubDependencies = {
  context(): SecureGithubContext;
  storage: SecureScopedStorage;
  request(
    target: SecureCliTarget,
    method: SecureGithubMethod,
    params: unknown,
    current: () => void,
  ): Promise<unknown>;
  appendInstruction(target: SecureCliTarget, text: string, current: () => void): Promise<void>;
  /** Runs under the execution lock, before a new binding or write is staged. */
  beforeWrite(target: SecureCliTarget, current: () => void): Promise<void>;
  changed?(target: SecureCliTarget, current: () => void): Promise<void> | void;
  uuid?(): string;
};
type BoundContext = SecureGithubContext & { target: SecureCliTarget };
export type SecureGithubMode = 'read' | 'write' | 'recovery';
export type SecureGithubReview = {
  target: SecureCliTarget;
  generation: number;
  panel: number;
  mode: SecureGithubMode;
  /** Immutable snapshot of the data actually presented by this render. */
  material: string;
};
type Recovery = {
  id: string;
  target: SecureCliTarget;
  binding?: GithubController;
  write?: GithubWriteController;
};
export type SecureGithubRecovery = {
  id: string;
  target: SecureCliTarget;
  binding?: GithubController['pending'];
  pending?: GithubWriteController['pending'];
  drafts?: GithubWriteController['drafts'];
  receipt?: GithubWriteController['receipt'];
  error: string;
};
export type SecureGithubState = {
  target: SecureCliTarget;
  online: boolean;
  mode: SecureGithubMode;
  review: SecureGithubReview;
  /** Detached presentation objects: panel callbacks never read newer controller content. */
  read: GithubController;
  write: GithubWriteController;
  recoveries: SecureGithubRecovery[];
  working: boolean;
  opening: boolean;
  adding: boolean;
  saving: boolean;
  error: string;
};

/** A send must consult all original mappings, even when the GitHub panel was never opened. */
export async function readSecureGithubExecutionBlock(
  storage: SecureScopedStorage,
  target: SecureCliTarget,
  current: () => void,
): Promise<string | null> {
  const records = await storage.list(target, current);
  for (const record of records) {
    const original = secureGitTarget(record.target);
    const binding = record.key === githubKey(original);
    if (!binding && record.key !== githubWriteKey(original)) continue;
    const dependencies = {
      ...storage.forTarget(record.target, current),
      current: () => {
        try {
          current();
          return true;
        } catch {
          return false;
        }
      },
      online: () => false,
      changed() {},
      request: async () => {
        throw Error('恢复本机记录不能读取或执行远端操作。');
      },
    };
    if (binding) {
      const controller = new GithubController(original, dependencies);
      await controller.load();
      current();
      if (controller.pending) return '存在原 GitHub 会话绑定待确认，请先核查或封存原绑定。';
      continue;
    }
    const controller = new GithubWriteController(original, dependencies);
    await controller.load();
    current();
    if (controller.blocksExecution)
      return '存在原提交或推送操作待确认，请先在 GitHub 面板核查或结束原操作。';
  }
  current();
  return null;
}

function readData(controller: GithubController) {
  return copy({
    target: controller.target,
    overview: controller.overview,
    branches: controller.branches,
    listing: controller.listing,
    detail: controller.detail,
    comments: controller.comments,
    checks: controller.checks,
    binding: controller.binding,
    pending: controller.pending,
    loaded: controller.loaded,
    loadError: controller.loadError,
  });
}
function writeData(controller: GithubWriteController) {
  return copy({
    target: controller.target,
    overview: controller.overview,
    detail: controller.detail,
    files: controller.files,
    comments: controller.comments,
    branches: controller.branches,
    commitPreview: controller.commitPreview,
    pushPreview: controller.pushPreview,
    drafts: controller.drafts,
    pending: controller.pending,
    receipt: controller.receipt,
    review: controller.review,
    loaded: controller.loaded,
    loadError: controller.loadError,
    branchChoices: controller.branchChoices,
  });
}
const editableFields: Record<GithubWriteDraft['kind'], readonly string[]> = {
  'issue-comment': ['body'],
  'review-comment': ['body'],
  'review-reply': ['body'],
  'pr-create': ['title', 'body', 'draft'],
  'pr-update': ['title', 'body'],
  'pr-state': [],
  'pr-merge': ['method'],
  commit: ['message', 'authorName', 'authorEmail'],
  push: [],
};
function immutableDraft(draft: GithubWriteDraft) {
  const fields = editableFields[draft.kind];
  return {
    ...draft,
    values: Object.fromEntries(
      Object.entries(draft.values).filter(([key]) => !fields.includes(key)),
    ),
  };
}

/** Reuses product validation and pure panels, with finite encrypted transport and isolated storage. */
export class SecureGithubController {
  #context?: BoundContext;
  #read?: GithubController;
  #write?: GithubWriteController;
  #recoveries: Recovery[] = [];
  #branches = new Set<string>();
  #panel = 0;
  #mode: SecureGithubMode = 'read';
  #opening = false;
  #working = false;
  #adding = false;
  #saving = 0;
  #error = '';
  #listeners = new Set<() => void>();
  constructor(private readonly options: SecureGithubDependencies) {}
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
    const context = this.options.context();
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
      throw Error('GitHub 面板、执行目标或连接已改变，请重新打开并审阅。');
  }
  #recoveryData() {
    return this.#recoveries.map(
      (entry): SecureGithubRecovery =>
        copy({
          id: entry.id,
          target: entry.target,
          binding: entry.binding?.pending,
          pending: entry.write?.pending,
          drafts: entry.write?.drafts,
          receipt: entry.write?.receipt,
          error:
            entry.binding?.loadError ||
            entry.write?.loadError ||
            entry.binding?.error ||
            entry.write?.error ||
            '',
        }),
    );
  }
  #branchData() {
    const result: Record<string, GithubBranch> = Object.create(null);
    if (this.#read?.branches)
      for (const branch of this.#read.branches.result.items) this.#branches.add(branch.name);
    for (const name of this.#branches) {
      const branch = this.#read?.branch(name);
      if (branch) result[name] = copy(branch);
    }
    return result;
  }
  #material() {
    return canonical({
      read: this.#read && readData(this.#read),
      write: this.#write && writeData(this.#write),
      branches: this.#branchData(),
      recovery: this.#recoveryData(),
    });
  }
  get state(): SecureGithubState | null {
    const context = this.#context,
      read = this.#read,
      write = this.#write;
    if (!context || !read || !write || !this.#matches(context)) return null;
    const branches = this.#branchData(),
      writeView = writeData(write);
    // The existing panels only use public presentation fields and branch lookups.
    // Detached projections keep their event closures from observing later mutable reads.
    const readView = {
      ...readData(read),
      error: read.error || this.#error,
      busy: read.busy || this.#working || this.#opening,
      blocked: read.blocked || this.#working || this.#opening,
      branch: (name: string) => copy(branches[name]),
    } as GithubController;
    const projectedWrite = {
      ...writeView,
      error: write.error || this.#error,
      busy: write.busy || this.#working || this.#opening,
      blocked: write.blocked || this.#working || this.#opening,
      blocksExecution: write.blocksExecution,
      branch: (name: string) =>
        copy(writeView.branchChoices.find((branch) => branch.name === name)),
    } as GithubWriteController;
    return {
      target: copy(context.target),
      online: context.online,
      mode: this.#mode,
      review: {
        target: copy(context.target),
        generation: context.generation,
        panel: this.#panel,
        mode: this.#mode,
        material: this.#material(),
      },
      read: readView,
      write: projectedWrite,
      recoveries: this.#recoveryData(),
      working: this.#working || this.#opening,
      opening: this.#opening,
      adding: this.#adding,
      saving: this.#saving > 0,
      error: this.#error,
    };
  }
  close() {
    const read = this.#read,
      write = this.#write,
      recoveries = this.#recoveries;
    this.#context = undefined;
    this.#read = undefined;
    this.#write = undefined;
    this.#recoveries = [];
    this.#branches.clear();
    this.#panel++;
    this.#opening = false;
    this.#working = false;
    this.#adding = false;
    this.#saving = 0;
    this.#error = '';
    read?.invalidate();
    write?.invalidate();
    for (const entry of recoveries) {
      entry.binding?.invalidate();
      entry.write?.invalidate();
    }
    this.#emit();
  }
  sync() {
    if (this.#context && !this.#matches(this.#context)) this.close();
  }
  dispose() {
    this.close();
    this.#listeners.clear();
  }
  #dependencies(target: SecureCliTarget, context: BoundContext, panel: number) {
    const current = () => this.#current(context, panel);
    const alive = () => {
      try {
        current();
        return true;
      } catch {
        return false;
      }
    };
    const prefix = `/api/workspaces/${target.product!.catalogWorkspaceId}/replicas/${target.product!.replicaId}/`;
    const mappings = {
      'github/read': ['github-read', githubReadSchema],
      'github/action': ['github-action', githubActionSchema],
      'github/abandon': ['github-abandon', githubActionSchema],
      'github-write/read': ['github-write-read', githubWriteReadSchema],
      'github-write/action': ['github-write-action', githubWriteActionSchema],
      'github-write/inspect': ['github-write-inspect', githubWriteInspectSchema],
      'github-write/abandon': ['github-write-abandon', githubWriteAbandonSchema],
    } as const;
    const storage = this.options.storage.forTarget(target, current);
    return {
      ...storage,
      compareWrite: async (...args: Parameters<typeof storage.compareWrite>) => {
        const saved = await storage.compareWrite(...args);
        current();
        if (saved) await this.options.changed?.(copy(context.target), current);
        current();
        return saved;
      },
      current: alive,
      online: () => alive() && context.online,
      changed: () => {
        if (alive()) this.#emit();
      },
      uuid: this.options.uuid,
      request: async (path: string, input: unknown) => {
        current();
        if (!context.online) throw Error('执行电脑离线；草稿已保留，请连接后手动操作。');
        const entry = Object.entries(mappings).find(([suffix]) => path === prefix + suffix)?.[1];
        if (!entry) throw Error('不支持的 GitHub 请求。');
        const [method, schema] = entry,
          params = schema.parse(input);
        const scope = 'request' in params ? params.request : params;
        if (
          scope.workspaceId !== target.workspaceId ||
          scope.localProjectId !== target.localProjectId ||
          scope.sessionId !== target.sessionId
        )
          throw Error('GitHub 请求不属于原执行范围。');
        if (
          !same(target, context.target) &&
          !['github-abandon', 'github-write-inspect', 'github-write-abandon'].includes(method)
        )
          throw Error('旧项目映射只能核查或封存原操作，不能重新绑定或发布。');
        const result = await this.options.request(copy(target), method, copy(params), current);
        current();
        return result;
      },
    };
  }
  async open(expectedTarget: SecureCliTarget, mode: SecureGithubMode = 'read') {
    const context = this.#bind();
    if (!same(context.target, secureTargetSchema.parse(expectedTarget)))
      throw Error('项目会话已改变，请重新打开 GitHub。');
    this.close();
    this.#context = context;
    this.#opening = true;
    this.#mode = mode;
    const panel = this.#panel,
      current = () => this.#current(context, panel);
    const deps = this.#dependencies(context.target, context, panel);
    const read = (this.#read = new GithubController(secureGitTarget(context.target), deps));
    const write = (this.#write = new GithubWriteController(secureGitTarget(context.target), deps));
    this.#emit();
    try {
      const loaded = await Promise.allSettled([read.load(), write.load()]);
      current();
      for (const result of loaded) if (result.status === 'rejected') throw result.reason;
      await this.#loadRecovery(context, panel);
      current();
      await this.options.changed?.(copy(context.target), current);
      current();
      // Initialization owns the panel until both durable rows, original mappings, root
      // execution blocking and the initial remote overview have all settled.
      if (context.online && mode === 'read') await read.refresh();
      else if (context.online && mode === 'write') await write.refresh();
      current();
    } catch (cause) {
      if (this.#context === context && this.#matches(context)) {
        this.#error = cause instanceof Error ? cause.message : 'GitHub 记录无法恢复。';
        this.#emit();
      }
      throw cause;
    } finally {
      if (this.#context === context && panel === this.#panel) {
        this.#opening = false;
        this.#emit();
      }
    }
  }
  async #loadRecovery(context: BoundContext, panel: number) {
    const current = () => this.#current(context, panel);
    const records = await this.options.storage.list(context.target, current);
    const recovered: Recovery[] = [];
    for (const record of records) {
      current();
      if (same(record.target, context.target)) continue;
      const target = secureGitTarget(record.target),
        deps = this.#dependencies(record.target, context, panel);
      if (record.key === githubKey(target)) {
        const binding = new GithubController(target, deps);
        await binding.load();
        if (binding.pending)
          recovered.push({
            id: canonical([record.target, 'binding']),
            target: record.target,
            binding,
          });
      } else if (record.key === githubWriteKey(target)) {
        const write = new GithubWriteController(target, deps);
        await write.load();
        if (write.pending || Object.keys(write.drafts).length || write.receipt)
          recovered.push({ id: canonical([record.target, 'write']), target: record.target, write });
      }
    }
    current();
    this.#recoveries = recovered;
  }
  #assertReview(review: SecureGithubReview, material = true) {
    const state = this.state;
    if (
      !state ||
      !same({ ...state.review, material: undefined }, { ...review, material: undefined }) ||
      (material && state.review.material !== review.material)
    )
      throw Error('GitHub 内容、草稿或确认目标已改变，请重新查看后操作。');
    return state;
  }
  async #run<T>(
    review: SecureGithubReview,
    action: (current: () => void) => Promise<T>,
    options: { lock?: boolean; beforeWrite?: boolean; online?: boolean } = {},
  ): Promise<T> {
    this.#assertReview(review);
    if (this.#opening || this.#working || this.#saving)
      throw Error('正在保存或核对 GitHub 内容，请稍后再试。');
    const context = this.#context!,
      panel = this.#panel,
      current = () => this.#current(context, panel);
    if (options.online !== false && !context.online)
      throw Error('执行电脑离线，连接后请手动操作。');
    this.#working = true;
    this.#error = '';
    this.#emit();
    const work = async () => {
      current();
      this.#assertReview(review);
      if (options.beforeWrite) {
        await this.options.beforeWrite(context.target, current);
        current();
        this.#assertReview(review);
      }
      return action(current);
    };
    try {
      const result = await (options.lock
        ? this.options.storage.exclusive(context.target, 'execution', current, work)
        : work());
      current();
      return result;
    } catch (cause) {
      if (this.#context === context && this.#matches(context))
        this.#error = cause instanceof Error ? cause.message : 'GitHub 操作失败，请手动核查。';
      throw cause;
    } finally {
      if (this.#context === context && panel === this.#panel) {
        this.#working = false;
        this.#adding = false;
        this.#emit();
      }
    }
  }
  refresh(review: SecureGithubReview) {
    return this.#run(
      review,
      async () => {
        if (this.#mode === 'read') await this.#read!.refresh();
        else if (this.#mode === 'write') await this.#write!.refresh();
        else await this.#loadRecovery(this.#context!, this.#panel);
      },
      { online: this.#mode !== 'recovery' },
    );
  }
  show(review: SecureGithubReview, mode: SecureGithubMode) {
    const detail = copy(this.#read?.detail);
    return this.#run(
      review,
      async (current) => {
        this.#mode = mode;
        if (mode === 'write' && this.#context!.online) {
          await this.#write!.refresh();
          current();
          if (detail) await this.#write!.openDetail(detail.view, detail.item.number);
        }
      },
      { online: false },
    );
  }
  branches(review: SecureGithubReview, page: number) {
    return this.#run(review, async () => {
      await (this.#mode === 'read' ? this.#read! : this.#write!).loadBranches(page);
    });
  }
  list(
    review: SecureGithubReview,
    view: 'issues' | 'pulls',
    state: 'open' | 'closed' | 'all',
    page: number,
  ) {
    return this.#run(review, async () => {
      await this.#read!.loadList(view, state, page);
    });
  }
  item(review: SecureGithubReview, kind: 'issue' | 'pull', number: number) {
    return this.#run(review, async () => {
      await this.#read!.openItem(kind, number);
    });
  }
  comments(review: SecureGithubReview, page: number) {
    return this.#run(review, async () => {
      await this.#read!.loadComments(page);
    });
  }
  checks(review: SecureGithubReview, page: number) {
    return this.#run(review, async () => {
      await this.#read!.loadChecks(page);
    });
  }
  clear(review: SecureGithubReview) {
    this.#assertReview(review);
    if (this.#opening || this.#working) throw Error('请等待当前 GitHub 操作完成。');
    this.#read!.clearSelection();
  }
  bind(review: SecureGithubReview, branch: string) {
    return this.#run(
      review,
      async () => {
        await this.#read!.bind(branch);
      },
      { lock: true, beforeWrite: true },
    );
  }
  unbind(review: SecureGithubReview) {
    return this.#run(
      review,
      async () => {
        await this.#read!.unbind();
      },
      { lock: true, beforeWrite: true },
    );
  }
  retryBinding(review: SecureGithubReview) {
    return this.#run(
      review,
      async () => {
        await this.#read!.retry();
      },
      { lock: true },
    );
  }
  abandonBinding(review: SecureGithubReview) {
    return this.#run(
      review,
      async () => {
        await this.#read!.abandon();
      },
      { lock: true },
    );
  }
  add(review: SecureGithubReview) {
    return this.#run(review, async (current) => {
      const detail: GithubDetail | undefined = copy(this.#read!.detail);
      if (!detail) throw Error('请先读取要加入草稿的 Issue 或 PR。');
      this.#adding = true;
      this.#emit();
      const text = await this.#read!.contextForDraft();
      current();
      const refreshed = this.#read!.detail;
      // Fresh Host reads change their observation time. All displayed content and identities
      // must still match, including providers that incorrectly reuse an item version.
      const { readAt: _displayedAt, ...displayedContent } = detail;
      const { readAt: _refreshedAt, ...refreshedContent } = refreshed ?? {};
      if (!refreshed || !same(displayedContent, refreshedContent))
        throw Error('GitHub 正文已改变，请重新审阅后加入。');
      await this.options.appendInstruction(copy(this.#context!.target), text, current);
    });
  }
  pull(review: SecureGithubReview, view: 'files' | 'review-comments', page: number) {
    return this.#run(review, async () => {
      await this.#write!.loadPull(view, page);
    });
  }
  commitPreview(review: SecureGithubReview, paths: string[]) {
    return this.#run(review, async () => {
      await this.#write!.previewCommit(copy(paths));
    });
  }
  pushPreview(review: SecureGithubReview) {
    return this.#run(review, async () => {
      await this.#write!.previewPush();
    });
  }
  createDraft(
    review: SecureGithubReview,
    kind: GithubWriteDraft['kind'],
    values: GithubWriteDraft['values'],
  ) {
    return this.#run(review, async () => this.#write!.createDraft(kind, copy(values)), {
      online: false,
    });
  }
  async saveDraft(
    review: SecureGithubReview,
    displayed: GithubWriteDraft,
    input: GithubWriteDraft,
  ) {
    this.#assertReview(review, false);
    const draft = githubWriteDraftSchema.parse(input),
      write = this.#write!,
      context = this.#context!,
      panel = this.#panel;
    if (
      this.#opening ||
      this.#working ||
      !write.drafts[draft.id] ||
      !same(immutableDraft(draft), immutableDraft(displayed)) ||
      !same(immutableDraft(draft), immutableDraft(write.drafts[draft.id]))
    )
      throw Error('草稿目标已改变，请重新选择原草稿。');
    this.#saving++;
    this.#emit();
    try {
      await write.saveDraft(draft);
      this.#current(context, panel);
    } catch (cause) {
      if (this.#context === context && this.#matches(context))
        this.#error = cause instanceof Error ? cause.message : '草稿未确认保存。';
      throw cause;
    } finally {
      if (this.#context === context && panel === this.#panel) {
        this.#saving--;
        this.#emit();
      }
    }
  }
  removeDraft(review: SecureGithubReview, id: string) {
    return this.#run(
      review,
      async () => {
        await this.#write!.removeDraft(id);
      },
      { online: false },
    );
  }
  prepare(review: SecureGithubReview, id: string) {
    return this.#run(review, async () => {
      await this.#write!.prepare(id);
    });
  }
  cancelReview(review: SecureGithubReview) {
    this.#assertReview(review);
    if (this.#opening || this.#working) return;
    this.#write!.cancelReview();
  }
  confirm(review: SecureGithubReview) {
    return this.#run(
      review,
      async () => {
        await this.#write!.confirm();
      },
      { lock: true, beforeWrite: true },
    );
  }
  inspect(review: SecureGithubReview, page = 1) {
    return this.#run(
      review,
      async () => {
        await this.#write!.inspect(page);
      },
      { lock: true },
    );
  }
  abandon(review: SecureGithubReview) {
    return this.#run(
      review,
      async () => {
        await this.#write!.abandon();
      },
      { lock: true },
    );
  }
  recover(review: SecureGithubReview, id: string, action: 'inspect' | 'abandon', page = 1) {
    return this.#run(
      review,
      async () => {
        const entry = this.#recoveries.find((item) => item.id === id);
        if (!entry) throw Error('原操作已改变，请重新读取本机记录。');
        if (entry.binding) {
          if (action !== 'abandon') throw Error('旧绑定只能封存原操作，不能重新绑定。');
          await entry.binding.abandon();
        } else if (entry.write) {
          if (action === 'inspect') await entry.write.inspect(page);
          else await entry.write.abandon();
        }
      },
      { lock: true },
    );
  }
}
