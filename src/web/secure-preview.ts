import { z } from 'zod';
import {
  secureTargetSchema,
  securePreviewReviewSchema,
  type SecureCliTarget,
  type SecurePreviewReview,
} from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import {
  previewReadSchema,
  previewActionSchema,
  previewInspectSchema,
  previewCloseSchema,
  previewOpenSchema,
  previewReceiptSchema,
  type PreviewOpen,
  type PreviewAction,
  type PreviewReceipt,
  type PreviewViewport,
} from '../preview-protocol';
import { SecureStore } from './secure-store';
import { SecureScopedStorage, secureGitTarget } from './secure-scoped-storage';
import {
  ProjectPreviewController,
  PreviewAnnotationStore,
  projectPreviewKey,
  previewAnnotationSchema,
  PREVIEW_ANNOTATION_LIMIT,
  type PreviewAnnotation,
  type PreviewInteraction,
} from './project-preview';

export type { SecurePreviewReview } from '../cli/secure-operation';
const canonical = productCanonicalJson;
const same = (left: unknown, right: unknown) =>
  canonical(left ?? null) === canonical(right ?? null);
const annotationArray = z.array(previewAnnotationSchema).max(PREVIEW_ANNOTATION_LIMIT);
const check = (current: () => void) => () => {
  try {
    current();
    return true;
  } catch {
    return false;
  }
};
function boundTarget(input: SecureCliTarget) {
  const target = secureTargetSchema.parse(input);
  if (!target.product) throw Error('请先选择已确认的项目副本。');
  return target;
}

/** The existing annotation store owns hashes and composition; encrypted scope and operation locks wrap it. */
export class SecurePreviewAnnotations {
  constructor(
    readonly store: SecureStore,
    readonly storage = new SecureScopedStorage(store),
  ) {}

  async load(input: SecureCliTarget, current: () => void): Promise<PreviewAnnotationStore> {
    const target = boundTarget(input),
      scoped = this.storage.forTarget(target, current);
    const result = new PreviewAnnotationStore(secureGitTarget(target), {
      current: check(current),
      changed() {},
      read: async (key) => {
        const raw = await scoped.read(key);
        current();
        if (raw === undefined) return undefined;
        const record = z.object({ annotations: annotationArray }).passthrough().parse(raw);
        const operations = await this.store.list(target);
        current();
        const consumed = operations
          .filter(
            (operation) =>
              same(operation.target, target) &&
              operation.kind === 'turn' &&
              operation.state === 'accepted' &&
              operation.previewReview,
          )
          .flatMap((operation) => operation.previewReview!.annotations);
        return {
          ...record,
          annotations: record.annotations.map((item) => {
            if (!item.selectionId) return item;
            const original = consumed.find(
              (value) =>
                value.id === item.id &&
                value.version === item.version &&
                value.selectionId === item.selectionId,
            );
            if (original && !same(original, item))
              throw Error('已确认原标注与当前同版本完整内容不匹配。');
            return original ? { ...item, selectionId: undefined } : item;
          }),
        };
      },
      compareWrite: scoped.compareWrite,
    });
    await result.load();
    current();
    return result;
  }
  async read(target: SecureCliTarget, current: () => void): Promise<PreviewAnnotation[]> {
    return [...(await this.load(target, current)).items];
  }
  async change<T>(
    input: SecureCliTarget,
    shown: readonly PreviewAnnotation[],
    current: () => void,
    work: (store: PreviewAnnotationStore) => Promise<T>,
  ): Promise<{ store: PreviewAnnotationStore; value: T }> {
    const target = boundTarget(input),
      expected = annotationArray.parse(shown);
    return this.storage.exclusive(target, 'preview-annotations', current, async () => {
      const store = await this.load(target, current);
      if (!same(store.items, expected)) throw Error('标注草稿已在另一页面改变，请重新打开并审阅。');
      const value = await work(store);
      current();
      return { store, value };
    });
  }
  async #validate(
    target: SecureCliTarget,
    shown: readonly PreviewAnnotation[],
    current: () => void,
  ) {
    const store = await this.load(target, current),
      expected = annotationArray.parse(shown);
    if (expected.some((item) => !item.selectionId) || !same(store.selected, expected))
      throw Error('已审阅的标注选择已改变，请重新核对后发送。');
    const pending = (await this.store.list(target)).some(
      (operation) =>
        same(operation.target, target) &&
        operation.kind === 'turn' &&
        ['pending', 'ending'].includes(operation.state),
    );
    current();
    if (pending) throw Error('请先核查原指令，不能替换或重新发送原标注。');
    return store;
  }
  async validate(input: SecureCliTarget, shown: readonly PreviewAnnotation[], current: () => void) {
    const target = boundTarget(input),
      expected = annotationArray.parse(shown);
    await this.storage.exclusive(target, 'preview-annotations', current, async () => {
      await this.#validate(target, expected, current);
    });
  }
  async withReview<T>(
    input: SecureCliTarget,
    shown: readonly PreviewAnnotation[],
    prompt: string,
    current: () => void,
    work: (value: { prompt: string; previewReview: SecurePreviewReview | undefined }) => Promise<T>,
  ): Promise<T> {
    const target = boundTarget(input),
      expected = annotationArray.parse(shown);
    return this.storage.exclusive(target, 'preview-annotations', current, async () => {
      const store = await this.#validate(target, expected, current),
        composed = store.compose(prompt);
      current();
      const result = await work({
        prompt: composed.prompt,
        previewReview: expected.length
          ? securePreviewReviewSchema.parse({ annotations: expected })
          : undefined,
      });
      current();
      return result;
    });
  }
}

