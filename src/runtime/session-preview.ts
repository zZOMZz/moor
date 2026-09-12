import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, assert } from '../protocol';
import type { ContentScope } from '../content-protocol';
import {
  PREVIEW_LIMITS,
  previewActionSchema,
  previewCloseSchema,
  previewElementSchema,
  previewInspectSchema,
  previewReadSchema,
  previewReadResultSchema,
  previewReceiptSchema,
  type PreviewAction,
  type PreviewFrame,
  type PreviewOpen,
  type PreviewRead,
  type PreviewReadResult,
  type PreviewReceipt,
} from '../preview-protocol';
import type { AttachmentScope, RuntimeStore } from './store';
import type { ExecutionLease } from './session-execution';
import type { PreviewDriver } from './preview-driver';
import type { PreviewConfig, PreviewServiceBinding } from './preview-config';
import { validatePreviewFrame } from '../preview-validation';

type Service = PreviewServiceBinding;
type Host = {
  store: RuntimeStore;
  ensureConnected(): void;
  executionLease(scope: ContentScope, project?: string, allowNew?: boolean): ExecutionLease;
  projectRootLease(scope: ContentScope, project?: string): AttachmentScope & { rootPath: string };
};
export type SessionPreviewOptions = {
  config?: Pick<PreviewConfig, 'getServices' | 'getService' | 'isCurrent'>;
  driver?: PreviewDriver;
  now?: () => number;
  schedule?: (ms: number, work: () => void) => () => void;
};
type Instance = {
  id: string;
  request: PreviewOpen;
  lease: ExecutionLease;
  service: Service;
  expiresAt: number;
  cancelTimer: () => void;
  frame?: PreviewFrame;
  queue: Promise<unknown>;
  queued: number;
};
type Record = { phase: string; result: string | null; approval: string | null };
const hash = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const scopeKey = (scope: AttachmentScope) =>
  JSON.stringify([
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
  ]);
const envelope = (scope: ContentScope) => ({
  previewVersion: 1 as const,
  workspaceId: scope.workspaceId,
  localProjectId: scope.localProjectId,
  sessionId: scope.sessionId,
});
const unavailable: PreviewDriver = {
  async available() {
    return { available: false, reason: '执行电脑未安装可用的网页预览运行环境' };
  },
  async open() {
    throw new AppError(409, '网页预览不可用');
  },
  async capture() {
    throw new AppError(409, '网页预览不可用');
  },
  async locate() {
    throw new AppError(409, '网页预览不可用');
  },
  async interact() {
    throw new AppError(409, '网页预览不可用');
  },
  async close() {},
  async closeAll() {},
};

