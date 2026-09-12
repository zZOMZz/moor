import { z } from 'zod';
import { id, mutationSchema, type Mutation } from '../protocol';
import {
  MCP_LIMITS,
  mcpServerIdsSchema,
  mcpServerViewSchema,
  validateMcpRead,
  type McpReadResult,
  type McpServerView,
} from '../mcp-protocol';
import { gitTargetSchema, type GitTarget, type GitWorkspaceDependencies } from './git-workspace';
import type { DraftBundleEntry } from './cache';

const reviewSchema = z
  .object({ reviewId: id, servers: z.array(mcpServerViewSchema).max(MCP_LIMITS.selected) })
  .strict();
export type McpReview = z.infer<typeof reviewSchema>;
const deliverySchema = z
  .object({
    operationId: id,
    review: reviewSchema,
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    review: reviewSchema.optional(),
    delivery: deliverySchema.optional(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;
export const mcpKey = (target: GitTarget) =>
  'mcp-draft-v1/' +
  JSON.stringify([
    target.owner,
    target.deviceId,
    target.userId,
    target.machineId,
    target.workspaceId,
    target.catalogWorkspaceId,
    target.replicaId,
    target.localProjectId,
    target.sessionId,
  ]);
const sameServer = (a: McpServerView, b: McpServerView) =>
  a.id === b.id &&
  a.name === b.name &&
  a.description === b.description &&
  a.transport === b.transport;
async function mutationVersion(mutation: Mutation) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(mutationSchema.parse(mutation))),
  );
  return (
    'sha256:' +
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
export type McpDependencies = GitWorkspaceDependencies & {
  online(): boolean;
  compareSubmission(entries: readonly DraftBundleEntry[], current: () => boolean): Promise<boolean>;
};
/** Only metadata is read here. Server connections belong to an explicitly submitted host turn. */
export class McpController {
  readonly target: GitTarget;
  list?: McpReadResult;
  review?: McpReview;
  delivery?: z.infer<typeof deliverySchema>;
  loaded = false;
  busy = false;
  error = '';
  loadError = '';
  private saved?: Stored;
  private revision = 0;
  private generation = 0;
  private catalogGeneration = 0;
  constructor(
    target: GitTarget,
    private deps: McpDependencies,
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  private current(generation = this.generation) {
    if (generation !== this.generation || !this.deps.current())
      throw new Error('MCP 草稿或执行目标已改变，请重新打开原会话。');
  }
  private access(generation = this.generation) {
    this.current(generation);
    if (!this.deps.online())
      throw new Error('当前离线或此电脑不支持额外 MCP；草稿保留，连接后请手动操作。');
  }
  get selected() {
    return this.review?.servers ?? [];
  }
  unavailable(server: McpServerView) {
    return !this.list?.servers.some((item) => sameServer(item, server));
  }
  invalidate(reason = 'MCP 目录已变化，请手动重新读取；原版本选择仍保留。') {
    this.catalogGeneration++;
    this.list = undefined;
    this.error = reason;
    this.deps.changed();
  }
  dispose() {
    this.generation++;
    this.catalogGeneration++;
    this.list = undefined;
  }
  async load() {
    try {
      const raw = await this.deps.read(mcpKey(this.target));
      this.current();
      if (raw !== undefined) {
        const saved = storedSchema.parse(raw);
        if (mcpKey(saved.target) !== mcpKey(this.target)) throw new Error('MCP 草稿范围不匹配。');
        for (const review of [saved.review, saved.delivery?.review])
          if (review) mcpServerIdsSchema.parse(review.servers.map((server) => server.id));
        this.saved = saved;
        this.revision = saved.cacheRevision;
        this.review = saved.review;
        this.delivery = saved.delivery;
      }
      this.loaded = true;
    } catch (error) {
      this.loadError = 'MCP 草稿无法恢复，请重新打开原会话后核对。';
      throw error;
    } finally {
      if (this.deps.current()) this.deps.changed();
    }
  }
  private record(extra: Partial<Stored>): Stored {
    return storedSchema.parse({
      version: 1,
      cacheRevision: this.revision + 1,
      target: this.target,
      review: this.review,
      delivery: this.delivery,
      ...extra,
    });
  }
  private remember(value: Stored) {
    this.saved = value;
    this.revision = value.cacheRevision;
    this.review = value.review;
    this.delivery = value.delivery;
  }
  private async work<T>(fn: (generation: number) => Promise<T>) {
    this.current();
    if (!this.loaded || this.loadError || this.busy)
      throw new Error(this.loadError || '请等待 MCP 草稿恢复或保存。');
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
  private async persist(value: Stored, generation: number) {
    try {
      const written = await this.deps.compareWrite(
        mcpKey(this.target),
        this.revision,
        value,
        () => generation === this.generation && this.deps.current(),
      );
      this.current(generation);
      if (!written) throw new Error('另一页面已修改 MCP 草稿。');
      this.remember(value);
    } catch (error) {
      this.loadError = 'MCP 草稿保存未确认，请重新打开原会话。';
      throw error;
    }
  }
  private async read(generation: number) {
    this.access(generation);
    const catalogGeneration = this.catalogGeneration;
    const request = {
      mcpVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
    const value = validateMcpRead(
      await this.deps.request(
        `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/mcp/read`,
        request,
      ),
      request,
    );
    this.access(generation);
    if (catalogGeneration !== this.catalogGeneration)
      throw new Error('读取期间 MCP 目录已改变，请手动重新读取。');
    this.list = value;
    return value;
  }
  refresh() {
    return this.work(async (generation) => {
      this.list = undefined;
      await this.read(generation);
    });
  }
  apply(servers: readonly McpServerView[]) {
    return this.work(async (generation) => {
      const selected = z.array(mcpServerViewSchema).max(MCP_LIMITS.selected).parse(servers);
      mcpServerIdsSchema.parse(selected.map((server) => server.id));
      for (const server of selected) {
        if (!this.selected.some((old) => sameServer(old, server)) && this.unavailable(server))
          throw new Error('请选择当前已读取目录中的原版本。');
      }
      const review = reviewSchema.parse({
        reviewId: (this.deps.uuid ?? (() => crypto.randomUUID()))(),
        servers: selected,
      });
      await this.persist(this.record({ review }), generation);
    });
  }
  /** A fresh check may reject an old version, but never substitutes a newer one. */
  prepareSend() {
    return this.work(async (generation) => {
      if (this.delivery) throw new Error('请先确认原指令，不可替换 MCP 授权。');
      const review = this.review;
      if (!review?.servers.length) return undefined;
      await this.read(generation);
      if (review !== this.review || review.servers.some((server) => this.unavailable(server)))
        throw new Error('所选 MCP 版本已不可用或已改变，请审查并手动更改草稿。');
      return structuredClone(review);
    });
  }
  assertReview(review?: McpReview) {
    this.current();
    if (review?.reviewId !== (this.selected.length ? this.review?.reviewId : undefined))
      throw new Error('MCP 草稿已改变，请重新发送。');
    if (review?.servers.some((server) => this.unavailable(server)))
      throw new Error('MCP 目录已改变，请重新核对原版本。');
  }
  async stageSubmission(
    mutation: Mutation,
    review: McpReview,
    pendingKey: string,
    pendingValue: unknown,
    combine?: (entry: DraftBundleEntry, current: () => boolean) => Promise<unknown>,
  ) {
    return this.work(async (generation) => {
      this.access(generation);
      this.assertReview(review);
      if (
        this.delivery ||
        mutation.kind !== 'turn' ||
        mutation.workspaceId !== this.target.workspaceId ||
        mutation.sessionId !== this.target.sessionId
      )
        throw new Error('MCP 授权与原指令范围不匹配。');
      const requestVersion = await mutationVersion(mutation);
      this.current(generation);
      this.assertReview(review);
      const value = this.record({
        delivery: { operationId: mutation.operationId, review, requestVersion },
      });
      const entry = { key: mcpKey(this.target), expected: this.saved, value };
      try {
        if (combine)
          await combine(entry, () => generation === this.generation && this.deps.current());
        else if (
          !(await this.deps.compareSubmission(
            [entry, { key: pendingKey, expected: undefined, value: pendingValue }],
            () => generation === this.generation && this.deps.current(),
          ))
        )
          throw new Error('MCP 草稿或待确认指令已被其他页面修改。');
        this.current(generation);
        this.remember(value);
      } catch (error) {
        this.loadError = 'MCP 授权与原指令未能一起保存，请重新打开原会话。';
        throw error;
      }
    });
  }
  async verifySubmission(mutation: Mutation) {
    if (!this.delivery) return false;
    const generation = this.generation,
      version = await mutationVersion(mutation);
    this.access(generation);
    if (
      this.delivery.operationId !== mutation.operationId ||
      this.delivery.requestVersion !== version
    )
      throw new Error('待确认指令与原 MCP 授权不匹配。');
    return true;
  }
  confirmSubmission(operationId: string, accepted = true) {
    return this.work(async (generation) => {
      if (this.delivery?.operationId !== operationId) return;
      const review =
        accepted && this.review?.reviewId === this.delivery.review.reviewId
          ? undefined
          : this.review;
      await this.persist(this.record({ delivery: undefined, review }), generation);
    });
  }
}
