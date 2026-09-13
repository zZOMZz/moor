import { z } from 'zod';
import { id } from '../protocol';
import {
  secureMcpReviewSchema,
  secureTargetSchema,
  type SecureCliTarget,
  type SecureMcpReview,
  type SecureCliOperation,
} from '../cli/secure-operation';
import {
  MCP_LIMITS,
  mcpServerIdsSchema,
  mcpServerViewSchema,
  validateMcpRead,
  type McpRead,
  type McpReadResult,
  type McpServerView,
} from '../mcp-protocol';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { buildSessionTurn } from '../session-client';
import { SecureStore } from './secure-store';

export type { SecureMcpReview } from '../cli/secure-operation';
const deliverySchema = z
  .object({
    operationId: id,
    state: z.enum(['pending', 'ending']),
    review: secureMcpReviewSchema,
  })
  .strict();
const draftSchema = z
  .object({
    target: secureTargetSchema,
    review: secureMcpReviewSchema.optional(),
    delivery: deliverySchema.optional(),
  })
  .strict();
export type SecureMcpDraft = z.infer<typeof draftSchema>;
const documentSchema = z
  .object({
    target: secureTargetSchema,
    revision: z.number().int().nonnegative().safe(),
    review: secureMcpReviewSchema.optional(),
  })
  .strict();
export type SecureMcpRead = (target: SecureCliTarget, request: McpRead) => Promise<unknown>;
export type SecureMcpTurnInput = Omit<Parameters<typeof buildSessionTurn>[0], 'mcpServerIds'>;
const canonical = productCanonicalJson;
const same = (left: unknown, right: unknown) =>
  canonical(left ?? null) === canonical(right ?? null);
const conflict = () => Error('MCP 草稿已改变，请重新读取并审阅后继续。');
const storageKey = (target: SecureCliTarget, kind: 'draft' | 'lock') =>
  canonical([`moor-secure-mcp-${kind}-v1`, target]);
function targetSnapshot(value: SecureCliTarget) {
  const target = secureTargetSchema.parse(value);
  if (!target.product) throw Error('加密 MCP 选择必须固定产品副本。');
  return target;
}
function expectedSnapshot(value: SecureMcpDraft, target: SecureCliTarget) {
  const expected = draftSchema.parse(value);
  if (!same(expected.target, target)) throw conflict();
  return expected;
}
const requestFor = (target: SecureCliTarget): McpRead => ({
  mcpVersion: 1,
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  sessionId: target.sessionId,
});

/** Selection is local. Only the caller can dispatch or recover a persisted original turn. */
export class SecureMcp {
  constructor(
    readonly store: SecureStore,
    private readonly options: { uuid?: () => string } = {},
  ) {}

