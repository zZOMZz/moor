import type { FeatureContext } from './feature-context';
import { attachmentActionSchema, ATTACHMENTS_FEATURE } from '@moor/protocol/attachment-protocol';
import { sessionActionSchema, type SessionAction } from '@moor/protocol/protocol';
import { sessionControlActionSchema } from '@moor/protocol/session-control-protocol';
import { SESSION_INTENTS_FEATURE } from '@moor/protocol/session-intent-protocol';
import { type SessionMetadata } from '@moor/protocol/session-responses';
import {
  taskActionSchema,
  validateTaskActionResult,
  type TaskAction,
} from '@moor/protocol/task-protocol';
import { type WorkspaceSource } from '@moor/protocol/workspace-client-protocol';
import {
  readClientSession,
  type SessionPermissionOutcome,
  type SessionPermissionReview,
} from '@moor/session/session-operations';
import {
  deliverOriginalOperation,
  persistOriginalConfirmation,
  recoverOriginalOperation,
} from '../../operations/session-operation';
import { sessionPendingOperations, WorkspacePersistence } from '../../operations/workspace/compose';
import { emptyWorkspaceAttachments } from '../attachments/workspace-attachments';
import { buildRespondPermission, buildSendTurn } from '../sessions/session-intent';
import type { WorkspaceAttachmentsService } from './attachments';
import type { WorkspaceCatalogService } from './catalog';
import type { WorkspaceDraftsService } from './drafts';
import { Context, Project, same } from './model';
import type { WorkspaceSessionsService } from './sessions';
import type { WorkspaceSyncService } from './sync';
/** Capabilities consumed by commands use cases; supplied only by the workspace composition root. */
export interface WorkspaceCommandsPorts {
  context: FeatureContext<
    'value' | 'context' | 'uuid' | 'execute' | 'command' | 'emit' | 'generation' | 'closed',
    'draft' | 'ledger' | 'offline' | 'scope' | 'sendProgress' | 'session' | 'sessionId',
    | 'session'
    | 'tasks-action'
    | 'send-turn'
    | 'respond-permission'
    | 'mutate'
    | 'session-control'
    | 'session-action'
    | 'attachment-action'
    | 'session-operations',
    never
  >;
  drafts: Pick<WorkspaceDraftsService, 'flushDraft' | 'reloadLedger' | 'draftInput'>;
  sessions: Pick<
    WorkspaceSessionsService,
    'refreshSession' | 'refreshAgentOptions' | 'exportSessionSnapshot'
  >;
  store: Pick<
    WorkspacePersistence,
    | 'stage'
    | 'read'
    | 'exclusiveOperation'
    | 'saveTasks'
    | 'attentionBlocked'
    | 'githubBlocked'
    | 'forkBlocked'
    | 'operation'
    | 'finish'
  >;
  catalog: Pick<
    WorkspaceCatalogService,
    'refreshSessions' | 'projectContext' | 'invalidateProject'
  >;
  sync: Pick<WorkspaceSyncService, 'scheduleSync'>;
  attachments: Pick<WorkspaceAttachmentsService, 'performAttachmentAction'>;
}
export class WorkspaceCommandsService {
  constructor(readonly ports: WorkspaceCommandsPorts) {}
  sendFlight?: { generation: number };
  async metadata(
    action: SessionAction['action'],
    title?: string,
    reviewed = this.ports.context.value.session?.meta,
  ) {
    const shown = structuredClone(reviewed);
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    if (!shown || shown.id !== context.sessionId) throw Error('请先读取原会话。');
    if (this.ports.context.value.offline) throw Error('执行电脑离线，请连接后手动整理会话。');
    await this.ports.sessions.refreshSession();
    context.current();
    const read = this.ports.context.value.session!;
    if (
      !read.persisted ||
      read.persistenceError ||
      (read.meta.metadataRevision ?? 0) !== (shown.metadataRevision ?? 0)
    )
      throw Error('会话信息已改变，请重新查看后操作。');
    const request = sessionActionSchema.parse({
      action,
      operationId: this.ports.context.uuid(),
      workspaceId: context.scope.target.workspaceId,
      localProjectId: context.scope.target.localProjectId,
      sessionId: shown.id,
      expectedRevision: shown.metadataRevision ?? 0,
      ...(action === 'rename' ? { title } : {}),
    });
    await this.ports.store.stage(
      context.scope,
      { kind: 'metadata', value: request },
      undefined,
      context.current,
    );
    await this.ports.drafts.reloadLedger(context);
    await this.retry(request.operationId);
    await this.ports.sessions.refreshSession();
    await this.ports.catalog.refreshSessions();
  }
  async projectMetadata(
    source: WorkspaceSource,
    target: Project['target'],
    reviewed: SessionMetadata,
    action: SessionAction['action'],
    title?: string,
  ) {
    const shown = structuredClone(reviewed);
    const context = this.ports.catalog.projectContext(source, target, shown.id);
    if (
      shown.userId !== target.userId ||
      shown.machineId !== target.machineId ||
      shown.project.localProjectId !== target.localProjectId
    )
      throw Error('会话信息与原执行范围不匹配。');
    if (!context.project.online) throw Error('执行电脑离线，请连接后手动整理会话。');
    const read = readClientSession(
      await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'session', { sessionId: shown.id }),
      ),
      { ...target, sessionId: shown.id },
    );
    if (
      !read.persisted ||
      read.persistenceError ||
      (read.meta.metadataRevision ?? 0) !== (shown.metadataRevision ?? 0)
    )
      throw Error('会话信息已改变，请重新查看后操作。');
    const request = sessionActionSchema.parse({
      action,
      operationId: this.ports.context.uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId: shown.id,
      expectedRevision: shown.metadataRevision ?? 0,
      ...(action === 'rename' ? { title } : {}),
    });
    await this.ports.store.stage(
      context.scope,
      { kind: 'metadata', value: request },
      undefined,
      context.current,
    );
    try {
      await this.deliverOperation(context, request.operationId);
    } finally {
      context.current();
      this.ports.catalog.invalidateProject(source, target);
      // Only the journal changes here: a sidebar action cannot overwrite an in-memory draft.
      if (same(context.scope, this.ports.context.value.scope)) {
        const ledger = await this.ports.store.read(
          context.scope,
          context.current,
          this.ports.context.value.sessionId ?? [],
        );
        if (same(context.scope, this.ports.context.value.scope))
          this.ports.context.value.ledger = ledger;
      }
      this.ports.context.emit();
      this.ports.sync.scheduleSync({
        source,
        owner: target.owner,
        connectionId: context.connectionId,
        kind: 'changed',
        deviceId: target.deviceId,
        workspaceId: target.workspaceId,
        sessionId: shown.id,
      });
    }
    if (same(context.scope, this.ports.context.value.scope)) {
      await this.ports.catalog.refreshSessions();
      if (this.ports.context.value.sessionId === shown.id)
        await this.ports.sessions.refreshSession({ announce: false, background: true });
    }
  }
  async createSession(agentId: string, title?: string) {
    const sessionId = this.ports.context.uuid(),
      context = this.ports.context.context(sessionId);
    if (!context.project.runtime.agents.some((agent) => agent.id === agentId))
      throw Error('Agent 不属于所选电脑。');
    const { target } = context.scope;
    const value = sessionControlActionSchema.parse({
      controlVersion: 1,
      action: 'create',
      operationId: this.ports.context.uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      userId: target.userId,
      machineId: target.machineId,
      sessionId,
      agentId,
      ...(title ? { title } : {}),
    });
    await this.ports.store.stage(
      context.scope,
      { kind: 'control', value },
      undefined,
      context.current,
    );
    await this.ports.drafts.reloadLedger(context);
    await this.retry(value.operationId);
    return sessionId;
  }
  async recoverRetiredTask(shown: TaskAction, mode: 'inspect' | 'retry') {
    const original = taskActionSchema.parse(structuredClone(shown));
    if (mode !== 'inspect' && mode !== 'retry') throw Error('仅支持核查或重试原操作。');
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开原会话。');
    return this.ports.store.exclusiveOperation(
      context.scope,
      'tasks:' + sessionId,
      context.current,
      async () => {
        const saved = (
          await this.ports.store.read(context.scope, context.current, context.sessionId ?? [])
        ).tasks?.[sessionId];
        if (!saved?.pending || !same(saved.pending, original))
          throw Error('原任务操作已改变，请重新读取会话。');
        const request =
          mode === 'retry'
            ? original
            : taskActionSchema.parse({
                taskVersion: original.taskVersion,
                workspaceId: original.workspaceId,
                localProjectId: original.localProjectId,
                sessionId: original.sessionId,
                grantId: original.grantId,
                operationId: original.operationId,
                action: 'inspect',
              });
        const result = validateTaskActionResult(
          await this.ports.context.execute(
            context,
            this.ports.context.command(context.scope, 'tasks-action', request),
          ),
          request,
        );
        context.current();
        if (
          (result.operation &&
            ['accepted', 'abandoned', 'rejected'].includes(result.operation.state)) ||
          (original.action === 'revoke' && result.grant.state !== 'active')
        ) {
          await this.ports.store.saveTasks(
            context.scope,
            sessionId,
            saved.cacheRevision,
            { ...saved, cacheRevision: saved.cacheRevision + 1, pending: undefined },
            context.current,
          );
          await this.ports.drafts.reloadLedger(context);
        }
        return result;
      },
    );
  }
  async send() {
    const context = this.ports.context.context(),
      sessionId = context.sessionId;
    if (!sessionId || !this.ports.context.value.draft) throw Error('请先打开会话。');
    if (this.sendFlight?.generation === this.ports.context.generation)
      throw Error('此会话正在准备或发送，请等待本次发送结果。');
    // Freeze the click before flushDraft can await a write and receive later
    // input. Only the captured write's committed revision is filled in later.
    const input = this.ports.drafts.draftInput,
      draft = structuredClone(
        input
          ? {
              text: input.text,
              selection: input.selection,
              revision: this.ports.context.value.draft.revision,
            }
          : this.ports.context.value.draft,
      );
    const mcpRevision = this.ports.context.value.ledger?.mcp?.[sessionId]?.cacheRevision ?? 0;
    const taskRevision = this.ports.context.value.ledger?.tasks?.[sessionId]?.cacheRevision ?? 0;
    const annotationRevision =
      this.ports.context.value.ledger?.annotations?.[sessionId]?.cacheRevision ?? 0;
    const attachments = structuredClone(
      this.ports.context.value.ledger?.attachments?.[sessionId] ?? emptyWorkspaceAttachments(),
    );
    const flight = { generation: this.ports.context.generation };
    this.sendFlight = flight;
    this.ports.context.value.sendProgress = { sessionId, stage: 'preparing' };
    this.ports.context.emit();
    try {
      await this.ports.drafts.flushDraft();
      context.current();
      if (input) {
        if (!input.committed) throw Error('发送时的草稿已改变，请确认当前内容后再次发送。');
        draft.revision = input.committed.revision;
      }
      if (!context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE))
        throw Error('执行电脑不支持新的会话发送接口，请升级主机；草稿未发送。');
      // This explicit send authorizes only these bytes and options. Later edits
      // remain a separate draft, including while uploads wait for their receipts.
      const readAttachments = async () => {
        const ledger = await this.ports.store.read(context.scope, context.current, sessionId);
        const current = ledger.attachments?.[sessionId] ?? emptyWorkspaceAttachments();
        if (
          current.items.length !== attachments.items.length ||
          current.items.some((item, index) => {
            const expected = attachments.items[index]!;
            return (
              !same(item.reference, expected.reference) ||
              item.data !== expected.data ||
              item.uploaded !== expected.uploaded ||
              !!item.pending ||
              !!expected.pending
            );
          })
        )
          throw Error('附件草稿已改变或原上传尚未确认，请重新读取后继续。');
        return { ledger, attachments: current };
      };
      await this.ports.sessions.refreshSession();
      await this.ports.sessions.refreshAgentOptions();
      context.current();
      const { ledger } = await readAttachments();
      if (sessionPendingOperations(ledger, sessionId).length)
        throw Error('请先核查此会话尚未确认的原操作。');
      if (this.ports.store.attentionBlocked(ledger, sessionId))
        throw Error('请先核查原待办指令或审批。');
      if (this.ports.store.githubBlocked(ledger, sessionId))
        throw Error('请先确认 GitHub 原操作，再发送新指令。');
      if (ledger.git?.[sessionId]?.pending) throw Error('请先确认原 Git 操作，再发送新指令。');
      if (this.ports.store.forkBlocked(ledger, sessionId))
        throw Error('请先核查原 Fork，再发送新指令。');
      // Validate the fixed prompt, Agent capabilities and idle turn before any upload.
      const value = buildSendTurn({
        scope: { ...context.scope.target, sessionId },
        read: this.ports.sessions.exportSessionSnapshot(context),
        agent: this.ports.context.value.session!.agent!,
        prompt: draft.text,
        selection: draft.selection,
        operationId: this.ports.context.uuid(),
        turnId: this.ports.context.uuid(),
        attachments: attachments.items.map((item) => item.reference),
      });
      const uploads = attachments.items.filter((item) => !item.uploaded);
      if (uploads.length && !context.project.runtime.features?.includes(ATTACHMENTS_FEATURE))
        throw Error('执行电脑暂不支持附件，请更新主机。');
      for (const [index, item] of uploads.entries()) {
        await readAttachments();
        this.ports.context.value.sendProgress = {
          sessionId,
          stage: 'uploading',
          uploaded: index,
          total: uploads.length,
        };
        this.ports.context.emit();
        await this.ports.attachments.performAttachmentAction(
          context,
          attachmentActionSchema.parse({
            contentVersion: 1,
            operationId: this.ports.context.uuid(),
            workspaceId: context.scope.target.workspaceId,
            localProjectId: context.scope.target.localProjectId,
            sessionId,
            action: 'upload',
            attachment: item.reference,
            data: item.data,
          }),
        );
        item.uploaded = true;
      }
      // Saving new input never expands the submitted prompt. A failed upload
      // exits before creating a send operation; reconnect/retry cannot resume it.
      await this.ports.drafts.flushDraft();
      context.current();
      const confirmed = await readAttachments();
      this.ports.context.value.sendProgress = { sessionId, stage: 'sending' };
      this.ports.context.emit();
      await this.ports.store.stage(
        context.scope,
        { kind: 'send-turn', value },
        {
          sessionId,
          revision: draft.revision,
          attachmentRevision: confirmed.attachments.revision,
          mcpRevision,
          taskRevision,
          annotationRevision,
        },
        context.current,
        undefined,
        undefined,
        undefined,
        true,
      );
      await this.ports.drafts.reloadLedger(context);
      await this.deliverOperation(context, value.operationId);
      await this.ports.drafts.reloadLedger(context);
    } finally {
      if (this.sendFlight === flight) {
        this.sendFlight = undefined;
        if (!this.ports.context.closed && this.ports.context.value.sendProgress) {
          delete this.ports.context.value.sendProgress;
          this.ports.context.emit();
        }
      }
    }
  }
  async respondPermission(review: SessionPermissionReview, outcome: SessionPermissionOutcome) {
    const context = this.ports.context.context();
    if (!context.sessionId) throw Error('请先打开会话。');
    if (!context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE))
      throw Error('执行电脑不支持新的审批接口，请升级主机；审批未发送。');
    await this.ports.sessions.refreshSession();
    context.current();
    const value = buildRespondPermission({
      scope: { ...context.scope.target, sessionId: context.sessionId },
      read: this.ports.sessions.exportSessionSnapshot(context),
      review,
      outcome,
      operationId: this.ports.context.uuid(),
    });
    await this.ports.store.stage(
      context.scope,
      { kind: 'respond-permission', value },
      undefined,
      context.current,
    );
    await this.ports.drafts.reloadLedger(context);
    await this.retry(value.operationId);
  }
  async stop(turnId: string) {
    const context = this.ports.context.context();
    if (!context.sessionId) throw Error('请先打开会话。');
    await this.ports.sessions.refreshSession();
    context.current();
    if (
      !this.ports.context.value.session?.history.some(
        (turn) => turn.role === 'assistant' && turn.id === turnId && !turn.finished,
      )
    )
      throw Error('此回合已经结束或改变，请重新读取。');
    const { target } = context.scope;
    const value = sessionControlActionSchema.parse({
      controlVersion: 1,
      action: 'stop',
      operationId: this.ports.context.uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      userId: target.userId,
      machineId: target.machineId,
      sessionId: context.sessionId,
      turnId,
    });
    await this.ports.store.stage(
      context.scope,
      { kind: 'control', value },
      undefined,
      context.current,
    );
    await this.ports.drafts.reloadLedger(context);
    await this.retry(value.operationId);
  }
  async retry(operationId: string) {
    const context = this.ports.context.context();
    await this.deliverOperation(context, operationId);
    await this.ports.drafts.reloadLedger(context);
  }
  async deliverOperation(context: Context, operationId: string) {
    await this.ports.store.exclusiveOperation(
      context.scope,
      operationId,
      context.current,
      async () => {
        const entry = await this.ports.store.operation(context.scope, operationId, context.current);
        const ledger = await this.ports.store.read(
          context.scope,
          context.current,
          entry?.original.value.sessionId ?? [],
        );
        if (!entry || entry.status !== 'pending') throw Error('此原操作无需重试，请重新读取。');
        const original = entry.original;
        if (
          (original.kind === 'send-turn' || original.kind === 'respond-permission') &&
          !context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE)
        )
          throw Error('执行电脑不支持原会话请求接口，请升级主机后手动核查。');
        if (
          ['mutation', 'send-turn', 'respond-permission'].includes(original.kind) &&
          (ledger.git?.[original.value.sessionId]?.pending ||
            this.ports.store.forkBlocked(ledger, original.value.sessionId) ||
            this.ports.store.githubBlocked(ledger, original.value.sessionId) ||
            this.ports.store.attentionBlocked(ledger, original.value.sessionId))
        )
          throw Error('请先核查原 Git 操作，再重试会话指令。');
        const confirmation = await deliverOriginalOperation(
          { controlVersion: 1, ...context.scope.target, sessionId: original.value.sessionId },
          original,
          {
            dispatch: (method, input) =>
              this.ports.context.execute(
                { ...context, sessionId: original.value.sessionId },
                this.ports.context.command(context.scope, method, input),
              ),
          },
        );
        if (confirmation.status !== 'pending')
          await persistOriginalConfirmation(operationId, confirmation.status, context.current, () =>
            this.ports.store.finish(
              context.scope,
              original,
              confirmation.status as 'confirmed' | 'abandoned',
              context.current,
            ),
          );
      },
    );
    this.ports.catalog.invalidateProject(context.scope.source, context.scope.target);
    this.ports.sync.scheduleSync({
      source: context.scope.source,
      connectionId: context.connectionId,
      owner: context.scope.target.owner,
      kind: 'changed',
      deviceId: context.scope.target.deviceId,
      workspaceId: context.scope.target.workspaceId,
      sessionId: context.sessionId,
    });
  }
  inspect(operationId: string) {
    return this.recover(operationId, 'inspect');
  }
  abandon(operationId: string) {
    return this.recover(operationId, 'abandon');
  }
  async recover(operationId: string, action: 'inspect' | 'abandon') {
    const context = this.ports.context.context();
    await this.ports.store.exclusiveOperation(
      context.scope,
      operationId,
      context.current,
      async () => {
        const entry = await this.ports.store.operation(context.scope, operationId, context.current);
        const ledger = await this.ports.store.read(
          context.scope,
          context.current,
          entry?.original.value.sessionId ?? [],
        );
        if (!entry || entry.status !== 'pending') throw Error('此原操作无需核查。');
        const target = context.scope.target,
          sessionId = entry.original.value.sessionId;
        const result = await recoverOriginalOperation(
          { controlVersion: 1, ...target, sessionId },
          entry.original,
          action,
          {
            dispatch: (method, input) =>
              this.ports.context.execute(
                { ...context, sessionId },
                this.ports.context.command(context.scope, method, input),
              ),
          },
        );
        if (result.found && result.receipt.status !== 'stopping')
          await persistOriginalConfirmation(
            operationId,
            result.receipt.status === 'abandoned' ? 'abandoned' : 'confirmed',
            context.current,
            () =>
              this.ports.store.finish(
                context.scope,
                entry.original,
                result.receipt.status === 'abandoned' ? 'abandoned' : 'confirmed',
                context.current,
              ),
          );
      },
    );
    await this.ports.drafts.reloadLedger(context);
  }
}
