import { z } from 'zod';
import {
  actorKey,
  actorSchema,
  attentionContinueSchema,
  attentionDispositionSchema,
  attentionPermissionSchema,
  attentionSeenSchema,
  ATTENTION_FEATURE,
  ACTOR_FEATURE,
  FOLLOWUP_FEATURE,
  type AttentionActor,
  type AttentionDetail,
  type AttentionGroup,
  type AttentionItem,
  type AttentionPage,
  type AttentionReceipt,
} from '../attention';
import type { Mutation } from '../protocol';
import { ApiError } from './api';

const revision = z.number().int().nonnegative();
const itemSchema: z.ZodType<AttentionItem> = z.object({
  itemId: z.string(),
  sessionId: z.string(),
  localProjectId: z.string(),
  assistantTurnId: z.string(),
  userTurnId: z.string(),
  kind: z.enum(['permission', 'outcome']),
  lifecycle: z.enum(['active', 'resolved', 'invalidated', 'ended', 'historical']),
  requestId: z.string().optional(),
  cause: z
    .enum([
      'agent_returned',
      'execution_failed',
      'host_stopped',
      'host_restarted',
      'user_canceled',
      'unknown',
    ])
    .optional(),
  eventRevision: revision,
  sequence: revision,
  occurredAt: z.number().nullable(),
  summary: z.string().max(10000),
  seenRevision: revision,
  disposition: z.enum(['pending', 'checked', 'needs_followup', 'continued']),
  observationRevision: revision,
  followupUserTurnId: z.string().optional(),
});
const groupSchema: z.ZodType<AttentionGroup> = z.object({
  sessionId: z.string(),
  title: z.string(),
  isArchived: z.boolean(),
  items: z.array(itemSchema).max(50),
  itemCount: revision,
  nextItemsCursor: z.string().optional(),
});
const pageSchema: z.ZodType<AttentionPage> = z.object({
  sessions: z.array(groupSchema).max(50),
  total: revision,
  nextCursor: z.string().optional(),
  version: revision,
});
const detailSchema: z.ZodType<AttentionDetail> = z.object({
  item: itemSchema,
  title: z.string(),
  isArchived: z.boolean(),
  turn: z.unknown(),
  userTurn: z.unknown(),
  permission: z
    .object({
      requestId: z.string(),
      expectedTurnId: z.string(),
      options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.string() })),
      toolCall: z.unknown(),
    })
    .optional(),
}) as z.ZodType<AttentionDetail>;
const routeSchema = z
  .object({
    origin: z.string(),
    actor: actorSchema,
    catalogWorkspaceId: z.string(),
    projectId: z.string(),
    replicaId: z.string(),
    executionDeviceId: z.string(),
    machineId: z.string(),
    runtimeWorkspaceId: z.string(),
    localProjectId: z.string(),
  })
  .strict();
export type AttentionRoute = z.infer<typeof routeSchema>;
function routeOf(target: AttentionRoute): AttentionRoute {
  return routeSchema.parse(
    Object.fromEntries(
      Object.keys(routeSchema.shape).map((key) => [key, target[key as keyof AttentionRoute]]),
    ),
  );
}
export type AttentionTarget = AttentionRoute & {
  hostName: string;
  projectName: string;
  online: boolean;
  features: string[];
};
export type AttentionContext = {
  origin: string;
  actor: AttentionActor;
  workspaceId: string;
  workspaceName: string;
  connected: boolean;
  targets: AttentionTarget[];
};
const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('seen'), body: attentionSeenSchema }),
  z.object({ kind: z.literal('disposition'), body: attentionDispositionSchema }),
  z.object({ kind: z.literal('permission'), body: attentionPermissionSchema }),
  z.object({ kind: z.literal('continue'), body: attentionContinueSchema }),
]);
export const pendingAttentionSchema = z
  .object({
    route: routeSchema,
    sessionId: z.string(),
    itemId: z.string(),
    operation: operationSchema,
  })
  .strict();