/** Host-owned ephemeral browser instances; durable receipts contain no page or input text. */
export class SessionPreviewManager {
  private instances = new Map<string, Instance>();
  private driver: PreviewDriver;
  constructor(
    private host: Host,
    private options: SessionPreviewOptions = {},
  ) {
    this.driver = options.driver ?? unavailable;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private schedule(ms: number, work: () => void) {
    if (this.options.schedule) return this.options.schedule(ms, work);
    const timer = setTimeout(work, ms);
    timer.unref();
    return () => clearTimeout(timer);
  }
  private scope(input: ContentScope, project?: string) {
    this.host.ensureConnected();
    const { rootPath: _, ...scope } = this.host.projectRootLease(input, project);
    return scope;
  }
  private lookup(scope: AttachmentScope, request: PreviewAction) {
    const record = this.host.store.journal.lookup(scopeKey(scope), request) as Record | undefined;
    if (record) assert(record.phase.startsWith('preview-'), 409, '原操作编号已用于其他操作');
    return record;
  }
  private receipt(
    request: PreviewAction,
    phase: PreviewReceipt['phase'],
    message: string,
    previewId?: string,
    frame?: PreviewFrame,
  ) {
    return previewReceiptSchema.parse({
      ...envelope(request),
      clientId: request.clientId,
      operationId: request.operationId,
      requestVersion: hash(JSON.stringify(request)),
      action: request.action,
      phase,
      message,
      closed: !previewId || !this.instances.has(previewId),
      previewId,
      checkedAt: new Date(this.now()).toISOString(),
      ...(frame ? { frame } : {}),
    });
  }
  private prior(request: PreviewAction, record: Record) {
    const id = record.approval ? (JSON.parse(record.approval).previewId as string) : undefined;
    const result = record.result
      ? previewReceiptSchema.parse(JSON.parse(record.result))
      : this.receipt(request, 'unknown', '原操作已登记；只能查询确认，不能重复执行', id);
    return previewReceiptSchema.parse({
      ...result,
      closed: !id || !this.instances.has(id),
      checkedAt: new Date(this.now()).toISOString(),
    });
  }
  private stage(scope: AttachmentScope, request: PreviewAction, previewId: string) {
    this.host.store.transaction(() => {
      assert(!this.lookup(scope, request), 409, '原操作已登记');
      this.host.store.reserveAttachmentScope(scope);
      this.host.store.journal.db
        .prepare(
          'INSERT INTO operation(id,fingerprint,phase,turn_id,result,approval) VALUES(?,?,?,NULL,NULL,?)',
        )
        .run(
          request.operationId,
          this.host.store.journal.fingerprint(scopeKey(scope), request),
          'preview-prepared',
          JSON.stringify({ previewId }),
        );
    });
  }
  private settle(scope: AttachmentScope, request: PreviewAction, result: PreviewReceipt) {
    const record = this.lookup(scope, request);
    assert(record, 409, '预览原操作记录不可用');
    if (record.phase === 'preview-closed') return this.prior(request, record);
    const { frame: _, ...stored } = result;
    this.host.store.journal.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
      .run('preview-' + result.phase, JSON.stringify(stored), request.operationId);
    return result;
  }
  private current(instance: Instance) {
    assert(
      this.instances.get(instance.id) === instance && this.now() < instance.expiresAt,
      409,
      '预览连接已关闭或到期，请手动连接',
    );
    try {
      this.host.ensureConnected();
      const lease = this.host.executionLease(instance.request, undefined, true);
      assert(isDeepStrictEqual(lease, instance.lease), 409, '预览会话执行目录已变化');
      assert(this.options.config?.isCurrent(instance.service, lease), 409, '预览服务登记已变化');
    } catch (error) {
      void this.destroy(instance);
      throw error;
    }
  }
  private touch(instance: Instance) {
    this.current(instance);
    instance.cancelTimer();
    instance.expiresAt = this.now() + PREVIEW_LIMITS.idleMs;
    instance.cancelTimer = this.schedule(PREVIEW_LIMITS.idleMs, () => {
      void this.destroy(instance);
    });
  }
  private async destroy(instance: Instance) {
    if (this.instances.get(instance.id) !== instance) return;
    this.instances.delete(instance.id);
    instance.cancelTimer();
    instance.frame = undefined;
    await this.driver.close(instance.id).catch(() => {});
  }
  /** Invalidates synchronously before asynchronous renderer teardown. */
  invalidate() {
    for (const instance of this.instances.values()) void this.destroy(instance);
  }
  async closeAll() {
    this.invalidate();
    await this.driver.closeAll();
  }
  private instance(input: ContentScope & { clientId: string; previewId: string }) {
    const instance = this.instances.get(input.previewId);
    assert(
      instance &&
        instance.request.clientId === input.clientId &&
        isDeepStrictEqual(envelope(instance.request), envelope(input)),
      409,
      '此预览连接已关闭或不属于当前会话',
    );
    this.current(instance);
    return instance;
  }
  private frame(instance: Instance, value: unknown) {
    this.current(instance);
    const frame = validatePreviewFrame(value);
    assert(frame.previewId === instance.id, 502, '预览画面不属于当前连接');
    instance.frame = frame;
    this.touch(instance);
    return frame;
  }
  private async serial<T>(instance: Instance, work: () => Promise<T>): Promise<T> {
    assert(instance.queued < 4, 429, '请等待当前预览请求完成');
    instance.queued++;
    const next = instance.queue
      .catch(() => {})
      .then(async () => {
        this.touch(instance);
        let cancel = () => {};
        const timeout = new Promise<never>((_, reject) => {
          cancel = this.schedule(PREVIEW_LIMITS.operationMs, () => {
            void this.destroy(instance);
            reject(new AppError(504, '预览请求超时，连接已关闭；不会重复执行'));
          });
        });
        try {
          return await Promise.race([work(), timeout]);
        } finally {
          cancel();
        }
      });
    instance.queue = next;
    try {
      return await next;
    } finally {
      instance.queued--;
    }
  }
  async read(input: PreviewRead, project?: string): Promise<PreviewReadResult> {
    const request = previewReadSchema.parse(input),
      scope = this.scope(request, project);
    const base = { ...envelope(scope), confirmed: true as const, view: request.view };
    if (request.view === 'options') {
      const lease = this.host.executionLease(request, project, true);
      const available = await this.driver.available();
      assert(
        isDeepStrictEqual(this.host.executionLease(request, project, true), lease),
        409,
        '预览会话执行目录已变化',
      );
      this.host.ensureConnected();
      return previewReadResultSchema.parse({
        ...base,
        ...available,
        execution: this.host.store.executions.info(scope),
        services: this.options.config?.getServices(lease) ?? [],
      });
    }
    if (request.view === 'status' && !this.instances.has(request.previewId))
      return previewReadResultSchema.parse({
        ...base,
        clientId: request.clientId,
        previewId: request.previewId,
        status: 'closed',
      });
    const instance = this.instance(request);
    const result = await this.serial(instance, async () => {
      const check = { assertCurrent: () => this.current(instance) };
      if (request.view === 'status')
        return { ...base, status: 'open', expiresAt: instance.expiresAt };
      if (request.view === 'frame')
        return {
          ...base,
          frame: this.frame(instance, await this.driver.capture(instance.id, check)),
          expiresAt: instance.expiresAt,
        };
      assert(
        instance.frame?.frameId === request.frameId &&
          request.x < instance.frame.viewport.width &&
          request.y < instance.frame.viewport.height,
        409,
        '画面已变化，请刷新后重新选择元素',
      );
      const raw = await this.driver.locate(
        instance.id,
        request.frameId,
        { x: request.x, y: request.y },
        check,
      );
      this.current(instance);
      const element = raw === null ? null : previewElementSchema.parse(raw);
      assert(!element || element.frameId === request.frameId, 502, '元素不属于当前画面');
      return { ...base, frameId: request.frameId, element };
    });
    this.current(instance);
    return previewReadResultSchema.parse({
      ...result,
      clientId: request.clientId,
      previewId: instance.id,
    });
  }
  async action(input: PreviewAction, project?: string): Promise<PreviewReceipt> {
    const request = previewActionSchema.parse(input),
      scope = this.scope(request, project);
    const previous = this.lookup(scope, request);
    if (previous) return this.prior(request, previous);
    const previewId = request.action === 'open' ? randomUUID() : request.previewId;
    this.stage(scope, request, previewId);
    let instance: Instance | undefined,
      dispatched = false;
    try {
      if (request.action === 'open') {
        const lease = this.host.executionLease(request, project, true);
        assert(lease.executionRevision === request.executionRevision, 409, '执行目录版本已变化');
        const service = this.options.config?.getService(lease, request.serviceId);
        assert(
          service && service.version === request.serviceVersion,
          409,
          '预览服务版本已变化，请重新读取',
        );
        assert(this.instances.size < PREVIEW_LIMITS.instances, 429, '请先关闭其他预览连接');
        instance = {
          id: previewId,
          request,
          lease,
          service,
          expiresAt: this.now() + PREVIEW_LIMITS.idleMs,
          cancelTimer() {},
          queue: Promise.resolve(),
          queued: 0,
        };
        this.instances.set(previewId, instance);
      } else instance = this.instance(request);
      const active = instance;
      const frame = await this.serial(active, async () => {
        const check = {
          assertCurrent: () => this.current(active),
          beforeDispatch: () => {
            this.current(active);
            assert(
              this.lookup(scope, request)?.phase === 'preview-prepared',
              409,
              '原预览操作已结束',
            );
            this.host.store.journal.db
              .prepare('UPDATE operation SET phase=? WHERE id=?')
              .run('preview-dispatched', request.operationId);
            dispatched = true;
          },
        };
        if (request.action !== 'open')
          assert(active.frame?.frameId === request.frameId, 409, '画面已变化，请重新读取后操作');
        const value =
          request.action === 'open'
            ? await this.driver.open(
                {
                  previewId,
                  origin: active.service.origin,
                  startPath: active.service.startPath,
                  viewport: request.viewport,
                },
                check,
              )
            : await this.driver.interact(request, check);
        assert(dispatched, 502, '预览运行环境未确认操作派发');
        return this.frame(active, value);
      });
      this.current(active);
      return this.settle(
        scope,
        request,
        this.receipt(request, 'accepted', '执行电脑已确认预览操作', previewId, frame),
      );
    } catch (error) {
      // A timed-out/disconnected renderer can finish late; removing it makes every checkpoint fail.
      if (instance && (request.action === 'open' || dispatched)) await this.destroy(instance);
      return this.settle(
        scope,
        request,
        this.receipt(
          request,
          dispatched ? 'unknown' : 'rejected',
          dispatched
            ? '原操作已派发但结果未确认；连接已关闭，不会重复执行'
            : error instanceof AppError
              ? error.message
              : '预览操作未派发，请检查执行电脑',
          previewId,
        ),
      );
    }
  }
  async inspect(input: { request: PreviewAction }, project?: string) {
    const { request } = previewInspectSchema.parse(input),
      scope = this.scope(request, project);
    const record = this.lookup(scope, request);
    return record
      ? this.prior(request, record)
      : this.receipt(request, 'unknown', '主机尚未登记此操作；不会代为执行。连接操作可手动关闭');
  }
  async close(input: { request: PreviewOpen }, project?: string) {
    const { request } = previewCloseSchema.parse(input),
      scope = this.scope(request, project);
    let record = this.lookup(scope, request);
    if (!record) {
      this.stage(scope, request, randomUUID());
      record = this.lookup(scope, request)!;
    }
    const previewId = JSON.parse(record.approval!).previewId as string;
    const instance = this.instances.get(previewId);
    // Persist cancellation before awaiting teardown, even if open has not reached the renderer yet.
    if (instance) {
      this.instances.delete(previewId);
      instance.cancelTimer();
      instance.frame = undefined;
    }
    const result = this.receipt(
      request,
      'closed',
      '预览连接已关闭，原连接请求不会再次打开',
      previewId,
    );
    try {
      this.host.store.journal.db
        .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
        .run('preview-closed', JSON.stringify(result), request.operationId);
    } finally {
      // Persistence failure must still tear down a renderer whose lease was invalidated above.
      await this.driver.close(previewId).catch(() => {});
    }
    this.scope(request, project);
    return result;
  }
}