export type SecurePreviewContext = {
  target: SecureCliTarget | null;
  online: boolean;
  generation: number;
};
export type SecurePreviewMethod =
  | 'preview-read'
  | 'preview-action'
  | 'preview-inspect'
  | 'preview-close';
export type SecurePreviewDependencies = {
  context(): SecurePreviewContext;
  storage: SecureScopedStorage;
  annotations: SecurePreviewAnnotations;
  request(
    target: SecureCliTarget,
    method: SecurePreviewMethod,
    params: unknown,
    current: () => void,
  ): Promise<unknown>;
  addImage(
    target: SecureCliTarget,
    annotation: PreviewAnnotation,
    current: () => void,
  ): Promise<void>;
  changedAnnotations?(
    target: SecureCliTarget,
    items: PreviewAnnotation[],
    current: () => void,
  ): Promise<void> | void;
  schedule?(milliseconds: number, work: () => void): () => void;
};
type Lease = {
  target: SecureCliTarget;
  online: boolean;
  generation: number;
  id: number;
  active: boolean;
  visible: boolean;
  work?: symbol;
  preview: ProjectPreviewController;
  annotations?: PreviewAnnotationStore;
  recoveries: SecurePreviewRecovery[];
};
export type SecurePreviewRecovery = {
  target: SecureCliTarget;
  open?: PreviewOpen;
  pending?: PreviewAction;
  receipt?: PreviewReceipt;
  closing: boolean;
};
export type SecurePreviewPanelReview = {
  target: SecureCliTarget;
  generation: number;
  panel: number;
  options: ProjectPreviewController['options'];
  frame: ProjectPreviewController['frame'];
  element: ProjectPreviewController['element'];
  openRequest: ProjectPreviewController['openRequest'];
  pending: ProjectPreviewController['pending'];
  annotations: PreviewAnnotation[];
};
export type SecurePreviewState = {
  target: SecureCliTarget;
  online: boolean;
  working: boolean;
  controller: ProjectPreviewController;
  annotations?: PreviewAnnotationStore;
  review: SecurePreviewPanelReview;
  error: string;
  recoveries: SecurePreviewRecovery[];
};

function previewController(
  options: SecurePreviewDependencies,
  target: SecureCliTarget,
  current: () => void,
  online: () => boolean,
  changed: () => void,
  recoveryOnly = false,
) {
  const scoped = options.storage.forTarget(target, current);
  return new ProjectPreviewController(secureGitTarget(target), {
    current: check(current),
    online,
    changed,
    read: scoped.read,
    compareWrite: scoped.compareWrite,
    request: async (path, params) => {
      current();
      const prefix = `/api/workspaces/${target.product!.catalogWorkspaceId}/replicas/${target.product!.replicaId}/preview/`;
      const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : '';
      const methods = {
        read: 'preview-read',
        action: 'preview-action',
        inspect: 'preview-inspect',
        close: 'preview-close',
      } as const;
      if (
        !Object.hasOwn(methods, suffix) ||
        (recoveryOnly && suffix !== 'inspect' && suffix !== 'close')
      )
        throw Error('不支持的加密预览操作。');
      const parsed =
        suffix === 'read'
          ? previewReadSchema.parse(params)
          : suffix === 'action'
            ? previewActionSchema.parse(params)
            : suffix === 'inspect'
              ? previewInspectSchema.parse(params)
              : previewCloseSchema.parse(params);
      const body = 'request' in parsed ? parsed.request : parsed;
      if (
        body.workspaceId !== target.workspaceId ||
        body.localProjectId !== target.localProjectId ||
        body.sessionId !== target.sessionId
      )
        throw Error('预览请求与完整执行范围不匹配。');
      if (!online()) throw Error('执行电脑离线，未发送预览操作。');
      const value = await options.request(
        structuredClone(target),
        methods[suffix as keyof typeof methods],
        parsed,
        current,
      );
      current();
      return value;
    },
  });
}