export type PendingAttention = z.infer<typeof pendingAttentionSchema>;
export type AttentionOperation = PendingAttention['operation'];
export type AttentionDraft = { text: string; saved: boolean; shared: boolean; insertion?: string };
export type AttentionListState = {
  target: AttentionTarget;
  page?: AttentionPage;
  cached: boolean;
  syncedAt?: number;
  loading: boolean;
  error?: string;
};
export type AttentionSelection = { replicaId: string; sessionId: string; itemId: string };
export type AttentionState = {
  context?: AttentionContext;
  view: 'pending' | 'processed';
  projectFilter: string;
  hostFilter: string;
  lists: AttentionListState[];
  selected?: AttentionSelection;
  detail?: AttentionDetail;
  detailFresh: boolean;
  detailOpen: boolean;
  detailLoading: boolean;
  busy: boolean;
  pending?: PendingAttention;
  draft?: AttentionDraft;
  error: string;
  notice: string;
  seenPending?: PendingAttention;
  seenBusy?: boolean;
  seenError?: string;
};
export function attentionScopeKey(route: AttentionRoute) {
  return JSON.stringify([
    'attention-v1',
    route.origin,
    actorKey(route.actor),
    route.machineId,
    route.runtimeWorkspaceId,
    route.localProjectId,
  ]);
}
export function attentionItemKey(route: AttentionRoute, sessionId: string, itemId: string) {
  return JSON.stringify([attentionScopeKey(route), sessionId, itemId]);
}
export function attentionPendingKey(
  operation: Pick<PendingAttention, 'route' | 'sessionId' | 'itemId'> & {
    operation?: AttentionOperation;
  },
) {
  return (
    attentionItemKey(operation.route, operation.sessionId, operation.itemId) +
    (operation.operation?.kind === 'seen' ? '/seen-pending/' : '/pending/') +
    operation.route.executionDeviceId
  );
}
export function attentionEndpoint(route: AttentionRoute, sessionId?: string, itemId?: string) {
  const e = encodeURIComponent;
  return (
    `/api/workspaces/${e(route.catalogWorkspaceId)}/replicas/${e(route.replicaId)}` +
    (sessionId && itemId ? `/sessions/${e(sessionId)}/attention/${e(itemId)}` : '/attention')
  );
}
export function attentionOperationId(operation: AttentionOperation) {
  return operation.kind === 'continue'
    ? operation.body.mutation.operationId
    : operation.body.operationId;
}
export function routeAttention(operation: PendingAttention, target: AttentionRoute) {
  if (
    attentionScopeKey(operation.route) !== attentionScopeKey(target) ||
    operation.route.executionDeviceId !== target.executionDeviceId
  )
    throw new Error('原操作的账号或执行绑定已改变，不能向新目标重试。');
  return { ...operation, route: routeOf(target) };
}
export async function deliverAttention(
  operation: PendingAttention,
  deps: {
    read: <T>(key: string) => Promise<T | undefined>;
    compareAndSet: (key: string, expected: unknown, value: unknown) => Promise<boolean>;
    request: (path: string, body?: unknown) => Promise<unknown>;
    onPending: (pending?: PendingAttention) => void;
    isAuthorized?: () => boolean;
  },
): Promise<AttentionReceipt> {
  const original = pendingAttentionSchema.parse(operation);
  const key = attentionPendingKey(original);
  if (deps.isAuthorized?.() === false) throw new Error('访问范围已改变。');
  const stored = await deps.read<PendingAttention>(key);
  if (stored) {
    const previous = pendingAttentionSchema.parse(stored);
    if (
      attentionScopeKey(previous.route) !== attentionScopeKey(original.route) ||
      previous.route.executionDeviceId !== original.route.executionDeviceId ||
      previous.sessionId !== original.sessionId ||
      previous.itemId !== original.itemId ||
      JSON.stringify(previous.operation) !== JSON.stringify(original.operation)
    )
      throw new Error('另一页面已有待确认操作，请重新打开事项并先确认原操作。');
  }
  if (!(await deps.compareAndSet(key, stored, original)))
    throw new Error('待确认记录已改变，请重新打开事项。');
  deps.onPending(original);
  if (deps.isAuthorized?.() === false) throw new Error('访问范围已改变，原请求保留待确认。');
  let response: unknown;
  try {
    response = await deps.request(
      attentionEndpoint(original.route, original.sessionId, original.itemId) +
        '/' +
        original.operation.kind,
      original.operation.body,
    );
  } catch (error) {
    if (error instanceof ApiError && error.rejected) {
      if (await deps.compareAndSet(key, original, undefined)) deps.onPending(undefined);
      else deps.onPending(await deps.read<PendingAttention>(key));
    }
    throw error;
  }
  const receipt = z
    .object({
      accepted: z.literal(true),
      delivered: z.literal(true),
      operationId: z.string(),
      item: itemSchema.optional(),
    })
    .parse(response);
  if (
    receipt.operationId !== attentionOperationId(original.operation) ||
    (receipt.item &&
      (receipt.item.itemId !== original.itemId ||
        receipt.item.sessionId !== original.sessionId ||
        receipt.item.localProjectId !== original.route.localProjectId))
  )
    throw new Error('尚未取得匹配的主机确认，请手动重试确认。');
  if (await deps.compareAndSet(key, original, undefined)) deps.onPending(undefined);
  else deps.onPending(await deps.read<PendingAttention>(key));
  return receipt;
}
export function attentionPending(item: AttentionItem) {
  if (item.kind === 'permission') return item.lifecycle === 'active';
  if (item.disposition === 'checked' || item.disposition === 'continued') return false;
  return (
    item.observationRevision > 0 || (item.lifecycle === 'ended' && item.cause !== 'user_canceled')
  );
}
export function attentionCategory(item: AttentionItem) {
  if (item.kind === 'permission') return 0;
  if (item.disposition === 'needs_followup') return 2;
  if (['execution_failed', 'host_stopped', 'host_restarted'].includes(item.cause ?? '')) return 1;
  return 3;
}
export function attentionGroups(lists: AttentionListState[], project = '', host = '') {
  return lists
    .filter(
      (list) =>
        (!project || list.target.projectId === project) &&
        (!host || list.target.executionDeviceId === host),
    )
    .flatMap((list) =>
      (list.page?.sessions ?? []).map((group) => ({
        group,
        target: list.target,
        cached: list.cached,
        category: Math.min(...group.items.map(attentionCategory), 3),
      })),
    )
    .sort(
      (a, b) =>
        a.category - b.category ||
        (a.category === 0 ? 1 : -1) *
          ((a.group.items[0]?.occurredAt ?? 0) - (b.group.items[0]?.occurredAt ?? 0)) ||
        attentionScopeKey(a.target).localeCompare(attentionScopeKey(b.target)) ||
        a.group.sessionId.localeCompare(b.group.sessionId),
    );
}

