import { z } from 'zod';
import { secureTargetSchema, type SecureCliTarget } from '@moor/client/secure-operation';
import { productCanonicalJson } from '@moor/client/encrypted-product';
import {
  forkCutoffSchema,
  forkDirectorySchema,
  forkOptionsReadSchema,
  forkOptionsResultSchema,
  forkOperationSchema,
  validateForkOperationResult,
  sessionForkSchema,
  type ForkCutoff,
  type ForkDirectory,
  type ForkOptionsResult,
} from '@moor/protocol/fork-protocol';
import type { GitStateResult } from '@moor/protocol/git-protocol';
import { SessionForkController, sessionForkKey, validateForkReceipt } from './session-fork';
import {
  SecureScopedStorage,
  secureGitTarget,
  sameSecureRuntimeProject,
} from '../../platform/secure-scoped-storage';

const copy = structuredClone;
const same = (left: unknown, right: unknown) =>
  productCanonicalJson(left ?? null) === productCanonicalJson(right ?? null);
const alive = (current: () => void) => () => {
  try {
    current();
    return true;
  } catch {
    return false;
  }
};
export type SecureForkContext = {
  target: SecureCliTarget | null;
  generation: number;
  online: boolean;
};
export type SecureForkMethod = 'fork-options' | 'fork-action' | 'fork-operations';
export type SecureForkDependencies = {
  context(): SecureForkContext;
  storage: SecureScopedStorage;
  request(
    target: SecureCliTarget,
    method: SecureForkMethod,
    params: unknown,
    current: () => void,
  ): Promise<unknown>;
  beforeWrite(target: SecureCliTarget, current: () => void): Promise<void>;
  changed?(target: SecureCliTarget, current: () => void): Promise<void> | void;
  openChild(target: SecureCliTarget, childId: string, current: () => void): Promise<void>;
  openWorkspace(target: SecureCliTarget, childId: string, current: () => void): Promise<void>;
  uuid?(): string;
};
type Binding = SecureForkContext & { target: SecureCliTarget };
type RecordController = { target: SecureCliTarget; fork: SessionForkController; ending: boolean };
export type SecureForkPlan = {
  cutoff: ForkCutoff;
  directory: ForkDirectory;
  options: ForkOptionsResult;
};
export type SecureForkReview = {
  target: SecureCliTarget;
  generation: number;
  panel: number;
  material: string;
};
export type SecureForkRecovery = {
  id: string;
  target: SecureCliTarget;
  fork: SessionForkController;
  ending: boolean;
};
export type SecureForkState = {
  target: SecureCliTarget;
  online: boolean;
  sourceTitle: string;
  initialTurnId?: string;
  controller: SessionForkController;
  opening: boolean;
  working: boolean;
  ending: boolean;
  plan?: SecureForkPlan;
  review: SecureForkReview;
  recoveries: SecureForkRecovery[];
  error: string;
  notice: string;
};

