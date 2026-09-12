import { createHash } from 'node:crypto';
import { assert } from '../protocol';
import { metas, mirror } from '../model';
import {
  actorKey,
  attentionContextSchema,
  attentionListQuerySchema,
  attentionSeenSchema,
  attentionDispositionSchema,
  attentionContinueSchema,
  type AttentionContext,
  type AttentionActor,
  type AttentionCause,
  type AttentionItem,
  type AttentionGroup,
  type AttentionPage,
  type AttentionItemPage,
  type AttentionListQuery,
  type AttentionSeen,
  type AttentionDisposition,
  type AttentionContinue,
  type AttentionReceipt,
} from '../attention';
import type { RuntimeStore } from './store';

const migrationKey = 'attention-v1-authoritative';
const authoritativeTables = [
  'attention_item',
  'attention_observation',
  'attention_receipt',
  'attention_projection_state',
];
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

export type AttentionFactInput = {
  sessionId: string;
  assistantTurnId: string;
  userTurnId: string;
  localProjectId: string;
  summary?: string;
};

// These tables contain authoritative lifecycle facts. Session v1 cannot recover
// their timestamps, causes, historical boundary or observation history.
export class AttentionStore {
  constructor(
    private readonly store: RuntimeStore,
    private readonly now: () => number = Date.now,
  ) {
    const initialized = store.load(migrationKey);
    const present = new Set(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    if (initialized) {
      assert(
        authoritativeTables.every((table) => present.has(table)),
        503,
        '待办权威数据不完整，请从完整 Moor 主机备份恢复。',
      );
      assert(Buffer.from(initialized).toString() === '1', 503, '待办数据版本不受支持');
      for (const state of this.db.prepare('SELECT * FROM attention_projection_state').all()) {
        const count = Number(
          this.db
            .prepare('SELECT COUNT(*) AS count FROM attention_item WHERE runtime_id=?')
            .get(String(state.runtime_id))!.count,
        );
        assert(
          state.version === 1 && count === Number(state.sequence),
          503,
          '待办权威数据不完整，请从完整 Moor 主机备份恢复。',
        );
      }
      assert(
        !this.db
          .prepare(
            `SELECT item_id FROM attention_item WHERE runtime_id NOT IN
        (SELECT runtime_id FROM attention_projection_state) LIMIT 1`,
          )
          .get(),
        503,
        '待办权威数据不完整，请从完整 Moor 主机备份恢复。',
      );
      return;
    }
    assert(
      authoritativeTables.every((table) => !present.has(table)),
      503,
      '待办迁移状态不完整，请保留数据并从完整 Moor 主机备份恢复。',
    );
    store.transaction(() => {
      this.db.exec(`
        CREATE TABLE attention_item (
          item_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, machine_id TEXT NOT NULL,
          local_project_id TEXT NOT NULL, session_id TEXT NOT NULL,
          assistant_turn_id TEXT NOT NULL, user_turn_id TEXT NOT NULL,
          kind TEXT NOT NULL, request_id TEXT, lifecycle TEXT NOT NULL,
          cause TEXT, historical INTEGER NOT NULL, revision INTEGER NOT NULL,
          sequence INTEGER NOT NULL UNIQUE, occurred_at INTEGER, summary TEXT NOT NULL
        );
        CREATE INDEX attention_item_project ON attention_item(runtime_id, local_project_id, session_id);
        CREATE TABLE attention_observation (
          actor TEXT NOT NULL, item_id TEXT NOT NULL, seen_revision INTEGER NOT NULL,
          disposition TEXT NOT NULL, observation_revision INTEGER NOT NULL,
          updated_at INTEGER, followup_user_turn_id TEXT,
          PRIMARY KEY(actor, item_id)
        );
        CREATE TABLE attention_receipt (
          actor TEXT NOT NULL, operation_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, result TEXT NOT NULL,
          PRIMARY KEY(actor, operation_id)
        );
        CREATE TABLE attention_projection_state (
          runtime_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
          sequence INTEGER NOT NULL, enabled_at INTEGER NOT NULL
        );
      `);
      this.db
        .prepare('INSERT INTO attention_projection_state VALUES(?,1,0,?)')
        .run(store.workspace.id, this.now());
      const metadata = metas(store.meta);
      for (const row of this.db.prepare('SELECT id FROM session').all()) {
        const sessionId = String(row.id);
        const localProjectId = (metadata['session-' + sessionId]?.project as any)?.localProjectId;
        if (typeof localProjectId !== 'string') continue;
        const view = mirror(store.doc(sessionId), sessionId);
        for (const turn of view.getState().history) {
          if (turn.role !== 'assistant' || !turn.finished) continue;
          this.recordOutcome(
            {
              sessionId,
              localProjectId,
              assistantTurnId: turn.id,
              userTurnId: turn.userTurnId ?? '',
              cause: 'unknown',
              summary: this.summary(turn.items),
              historical: true,
            },
            null,
          );
        }
        view.dispose();
      }
      store.save(migrationKey, Buffer.from('1'));
    });
  }

  private get db() {
    return this.store.journal.db;
  }

  private transaction<T>(fn: () => T): T {
    return this.db.isTransaction ? fn() : this.store.transaction(fn);
  }

  summary(items: unknown): string {
    if (!Array.isArray(items)) return '';
    const text = [...items]
      .reverse()
      .find((item: any) => item?.type === 'system_notice' || item?.type === 'text');
    return String(text?.message ?? text?.text ?? '').slice(0, 240);
  }

  private nextSequence() {
    // Fixtures can assign a synthetic runtime identity before creating sessions.
    this.db
      .prepare('INSERT OR IGNORE INTO attention_projection_state VALUES(?,1,0,?)')
      .run(this.store.workspace.id, this.now());
    return Number(
      this.db
        .prepare(
          'UPDATE attention_projection_state SET sequence=sequence+1 WHERE runtime_id=? RETURNING sequence',
        )
        .get(this.store.workspace.id)!.sequence,
    );
  }

  private itemId(input: AttentionFactInput, kind: string, requestId?: string) {
    return (
      'attention_' +
      fingerprint([
        this.store.workspace.machineId,
        this.store.workspace.id,
        input.localProjectId,
        input.sessionId,
        input.assistantTurnId,
        kind,
        requestId ?? null,
      ])
    );
  }

  recordPermission(input: AttentionFactInput & { requestId: string }, occurredAt = this.now()) {
    return this.transaction(() =>
      this.insert(input, 'permission', input.requestId, 'active', null, false, occurredAt),
    );
  }

  recordOutcome(
    input: AttentionFactInput & { cause: AttentionCause; historical?: boolean },
    occurredAt: number | null = this.now(),
  ) {
    return this.transaction(() => {
      this.invalidateTurn(input.sessionId, input.assistantTurnId);
      return this.insert(
        input,
        'outcome',
        undefined,
        input.historical ? 'historical' : 'ended',
        input.cause,
        input.historical ?? false,
        occurredAt,
      );
    });
  }

  private insert(
    input: AttentionFactInput,
    kind: string,
    requestId: string | undefined,
    lifecycle: string,
    cause: string | null,
    historical: boolean,
    occurredAt: number | null,
  ) {
    const itemId = this.itemId(input, kind, requestId);
    const previous = this.db.prepare('SELECT * FROM attention_item WHERE item_id=?').get(itemId);
    if (previous) return itemId;
    this.db
      .prepare('INSERT INTO attention_item VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        itemId,
        this.store.workspace.id,
        this.store.workspace.machineId,
        input.localProjectId,
        input.sessionId,
        input.assistantTurnId,
        input.userTurnId,
        kind,
        requestId ?? null,
        lifecycle,
        cause,
        Number(historical),
        1,
        this.nextSequence(),
        occurredAt,
        (input.summary ?? '').slice(0, 240),
      );
    return itemId;
  }

  resolvePermission(
    sessionId: string,
    assistantTurnId: string,
    requestId: string,
    lifecycle: 'resolved' | 'invalidated' = 'resolved',
  ) {
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE attention_item SET lifecycle=?, revision=revision+1
        WHERE runtime_id=? AND session_id=? AND assistant_turn_id=? AND request_id=?
        AND kind='permission' AND lifecycle='active'`,
        )
        .run(lifecycle, this.store.workspace.id, sessionId, assistantTurnId, requestId);
    });
  }

  invalidateTurn(sessionId: string, assistantTurnId: string) {
    this.db
      .prepare(
        `UPDATE attention_item SET lifecycle='invalidated', revision=revision+1
      WHERE runtime_id=? AND session_id=? AND assistant_turn_id=?
      AND kind='permission' AND lifecycle='active'`,
      )
      .run(this.store.workspace.id, sessionId, assistantTurnId);
  }

  invalidatePermissions() {
    this.db
      .prepare(
        `UPDATE attention_item SET lifecycle='invalidated', revision=revision+1
      WHERE runtime_id=? AND kind='permission' AND lifecycle='active'`,
      )
      .run(this.store.workspace.id);
  }

  // Rebuilding this derived text never replaces the authoritative event row or
  // its observed versions, timestamps, causes and initialization boundary.
  rebuildSummaries() {
    this.transaction(() => {
      for (const session of this.db
        .prepare('SELECT DISTINCT session_id FROM attention_item WHERE runtime_id=?')
        .all(this.store.workspace.id)) {
        const sessionId = String(session.session_id),
          view = mirror(this.store.doc(sessionId), sessionId);
        const history = view.getState().history;
        for (const row of this.db
          .prepare('SELECT * FROM attention_item WHERE runtime_id=? AND session_id=?')
          .all(this.store.workspace.id, sessionId)) {
          const turn = history.find((entry) => entry.id === row.assistant_turn_id);
          if (!turn) continue;
          let summary: string | undefined;
          if (row.kind === 'outcome') summary = this.summary(turn.items);
          else {
            const tool = turn.items?.find(
              (item: any) => item.permissionRequest?.requestId === row.request_id,
            ) as any;
            if (tool) summary = String(tool.title ?? '等待审批').slice(0, 240);
          }
          if (summary !== undefined)
            this.db
              .prepare('UPDATE attention_item SET summary=? WHERE item_id=?')
              .run(summary, String(row.item_id));
        }
        view.dispose();
      }
    });
  }

  reconcilePermissions(localProjectId: string, isActive: (item: AttentionItem) => boolean) {
    this.transaction(() => {
      for (const row of this.db
        .prepare(
          `SELECT * FROM attention_item WHERE runtime_id=?
        AND local_project_id=? AND kind='permission' AND lifecycle='active'`,
        )
        .all(this.store.workspace.id, localProjectId)) {
        const item = this.toItem(row, '');
        if (!isActive(item))
          this.resolvePermission(
            item.sessionId,
            item.assistantTurnId,
            item.requestId!,
            'invalidated',
          );
      }
    });
  }

  private checkContext(input: AttentionContext, itemId?: string) {
    const context = attentionContextSchema.parse(input);
    assert(
      context.runtimeWorkspaceId === this.store.workspace.id &&
        context.machineId === this.store.workspace.machineId,
      400,
      '待办执行目标不匹配',
    );
    const project = this.store.machine.get(['localProject', context.localProjectId]);
    assert(
      project || this.store.workspace.projects.some((p) => p.id === context.localProjectId),
      404,
      '待办项目副本不可用',
    );
    if (context.sessionId) {
      const meta = metas(this.store.meta)['session-' + context.sessionId];
      assert(
        meta && (meta.project as any)?.localProjectId === context.localProjectId,
        404,
        '待办会话不属于当前项目',
      );
    }
    if (itemId) {
      assert(context.sessionId, 400, '待办操作必须指定会话');
      const row = this.db
        .prepare(
          `SELECT * FROM attention_item WHERE item_id=?
        AND runtime_id=? AND machine_id=? AND local_project_id=? AND session_id=?`,
        )
        .get(
          itemId,
          context.runtimeWorkspaceId,
          context.machineId,
          context.localProjectId,
          context.sessionId,
        );
      assert(row, 404, '待办事项不存在或执行目标不匹配');
      return row;
    }
    return undefined;
  }

  private observation(actor: string, itemId: string) {
    return this.db
      .prepare('SELECT * FROM attention_observation WHERE actor=? AND item_id=?')
      .get(actor, itemId);
  }

  private toItem(row: Record<string, unknown>, actor: string): AttentionItem {
    const observation = this.observation(actor, String(row.item_id));
    return {
      itemId: String(row.item_id),
      sessionId: String(row.session_id),
      localProjectId: String(row.local_project_id),
      assistantTurnId: String(row.assistant_turn_id),
      userTurnId: String(row.user_turn_id),
      kind: row.kind as AttentionItem['kind'],
      lifecycle: row.lifecycle as AttentionItem['lifecycle'],
      ...(row.request_id ? { requestId: String(row.request_id) } : {}),
      ...(row.cause ? { cause: row.cause as AttentionCause } : {}),
      eventRevision: Number(row.revision),
      sequence: Number(row.sequence),
      occurredAt: row.occurred_at === null ? null : Number(row.occurred_at),
      summary: String(row.summary),
      seenRevision: Number(observation?.seen_revision ?? 0),
      disposition: (observation?.disposition ?? 'pending') as AttentionItem['disposition'],
      observationRevision: Number(observation?.observation_revision ?? 0),
      ...(observation?.followup_user_turn_id
        ? { followupUserTurnId: String(observation.followup_user_turn_id) }
        : {}),
    };
  }

  get(context: AttentionContext, itemId: string): AttentionItem {
    return this.toItem(this.checkContext(context, itemId)!, actorKey(context.actor));
  }

  private pending(item: AttentionItem) {
    if (item.kind === 'permission') return item.lifecycle === 'active';
    if (item.disposition === 'checked' || item.disposition === 'continued') return false;
    if (item.observationRevision > 0) return true;
    return item.lifecycle === 'ended' && item.cause !== 'user_canceled';
  }

  private priority(item: AttentionItem) {
    if (item.kind === 'permission' && item.lifecycle === 'active') return 0;
    if (item.disposition === 'needs_followup') return 2;
    if (['execution_failed', 'host_stopped', 'host_restarted'].includes(item.cause ?? '')) return 1;
    return 3;
  }

  private compareItems(actor: string, view: AttentionListQuery['view']) {
    return (a: AttentionItem, b: AttentionItem) => {
      const order = this.priority(a) - this.priority(b);
      if (view === 'pending' && order) return order;
      if (view === 'pending' && this.priority(a) === 0) return a.sequence - b.sequence;
      if (view === 'pending' && this.priority(a) === 2) {
        const difference =
          Number(this.observation(actor, b.itemId)?.updated_at ?? 0) -
          Number(this.observation(actor, a.itemId)?.updated_at ?? 0);
        if (difference) return difference;
      }
      return b.sequence - a.sequence;
    };
  }

  private cursorOffset(cursor: string | undefined, scope: string, version: number, total: number) {
    if (!cursor) return 0;
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    } catch {
      assert(false, 400, '待办游标无效');
    }
    assert(parsed && parsed.scope === scope, 400, '待办游标不属于当前范围');
    assert(parsed.version === version, 409, '待办列表已更新，请重新读取');
    assert(
      Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 && parsed.offset <= total,
      400,
      '待办游标无效',
    );
    return parsed.offset as number;
  }

  private cursor(scope: string, version: number, offset: number) {
    return Buffer.from(JSON.stringify({ scope, version, offset })).toString('base64url');
  }

  sessionItems(
    context: AttentionContext,
    input: Partial<AttentionListQuery> = {},
  ): AttentionItemPage {
    this.checkContext(context);
    assert(context.sessionId, 400, '事项分页必须指定会话');
    const query = attentionListQuerySchema.parse(input),
      actor = actorKey(context.actor);
    const all = this.db
      .prepare(
        `SELECT * FROM attention_item WHERE runtime_id=?
      AND machine_id=? AND local_project_id=? AND session_id=?`,
      )
      .all(context.runtimeWorkspaceId, context.machineId, context.localProjectId, context.sessionId)
      .map((row) => this.toItem(row, actor))
      .filter((item) => this.pending(item) === (query.view === 'pending'))
      .sort(this.compareItems(actor, query.view));
    const version = parseInt(fingerprint(all).slice(0, 12), 16);
    const scope = fingerprint([context, query.view, query.limit, 'items']);
    const offset = this.cursorOffset(query.cursor, scope, version, all.length);
    const items = all.slice(offset, offset + query.limit),
      next = offset + items.length;
    return {
      items,
      total: all.length,
      version,
      ...(next < all.length ? { nextCursor: this.cursor(scope, version, next) } : {}),
    };
  }

  list(context: AttentionContext, input: Partial<AttentionListQuery> = {}): AttentionPage {
    this.checkContext(context);
    assert(!context.sessionId, 400, '待办列表需要明确的项目级范围');
    const query = attentionListQuerySchema.parse(input);
    const actor = actorKey(context.actor),
      metadata = metas(this.store.meta);
    const compare = this.compareItems(actor, query.view);
    const groups = new Map<string, AttentionGroup>();
    for (const row of this.db
      .prepare(
        `SELECT * FROM attention_item
      WHERE runtime_id=? AND machine_id=? AND local_project_id=? ORDER BY sequence`,
      )
      .all(context.runtimeWorkspaceId, context.machineId, context.localProjectId)) {
      const item = this.toItem(row, actor);
      if (this.pending(item) !== (query.view === 'pending')) continue;
      const meta = metadata['session-' + item.sessionId];
      if (!meta || (meta.project as any)?.localProjectId !== context.localProjectId) continue;
      let group = groups.get(item.sessionId);
      if (!group)
        groups.set(
          item.sessionId,
          (group = {
            sessionId: item.sessionId,
            title: String(meta.title ?? '未命名会话'),
            isArchived: meta.isArchived === true,
            items: [],
            itemCount: 0,
          }),
        );
      group.items.push(item);
      group.itemCount++;
    }
    const all = [...groups.values()];
    for (const group of all) group.items.sort(compare);
    all.sort((a, b) => compare(a.items[0], b.items[0]) || a.sessionId.localeCompare(b.sessionId));
    // A content-derived version isolates one Actor's pagination from other
    // accounts' private observations and also detects metadata-only changes.
    const version = parseInt(fingerprint(all).slice(0, 12), 16);
    const scope = fingerprint([context, query.view, query.limit]);
    const offset = this.cursorOffset(query.cursor, scope, version, all.length);
    const sessions = all.slice(offset, offset + query.limit).map((group) => ({
      ...group,
      items: group.items.slice(0, 50),
      ...(group.items.length > 50
        ? {
            nextItemsCursor: this.cursor(
              fingerprint([{ ...context, sessionId: group.sessionId }, query.view, 50, 'items']),
              parseInt(fingerprint(group.items).slice(0, 12), 16),
              50,
            ),
          }
        : {}),
    }));
    const next = offset + sessions.length;
    return {
      sessions,
      total: all.length,
      version,
      ...(next < all.length
        ? {
            nextCursor: this.cursor(scope, version, next),
          }
        : {}),
    };
  }

  private receiptFingerprint(
    context: AttentionContext,
    itemId: string,
    method: string,
    request: unknown,
  ) {
    return fingerprint([
      method,
      actorKey(context.actor),
      context.executionDeviceId,
      context.machineId,
      context.runtimeWorkspaceId,
      context.localProjectId,
      context.sessionId,
      itemId,
      request,
    ]);
  }

  lookupReceipt(
    context: AttentionContext,
    itemId: string,
    method: string,
    request: unknown,
    operationId: string,
  ): AttentionReceipt | undefined {
    this.checkContext(context, itemId);
    const row = this.db
      .prepare('SELECT * FROM attention_receipt WHERE actor=? AND operation_id=?')
      .get(actorKey(context.actor), operationId);
    if (!row) return undefined;
    assert(
      row.fingerprint === this.receiptFingerprint(context, itemId, method, request),
      409,
      '重复编号对应不同待办请求或执行绑定',
    );
    return JSON.parse(String(row.result));
  }

  hasReceipt(actor: AttentionActor, operationId: string) {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM attention_receipt WHERE actor=? AND operation_id=?')
        .get(actorKey(actor), operationId),
    );
  }

  acceptReceipt(
    context: AttentionContext,
    itemId: string,
    method: string,
    request: unknown,
    operationId: string,
    result?: AttentionReceipt,
  ): AttentionReceipt {
    this.checkContext(context, itemId);
    const accepted = result ?? {
      accepted: true,
      delivered: true,
      operationId,
      item: this.get(context, itemId),
    };
    this.db
      .prepare('INSERT INTO attention_receipt VALUES(?,?,?,?)')
      .run(
        actorKey(context.actor),
        operationId,
        this.receiptFingerprint(context, itemId, method, request),
        JSON.stringify(accepted),
      );
    return accepted;
  }

  seen(context: AttentionContext, itemId: string, input: AttentionSeen): AttentionReceipt {
    const request = attentionSeenSchema.parse(input);
    return this.transaction(() => {
      const previous = this.lookupReceipt(context, itemId, 'seen', request, request.operationId);
      if (previous) return previous;
      const item = this.get(context, itemId);
      assert(
        request.eventRevision > 0 && request.eventRevision <= item.eventRevision,
        409,
        '待办事项版本已变化或不存在',
      );
      this.db
        .prepare(
          `INSERT INTO attention_observation VALUES(?,?,?,'pending',0,?,NULL)
        ON CONFLICT(actor,item_id) DO UPDATE SET
        seen_revision=MAX(seen_revision,excluded.seen_revision)`,
        )
        .run(actorKey(context.actor), itemId, request.eventRevision, this.now());
      return this.acceptReceipt(context, itemId, 'seen', request, request.operationId);
    });
  }

  disposition(
    context: AttentionContext,
    itemId: string,
    input: AttentionDisposition,
  ): AttentionReceipt {
    const request = attentionDispositionSchema.parse(input);
    return this.transaction(() => {
      const previous = this.lookupReceipt(
        context,
        itemId,
        'disposition',
        request,
        request.operationId,
      );
      if (previous) return previous;
      const item = this.checkDecision(context, itemId, request);
      assert(
        request.disposition !== 'pending' ||
          item.disposition === 'checked' ||
          item.disposition === 'continued' ||
          item.lifecycle === 'historical' ||
          item.cause === 'user_canceled',
        409,
        '该事项已处于待处理状态',
      );
      this.writeDisposition(context, item, request.disposition);
      return this.acceptReceipt(context, itemId, 'disposition', request, request.operationId);
    });
  }

  private checkDecision(
    context: AttentionContext,
    itemId: string,
    request: { eventRevision: number; observationRevision: number },
  ) {
    const item = this.get(context, itemId);
    assert(item.kind === 'outcome', 409, '审批事项必须通过原始审批处理');
    assert(item.eventRevision === request.eventRevision, 409, '待办事项已更新，请刷新后重试');
    assert(
      item.observationRevision === request.observationRevision,
      409,
      '待办处理状态已更新，请刷新后重试',
    );
    return item;
  }

  private writeDisposition(
    context: AttentionContext,
    item: AttentionItem,
    disposition: AttentionItem['disposition'],
    followupUserTurnId?: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO attention_observation VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(actor,item_id) DO UPDATE SET disposition=excluded.disposition,
      observation_revision=excluded.observation_revision, updated_at=excluded.updated_at,
      followup_user_turn_id=excluded.followup_user_turn_id`,
      )
      .run(
        actorKey(context.actor),
        item.itemId,
        item.seenRevision,
        disposition,
        item.observationRevision + 1,
        this.now(),
        followupUserTurnId ?? null,
      );
  }

  prepareContinue(context: AttentionContext, itemId: string, input: AttentionContinue) {
    const request = attentionContinueSchema.parse(input);
    const item = this.checkDecision(context, itemId, request);
    assert(item.disposition === 'needs_followup', 409, '请先将该事项标记为需要继续');
    assert(
      request.mutation.sessionId === context.sessionId &&
        request.mutation.workspaceId === context.runtimeWorkspaceId,
      400,
      '后续指令与待办执行目标不匹配',
    );
    return item;
  }

  continue(
    context: AttentionContext,
    itemId: string,
    input: AttentionContinue,
    followupUserTurnId: string,
  ): AttentionReceipt {
    const request = attentionContinueSchema.parse(input);
    assert(this.db.isTransaction, 500, '关联继续必须与新回合在同一主机事务中保存');
    const previous = this.lookupReceipt(
      context,
      itemId,
      'continue',
      request,
      request.mutation.operationId,
    );
    if (previous) return previous;
    const item = this.prepareContinue(context, itemId, request);
    this.writeDisposition(context, item, 'continued', followupUserTurnId);
    return this.acceptReceipt(context, itemId, 'continue', request, request.mutation.operationId);
  }
}