/** Only explicit panel actions use the finite encrypted boundary; leases never resume on reconnect. */
export class SecurePreviewController {
  #lease?: Lease;
  #serial = 0;
  #error = '';
  #listeners = new Set<() => void>();
  #heartbeat?: () => void;
  #heartbeatId = 0;
  #closing: Promise<void> = Promise.resolve();
  constructor(private readonly options: SecurePreviewDependencies) {}
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #emit() {
    for (const listener of this.#listeners) listener();
    this.#keepAlive();
  }
  #bind() {
    const context = this.options.context();
    if (!context.target || !Number.isSafeInteger(context.generation) || context.generation < 0)
      throw Error('请先打开已确认的项目会话。');
    return {
      target: boundTarget(context.target),
      online: context.online === true,
      generation: context.generation,
    };
  }
  #matches(lease: Lease) {
    try {
      const current = this.#bind();
      return (
        lease.active &&
        same(current, { target: lease.target, online: lease.online, generation: lease.generation })
      );
    } catch {
      return false;
    }
  }
  #current(lease: Lease) {
    if (!this.#matches(lease)) throw Error('网页预览所属会话或连接已改变，请重新打开。');
  }
  get state(): SecurePreviewState | null {
    const lease = this.#lease;
    if (!lease?.visible || !this.#matches(lease)) return null;
    return {
      target: structuredClone(lease.target),
      online: lease.online,
      working: !!lease.work,
      controller: lease.preview,
      annotations: lease.annotations,
      error: this.#error,
      recoveries: structuredClone(lease.recoveries),
      review: structuredClone({
        target: lease.target,
        generation: lease.generation,
        panel: lease.id,
        options: lease.preview.options,
        frame: lease.preview.frame,
        element: lease.preview.element,
        openRequest: lease.preview.openRequest,
        pending: lease.preview.pending,
        annotations: [...(lease.annotations?.items ?? [])],
      }),
    };
  }
  #stopHeartbeat() {
    this.#heartbeatId++;
    this.#heartbeat?.();
    this.#heartbeat = undefined;
  }
  #keepAlive() {
    const lease = this.#lease,
      preview = lease?.preview;
    const eligible = !!(
      lease?.visible &&
      lease.online &&
      this.#matches(lease) &&
      !lease.work &&
      preview?.active &&
      !preview.busy &&
      !preview.pending &&
      !preview.closing &&
      !preview.error &&
      !preview.loadError
    );
    if (!eligible) {
      this.#stopHeartbeat();
      return;
    }
    if (this.#heartbeat) return;
    const schedule =
      this.options.schedule ??
      ((ms, work) => {
        const timer = setTimeout(work, ms);
        return () => clearTimeout(timer);
      });
    const heartbeatId = ++this.#heartbeatId;
    this.#heartbeat = schedule(12000, () => {
      if (heartbeatId !== this.#heartbeatId) return;
      this.#heartbeat = undefined;
      if (
        !lease?.visible ||
        !this.#matches(lease) ||
        lease.work ||
        lease.preview.busy ||
        lease.preview.pending ||
        lease.preview.closing
      )
        return;
      const state = this.state;
      if (state) void this.#work(state.review, async () => lease.preview.status()).catch(() => {});
    });
  }
  sync() {
    const lease = this.#lease;
    if (lease && !this.#matches(lease)) {
      this.#stopHeartbeat();
      lease.visible = false;
      lease.active = false;
      lease.preview.invalidate();
      this.#lease = undefined;
      this.#emit();
    }
  }
  async open(input: SecureCliTarget) {
    const context = this.#bind(),
      target = boundTarget(input);
    if (!same(context.target, target)) throw Error('网页预览所属目标已改变，请重新打开。');
    await this.dismiss();
    if (!same(context, this.#bind())) throw Error('网页预览所属连接已改变，请重新打开。');
    const id = ++this.#serial;
    let lease!: Lease;
    const current = () => this.#current(lease);
    const controller = previewController(
      this.options,
      target,
      current,
      () => lease.online && this.#matches(lease),
      () => {
        if (lease.visible) this.#emit();
      },
    );
    const opening = Symbol('opening');
    lease = {
      ...context,
      id,
      active: true,
      visible: true,
      work: opening,
      preview: controller,
      recoveries: [],
    };
    const loadingCurrent = () => {
      current();
      if (!lease.visible || lease.work !== opening) throw Error('预览面板的读取已失效。');
    };
    this.#lease = lease;
    this.#error = '';
    this.#emit();
    try {
      await this.options.storage.exclusive(target, 'preview', loadingCurrent, () =>
        controller.load(),
      );
      lease.annotations = await this.options.annotations.load(target, loadingCurrent);
      lease.recoveries = await this.#recoveries(lease, loadingCurrent);
      loadingCurrent();
      this.#emit();
      if (lease.online)
        await this.options.storage.exclusive(target, 'preview', loadingCurrent, () =>
          controller.refreshOptions(),
        );
    } catch (error) {
      if (this.#matches(lease) && lease.visible && lease.work === opening) {
        this.#error = error instanceof Error ? error.message : '无法读取预览。';
        this.#emit();
      }
      throw error;
    } finally {
      if (lease.work === opening) {
        lease.work = undefined;
        if (lease.visible && this.#matches(lease)) this.#emit();
      }
    }
  }
  async dismiss() {
    const lease = this.#lease;
    if (!lease) return this.#closing;
    lease.visible = false;
    this.#lease = undefined;
    this.#stopHeartbeat();
    this.#emit();
    // close() invalidates any in-flight frame/action before persisting the original close marker.
    const closing = async () => {
      try {
        if (this.#matches(lease) && lease.preview.openRequest) {
          await lease.preview.close();
        } else lease.preview.invalidate();
      } catch {
        /* Keep the persisted original open/closing marker for explicit inspection or closure. */
      } finally {
        lease.active = false;
        lease.preview.invalidate();
      }
    };
    this.#closing = closing();
    await this.#closing;
  }
  dispose() {
    void this.dismiss();
    this.#listeners.clear();
  }
  async #recoveries(lease: Lease, current: () => void): Promise<SecurePreviewRecovery[]> {
    const records = await this.options.storage.list(lease.target, current);
    return records
      .filter(
        (record) =>
          !same(record.target, lease.target) &&
          record.key === projectPreviewKey(secureGitTarget(record.target)),
      )
      .flatMap((record) => {
        const { open, pending, receipt, closing } = record.value;
        if (!open && !pending && !closing) return [];
        return [
          {
            target: record.target,
            open: open === undefined ? undefined : previewOpenSchema.parse(open),
            pending: pending === undefined ? undefined : previewActionSchema.parse(pending),
            receipt: receipt === undefined ? undefined : previewReceiptSchema.parse(receipt),
            closing: closing === true,
          },
        ];
      });
  }
  async recover(
    review: SecurePreviewPanelReview,
    shown: SecurePreviewRecovery,
    action: 'inspect' | 'close',
  ) {
    const selected = structuredClone(shown);
    await this.#work(review, async (lease, current) => {
      if (!lease.recoveries.some((record) => same(record, selected)))
        throw Error('原预览记录已改变，请重新打开核对。');
      await this.options.storage.exclusive(selected.target, 'preview', current, async () => {
        const fresh = await this.#recoveries(lease, current);
        if (!fresh.some((record) => same(record, selected)))
          throw Error('原预览记录已在另一页面改变，请重新打开核对。');
        const original = previewController(
          this.options,
          selected.target,
          current,
          () => lease.online && this.#matches(lease),
          () => {},
          true,
        );
        await original.load();
        current();
        try {
          if (action === 'inspect') await original.inspect();
          else await original.close();
        } finally {
          original.invalidate();
        }
        current();
      });
      lease.recoveries = await this.#recoveries(lease, current);
    });
  }
  #review(input: SecurePreviewPanelReview) {
    const lease = this.#lease;
    if (
      !lease?.visible ||
      !this.#matches(lease) ||
      !same(input.target, lease.target) ||
      input.generation !== lease.generation ||
      input.panel !== lease.id
    )
      throw Error('预览面板或执行范围已改变，请重新查看。');
    return lease;
  }
  async #work(
    review: SecurePreviewPanelReview,
    work: (lease: Lease, current: () => void) => Promise<unknown>,
    preempt = false,
  ) {
    const lease = this.#review(review);
    if (!preempt && (lease.work || lease.preview.busy)) throw Error('请等待当前预览操作完成。');
    const operation = Symbol('preview-operation'),
      current = () => {
        this.#current(lease);
        if (!lease.visible) throw Error('网页预览面板已关闭。');
        if (lease.work !== operation) throw Error('原预览操作已失效。');
      };
    lease.work = operation;
    this.#error = '';
    this.#emit();
    try {
      await work(lease, current);
      current();
    } catch (error) {
      if (lease.work === operation && lease.visible && this.#matches(lease)) {
        this.#error = error instanceof Error ? error.message : '预览操作未确认。';
        this.#emit();
      }
      throw error;
    } finally {
      if (lease.work === operation) {
        lease.work = undefined;
        if (lease.visible && this.#matches(lease)) this.#emit();
      }
    }
  }
  #sameView(
    review: SecurePreviewPanelReview,
    lease: Lease,
    fields: readonly ('options' | 'frame' | 'element' | 'openRequest' | 'pending')[],
  ) {
    if (fields.some((field) => !same(review[field], lease.preview[field])))
      throw Error('已审阅的预览画面或服务已改变，请重新核对后操作。');
  }
  async action(
    review: SecurePreviewPanelReview,
    action:
      | 'options'
      | 'capture'
      | 'inspect'
      | 'close'
      | { connect: string; viewport: PreviewViewport }
      | { locate: { x: number; y: number } }
      | { interact: PreviewInteraction },
  ) {
    await this.#work(
      review,
      async (lease, current) => {
        const c = lease.preview;
        this.#sameView(
          review,
          lease,
          typeof action === 'object' && 'connect' in action
            ? ['options', 'openRequest', 'pending']
            : typeof action === 'object'
              ? ['frame', 'element', 'openRequest', 'pending']
              : ['openRequest', 'pending'],
        );
        if (action === 'close') {
          await c.close();
          return;
        }
        await this.options.storage.exclusive(lease.target, 'preview', current, async () => {
          this.#sameView(
            review,
            lease,
            typeof action === 'object' && 'connect' in action
              ? ['options', 'openRequest', 'pending']
              : typeof action === 'object'
                ? ['frame', 'element', 'openRequest', 'pending']
                : ['openRequest', 'pending'],
          );
          if (action === 'options') await c.refreshOptions();
          else if (action === 'capture') await c.capture();
          else if (action === 'inspect') await c.inspect();
          else if ('connect' in action) await c.open(action.connect, action.viewport);
          else if ('locate' in action) await c.locate(action.locate.x, action.locate.y);
          else await c.interact(action.interact);
        });
      },
      action === 'close',
    );
  }
  async #change(
    review: SecurePreviewPanelReview,
    work: (store: PreviewAnnotationStore, lease: Lease) => Promise<unknown>,
  ) {
    await this.#work(review, async (lease, current) => {
      const result = await this.options.annotations.change(
        lease.target,
        review.annotations,
        current,
        (store) => work(store, lease),
      );
      current();
      lease.annotations = result.store;
      await this.options.changedAnnotations?.(
        structuredClone(lease.target),
        [...result.store.items],
        current,
      );
      current();
    });
  }
  async save(review: SecurePreviewPanelReview, note: string, includeImage: boolean) {
    const lease = this.#review(review);
    this.#sameView(review, lease, ['frame', 'element', 'options', 'openRequest', 'pending']);
    const frozen = lease.preview.annotation(note, includeImage);
    await this.#change(review, (store) => store.save(frozen));
  }
  async select(review: SecurePreviewPanelReview, id: string, selected: boolean) {
    await this.#change(review, (store) => store.select(id, selected));
  }
  async remove(review: SecurePreviewPanelReview, id: string) {
    await this.#change(review, (store) => store.remove(id));
  }
  async edit(review: SecurePreviewPanelReview, id: string, note: string) {
    const item = review.annotations.find((item) => item.id === id);
    if (!item) throw Error('已审阅标注不存在。');
    await this.#change(review, (store) => store.save({ ...item.snapshot, note }, id));
  }
  async image(review: SecurePreviewPanelReview, id: string) {
    const item = review.annotations.find((item) => item.id === id);
    if (!item?.snapshot.image) throw Error('此标注未保存截图。');
    await this.#work(review, async (lease, current) => {
      await this.options.annotations.change(lease.target, review.annotations, current, async () => {
        await this.options.addImage(structuredClone(lease.target), structuredClone(item), current);
      });
    });
  }
}
