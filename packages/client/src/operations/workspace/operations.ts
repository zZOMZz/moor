import type { StorageBackend } from '@moor/client/operations/storage';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import {
  sessionOriginalOperationSchema,
  type SessionOriginalOperation,
} from '@moor/protocol/session-control-protocol';
import { emptyWorkspaceAttachments } from '../../features/attachments/workspace-attachments';
import { workspaceAttentionPending } from '../../features/attention/workspace-attention';
import { workspaceForkPending } from '../../features/fork/workspace-fork';
import { mcpReviewSchema, type McpReview } from '../../features/mcp/mcp';
import { workspaceFeatureTarget } from '../../features/mcp/workspace-mcp';
import {
  previewAnnotationSubmissionSchema,
  type PreviewAnnotationSubmission,
} from '../../features/preview/project-preview';
import { taskReviewedSchema, type ReviewedTasks } from '../../features/tasks/tasks';
import type { WorkspaceLedgerPersistence } from './ledger';
import {
  conflict,
  mutationVersion,
  operationSchema,
  same,
  scopeSchema,
  WorkspaceLedger,
  WorkspaceOperation,
  WorkspaceScope,
} from './model';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceOperationsPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'validateOriginal' | 'change'>;
}
export class WorkspaceOperationsPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceOperationsPersistencePorts,
  ) {}
  async stage(
    scope: WorkspaceScope,
    original: SessionOriginalOperation,
    draft: WorkspaceOperation['draft'],
    current: () => void,
    mcpReview?: McpReview,
    annotations?: PreviewAnnotationSubmission,
    taskReview?: ReviewedTasks,
    plainTurn = false,
  ) {
    if (plainTurn && (mcpReview || annotations || taskReview)) throw conflict();
    original = sessionOriginalOperationSchema.parse(original);
    if (original.kind === 'send-turn') plainTurn = true;
    draft = draft === undefined ? undefined : operationSchema.shape.draft.parse(draft);
    if (original.kind === 'respond-permission' && draft)
      throw Error('审批原操作不能清除聊天草稿。');
    this.ports.ledger.validateOriginal(scope, original);
    mcpReview = mcpReview === undefined ? undefined : mcpReviewSchema.parse(mcpReview);
    taskReview = taskReview === undefined ? undefined : taskReviewedSchema.parse(taskReview);
    if (taskReview && (!draft || original.kind !== 'mutation' || original.value.kind !== 'turn'))
      throw Error('任务授权只能与父指令一起保存。');
    annotations =
      annotations === undefined ? undefined : previewAnnotationSubmissionSchema.parse(annotations);
    if (
      annotations &&
      (!draft ||
        original.kind !== 'mutation' ||
        original.value.kind !== 'turn' ||
        !same(
          annotations.target,
          workspaceFeatureTarget({ ...scope.target, sessionId: original.value.sessionId }),
        ))
    )
      throw Error('标注只能与原会话的新指令一起保存。');
    if (mcpReview && (!draft || original.kind !== 'mutation' || original.value.kind !== 'turn'))
      throw Error('MCP 授权只能用于已审阅的新指令。');
    const requestVersion =
      original.kind === 'mutation' && draft ? await mutationVersion(original.value) : undefined;
    return this.ports.ledger.change(
      scope,
      current,
      [original.value.sessionId],
      (state) => {
        const found = state.operations.find(
          (operation) => operation.original.value.operationId === original.value.operationId,
        );
        if (found) {
          if (
            !same(found.original, original) ||
            !same(found.draft ?? null, draft ?? null) ||
            !same(found.mcpReview ?? null, mcpReview ?? null) ||
            !same(found.annotations ?? null, annotations ?? null) ||
            !same(found.taskReview ?? null, taskReview ?? null)
          )
            throw conflict();
          return structuredClone(found);
        }
        if (
          draft &&
          state.operations.some(
            (item) =>
              item.status === 'pending' &&
              item.original.value.sessionId === original.value.sessionId,
          )
        )
          throw Error('请先核查此会话尚未确认的原操作。');
        if (draft && draft.sessionId !== original.value.sessionId) throw conflict();
        if (
          original.kind === 'metadata' &&
          state.operations.some(
            (entry) =>
              entry.status === 'pending' &&
              entry.original.kind === 'metadata' &&
              entry.original.value.sessionId === original.value.sessionId,
          )
        )
          throw Error('请先核查原会话整理操作。');
        if (draft) {
          const tasks = state.tasks?.[draft.sessionId];
          if (
            (tasks?.cacheRevision ?? 0) !== (draft.taskRevision ?? 0) ||
            tasks?.delivery ||
            tasks?.pending ||
            (!plainTurn && !same(tasks?.enabled ?? null, taskReview ?? null))
          )
            throw Error('任务计划已改变或原任务操作尚未确认，请重新读取。');
          if (taskReview) {
            if (!tasks || !requestVersion) throw conflict();
            tasks.delivery = {
              operationId: original.value.operationId,
              review: structuredClone(taskReview),
              requestVersion,
            };
            tasks.cacheRevision++;
          }
          const savedAnnotations = state.annotations?.[draft.sessionId];
          const selection = (savedAnnotations?.annotations ?? [])
            .filter((item) => item.selectionId)
            .map((item) => ({ id: item.id, version: item.version, selectionId: item.selectionId }));
          if (
            (savedAnnotations?.cacheRevision ?? 0) !== (draft.annotationRevision ?? 0) ||
            (!plainTurn && !same(selection, annotations?.selection ?? []))
          )
            throw Error('标注草稿已改变，请重新读取后发送。');
          if (this.forkBlocked(state, draft.sessionId))
            throw Error('请先核查原 Fork，源会话和预留副本不能发送新指令。');
          if (this.attentionBlocked(state, draft.sessionId))
            throw Error('请先核查原待办指令或审批。');
          if (this.githubBlocked(state, draft.sessionId))
            throw Error('请先核查 GitHub 原绑定、提交或推送，再发送新指令。');
          if (state.git?.[draft.sessionId]?.pending)
            throw Error('请先确认原 Git 操作，再发送新指令。');
          if (state.interactions?.[draft.sessionId]?.value.pending)
            throw Error('请先核查原会话交互，不能发送新的指令。');
          const mcp = state.mcp?.[draft.sessionId];
          if (
            (mcp?.cacheRevision ?? 0) !== (draft.mcpRevision ?? 0) ||
            mcp?.delivery ||
            (!plainTurn &&
              !same(mcpReview ?? null, mcp?.review?.servers.length ? mcp.review : null))
          )
            throw Error('MCP 草稿已改变或原授权尚未确认，请重新读取。');
          if (mcpReview) {
            if (!mcp || !requestVersion) throw conflict();
            mcp.delivery = {
              operationId: original.value.operationId,
              review: structuredClone(mcpReview),
              requestVersion,
            };
            mcp.cacheRevision++;
          }
          const attachments = state.attachments?.[draft.sessionId] ?? emptyWorkspaceAttachments();
          if (
            (draft.attachmentRevision ?? 0) !== attachments.revision ||
            attachments.items.some((item) => !item.uploaded || item.pending) ||
            (original.kind === 'send-turn' &&
              !same(
                original.value.attachments,
                attachments.items.map((item) => item.reference),
              ))
          )
            throw Error('附件草稿已改变或尚未上传，请重新读取后继续。');
        }
        if (
          draft &&
          state.operations.some(
            (item) =>
              item.status === 'pending' &&
              item.draft?.sessionId === draft.sessionId &&
              item.draft.revision === draft.revision,
          )
        )
          throw conflict();
        const operation = operationSchema.parse({
          original,
          ...(mcpReview ? { mcpReview } : {}),
          ...(taskReview ? { taskReview } : {}),
          ...(annotations ? { annotations } : {}),
          ...(draft ? { draft } : {}),
          status: 'pending',
        });
        state.operations.push(operation);
        if (original.kind === 'attachment') {
          const request = original.value,
            attachments = state.attachments?.[request.sessionId];
          const attachmentId =
            request.action === 'upload' ? request.attachment.attachmentId : request.attachmentId;
          const item = attachments?.items.find(
            (item) => item.reference.attachmentId === attachmentId,
          );
          if (
            !item ||
            item.pending ||
            (request.action === 'upload' &&
              (!same(item.reference, request.attachment) || item.data !== request.data))
          )
            throw conflict();
          item.pending = {
            owner: scope.target.owner,
            deviceId: scope.target.deviceId,
            catalogWorkspaceId: scope.target.catalogWorkspaceId,
            replicaId: scope.target.replicaId,
            request,
          };
          attachments!.revision++;
        }
        return structuredClone(operation);
      },
      [original.value.operationId],
    );
  }
  attentionBlocked(ledger: WorkspaceLedger, sessionId: string) {
    return workspaceAttentionPending(ledger.attention, sessionId).some((entry) =>
      ['continue', 'permission'].includes(entry.operation.kind),
    );
  }
  githubBlocked(ledger: WorkspaceLedger, sessionId: string) {
    const action = ledger.githubWrite?.[sessionId]?.pending?.request.action;
    return !!ledger.github?.[sessionId]?.pending || action === 'commit' || action === 'push';
  }
  forkBlocked(ledger: WorkspaceLedger, sessionId: string) {
    return Object.values(ledger.forks ?? {}).some((record) => {
      const operation = workspaceForkPending(record);
      return (
        operation &&
        (operation.request.sessionId === sessionId ||
          operation.request.childSessionId === sessionId)
      );
    });
  }
  exclusiveOperation<T>(
    scope: WorkspaceScope,
    operationId: string,
    current: () => void,
    task: () => Promise<T>,
  ) {
    return this.backend.exclusive(
      canonical(['moor-desktop-operation-v1', scopeSchema.parse(scope), operationId]),
      current,
      task,
    );
  }
  async finish(
    scope: WorkspaceScope,
    original: SessionOriginalOperation,
    status: 'confirmed' | 'abandoned',
    current: () => void,
  ) {
    return this.ports.ledger.change(
      scope,
      current,
      [original.value.sessionId],
      (state) => {
        const operation = state.operations.find(
          (item) => item.original.value.operationId === original.value.operationId,
        );
        if (
          !operation ||
          !same(operation.original, original) ||
          (operation.status !== 'pending' && operation.status !== status)
        )
          throw conflict();
        if (operation.status === status) return;
        operation.status = status;
        const tasks = state.tasks?.[original.value.sessionId];
        if (tasks?.delivery?.operationId === original.value.operationId) {
          if (status === 'confirmed' && tasks.enabled?.reviewId === tasks.delivery.review.reviewId)
            delete tasks.enabled;
          delete tasks.delivery;
          tasks.cacheRevision++;
        }
        const annotations = state.annotations?.[original.value.sessionId];
        if (status === 'confirmed' && annotations && operation.annotations) {
          for (const item of annotations.annotations)
            if (
              operation.annotations.selection.some(
                (sent) =>
                  sent.id === item.id &&
                  sent.version === item.version &&
                  sent.selectionId === item.selectionId,
              )
            )
              delete item.selectionId;
          annotations.cacheRevision++;
        }
        const mcp = state.mcp?.[original.value.sessionId];
        if (mcp?.delivery?.operationId === original.value.operationId) {
          if (status === 'confirmed' && mcp.review?.reviewId === mcp.delivery.review.reviewId)
            delete mcp.review;
          delete mcp.delivery;
          mcp.cacheRevision++;
        }
        const draft = operation.draft;
        const attachments = state.attachments?.[original.value.sessionId];
        if (attachments && original.kind === 'attachment') {
          const request = original.value;
          const item = attachments.items.find(
            (item) => item.pending && same(item.pending.request, request),
          );
          if (!item) throw conflict();
          if (status === 'confirmed' && request.action === 'remove')
            attachments.items = attachments.items.filter((entry) => entry !== item);
          else {
            if (status === 'confirmed') item.uploaded = true;
            delete item.pending;
          }
          attachments.revision++;
        }
        if (
          status === 'confirmed' &&
          draft?.attachmentRevision !== undefined &&
          attachments?.revision === draft.attachmentRevision
        ) {
          attachments.items = [];
          attachments.revision++;
        }
      },
      [original.value.operationId],
    );
  }
}
