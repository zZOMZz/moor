import { z } from 'zod';
import { ApiError } from './api';
import {
  gitTargetSchema,
  gitWorkspaceKey,
  type GitTarget,
  type GitWorkspaceDependencies,
} from './git-workspace';
import {
  roleActionSchema,
  validateRolesRead,
  validateRoleReceipt,
  validateRolesInspect,
  type RoleAction,
  type RoleReceipt,
  type RolesReadResult,
  type RoleView,
} from '../role-protocol';
import { resolveRunSelection, type RunCapabilities, type RunSelection } from '../run-config';

export type RoleEdit = {
  id?: string;
  name: string;
  agentId: string;
  selection: RunSelection;
  instructions: string;
};
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    pending: roleActionSchema.optional(),
    ending: z.literal(true).optional(),
  })
  .strict();
export const rolesKey = (target: GitTarget) =>
  gitWorkspaceKey(target).replace('git-workspace-v1/', 'roles-outbox-v1/');
export const roleAppliedKey = (target: GitTarget) =>
  gitWorkspaceKey(target).replace('git-workspace-v1/', 'role-applied-v1/');
export const roleAppliedSchema = z
  .object({
    version: z.literal(1),
    target: gitTargetSchema,
    base: z.string().max(160),
    applied: z
      .array(
        z
          .object({
            roleId: z.string().min(1).max(160),
            revision: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type RoleApplied = z.infer<typeof roleAppliedSchema>;
export function roleSelection(
  role: RoleView,
  current: RunSelection,
  capabilities?: RunCapabilities,
) {
  if (!role.available) throw new Error(role.unavailableReason || '角色 Agent 当前不可用。');
  const selection = {
    ...current,
    ...Object.fromEntries(Object.entries(role.selection).filter(([, value]) => !!value)),
  };
  resolveRunSelection(selection, capabilities);
  return selection;
}
export function roleInstruction(role: RoleView) {
  return role.instructions
    ? `[角色预设：${role.name} · 版本 ${role.revision}]\n${role.instructions}\n[/角色预设]`
    : '';
}
/** Shared role contents are read-only until a manual, durable operation is staged. */
export class RolesController {
  readonly target: GitTarget;
  list?: RolesReadResult;
  pending?: RoleAction;
  receipt?: RoleReceipt;
  ending = false;
  loaded = false;
  busy = false;
  error = '';
  loadError = '';
  private cacheRevision = 0;
  private generation = 0;
  private contentGeneration = 0;
  constructor(
    target: GitTarget,
    private deps: GitWorkspaceDependencies & { online(): boolean },
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  private current(generation = this.generation) {
    if (!this.deps.current() || generation !== this.generation)
      throw new Error('角色面板或执行目标已改变，请重新打开。');
  }
  private access(generation = this.generation) {
    this.current(generation);
    if (!this.deps.online()) throw new Error('当前离线，请连接执行电脑后手动读取角色。');
  }
  private base() {
    return {
      rolesVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private endpoint(kind: string) {
    return `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/roles/${kind}`;
  }
  catalogChanged() {
    this.contentGeneration++;
    this.list = undefined;
    this.error = '项目角色目录已更新，请手动重新读取；未保存的编辑仍保留。';
    this.deps.changed();
  }
  invalidate(reason = '') {
    this.generation++;
    this.list = undefined;
    this.busy = false;
    this.error = reason;
    this.deps.changed();
  }
  async load() {
    try {
      const raw = await this.deps.read(rolesKey(this.target));
      this.current();
      if (raw !== undefined) {
        const saved = storedSchema.parse(raw);
        if (rolesKey(saved.target) !== rolesKey(this.target))
          throw new Error('角色操作记录的执行范围不匹配。');
        if (
          saved.pending &&
          (saved.pending.workspaceId !== this.target.workspaceId ||
            saved.pending.localProjectId !== this.target.localProjectId ||
            saved.pending.sessionId !== this.target.sessionId)
        )
          throw new Error('角色操作记录的执行范围不匹配。');
        this.cacheRevision = saved.cacheRevision;
        this.pending = saved.pending;
        if (saved.ending && !saved.pending) throw new Error('角色结束记录缺少原请求。');
        this.ending = saved.ending === true;
      }
      this.loaded = true;
    } catch (error) {
      this.loadError = '角色操作记录无法恢复，请重新打开原会话。';
      throw error;
    } finally {
      if (this.deps.current()) this.deps.changed();
    }
  }
  private async save(pending: RoleAction | undefined, generation: number, ending = false) {
    this.current(generation);
    const value = storedSchema.parse({
      version: 1,
      cacheRevision: this.cacheRevision + 1,
      target: this.target,
      pending,
      ...(pending && ending ? { ending: true } : {}),
    });
    try {
      const saved = await this.deps.compareWrite(
        rolesKey(this.target),
        this.cacheRevision,
        value,
        () => this.deps.current() && generation === this.generation,
      );
      this.current(generation);
      if (!saved) throw new Error('角色操作记录已由其他页面改变。');
      this.cacheRevision = value.cacheRevision;
      this.pending = pending;
      this.ending = !!pending && ending;
    } catch (error) {
      this.loadError = '角色操作记录未确认保存，请重新打开原会话。';
      throw error;
    }
  }
  private async work<T>(fn: (generation: number) => Promise<T>) {
    this.access();
    if (!this.loaded || this.loadError || this.busy)
      throw new Error(this.loadError || '请等待角色操作恢复或完成。');
    const generation = this.generation;
    this.busy = true;
    this.error = '';
    this.deps.changed();
    try {
      return await fn(generation);
    } catch (error) {
      if (generation === this.generation && this.deps.current())
        this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (generation === this.generation && this.deps.current()) {
        this.busy = false;
        this.deps.changed();
      }
    }
  }
  private async read(generation: number) {
    const request = this.base(),
      contentGeneration = this.contentGeneration;
    const raw = await this.deps.request(this.endpoint('read'), request);
    this.access(generation);
    if (contentGeneration !== this.contentGeneration)
      throw new Error('角色目录在读取期间已变化，请重新读取。');
    return validateRolesRead(raw, request);
  }
  refresh() {
    return this.work(async (generation) => {
      this.list = undefined;
      this.list = await this.read(generation);
    });
  }
  async freshRole(role: RoleView) {
    return this.work(async (generation) => {
      const list = await this.read(generation),
        fresh = list.roles.find((value) => value.id === role.id);
      this.list = list;
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(role))
        throw new Error('角色版本或可用状态已改变，请重新查看后应用。');
      return fresh;
    });
  }
  private async finish(raw: unknown, request: RoleAction, generation: number) {
    this.current(generation);
    const receipt = validateRoleReceipt(raw, request);
    await this.save(undefined, generation);
    this.receipt = receipt;
    this.list = undefined;
    this.error = receipt.accepted
      ? '操作已由主机确认；请重新读取角色列表。'
      : '主机已封存未执行的原请求，不会再保存或删除角色。';
    return receipt;
  }
  private async deliver(request: RoleAction, generation: number, first: boolean) {
    this.access(generation);
    let raw: unknown;
    try {
      raw = await this.deps.request(this.endpoint('action'), request);
    } catch (error) {
      this.current(generation);
      if (first && error instanceof ApiError && error.rejected)
        await this.save(undefined, generation);
      throw error;
    }
    this.access(generation);
    return this.finish(raw, request, generation);
  }
  saveRole(edit: RoleEdit) {
    return this.stage({ action: 'save', ...edit });
  }
  remove(id: string) {
    return this.stage({ action: 'remove', id });
  }
  private stage(input: Record<string, unknown>) {
    return this.work(async (generation) => {
      if (this.pending || !this.list) throw new Error('请先确认原操作并读取角色列表。');
      const request = roleActionSchema.parse({
        ...this.base(),
        operationId: (this.deps.uuid ?? (() => crypto.randomUUID()))(),
        expectedRevision: this.list.catalogRevision,
        ...input,
      });
      await this.save(request, generation);
      return this.deliver(request, generation, true);
    });
  }
  retry() {
    return this.work(async (generation) => {
      if (!this.pending) throw new Error('没有待确认角色操作。');
      return this.ending
        ? this.deliverAbandon(this.pending, generation)
        : this.deliver(this.pending, generation, false);
    });
  }
  private async deliverAbandon(request: RoleAction, generation: number) {
    this.access(generation);
    const raw = await this.deps.request(this.endpoint('action'), { action: 'abandon', request });
    this.access(generation);
    return this.finish(raw, request, generation);
  }
  abandon() {
    return this.work(async (generation) => {
      const request = this.pending;
      if (!request) throw new Error('没有待确认角色操作。');
      await this.save(request, generation, true);
      return this.deliverAbandon(request, generation);
    });
  }
  inspect() {
    return this.work(async (generation) => {
      const request = this.pending;
      if (!request) throw new Error('没有待确认角色操作。');
      const raw = await this.deps.request(this.endpoint('action'), { action: 'inspect', request });
      this.access(generation);
      const result = validateRolesInspect(raw, request);
      if (result.found) return this.finish(result.receipt, request, generation);
      this.error = '主机目前未找到原回执；这不代表操作已取消。可手动重试原保存请求。';
    });
  }
}