  async #load(target: SecureCliTarget, current: () => void) {
    current();
    const key = storageKey(target, 'draft'),
      raw = await this.store.backend.read(key);
    current();
    const document = raw == null ? { target, revision: 0 } : documentSchema.parse(raw);
    if (!same(document.target, target)) throw Error('本机 MCP 草稿与当前完整执行身份不匹配。');
    const operations = (await this.store.list(target)).filter((operation) =>
      same(operation.target, target),
    );
    current();
    const reviews = new Map<string, SecureMcpReview>();
    for (const review of [document.review, ...operations.map((operation) => operation.mcpReview)]) {
      if (!review) continue;
      const prior = reviews.get(review.reviewId);
      if (prior && !same(prior, review)) throw Error('同一 MCP 审阅编号的不可变内容不匹配。');
      reviews.set(review.reviewId, review);
    }
    const delivered = operations.filter(
      (operation) => operation.kind === 'turn' && operation.mcpReview,
    );
    const pending = delivered.find((operation) => ['pending', 'ending'].includes(operation.state));
    const consumed = delivered.some(
      (operation) =>
        operation.state === 'accepted' &&
        operation.mcpReview!.reviewId === document.review?.reviewId,
    );
    const draft = draftSchema.parse({
      target,
      ...(!consumed && document.review ? { review: document.review } : {}),
      ...(pending
        ? {
            delivery: {
              operationId: pending.operationId,
              state: pending.state,
              review: pending.mcpReview,
            },
          }
        : {}),
    });
    return { key, raw: raw ?? null, document, draft, reviews };
  }

  async read(input: SecureCliTarget, current: () => void): Promise<SecureMcpDraft> {
    const target = targetSnapshot(input);
    return structuredClone((await this.#load(target, current)).draft);
  }

  async readCatalog(
    input: SecureCliTarget,
    current: () => void,
    request: SecureMcpRead,
  ): Promise<McpReadResult> {
    const target = targetSnapshot(input),
      query = requestFor(target);
    current();
    const result = validateMcpRead(await request(structuredClone(target), query), query);
    current();
    return result;
  }

  async apply(
    input: SecureCliTarget,
    shown: SecureMcpDraft,
    servers: readonly McpServerView[],
    access: { online: boolean; catalog?: McpReadResult },
    current: () => void,
  ): Promise<SecureMcpDraft> {
    const target = targetSnapshot(input),
      expected = expectedSnapshot(shown, target),
      selected = z.array(mcpServerViewSchema).max(MCP_LIMITS.selected).parse(servers),
      catalog =
        access.online && access.catalog
          ? validateMcpRead(access.catalog, requestFor(target))
          : undefined;
    mcpServerIdsSchema.parse(selected.map((server) => server.id));
    return this.store.backend.exclusive(storageKey(target, 'lock'), current, async () => {
      const loaded = await this.#load(target, current);
      if (!same(loaded.draft, expected)) throw conflict();
      for (const server of selected) {
        if (
          !expected.review?.servers.some((prior) => same(prior, server)) &&
          !catalog?.servers.some((available) => same(available, server))
        )
          throw Error('请先连接并读取目录，再选择当前完整原版本；离线只能保留或移除已有选择。');
      }
      const review = secureMcpReviewSchema.parse({
        reviewId: (this.options.uuid ?? (() => crypto.randomUUID()))(),
        servers: selected,
      });
      if (loaded.reviews.has(review.reviewId)) throw Error('MCP 审阅编号已使用，请重新保存。');
      const document = documentSchema.parse({
        target,
        revision: loaded.document.revision + 1,
        review,
      });
      await this.store.backend.compareAndSet(loaded.key, loaded.raw, document, current);
      current();
      return structuredClone({ ...loaded.draft, review });
    });
  }

  async #validate(
    target: SecureCliTarget,
    expected: SecureMcpDraft,
    current: () => void,
    request?: SecureMcpRead,
  ) {
    const loaded = await this.#load(target, current);
    if (!same(loaded.draft, expected)) throw conflict();
    if (loaded.draft.delivery) throw Error('请先确认原指令，不可替换或自动重发原 MCP 授权。');
    if (expected.review?.servers.length) {
      if (!request) throw Error('当前未连接或主机不支持 MCP；选择保留，尚未发送。');
      const catalog = await this.readCatalog(target, current, request);
      if (
        expected.review.servers.some(
          (server) => !catalog.servers.some((item) => same(item, server)),
        )
      )
        throw Error('所选 MCP 原版本已不可用或已改变，请重新审查并手动更改草稿。');
    }
    current();
    return loaded;
  }

  /** Run before uploading attachments so invalid MCP versions cannot cause partial send work. */
  async validateBeforeSend(
    input: SecureCliTarget,
    shown: SecureMcpDraft,
    current: () => void,
    request?: SecureMcpRead,
  ) {
    const target = targetSnapshot(input),
      expected = expectedSnapshot(shown, target);
    await this.store.backend.exclusive(storageKey(target, 'lock'), current, async () => {
      await this.#validate(target, expected, current, request);
    });
  }

  async stageTurn(
    input: SecureCliTarget,
    shown: SecureMcpDraft,
    buildInput: SecureMcpTurnInput,
    current: () => void,
    request?: SecureMcpRead,
  ): Promise<SecureCliOperation> {
    const target = targetSnapshot(input),
      expected = expectedSnapshot(shown, target),
      build = structuredClone(buildInput);
    for (const field of [
      'workspaceId',
      'localProjectId',
      'sessionId',
      'userId',
      'machineId',
    ] as const)
      if (target[field] !== build.scope[field]) throw Error('MCP 指令与已审阅完整执行目标不匹配。');
    return this.store.backend.exclusive(storageKey(target, 'lock'), current, async () => {
      await this.#validate(target, expected, current, request);
      const mutation = buildSessionTurn({
        ...build,
        mcpServerIds: expected.review?.servers.map((server) => server.id) ?? [],
      });
      current();
      return this.store.stage(
        {
          operationId: build.operationId,
          kind: 'turn',
          userTurnId: build.turnId,
          target,
          body: JSON.stringify({
            method: 'mutate',
            workspaceId: target.workspaceId,
            localProjectId: target.localProjectId,
            params: mutation,
          }),
          ...(expected.review ? { mcpReview: expected.review } : {}),
        },
        build.now,
        current,
      );
    });
  }
}