function stored(raw: unknown) {
  const value = z
    .object({
      cacheRevision: z.number().int().nonnegative().safe(),
      ending: z.boolean().optional(),
    })
    .passthrough()
    .parse(raw);
  const { options: _options, ending: _ending, ...legacy } = value;
  return { value, legacy, ending: value.ending === true };
}
/** Legacy validation and receipt/resource accounting remain authoritative; read options never persist. */
function recordController(
  storage: SecureScopedStorage,
  input: SecureCliTarget,
  current: () => void,
  options?: Pick<SecureForkDependencies, 'request' | 'uuid'> & {
    changed(): void;
    online(): boolean;
    expectedOptions?(): ForkOptionsResult | undefined;
  },
) {
  const target = secureTargetSchema.parse(input),
    scoped = storage.forTarget(target, current);
  const record = { target, ending: false } as RecordController;
  record.fork = new SessionForkController(secureGitTarget(target), {
    current: alive(current),
    changed: options?.changed ?? (() => {}),
    uuid: options?.uuid,
    read: async (key) => {
      const raw = await scoped.read(key);
      current();
      if (raw === undefined) return undefined;
      const parsed = stored(raw);
      record.ending = parsed.ending;
      if (record.ending && !parsed.value.operation) throw Error('Fork 封存意图缺少原请求。');
      return parsed.legacy;
    },
    compareWrite: (key, revision, value, active) => {
      const { options: _options, ...persisted } = value as Record<string, unknown> & {
        cacheRevision: number;
      };
      const next = { ...persisted, ending: record.ending };
      return scoped.compareWrite(key, revision, next, active);
    },
    request: async (path, input) => {
      current();
      if (!options || !options.online()) throw Error('执行电脑离线，请连接后手动继续。');
      const root = `/api/workspaces/${target.product!.catalogWorkspaceId}/replicas/${target.product!.replicaId}/fork/`;
      const method =
        path === root + 'options'
          ? 'fork-options'
          : path === root + 'action'
            ? 'fork-action'
            : undefined;
      if (!method) throw Error('不支持的加密 Fork 操作。');
      if (method === 'fork-action' && record.ending)
        throw Error('原 Fork 已开始封存，请核查或继续封存。');
      const params =
        method === 'fork-options'
          ? forkOptionsReadSchema.parse(input)
          : sessionForkSchema.parse(input);
      const result = await options.request(copy(target), method, copy(params), current);
      current();
      if (method === 'fork-options') {
        const parsed = forkOptionsResultSchema.parse(result),
          expected = options.expectedOptions?.();
        if (expected && !same(expected, parsed))
          throw Error('已审阅的完整 Fork 选项已改变，请重新审阅。');
        return parsed;
      }
      return result;
    },
  });
  return record;
}
function data(record: RecordController) {
  const c = record.fork;
  return copy({
    target: c.target,
    options: c.options,
    operation: c.operation,
    receipt: c.receipt,
    resources: c.resources,
    cleanup: c.cleanup,
    loaded: c.loaded,
    source: c.source,
    loadError: c.loadError,
    error: c.error,
    busy: c.busy,
    ending: record.ending,
  });
}
function presentation(record: RecordController) {
  return Object.assign(
    Object.create(SessionForkController.prototype) as SessionForkController,
    data(record),
  );
}
async function projectRecords(
  storage: SecureScopedStorage,
  target: SecureCliTarget,
  current: () => void,
) {
  const records: RecordController[] = [];
  for (const row of await storage.listProject(target, current)) {
    if (row.key !== sessionForkKey(secureGitTarget(row.target))) continue;
    const record = recordController(storage, row.target, current);
    await record.fork.load();
    current();
    records.push(record);
  }
  return records;
}
function concerns(record: RecordController, sessionId: string) {
  return (
    record.target.sessionId === sessionId ||
    record.fork.operation?.request.childSessionId === sessionId ||
    record.fork.resources.some((entry) => entry.receipt.childSessionId === sessionId)
  );
}
export async function readSecureForkExecutionBlock(
  storage: SecureScopedStorage,
  target: SecureCliTarget,
  current: () => void,
): Promise<string | null> {
  for (const record of await projectRecords(storage, target, current))
    if (concerns(record, target.sessionId) && (record.fork.pending || record.ending))
      return `原会话 ${record.target.sessionId} 的 Fork 结果待确认，请先核查原请求或明确封存。`;
  current();
  return null;
}

export async function readSecureForkResource(
  storage: SecureScopedStorage,
  sourceTarget: SecureCliTarget,
  childId: string,
  current: () => void,
) {
  const record = recordController(storage, sourceTarget, current);
  await record.fork.load();
  current();
  const fork = record.fork;
  const entry =
    fork.receipt?.childSessionId === childId && fork.operation
      ? { operation: fork.operation, receipt: fork.receipt }
      : fork.resources.find((resource) => resource.receipt.childSessionId === childId);
  if (
    !entry ||
    entry.receipt.execution?.mode !== 'worktree' ||
    entry.receipt.execution.status === 'removed' ||
    (fork.receipt?.childSessionId === childId &&
      fork.cleanup?.executionId === entry.receipt.execution.executionId)
  )
    throw Error('主机尚未确认此 Fork 保留的工作目录。');
  validateForkReceipt(entry.receipt, entry.operation);
  const execution = entry.receipt.execution,
    request = entry.operation.request;
  if (
    request.directory.kind === 'worktree'
      ? execution.branch !== request.directory.newBranch ||
        execution.baseOid !== request.directory.expectedOid
      : !same(execution.executionId, entry.operation.sourceExecution.executionId)
  )
    throw Error('Fork 目录与原请求的执行范围不匹配。');
  return copy(entry);
}

export async function readSecureForkChild(
  storage: SecureScopedStorage,
  sourceTarget: SecureCliTarget,
  childId: string,
  current: () => void,
) {
  const record = recordController(storage, sourceTarget, current);
  await record.fork.load();
  current();
  const { operation, receipt } = record.fork;
  if (!operation || receipt?.phase !== 'accepted' || receipt.childSessionId !== childId)
    throw Error('此原 Fork 尚未确认所选子会话。');
  validateForkReceipt(receipt, operation);
  return copy({ operation, receipt });
}