export type AttentionDependencies = {
  request: (path: string, body?: unknown) => Promise<unknown>;
  read: <T>(key: string) => Promise<T | undefined>;
  write: (key: string, value: unknown) => Promise<void>;
  compareAndSet: (key: string, expected: unknown, value: unknown) => Promise<boolean>;
  now: () => number;
  uuid: () => string;
  changed: () => void;
  readSessionDraft: (
    route: AttentionRoute,
    sessionId: string,
  ) => Promise<string | { text: string; unscoped: boolean }>;
  prepareTurn: (route: AttentionRoute, sessionId: string, text: string) => Promise<Mutation>;
  continued: (route: AttentionRoute, sessionId: string, text: string) => Promise<void>;
};

export class AttentionController {
  state: AttentionState = {
    view: 'pending',
    projectFilter: '',
    hostFilter: '',
    lists: [],
    detailFresh: false,
    detailOpen: false,
    detailLoading: false,
    busy: false,
    error: '',
    notice: '',
  };
  private generation = 0;
  private listGeneration = 0;
  private detailGeneration = 0;
  constructor(private deps: AttentionDependencies) {}
  configure(context?: AttentionContext) {
    const before = this.state.context;
    const identity = (c?: AttentionContext) =>
      c ? JSON.stringify([c.origin, actorKey(c.actor), c.workspaceId]) : '';
    if (identity(before) !== identity(context)) {
      this.generation++;
      this.listGeneration++;
      this.detailGeneration++;
      this.state = {
        view: 'pending',
        projectFilter: '',
        hostFilter: '',
        lists: [],
        detailFresh: false,
        detailOpen: false,
        detailLoading: false,
        busy: false,
        error: '',
        notice: '',
        context,
      };
    } else {
      const bindings = (value?: AttentionContext) =>
        JSON.stringify([
          value?.connected,
          value?.targets.map((t) => [
            attentionScopeKey(t),
            t.executionDeviceId,
            t.replicaId,
            t.projectId,
            t.online,
            t.features,
          ]),
        ]);
      if (bindings(before) !== bindings(context)) {
        this.generation++;
        this.listGeneration++;
        this.detailGeneration++;
        this.state.busy = false;
        this.state.seenBusy = false;
        this.state.detailLoading = false;
        this.state.detailFresh = false;
      }
      const priorTarget = before?.targets.find(
        (t) => t.replicaId === this.state.selected?.replicaId,
      );
      const nextTarget = context?.targets.find(
        (t) => t.replicaId === this.state.selected?.replicaId,
      );
      if (
        priorTarget &&
        nextTarget &&
        (attentionScopeKey(priorTarget) !== attentionScopeKey(nextTarget) ||
          priorTarget.executionDeviceId !== nextTarget.executionDeviceId)
      ) {
        this.detailGeneration++;
        this.state.detailFresh = false;
        this.state.detail = undefined;
        this.state.pending = undefined;
        this.state.seenPending = undefined;
        this.state.draft = undefined;
      }
      this.state.context = context;
      this.state.lists = this.state.lists.flatMap((list) => {
        const target = context?.targets.find(
          (t) =>
            t.replicaId === list.target.replicaId &&
            attentionScopeKey(t) === attentionScopeKey(list.target),
        );
        return target
          ? [{ ...list, target, cached: list.cached || !context?.connected || !target.online }]
          : [];
      });
      if (
        this.state.selected &&
        !context?.targets.some((t) => t.replicaId === this.state.selected!.replicaId)
      ) {
        this.detailGeneration++;
        this.state.selected = undefined;
        this.state.detail = undefined;
        this.state.pending = undefined;
        this.state.seenPending = undefined;
        this.state.draft = undefined;
      }
      if (!this.canWrite()) this.state.detailFresh = false;
    }
  }
  private changed() {
    this.deps.changed();
  }
  target() {
    return this.state.context?.targets.find((t) => t.replicaId === this.state.selected?.replicaId);
  }
  private supported(target: AttentionTarget, followup = false) {
    return (
      target.features.includes(ATTENTION_FEATURE) &&
      target.features.includes(ACTOR_FEATURE) &&
      (!followup || target.features.includes(FOLLOWUP_FEATURE))
    );
  }
  canWrite(followup = false) {
    const target = this.target();
    return !!(this.state.context?.connected && target?.online && this.supported(target, followup));
  }
  total() {
    return this.state.context &&
      this.state.lists.length === this.state.context.targets.length &&
      this.state.lists.every((list) => !!list.page)
      ? this.state.lists.reduce((sum, list) => sum + (list.page?.total ?? 0), 0)
      : undefined;
  }
  async setView(view: AttentionState['view']) {
    this.state.view = view;
    this.state.detailOpen = false;
    this.state.selected = undefined;
    this.state.detail = undefined;
    this.state.pending = undefined;
    this.state.seenPending = undefined;
    this.state.draft = undefined;
    this.state.busy = false;
    this.state.seenBusy = false;
    this.detailGeneration++;
    await this.refresh();
  }
  filter(project: string, host: string) {
    this.state.projectFilter = project;
    this.state.hostFilter = host;
    this.changed();
  }
  back() {
    this.state.detailOpen = false;
    this.changed();
  }
  report(cause: unknown) {
    this.state.error = cause instanceof Error ? cause.message : String(cause);
    this.changed();
  }
  async refresh() {
    const context = this.state.context;
    if (!context) return;
    const generation = this.generation,
      request = ++this.listGeneration,
      view = this.state.view;
    const current = () =>
      generation === this.generation && request === this.listGeneration && this.state.view === view;
    this.state.lists = context.targets.map((target) => ({
      ...this.state.lists.find((list) => list.target.replicaId === target.replicaId),
      target,
      loading: true,
      cached: true,
    }));
    this.changed();
    for (let start = 0; start < context.targets.length; start += 4) {
      await Promise.all(
        context.targets.slice(start, start + 4).map(async (target) => {
          const cacheKey = attentionScopeKey(target) + '/page/' + view;
          let saved: { page: AttentionPage; syncedAt: number } | undefined;
          try {
            saved = await this.deps.read(cacheKey);
          } catch {
            /* Optional read cache. */
          }
          if (!current()) return;
          let page: AttentionPage | undefined;
          try {
            if (saved) page = pageSchema.parse(saved.page);
          } catch {
            saved = undefined;
          }
          let cached = true,
            syncedAt = saved?.syncedAt,
            error = '';
          if (page) this.replaceList({ target, page, cached, syncedAt, loading: true });
          try {
            if (!context.connected || !target.online)
              throw new Error(page ? '执行电脑离线，显示缓存。' : '执行电脑离线，待办状态未知。');
            if (!this.supported(target)) throw new Error('更新执行电脑后可查看待办。');
            const fresh = pageSchema.parse(
              await this.deps.request(attentionEndpoint(target) + '?view=' + view + '&limit=50'),
            );
            if (!current()) return;
            this.validatePage(fresh, target);
            page = fresh;
            cached = false;
            syncedAt = this.deps.now();
            await this.deps.write(cacheKey, { page, syncedAt });
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
          if (current())
            this.replaceList({ target, page, cached, syncedAt, loading: false, error });
        }),
      );
    }
    if (current() && this.state.selected) await this.readDetail(false);
  }
  private validatePage(page: AttentionPage, target: AttentionTarget) {
    for (const group of page.sessions)
      for (const item of group.items)
        if (item.sessionId !== group.sessionId || item.localProjectId !== target.localProjectId)
          throw new Error('主机待办响应与项目范围不匹配。');
  }
  private replaceList(list: AttentionListState) {
    this.state.lists = this.state.lists.map((old) =>
      old.target.replicaId === list.target.replicaId ? list : old,
    );
    this.changed();
  }
  async more(replicaId: string) {
    const list = this.state.lists.find((row) => row.target.replicaId === replicaId);
    if (
      !list?.page?.nextCursor ||
      list.loading ||
      !this.state.context?.connected ||
      !list.target.online
    )
      return;
    const generation = this.generation,
      request = this.listGeneration,
      view = this.state.view;
    this.replaceList({ ...list, loading: true });
    try {
      const page = pageSchema.parse(
        await this.deps.request(
          attentionEndpoint(list.target) +
            '?view=' +
            view +
            '&limit=50&cursor=' +
            encodeURIComponent(list.page.nextCursor),
        ),
      );
      if (generation !== this.generation || request !== this.listGeneration) return;
      this.validatePage(page, list.target);
      if (page.version !== list.page.version) throw new Error('列表已变化，请刷新后重新加载。');
      const sessions = [
        ...new Map(
          [...list.page.sessions, ...page.sessions].map((group) => [group.sessionId, group]),
        ).values(),
      ];
      this.replaceList({ ...list, loading: false, cached: false, page: { ...page, sessions } });
    } catch (cause) {
      if (generation === this.generation && request === this.listGeneration)
        this.replaceList({ ...list, loading: false, error: (cause as Error).message });
    }
  }
  async open(selected: AttentionSelection) {
    this.detailGeneration++;
    this.state.selected = selected;
    this.state.detail = undefined;
    this.state.detailFresh = false;
    this.state.pending = undefined;
    this.state.draft = undefined;
    this.state.detailOpen = true;
    this.state.seenPending = undefined;
    this.state.seenError = '';
    this.state.busy = false;
    this.state.seenBusy = false;
    this.state.error = this.state.notice = '';
    this.changed();
    await this.readDetail(true);
  }
  async moreItems() {
    const target = this.target(),
      selected = this.state.selected;
    const list = this.state.lists.find((row) => row.target.replicaId === selected?.replicaId);
    const group = list?.page?.sessions.find((row) => row.sessionId === selected?.sessionId);
    if (!target || !selected || !list?.page || !group?.nextItemsCursor || !this.canWrite()) return;
    const generation = this.generation,
      request = this.listGeneration;
    try {
      const e = encodeURIComponent;
      const path = `/api/workspaces/${e(target.catalogWorkspaceId)}/replicas/${e(target.replicaId)}/sessions/${e(selected.sessionId)}/attention`;
      const page = z
        .object({
          items: z.array(itemSchema).max(50),
          total: revision,
          nextCursor: z.string().optional(),
          version: revision,
        })
        .parse(
          await this.deps.request(
            path + '?view=' + this.state.view + '&limit=50&cursor=' + e(group.nextItemsCursor),
          ),
        );
      if (generation !== this.generation || request !== this.listGeneration) return;
      if (
        page.items.some(
          (item) =>
            item.sessionId !== selected.sessionId || item.localProjectId !== target.localProjectId,
        )
      )
        throw new Error('事项分页与会话范围不匹配。');
      const updated = {
        ...group,
        items: [
          ...new Map([...group.items, ...page.items].map((item) => [item.itemId, item])).values(),
        ],
        itemCount: page.total,
        nextItemsCursor: page.nextCursor,
      };
      this.replaceList({
        ...list,
        page: {
          ...list.page,
          sessions: list.page.sessions.map((row) =>
            row.sessionId === selected.sessionId ? updated : row,
          ),
        },
      });
    } catch (cause) {
      if (generation === this.generation && request === this.listGeneration) this.report(cause);
    }
  }
  async readDetail(markSeen = false) {
    const target = this.target(),
      selected = this.state.selected;
    if (!target || !selected) return;
    const generation = this.generation,
      request = ++this.detailGeneration;
    const current = () => generation === this.generation && request === this.detailGeneration;
    const key = attentionItemKey(target, selected.sessionId, selected.itemId);
    this.state.detailLoading = true;
    this.changed();
    try {
      const [saved, pending, draft, seenPending] = await Promise.all([
        this.deps.read<AttentionDetail>(key + '/detail'),
        this.deps.read<PendingAttention>(
          attentionPendingKey({
            route: target,
            sessionId: selected.sessionId,
            itemId: selected.itemId,
          }),
        ),
        this.deps.read<AttentionDraft>(key + '/draft'),
        this.deps.read<PendingAttention>(
          attentionPendingKey({
            route: target,
            sessionId: selected.sessionId,
            itemId: selected.itemId,
            operation: { kind: 'seen', body: { operationId: 'read-only', eventRevision: 0 } },
          }),
        ),
      ]);
      if (!current()) return;
      const cached = detailSchema.safeParse(saved);
      if (cached.success) this.acceptDetail(cached.data, selected, target, false);
      if (pending)
        this.state.pending = routeAttention(pendingAttentionSchema.parse(pending), target);
      if (draft && typeof draft.text === 'string' && !this.state.draft) this.state.draft = draft;
      if (seenPending)
        this.state.seenPending = routeAttention(pendingAttentionSchema.parse(seenPending), target);
      this.changed();
      if (!this.canWrite()) return;
      const detail = detailSchema.parse(
        await this.deps.request(attentionEndpoint(target, selected.sessionId, selected.itemId)),
      );
      if (!current()) return;
      this.acceptDetail(detail, selected, target, true);
      await this.deps.write(key + '/detail', detail);
      if (!current()) return;
      if (
        markSeen &&
        !this.state.seenPending &&
        detail.item.seenRevision < detail.item.eventRevision
      ) {
        await this.perform(
          {
            kind: 'seen',
            body: { operationId: this.deps.uuid(), eventRevision: detail.item.eventRevision },
          },
          false,
        );
      }
    } catch (cause) {
      if (current()) this.state.error = (cause as Error).message;
    } finally {
      if (current()) {
        this.state.detailLoading = false;
        this.changed();
      }
    }
  }
  private acceptDetail(
    detail: AttentionDetail,
    selected: AttentionSelection,
    target: AttentionTarget,
    fresh: boolean,
  ) {
    if (
      detail.item.itemId !== selected.itemId ||
      detail.item.sessionId !== selected.sessionId ||
      detail.item.localProjectId !== target.localProjectId
    )
      throw new Error('事项详情与请求范围不匹配。');
    const old = this.state.detail?.item;
    if (
      old &&
      (detail.item.eventRevision < old.eventRevision ||
        detail.item.observationRevision < old.observationRevision)
    )
      return;
    this.state.detail = detail;
    this.state.detailFresh = fresh;
  }
  async disposition(disposition: 'pending' | 'checked' | 'needs_followup') {
    const item = this.state.detail?.item;
    if (!item || item.kind === 'permission') throw new Error('审批必须使用原始权限选项。');
    await this.perform({
      kind: 'disposition',
      body: {
        operationId: this.deps.uuid(),
        eventRevision: item.eventRevision,
        observationRevision: item.observationRevision,
        disposition,
      },
    });
  }
  async permission(optionId: string | null) {
    const detail = this.state.detail;
    if (!detail?.permission || detail.item.lifecycle !== 'active')
      throw new Error('审批请求已失效。');
    if (
      optionId !== null &&
      !detail.permission.options.some((option) => option.optionId === optionId)
    )
      throw new Error('无效的权限选项。');
    await this.perform({
      kind: 'permission',
      body: {
        operationId: this.deps.uuid(),
        eventRevision: detail.item.eventRevision,
        requestId: detail.permission.requestId,
        expectedTurnId: detail.permission.expectedTurnId,
        optionId,
      },
    });
  }
  async retry() {
    if (!this.state.pending || !this.target()) return;
    const original = this.state.pending,
      target = this.target()!,
      draft = this.state.draft;
    const generation = this.generation,
      selected = this.state.selected;
    await this.perform(original.operation, true, routeAttention(original, target));
    if (
      original.operation.kind === 'continue' &&
      generation === this.generation &&
      selected === this.state.selected
    ) {
      await this.deps.compareAndSet(
        attentionItemKey(target, original.sessionId, original.itemId) + '/draft',
        draft,
        undefined,
      );
      if (this.state.draft === draft) this.state.draft = undefined;
      await this.deps.continued(target, original.sessionId, draft?.text ?? '');
      this.changed();
    }
  }
  async retrySeen() {
    if (!this.state.seenPending || !this.target()) return;
    await this.perform(
      this.state.seenPending.operation,
      false,
      routeAttention(this.state.seenPending, this.target()!),
    );
  }
  private async perform(operation: AttentionOperation, refresh = true, retry?: PendingAttention) {
    const seen = operation.kind === 'seen';
    if (seen ? this.state.seenBusy : this.state.busy) throw new Error('请等待当前操作确认。');
    const target = this.target(),
      selected = this.state.selected;
    if (!target || !selected || !this.canWrite(operation.kind === 'continue'))
      throw new Error('当前无法连接支持此操作的执行电脑。');
    if (!retry && (!this.state.detailFresh || (seen ? this.state.seenPending : this.state.pending)))
      throw new Error('请先刷新事项并确认上一次请求。');
    const generation = this.generation,
      selection = attentionItemKey(target, selected.sessionId, selected.itemId);
    const current = () =>
      generation === this.generation &&
      selected === this.state.selected &&
      this.target() &&
      this.state.selected &&
      attentionItemKey(
        this.target()!,
        this.state.selected!.sessionId,
        this.state.selected!.itemId,
      ) === selection;
    const original = retry ?? {
      route: routeOf(target),
      sessionId: selected.sessionId,
      itemId: selected.itemId,
      operation,
    };
    if (seen) {
      this.state.seenBusy = true;
      this.state.seenError = '';
    } else {
      this.state.busy = true;
      this.state.error = this.state.notice = '';
    }
    this.changed();
    try {
      const receipt = await deliverAttention(original, {
        read: this.deps.read,
        compareAndSet: this.deps.compareAndSet,
        request: this.deps.request,
        isAuthorized: () => !!current() && this.canWrite(operation.kind === 'continue'),
        onPending: (pending) => {
          if (current()) {
            if (seen) this.state.seenPending = pending;
            else this.state.pending = pending;
            this.changed();
          }
        },
      });
      if (!current()) return;
      // A response to a read started before this receipt cannot undo the confirmed state.
      if (!seen) {
        this.listGeneration++;
        this.detailGeneration++;
      }
      if (receipt.item && this.state.detail) {
        if (seen)
          this.state.detail = {
            ...this.state.detail,
            item: {
              ...this.state.detail.item,
              seenRevision: Math.max(
                this.state.detail.item.seenRevision,
                receipt.item.seenRevision,
              ),
            },
          };
        else
          this.acceptDetail(
            { ...this.state.detail, item: receipt.item },
            this.state.selected!,
            this.target()!,
            true,
          );
      }
      if (!seen) this.state.notice = '主机已确认。';
      if (
        operation.kind === 'disposition' &&
        operation.body.disposition === 'needs_followup' &&
        this.state.draft
      ) {
        this.state.draft = { ...this.state.draft, shared: true };
        await this.deps.write(selection + '/draft', this.state.draft);
      }
      if (refresh) await this.refresh();
    } catch (cause) {
      if (current()) {
        if (seen) this.state.seenError = (cause as Error).message;
        else this.state.error = (cause as Error).message;
      }
      if (!seen) throw cause;
    } finally {
      if (current()) {
        if (seen) this.state.seenBusy = false;
        else this.state.busy = false;
        this.state.detailLoading = false;
        this.changed();
      }
    }
  }
  async createDraft() {
    if (this.state.draft) return;
    const target = this.target(),
      detail = this.state.detail;
    if (!target || !detail || detail.item.kind !== 'outcome') return;
    const generation = this.generation,
      selected = this.state.selected;
    const source = await this.deps.readSessionDraft(target, detail.item.sessionId);
    const existing = typeof source === 'string' ? source : source.text;
    if (generation !== this.generation || selected !== this.state.selected) return;
    const insertion = `请继续检查这一回合的结果：${detail.item.summary || detail.title}`;
    this.state.draft = {
      text: existing || insertion,
      insertion: existing ? insertion : undefined,
      saved: false,
      shared: false,
    };
    if (typeof source !== 'string' && source.unscoped)
      this.state.notice = '原会话草稿未关联当前账号，未搬入工作台。请打开原会话手动检查和合并。';
    this.changed();
  }
  editDraft(text: string) {
    if (this.state.draft && this.state.pending?.operation.kind !== 'continue') {
      this.state.draft = { ...this.state.draft, text, saved: false };
      this.changed();
    }
  }
  mergeDraft() {
    if (!this.state.draft?.insertion) return;
    this.state.draft = {
      ...this.state.draft,
      text: this.state.draft.text + '\n\n' + this.state.draft.insertion,
      insertion: undefined,
      saved: false,
    };
    this.changed();
  }
  async saveDraft() {
    const target = this.target(),
      selected = this.state.selected,
      draft = this.state.draft;
    if (!target || !selected || !draft) return;
    const generation = this.generation,
      key = attentionItemKey(target, selected.sessionId, selected.itemId);
    const saved = { ...draft, saved: true };
    await this.deps.write(key + '/draft', saved);
    if (generation !== this.generation || selected !== this.state.selected) return;
    if (this.state.draft !== draft) {
      this.state.notice = '旧版本已保存；刚才的新编辑仍未保存。';
      this.changed();
      return;
    }
    this.state.draft = saved;
    if (
      this.canWrite() &&
      this.state.detailFresh &&
      !this.state.pending &&
      this.state.detail?.item.disposition !== 'needs_followup'
    )
      await this.disposition('needs_followup');
    else {
      this.state.notice = saved.shared
        ? '本机草稿已保存，尚未发送。'
        : '本机草稿已保存；共享标记尚未提交。';
      this.changed();
    }
  }
  async sendContinue() {
    const target = this.target(),
      detail = this.state.detail,
      draft = this.state.draft;
    if (!target || !detail || !draft?.saved || !draft.text.trim())
      throw new Error('请先保存后续草稿。');
    if (detail.isArchived) throw new Error('请先在原会话恢复，再手动发送。');
    if (!this.canWrite(true) || !this.state.detailFresh || this.state.pending)
      throw new Error('当前不能发送后续要求，请先刷新并确认原请求。');
    if (this.state.busy) throw new Error('请等待当前操作确认。');
    const generation = this.generation,
      selected = this.state.selected;
    this.state.busy = true;
    this.changed();
    let mutation: Mutation;
    try {
      mutation = await this.deps.prepareTurn(target, detail.item.sessionId, draft.text);
    } finally {
      if (generation === this.generation && selected === this.state.selected) {
        this.state.busy = false;
        this.changed();
      }
    }
    if (generation !== this.generation || selected !== this.state.selected)
      throw new Error('访问范围已改变，草稿未发送。');
    if (
      mutation.sessionId !== detail.item.sessionId ||
      mutation.workspaceId !== target.runtimeWorkspaceId ||
      mutation.kind !== 'turn'
    )
      throw new Error('后续回合与原事项不匹配。');
    await this.perform({
      kind: 'continue',
      body: {
        mutation,
        eventRevision: detail.item.eventRevision,
        observationRevision: detail.item.observationRevision,
      },
    });
    if (generation !== this.generation || selected !== this.state.selected) return;
    await this.deps.compareAndSet(
      attentionItemKey(target, detail.item.sessionId, detail.item.itemId) + '/draft',
      draft,
      undefined,
    );
    if (this.state.draft === draft) this.state.draft = undefined;
    await this.deps.continued(target, detail.item.sessionId, draft.text);
    this.changed();
  }
}
