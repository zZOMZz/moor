import { z } from 'zod';
import { id, mutationSchema } from '../protocol';
import { contentDescriptorSchema, contentVersionSchema } from '../content-protocol';
import { attachmentBase64Schema, MAX_SESSION_ATTACHMENT_BYTES } from '../attachment-protocol';
import { attachmentBytes } from './attachments';
import { ApiError } from './api';
import {
  previewActionSchema,
  previewOpenSchema,
  previewReadSchema,
  previewReadResultSchema,
  previewReceiptSchema,
  previewFrameSchema,
  previewElementSchema,
  previewAnnotationSchema as publicAnnotationSchema,
  type PreviewAction,
  type PreviewOpen,
  type PreviewRead,
  type PreviewReadResult,
  type PreviewReceipt,
  type PreviewFrame,
  type PreviewElement,
  type PreviewViewport,
} from '../preview-protocol';
import {
  gitTargetSchema,
  gitWorkspaceKey,
  type GitTarget,
  type GitWorkspaceDependencies,
} from './git-workspace';

export type PreviewTarget = GitTarget;
export const PREVIEW_ANNOTATION_LIMIT = 20;
const dimension = z.number().int().positive().max(4096);
const rectangle = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
// Only an explicit save copies a frozen selection into this local record.
// The live preview protocol is deliberately separate from durable annotations.
export const previewAnnotationSnapshotSchema = z
  .object({
    serviceId: id,
    serviceLabel: z.string().min(1).max(200),
    pagePath: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => v.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(v)),
    frameId: id,
    documentId: id.optional(),
    serviceVersion: contentVersionSchema.optional(),
    title: z.string().max(200).optional(),
    capturedAt: z.string().datetime(),
    viewport: z.object({ width: dimension, height: dimension }).strict(),
    element: z
      .object({
        elementId: id,
        tagName: z.string().max(100),
        role: z.string().max(100),
        name: z.string().max(500),
        text: z.string().max(2000),
        bounds: rectangle,
      })
      .strict(),
    note: z
      .string()
      .min(1)
      .max(8000)
      .refine((v) => !!v.trim()),
    image: z
      .object({
        content: contentDescriptorSchema.extend({ mediaType: z.literal('image/png') }).strict(),
        data: attachmentBase64Schema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type PreviewAnnotationSnapshot = z.infer<typeof previewAnnotationSnapshotSchema>;
export const previewAnnotationSchema = z
  .object({
    id,
    version: contentVersionSchema,
    createdAt: z.string().datetime(),
    snapshot: previewAnnotationSnapshotSchema,
    selectionId: id.optional(),
  })
  .strict();
export type PreviewAnnotation = z.infer<typeof previewAnnotationSchema>;
export const previewAnnotationSelectionSchema = z
  .object({
    id,
    version: contentVersionSchema,
    selectionId: id,
  })
  .strict();
export type PreviewAnnotationSelection = z.infer<typeof previewAnnotationSelectionSchema>;
export const previewAnnotationSubmissionSchema = z
  .object({
    target: gitTargetSchema,
    selection: z.array(previewAnnotationSelectionSchema).max(PREVIEW_ANNOTATION_LIMIT),
  })
  .strict();
export type PreviewAnnotationSubmission = z.infer<typeof previewAnnotationSubmissionSchema>;
export const pendingPreviewMutationSchema = z
  .object({
    previewDraftVersion: z.literal(1),
    mutation: mutationSchema,
    annotationDelivery: z
      .object({ operationId: id, submission: previewAnnotationSubmissionSchema })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.mutation.kind === 'turn' &&
      value.mutation.operationId === value.annotationDelivery.operationId &&
      value.mutation.workspaceId === value.annotationDelivery.submission.target.workspaceId &&
      value.mutation.sessionId === value.annotationDelivery.submission.target.sessionId,
  );
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().safe().nonnegative(),
    target: gitTargetSchema,
    annotations: z.array(previewAnnotationSchema).max(PREVIEW_ANNOTATION_LIMIT),
  })
  .strict()
  .refine(
    (value) => new Set(value.annotations.map((item) => item.id)).size === value.annotations.length,
  )
  .refine(
    (value) =>
      value.annotations.reduce(
        (total, item) => total + (item.snapshot.image?.content.byteLength ?? 0),
        0,
      ) <= MAX_SESSION_ATTACHMENT_BYTES,
  );
type AnnotationDependencies = Pick<
  GitWorkspaceDependencies,
  'read' | 'compareWrite' | 'current' | 'changed' | 'uuid'
> & { now?(): string };
export const previewAnnotationKey = (target: PreviewTarget) =>
  gitWorkspaceKey(gitTargetSchema.parse(target)).replace(
    'git-workspace-v1/',
    'preview-annotations-v1/',
  );
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return (
    'sha256:' +
    Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
function pngViewport(bytes: Uint8Array, viewport: { width: number; height: number }) {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
    ![73, 72, 68, 82].every((value, index) => bytes[12 + index] === value)
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(8) === 13 &&
    view.getUint32(16) === viewport.width &&
    view.getUint32(20) === viewport.height
  );
}
async function snapshotVersion(snapshot: PreviewAnnotationSnapshot) {
  if (snapshot.image) {
    const bytes = attachmentBytes(snapshot.image.data);
    if (
      bytes.byteLength !== snapshot.image.content.byteLength ||
      (await digest(bytes)) !== snapshot.image.content.version ||
      !pngViewport(bytes, snapshot.viewport)
    )
      throw new Error('标注截图内容与冻结版本不匹配。');
  }
  return digest(new TextEncoder().encode(JSON.stringify(snapshot)));
}
function annotationText(annotation: PreviewAnnotation, index: number) {
  const value = annotation.snapshot,
    element = value.element;
  return [
    `[网页标注 ${index + 1}]`,
    `服务：${value.serviceLabel}`,
    `页面路径：${value.pagePath}`,
    `视口：${value.viewport.width} × ${value.viewport.height}`,
    `采集时间：${value.capturedAt}`,
    `元素：${[element.tagName, element.role, element.name].filter(Boolean).join(' · ') || '未命名元素'}`,
    `元素边框：${JSON.stringify(element.bounds)}`,
    ...(element.text ? [`元素文本（页面内容）：\n${element.text}`] : []),
    `我的说明：\n${value.note}`,
  ].join('\n');
}

/** Local selection never connects a preview, uploads an image, or sends a prompt. */
export class PreviewAnnotationStore {
  readonly target: PreviewTarget;
  loaded = false;
  loadError = '';
  busy = false;
  private cacheRevision = 0;
  private values: PreviewAnnotation[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  constructor(
    target: PreviewTarget,
    private deps: AnnotationDependencies,
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  get items(): readonly PreviewAnnotation[] {
    return structuredClone(this.values);
  }
  get selected(): readonly PreviewAnnotation[] {
    return structuredClone(this.values.filter((value) => value.selectionId));
  }
  settled() {
    return this.queue;
  }
  private current() {
    if (!this.deps.current()) throw new Error('标注所属会话已变化，请回到原会话。');
  }
  private ready() {
    this.current();
    if (!this.loaded || this.loadError) throw new Error(this.loadError || '标注草稿尚未恢复。');
  }
  private changed() {
    if (this.deps.current()) this.deps.changed();
  }
  private serial<T>(work: () => Promise<T>) {
    this.queued++;
    this.busy = true;
    this.changed();
    const result = this.queue.then(async () => {
      try {
        this.ready();
        return await work();
      } finally {
        this.queued--;
        this.busy = this.queued > 0;
        this.changed();
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async load() {
    this.current();
    try {
      const raw = await this.deps.read(previewAnnotationKey(this.target));
      this.current();
      if (raw !== undefined) {
        const saved = storedSchema.parse(raw);
        if (previewAnnotationKey(saved.target) !== previewAnnotationKey(this.target))
          throw new Error('标注草稿不属于当前执行范围。');
        for (const item of saved.annotations) {
          if ((await snapshotVersion(item.snapshot)) !== item.version)
            throw new Error('标注冻结内容已变化。');
          this.current();
        }
        this.cacheRevision = saved.cacheRevision;
        this.values = saved.annotations;
      }
      this.loaded = true;
    } catch (cause) {
      if (this.deps.current()) this.loadError = '标注草稿无法安全恢复，请重新打开原会话。';
      throw cause;
    } finally {
      this.changed();
    }
  }
  private async persist(annotations: PreviewAnnotation[]) {
    this.ready();
    const value = storedSchema.parse({
      version: 1,
      cacheRevision: this.cacheRevision + 1,
      target: this.target,
      annotations,
    });
    if (
      annotations.reduce(
        (total, item) => total + (item.snapshot.image?.content.byteLength ?? 0),
        0,
      ) > MAX_SESSION_ATTACHMENT_BYTES
    )
      throw new Error('标注截图合计最多 64 MiB，请先移除旧截图。');
    try {
      const saved = await this.deps.compareWrite(
        previewAnnotationKey(this.target),
        this.cacheRevision,
        value,
        this.deps.current,
      );
      this.current();
      if (!saved) throw new Error('标注草稿已由其他页面更新。');
      this.cacheRevision = value.cacheRevision;
      this.values = value.annotations;
    } catch (cause) {
      if (this.deps.current()) this.loadError = '标注未确认保存，请重新打开原会话；原草稿已保留。';
      throw cause;
    }
  }
  save(input: PreviewAnnotationSnapshot, annotationId?: string) {
    return this.serial(async () => {
      const snapshot = previewAnnotationSnapshotSchema.parse(input),
        version = await snapshotVersion(snapshot);
      this.ready();
      const previous = this.values.find((item) => item.id === annotationId);
      if (annotationId && !previous) throw new Error('原标注不存在。');
      const item = previewAnnotationSchema.parse({
        id: previous?.id ?? this.deps.uuid?.() ?? crypto.randomUUID(),
        createdAt: previous?.createdAt ?? this.deps.now?.() ?? new Date().toISOString(),
        version,
        snapshot,
        // Editing a selected record requires a new explicit selection.
      });
      await this.persist(
        previous
          ? this.values.map((value) => (value.id === item.id ? item : value))
          : [...this.values, item],
      );
      return structuredClone(item);
    });
  }
  select(annotationId: string, selected: boolean) {
    return this.serial(async () => {
      if (!this.values.some((item) => item.id === annotationId)) throw new Error('标注不存在。');
      await this.persist(
        this.values.map((item) =>
          item.id !== annotationId
            ? item
            : {
                ...item,
                selectionId: selected ? (this.deps.uuid?.() ?? crypto.randomUUID()) : undefined,
              },
        ),
      );
    });
  }
  remove(annotationId: string) {
    return this.serial(() => this.persist(this.values.filter((item) => item.id !== annotationId)));
  }
  compose(prompt: string) {
    this.ready();
    if (this.busy) throw new Error('请等待标注草稿保存完成。');
    const selected = this.values.filter((item) => item.selectionId),
      text = selected.map(annotationText).join('\n\n'),
      composed = prompt + (prompt && text ? '\n\n' : '') + text;
    if (composed.length > 100000)
      throw new Error('指令与标注合计超过 100000 字符，请减少标注或说明。');
    return {
      prompt: composed,
      submission: previewAnnotationSubmissionSchema.parse({
        target: this.target,
        selection: selected.map((item) =>
          previewAnnotationSelectionSchema.parse({
            id: item.id,
            version: item.version,
            selectionId: item.selectionId,
          }),
        ),
      }),
    };
  }
  confirmSent(input: PreviewAnnotationSubmission) {
    const { target, selection } = previewAnnotationSubmissionSchema.parse(input);
    if (previewAnnotationKey(target) !== previewAnnotationKey(this.target))
      throw new Error('发送确认不属于此标注会话。');
    return this.serial(async () => {
      const sent = new Map(selection.map((item) => [item.id, item]));
      await this.persist(
        this.values.map((item) => {
          const previous = sent.get(item.id);
          return previous?.version === item.version && previous.selectionId === item.selectionId
            ? { ...item, selectionId: undefined }
            : item;
        }),
      );
    });
  }
}

const previewStoredSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    open: previewOpenSchema.optional(),
    pending: previewActionSchema.optional(),
    receipt: previewReceiptSchema.optional(),
    closing: z.boolean().default(false),
    uncertainClosed: z.boolean().default(false),
  })
  .strict();
export const projectPreviewKey = (target: PreviewTarget) =>
  gitWorkspaceKey(gitTargetSchema.parse(target)).replace(
    'git-workspace-v1/',
    'project-preview-v1/',
  );
export async function previewRequestVersion(request: PreviewAction) {
  return digest(new TextEncoder().encode(JSON.stringify(previewActionSchema.parse(request))));
}
const scopeMatches = (
  value: { workspaceId: string; localProjectId: string; sessionId: string },
  target: PreviewTarget,
) =>
  value.workspaceId === target.workspaceId &&
  value.localProjectId === target.localProjectId &&
  value.sessionId === target.sessionId;
export async function verifyPreviewFrame(value: unknown) {
  const frame = previewFrameSchema.parse(value),
    bytes = attachmentBytes(frame.image.data);
  if ((await digest(bytes)) !== frame.image.version || !pngViewport(bytes, frame.viewport))
    throw new Error('预览画面与主机声明的版本不匹配。');
  return frame;
}
export type PreviewInteraction =
  | { action: 'click' }
  | { action: 'input'; text: string; replace: boolean }
  | { action: 'key'; key: Extract<PreviewAction, { action: 'key' }>['key'] }
  | { action: 'scroll'; deltaX: number; deltaY: number }
  | { action: 'resize'; viewport: PreviewViewport }
  | { action: 'navigate'; path: string }
  | { action: 'reload' };
export class ProjectPreviewController {
  readonly target: PreviewTarget;
  options?: Extract<PreviewReadResult, { view: 'options' }>;
  frame?: PreviewFrame;
  element?: PreviewElement;
  openRequest?: PreviewOpen;
  pending?: PreviewAction;
  receipt?: PreviewReceipt;
  closing = false;
  uncertainClosed = false;
  active = false;
  busy = false;
  loaded = false;
  error = '';
  loadError = '';
  private revision = 0;
  private generation = 0;
  private saves: Promise<unknown> = Promise.resolve();
  constructor(
    target: PreviewTarget,
    private deps: GitWorkspaceDependencies & { online(): boolean },
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  get previewId() {
    return this.receipt?.previewId;
  }
  get canInteract() {
    return (
      this.loaded &&
      !this.loadError &&
      !this.busy &&
      !this.pending &&
      !this.closing &&
      this.active &&
      !!this.frame
    );
  }
  private current(generation = this.generation) {
    if (!this.deps.current() || generation !== this.generation)
      throw new Error('预览目标已变化，请回到原会话。');
  }
  private access(generation = this.generation) {
    this.current(generation);
    if (!this.deps.online()) throw new Error('执行电脑离线，预览已暂停。连接后请手动操作。');
  }
  private changed() {
    if (this.deps.current()) this.deps.changed();
  }
  private clearFrame() {
    this.frame = undefined;
    this.element = undefined;
  }
  invalidate(reason = '') {
    this.generation++;
    this.busy = false;
    this.active = false;
    this.options = undefined;
    this.clearFrame();
    this.error = reason;
    this.changed();
  }
  async load() {
    const generation = this.generation;
    try {
      const raw = await this.deps.read(projectPreviewKey(this.target));
      this.current(generation);
      if (raw !== undefined) {
        const saved = previewStoredSchema.parse(raw);
        if (
          projectPreviewKey(saved.target) !== projectPreviewKey(this.target) ||
          [saved.open, saved.pending, saved.receipt].some(
            (value) => value && !scopeMatches(value, this.target),
          ) ||
          (saved.pending && (!saved.open || saved.pending.clientId !== saved.open.clientId))
        )
          throw new Error('预览记录不属于当前执行范围。');
        this.revision = saved.cacheRevision;
        this.openRequest = saved.open;
        this.pending = saved.pending;
        this.receipt = saved.receipt;
        this.closing = saved.closing;
        this.uncertainClosed = saved.uncertainClosed;
      }
      this.loaded = true;
    } catch (cause) {
      if (this.deps.current()) this.loadError = '预览操作无法安全恢复，请重新打开原会话。';
      throw cause;
    } finally {
      this.changed();
    }
  }
  private save(
    values: Partial<
      Pick<
        z.infer<typeof previewStoredSchema>,
        'open' | 'pending' | 'receipt' | 'closing' | 'uncertainClosed'
      >
    >,
    generation: number,
  ) {
    const task = this.saves.then(async () => {
      this.current(generation);
      const value = previewStoredSchema.parse({
        version: 1,
        cacheRevision: this.revision + 1,
        target: this.target,
        open: this.openRequest,
        pending: this.pending,
        receipt: this.receipt,
        closing: this.closing,
        uncertainClosed: this.uncertainClosed,
        ...values,
      });
      try {
        const saved = await this.deps.compareWrite(
          projectPreviewKey(this.target),
          this.revision,
          value,
          () => this.deps.current() && generation === this.generation,
        );
        this.current(generation);
        if (!saved) throw new Error('预览记录已由其他页面更新。');
        this.revision = value.cacheRevision;
        this.openRequest = value.open;
        this.pending = value.pending;
        this.receipt = value.receipt;
        this.closing = value.closing;
        this.uncertainClosed = value.uncertainClosed;
      } catch (cause) {
        if (this.deps.current() && generation === this.generation)
          this.loadError = '预览操作尚未确认保存，请重新打开原会话；不会继续交互。';
        throw cause;
      }
    });
    this.saves = task.catch(() => {});
    return task;
  }
  private scope() {
    return {
      previewVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private endpoint(kind: string) {
    return `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/preview/${kind}`;
  }
  private uuid() {
    return this.deps.uuid?.() ?? crypto.randomUUID();
  }
  private async work<T>(fn: (generation: number) => Promise<T>) {
    this.access();
    if (!this.loaded || this.loadError || this.busy)
      throw new Error(this.loadError || '请等待当前预览操作。');
    this.busy = true;
    this.error = '';
    this.changed();
    const generation = this.generation;
    try {
      return await fn(generation);
    } catch (cause) {
      if (this.deps.current() && generation === this.generation) {
        this.clearFrame();
        this.error = cause instanceof Error ? cause.message : String(cause);
      }
      throw cause;
    } finally {
      if (generation === this.generation) this.busy = false;
      this.changed();
    }
  }
  private instance() {
    if (!this.openRequest || !this.previewId || this.closing) throw new Error('请先手动连接预览。');
    return { ...this.scope(), clientId: this.openRequest.clientId, previewId: this.previewId };
  }
  private async read(input: unknown, generation: number) {
    const request = previewReadSchema.parse(input),
      result = previewReadResultSchema.parse(
        await this.deps.request(this.endpoint('read'), request),
      );
    this.access(generation);
    if (
      result.view !== request.view ||
      !scopeMatches(result, this.target) ||
      ('previewId' in request &&
        (!('previewId' in result) ||
          result.previewId !== request.previewId ||
          result.clientId !== request.clientId))
    )
      throw new Error('预览读取结果与当前范围不匹配。');
    if (result.view === 'options') this.options = result;
    if (result.view === 'frame') {
      const frame = await verifyPreviewFrame(result.frame);
      this.access(generation);
      if (frame.previewId !== result.previewId) throw new Error('预览画面实例不匹配。');
      this.frame = frame;
      this.element = undefined;
      this.active = true;
    }
    if (result.view === 'status') {
      this.active = result.status === 'open';
      if (!this.active) {
        this.clearFrame();
        this.error = '预览已关闭或租约已结束，请关闭原连接记录后重新连接。';
      }
    }
    if (result.view === 'locate') {
      if (
        request.view !== 'locate' ||
        result.frameId !== request.frameId ||
        this.frame?.frameId !== request.frameId ||
        (result.element && result.element.frameId !== request.frameId)
      )
        throw new Error('所选画面已变化，请重新定位元素。');
      this.element = result.element ?? undefined;
    }
    return result;
  }
  refreshOptions() {
    return this.work((g) => this.read({ ...this.scope(), view: 'options' }, g));
  }
  capture() {
    return this.work((g) => this.read({ ...this.instance(), view: 'frame' }, g));
  }
  status() {
    return this.work((g) => this.read({ ...this.instance(), view: 'status' }, g));
  }
  locate(x: number, y: number) {
    return this.work((g) => {
      if (!this.frame || this.pending) throw new Error('请先读取可交互画面。');
      return this.read(
        { ...this.instance(), view: 'locate', frameId: this.frame.frameId, x, y },
        g,
      );
    });
  }
  open(serviceId: string, viewport: PreviewViewport) {
    return this.work(async (g) => {
      if (this.pending || this.openRequest || !this.options?.available)
        throw new Error('请先关闭原连接，并读取可用预览服务。');
      const service = this.options.services.find((item) => item.id === serviceId);
      if (!service) throw new Error('请选择本机明确登记的预览服务。');
      const request = previewOpenSchema.parse({
        ...this.scope(),
        action: 'open',
        confirmed: true,
        operationId: this.uuid(),
        clientId: this.uuid(),
        serviceId,
        serviceVersion: service.version,
        executionRevision: this.options.execution.revision,
        viewport,
      });
      await this.save(
        {
          open: request,
          pending: request,
          receipt: undefined,
          closing: false,
          uncertainClosed: false,
        },
        g,
      );
      return this.deliver(request, g);
    });
  }
  interact(input: PreviewInteraction) {
    const frame = this.frame,
      element = this.element;
    if (!this.canInteract || !frame)
      return Promise.reject(new Error('画面不可交互，请先核查原操作或重新截图。'));
    return this.work(async (g) => {
      if (
        (input.action === 'click' || input.action === 'input') &&
        (!element || element.frameId !== frame.frameId)
      )
        throw new Error('请先在当前画面中定位元素。');
      if (input.action === 'input' && (!element?.editable || element.password))
        throw new Error('此元素不支持安全文字输入。');
      const request = previewActionSchema.parse({
        ...this.instance(),
        ...input,
        frameId: frame.frameId,
        confirmed: true,
        operationId: this.uuid(),
        ...(['click', 'input'].includes(input.action) ? { elementId: element!.elementId } : {}),
      });
      await this.save({ pending: request }, g);
      this.clearFrame();
      return this.deliver(request, g);
    });
  }
  private async deliver(request: PreviewAction, generation: number) {
    try {
      return await this.finish(
        await this.deps.request(this.endpoint('action'), request),
        request,
        generation,
      );
    } catch (cause) {
      this.current(generation);
      if (cause instanceof ApiError && cause.rejected)
        await this.save(
          { pending: undefined, ...(request.action === 'open' ? { open: undefined } : {}) },
          generation,
        );
      throw cause;
    }
  }
  inspect() {
    return this.work(async (g) => {
      const request = this.pending;
      if (!request) throw new Error('没有待核查的原操作。');
      return this.finish(
        await this.deps.request(this.endpoint('inspect'), { request }),
        request,
        g,
      );
    });
  }
  private async finish(raw: unknown, request: PreviewAction, generation: number) {
    const result = previewReceiptSchema.parse(raw);
    this.access(generation);
    if (
      !scopeMatches(result, this.target) ||
      result.clientId !== request.clientId ||
      result.operationId !== request.operationId ||
      result.action !== request.action ||
      result.requestVersion !== (await previewRequestVersion(request)) ||
      ('previewId' in request &&
        result.previewId !== undefined &&
        result.previewId !== request.previewId)
    )
      throw new Error('主机回执与原预览操作不匹配，请保留原请求核查。');
    const frame = result.frame ? await verifyPreviewFrame(result.frame) : undefined;
    this.access(generation);
    if (
      frame &&
      (request.action === 'open' || request.action === 'resize') &&
      (frame.viewport.width !== request.viewport.width ||
        frame.viewport.height !== request.viewport.height)
    )
      throw new Error('主机画面与所选响应式视口不匹配。');
    // A receipt's frame is ephemeral; only its bounded, non-image confirmation is durable.
    await this.save(
      {
        receipt: { ...result, frame: undefined },
        ...(result.phase !== 'unknown' ? { pending: undefined } : {}),
        ...((result.closed && result.phase !== 'unknown') ||
        (request.action === 'open' && result.phase === 'rejected')
          ? { open: undefined, closing: false }
          : {}),
      },
      generation,
    );
    this.access(generation);
    this.active = !result.closed && result.phase === 'accepted';
    this.frame = this.active ? frame : undefined;
    this.element = undefined;
    this.error =
      result.phase === 'unknown'
        ? '页面操作结果未知。仅手动核查原操作，不会重新派发；也可以关闭连接。'
        : '';
    return result;
  }
  async close() {
    const request = this.openRequest;
    if (!request) return;
    this.generation++;
    const generation = this.generation;
    this.clearFrame();
    this.active = false;
    this.busy = false;
    this.closing = true;
    this.changed();
    await this.save(
      {
        closing: true,
        uncertainClosed: this.uncertainClosed || (!!this.pending && this.pending.action !== 'open'),
      },
      generation,
    );
    this.access(generation);
    try {
      const result = await this.finish(
        await this.deps.request(this.endpoint('close'), { request }),
        request,
        generation,
      );
      if (!result.closed) {
        this.closing = true;
        this.error = '连接关闭尚未得到主机确认，请手动重试关闭。';
      }
    } catch (cause) {
      if (this.deps.current() && generation === this.generation)
        this.error = '关闭连接尚未确认；不会继续交互，请手动重试关闭。';
      throw cause;
    } finally {
      this.changed();
    }
  }
  /** Best-effort disposal is allowed after navigation, but never reopens or replays an action. */
  dispose() {
    const request = this.openRequest;
    this.invalidate();
    if (request)
      return this.deps.request(this.endpoint('close'), { request }).catch(() => undefined);
    return Promise.resolve();
  }
  annotation(note: string, includeImage: boolean): PreviewAnnotationSnapshot {
    this.access();
    if (
      !this.frame ||
      !this.element ||
      this.element.frameId !== this.frame.frameId ||
      this.pending ||
      this.closing
    )
      throw new Error('请选择当前画面上的元素后保存标注。');
    const service = this.options?.services.find((item) => item.id === this.openRequest?.serviceId);
    if (!service || service.version !== this.openRequest?.serviceVersion)
      throw new Error('预览服务已变化，请重新连接。');
    const value = publicAnnotationSchema.parse({
      id: this.uuid(),
      version: this.frame.image.version,
      service,
      path: this.frame.path,
      title: this.frame.title,
      frameId: this.frame.frameId,
      documentId: this.frame.documentId,
      viewport: this.frame.viewport,
      element: this.element,
      note,
      capturedAt: this.frame.capturedAt,
      ...(includeImage ? { image: this.frame.image } : {}),
    });
    return previewAnnotationSnapshotSchema.parse({
      serviceId: value.service.id,
      serviceLabel: value.service.label,
      serviceVersion: value.service.version,
      pagePath: value.path,
      title: value.title,
      frameId: value.frameId,
      documentId: value.documentId,
      capturedAt: value.capturedAt,
      viewport: value.viewport,
      element: {
        elementId: value.element.elementId,
        tagName: value.element.tag,
        role: value.element.role,
        name: value.element.name,
        text: value.element.text,
        bounds: value.element.rect,
      },
      note: value.note,
      ...(value.image
        ? {
            image: {
              data: value.image.data,
              content: {
                version: value.image.version,
                mediaType: value.image.mediaType,
                byteLength: value.image.byteLength,
              },
            },
          }
        : {}),
    });
  }
}