export async function readSecureForkOperation(
  storage: SecureScopedStorage,
  sourceTarget: SecureCliTarget,
  childId: string,
  current: () => void,
) {
  const record = recordController(storage, sourceTarget, current);
  await record.fork.load();
  current();
  const { operation, receipt } = record.fork;
  if (!operation || operation.request.childSessionId !== childId)
    throw Error('原 Fork 请求不属于此子会话。');
  if (receipt) validateForkReceipt(receipt, operation);
  return copy(operation);
}

export class SecureForkController {
  #binding?: Binding;
  #record?: RecordController;
  #recoveries: RecordController[] = [];
  #panel = 0;
  #opening = false;
  #working = false;
  #plan?: SecureForkPlan;
  #expectedOptions?: ForkOptionsResult;
  #sourceTitle = '';
  #initialTurnId?: string;
  #error = '';
  #notice = '';
  #listeners = new Set<() => void>();
  constructor(private readonly options: SecureForkDependencies) {}
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  #bind(): Binding {
    const value = this.options.context();
    if (!value.target || !Number.isSafeInteger(value.generation) || value.generation < 0)
      throw Error('请先打开已确认的源会话。');
    const target = secureTargetSchema.parse(value.target);
    secureGitTarget(target);
    return { target, generation: value.generation, online: value.online === true };
  }
  #matches(binding: Binding) {
    try {
      return same(binding, this.#bind());
    } catch {
      return false;
    }
  }
  #current(binding: Binding, panel: number) {
    if (this.#binding !== binding || this.#panel !== panel || !this.#matches(binding))
      throw Error('Fork 面板或执行身份已改变，请重新打开。');
  }
  #material() {
    return productCanonicalJson({
      record: this.#record && data(this.#record),
      plan: this.#plan,
      recoveries: this.#recoveries.map((record) => ({ target: record.target, data: data(record) })),
    });
  }
  get state(): SecureForkState | null {
    const binding = this.#binding,
      record = this.#record;
    if (!binding || !record || !this.#matches(binding)) return null;
    return {
      target: copy(binding.target),
      online: binding.online,
      sourceTitle: this.#sourceTitle,
      initialTurnId: this.#initialTurnId,
      controller: presentation(record),
      opening: this.#opening,
      working: this.#working,
      ending: record.ending,
      plan: copy(this.#plan),
      recoveries: this.#recoveries.map((entry) => ({
        id: productCanonicalJson(entry.target),
        target: copy(entry.target),
        fork: presentation(entry),
        ending: entry.ending,
      })),
      review: {
        target: copy(binding.target),
        generation: binding.generation,
        panel: this.#panel,
        material: this.#material(),
      },
      error: this.#error,
      notice: this.#notice,
    };
  }
  close() {
    this.#panel++;
    this.#binding = undefined;
    this.#record = undefined;
    this.#recoveries = [];
    this.#plan = undefined;
    this.#expectedOptions = undefined;
    this.#opening = false;
    this.#working = false;
    this.#error = '';
    this.#notice = '';
    this.#emit();
  }
  sync() {
    if (this.#binding && !this.#matches(this.#binding)) this.close();
  }
  dispose() {
    this.close();
    this.#listeners.clear();
  }
  #newRecord(target: SecureCliTarget, current: () => void) {
    return recordController(this.options.storage, target, current, {
      request: (...args) => this.options.request(...args),
      uuid: () => this.options.uuid?.() ?? crypto.randomUUID(),
      online: () => this.#binding?.online === true,
      changed: () => {
        if (alive(current)()) this.#emit();
      },
      expectedOptions: () => this.#expectedOptions,
    });
  }
  async #loadRecoveries(binding: Binding, current: () => void) {
    const recoveries = (await projectRecords(this.options.storage, binding.target, current)).filter(
      (record) =>
        !same(record.target, binding.target) && concerns(record, binding.target.sessionId),
    );
    current();
    this.#recoveries = recoveries;
  }
  async open(input: SecureCliTarget, view: { sourceTitle: string; turnId?: string }) {
    const binding = this.#bind(),
      target = secureTargetSchema.parse(input);
    if (!same(target, binding.target)) throw Error('Fork 来源已改变。');
    this.close();
    this.#binding = binding;
    const panel = this.#panel,
      current = () => this.#current(binding, panel);
    this.#sourceTitle = z.string().max(200).parse(view.sourceTitle);
    this.#initialTurnId = view.turnId;
    this.#opening = true;
    this.#record = this.#newRecord(target, current);
    this.#emit();
    try {
      await this.#record.fork.load();
      current();
      await this.#loadRecoveries(binding, current);
      if (binding.online && !this.#record.fork.pending && !this.#record.ending)
        await this.#record.fork.refresh(view.turnId);
      current();
    } catch (error) {
      if (alive(current)())
        this.#error = error instanceof Error ? error.message : 'Fork 记录无法恢复。';
      throw error;
    } finally {
      if (alive(current)()) {
        this.#opening = false;
        this.#emit();
      }
    }
  }
  #review(review: SecureForkReview, online = true) {
    const binding = this.#binding;
    if (!binding) throw Error('请重新打开 Fork 面板。');
    this.#current(binding, review.panel);
    if (
      !same(review.target, binding.target) ||
      review.generation !== binding.generation ||
      review.material !== this.#material()
    )
      throw Error('已审阅的 Fork 方案或原记录已改变，请重新查看。');
    if (online && !binding.online) throw Error('执行电脑离线，请连接后手动继续。');
    if (this.#opening || this.#working) throw Error('请等待当前 Fork 操作完成。');
    return binding;
  }
  async #work<T>(
    review: SecureForkReview,
    work: (record: RecordController, current: () => void, binding: Binding) => Promise<T>,
    lock = false,
    online = true,
  ) {
    const binding = this.#review(review, online),
      panel = this.#panel,
      current = () => this.#current(binding, panel),
      record = this.#record!;
    this.#working = true;
    this.#error = '';
    this.#notice = '';
    this.#emit();
    try {
      const execute = () => work(record, current, binding);
      const result = await (lock
        ? this.options.storage.exclusive(binding.target, 'execution', current, execute)
        : execute());
      current();
      return result;
    } catch (error) {
      if (alive(current)())
        this.#error = error instanceof Error ? error.message : 'Fork 操作未确认。';
      throw error;
    } finally {
      if (alive(current)()) {
        this.#working = false;
        this.#expectedOptions = undefined;
        this.#emit();
      }
    }
  }
  refresh(review: SecureForkReview, turnId?: string) {
    return this.#work(review, async (record, current, binding) => {
      this.#plan = undefined;
      if (!record.fork.pending && !record.ending) await record.fork.refresh(turnId);
      await this.#loadRecoveries(binding, current);
    });
  }
  prepare(review: SecureForkReview, cutoff: ForkCutoff, directory: ForkDirectory) {
    const selected = {
      cutoff: forkCutoffSchema.parse(cutoff),
      directory: forkDirectorySchema.parse(directory),
    };
    return this.#work(review, async (record, current) => {
      if (record.fork.pending || record.ending) throw Error('请先核查原 Fork。');
      await record.fork.refresh(
        selected.cutoff.kind === 'turn' ? selected.cutoff.turnId : undefined,
      );
      current();
      this.#plan = copy({ ...selected, options: record.fork.options! });
    });
  }
  cancelPlan(review: SecureForkReview) {
    this.#review(review, false);
    this.#plan = undefined;
    this.#emit();
  }
  confirm(review: SecureForkReview) {
    const plan = copy(this.#plan);
    if (!plan) return Promise.reject(Error('请先审阅 Fork 方案。'));
    return this.#work(
      review,
      async (record, current, binding) => {
        await this.options.beforeWrite(copy(binding.target), current);
        current();
        if (!same(plan.options, record.fork.options)) throw Error('原 Fork 选项已改变。');
        this.#expectedOptions = plan.options;
        try {
          await record.fork.create(plan.cutoff, plan.directory);
        } finally {
          if (alive(current)()) {
            this.#plan = undefined;
            await this.options.changed?.(copy(binding.target), current);
          }
        }
      },
      true,
    );
  }
  retry(review: SecureForkReview) {
    return this.#work(
      review,
      async (record, current, binding) => {
        if (record.ending) throw Error('原 Fork 已开始封存，请核查或继续封存。');
        await record.fork.retry();
        current();
        await this.options.changed?.(copy(binding.target), current);
      },
      true,
    );
  }
  async #recoverRecord(
    record: RecordController,
    action: 'inspect' | 'abandon',
    current: () => void,
  ) {
    const key = sessionForkKey(secureGitTarget(record.target));
    let raw = stored(await this.options.storage.read(record.target, key, current));
    const fresh = recordController(this.options.storage, record.target, current);
    await fresh.fork.load();
    current();
    if (
      !same(fresh.fork.operation, record.fork.operation) ||
      !same(fresh.fork.receipt, record.fork.receipt) ||
      fresh.ending !== record.ending
    )
      throw Error('Fork 原记录已在另一页面改变，请重新打开。');
    const operation = fresh.fork.operation;
    if (!operation) throw Error('缺少完整原 Fork 请求。');
    const save = async (values: Record<string, unknown>) => {
      const next = {
        ...raw.legacy,
        ending: raw.ending,
        ...values,
        cacheRevision: raw.value.cacheRevision + 1,
      };
      if (
        !(await this.options.storage.compareWrite(
          record.target,
          key,
          raw.value.cacheRevision,
          next,
          current,
        ))
      )
        throw Error('Fork 原记录已在另一页面改变。');
      current();
      raw = stored(next);
    };
    if (action === 'abandon' && !raw.ending) await save({ ending: true });
    const request = forkOperationSchema.parse({ action, request: copy(operation.request) });
    const result = await this.options.request(
      copy(record.target),
      'fork-operations',
      request,
      current,
    );
    current();
    const checked = await validateForkOperationResult(result, request);
    current();
    if (checked.found) {
      const receipt = validateForkReceipt(checked.receipt, operation);
      await save({ receipt, ending: receipt.phase === 'unknown' && raw.ending });
    } else this.#notice = '主机尚无此原请求的结果；核查没有执行 Fork。';
  }
  recover(review: SecureForkReview, action: 'inspect' | 'abandon', recoveryId?: string) {
    return this.#work(
      review,
      async (record, current, binding) => {
        const original = recoveryId
          ? this.#recoveries.find((entry) => productCanonicalJson(entry.target) === recoveryId)
          : record;
        if (!original) throw Error('原 Fork 记录不存在。');
        try {
          await this.#recoverRecord(original, action, current);
        } finally {
          if (alive(current)()) {
            const loaded = this.#newRecord(binding.target, current);
            await loaded.fork.load();
            current();
            this.#record = loaded;
            await this.#loadRecoveries(binding, current);
            await this.options.changed?.(copy(binding.target), current);
          }
        }
      },
      true,
    );
  }
  openChild(review: SecureForkReview, recoveryId?: string) {
    return this.#work(review, async (record, current, binding) => {
      const original = recoveryId
        ? this.#recoveries.find((entry) => productCanonicalJson(entry.target) === recoveryId)
        : record;
      if (!original?.fork.operation || original.fork.receipt?.phase !== 'accepted')
        throw Error('副本尚未获得主机确认。');
      if (original.target.sessionId !== binding.target.sessionId)
        throw Error('请通过 Fork 来源返回源会话后打开副本。');
      const receipt = validateForkReceipt(original.fork.receipt, original.fork.operation);
      await this.options.openChild(copy(original.target), receipt.childSessionId, current);
    });
  }
  openWorkspace(review: SecureForkReview, childId: string, recoveryId?: string) {
    return this.#work(review, async (record, current, binding) => {
      const original = recoveryId
        ? this.#recoveries.find((entry) => productCanonicalJson(entry.target) === recoveryId)
        : record;
      if (!original) throw Error('原 Fork 记录不存在。');
      if (original.target.sessionId !== binding.target.sessionId)
        throw Error('请通过 Fork 来源返回源会话后管理目录。');
      const entry =
        original.fork.receipt?.childSessionId === childId
          ? { operation: original.fork.operation, receipt: original.fork.receipt }
          : original.fork.resources.find((item) => item.receipt.childSessionId === childId);
      if (!entry?.operation || entry.receipt.execution?.mode !== 'worktree')
        throw Error('主机尚未确认该 Fork 工作目录。');
      validateForkReceipt(entry.receipt, entry.operation);
      await this.options.openWorkspace(copy(original.target), childId, current);
    });
  }
  async confirmResourceCleanup(
    input: SecureCliTarget,
    childId: string,
    result: GitStateResult,
    reviewed: () => void,
  ) {
    const binding = this.#bind(),
      target = secureTargetSchema.parse(input);
    if (
      !sameSecureRuntimeProject(binding.target, target) ||
      ![target.sessionId, childId].includes(binding.target.sessionId)
    )
      throw Error('Fork 目录的来源已改变。');
    const current = () => {
      reviewed();
      if (!this.#matches(binding)) throw Error('Fork 清理确认的执行身份已改变。');
    };
    await this.options.storage.exclusive(target, 'execution', current, async () => {
      const record = recordController(this.options.storage, target, current);
      await record.fork.load();
      current();
      await record.fork.confirmResourceCleanup(childId, result);
      current();
      await this.options.changed?.(copy(binding.target), current);
    });
    if (this.#binding && this.#matches(this.#binding)) this.close();
  }
}
