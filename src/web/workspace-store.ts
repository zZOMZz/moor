import { mergeLegacyToolState, legacyObject } from './legacy-merge';
import { parseLegacyContentEntry, validateLegacyContent } from './legacy-project-content';
import { actorSchema, type AttentionActor } from '../attention';
import { attentionScopeKey, pendingAttentionSchema, type AttentionRoute } from './attention';
import {
  workspaceAttentionBucketSchema,
  validateWorkspaceAttentionBucket,
  validateWorkspaceAttentionEntry,
  workspaceAttentionKey,
  workspaceAttentionPending,
} from './workspace-attention';
import { githubStoredSchema } from './github';
import { githubWriteStoredSchema } from './github-write';
import { validateWorkspaceGithub, validateWorkspaceGithubWrite } from './workspace-github';
import { z } from 'zod';
import {
  desktopWorkspaceSourceSchema,
  desktopWorkspaceTargetSchema,
} from '../desktop/workspace-protocol';
import { runSelectionSchema, type RunSelection } from '../run-config';
import {
  sessionOriginalOperationSchema,
  type SessionOriginalOperation,
} from '../session-control-protocol';
import { sessionReadResponseSchema } from '../session-responses';
import { readClientSession, readLegacyClientSession } from '../session-client';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';
import { IndexedSecureStorage, type SecureStorageBackend } from './secure-store';
import {
  legacySessionRead,
  legacyReservedDraftSchema,
  legacyRestorableSchema,
  legacyDraftRecoverySchema,
  type LegacyRestorable,
  type LegacyDraftRecovery,
  legacySessionRecoverySchema,
  type LegacySessionRecovery,
} from '../desktop/legacy-cache';
import {
  workspaceAttachmentDraftSchema,
  emptyWorkspaceAttachments,
  validateWorkspaceAttachments,
  type WorkspaceAttachmentDraft,
} from './workspace-attachments';
import { attachmentContentSchema } from '../attachment-protocol';
import { type AttachmentReference } from '../content-protocol';
import { verifyAttachmentBytes } from './attachments';
import {
  mcpStoredSchema,
  mcpReviewSchema,
  mcpMutationVersion,
  type McpSaved,
  type McpReview,
} from './mcp';
import { validateWorkspaceMcp } from './workspace-mcp';
import {
  tasksStoredSchema,
  taskReviewedSchema,
  taskMutationVersion,
  type ReviewedTasks,
} from './tasks';
import { validateWorkspaceTasks } from './workspace-tasks';
import { rolesStoredSchema, roleAppliedSchema, roleInstruction } from './roles';
import { roleViewSchema, type RoleView } from '../role-protocol';
import { validateWorkspaceRoles, validateWorkspaceRoleApplied } from './workspace-roles';
import { workspaceFeatureTarget } from './workspace-mcp';
import {
  previewStoredSchema,
  previewAnnotationsStoredSchema,
  previewAnnotationSubmissionSchema,
  type PreviewAnnotationSubmission,
} from './project-preview';
import { validateWorkspacePreview, validateWorkspaceAnnotations } from './workspace-preview';
import { gitStoredSchema, type GitSaved } from './git-workspace';
import { validateWorkspaceGit } from './workspace-git';
import { validateGitActionReceipt } from '../git-protocol';
import { forkStoredSchema, type ForkSaved } from './session-fork';
import { validateWorkspaceFork, workspaceForkPending } from './workspace-fork';
import {
  interactionSavedSchema,
  interactionKey,
  interactionScope,
  emptyInteractionSaved,
  type InteractionSaved,
} from './interactions';
const interactionDocumentSchema = z
  .object({ revision: z.number().int().nonnegative().safe(), value: interactionSavedSchema })
  .strict();

const scopeSchema = z
  .object({
    source: desktopWorkspaceSourceSchema,
    target: desktopWorkspaceTargetSchema.omit({ sessionId: true }).strict(),
  })
  .strict();
export type WorkspaceScope = z.infer<typeof scopeSchema>;
const draftSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    text: z.string().max(100000),
    selection: runSelectionSchema,
    actor: actorSchema.optional(),
  })
  .strict();
export type WorkspaceDraft = z.infer<typeof draftSchema>;
const operationSchema = z
  .object({
    original: sessionOriginalOperationSchema,
    mcpReview: mcpReviewSchema.optional(),
    taskReview: taskReviewedSchema.optional(),
    annotations: previewAnnotationSubmissionSchema.optional(),
    draft: z
      .object({
        sessionId: z.string(),
        revision: z.number().int().nonnegative().safe(),
        attachmentRevision: z.number().int().nonnegative().safe().optional(),
        mcpRevision: z.number().int().nonnegative().safe().optional(),
        taskRevision: z.number().int().nonnegative().safe().optional(),
        annotationRevision: z.number().int().nonnegative().safe().optional(),
      })
      .strict()
      .optional(),
    status: z.enum(['pending', 'confirmed', 'abandoned']),
  })
  .strict();
export type WorkspaceOperation = z.infer<typeof operationSchema>;
const ledgerSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    revision: z.number().int().nonnegative().safe(),
    drafts: z.record(draftSchema),
    operations: z.array(operationSchema).max(512),
    legacy: z.array(legacySessionRecoverySchema).max(10000).optional(),
    legacyDrafts: z.array(legacyReservedDraftSchema).max(1000).optional(),
    legacyDraftSlots: z.record(z.string(), legacyReservedDraftSchema.shape.sessionId).optional(),
    legacyRevisions: z.array(legacyRestorableSchema).max(1000).optional(),
    attachments: z.record(workspaceAttachmentDraftSchema).optional(),
    interactions: z.record(interactionDocumentSchema).optional(),
    mcp: z.record(mcpStoredSchema).optional(),
    tasks: z.record(tasksStoredSchema).optional(),
    git: z.record(gitStoredSchema).optional(),
    github: z.record(githubStoredSchema).optional(),
    attention: z.record(workspaceAttentionBucketSchema).optional(),
    githubWrite: z.record(githubWriteStoredSchema).optional(),
    forks: z.record(forkStoredSchema).optional(),
    roles: z.record(rolesStoredSchema).optional(),
    roleApplied: z.record(roleAppliedSchema).optional(),
    previews: z.record(previewStoredSchema).optional(),
    annotations: z.record(previewAnnotationsStoredSchema).optional(),
  })
  .strict();
export type WorkspaceLedger = z.infer<typeof ledgerSchema>;
const emptyDraft = (): WorkspaceDraft => ({ revision: 0, text: '', selection: {} });
const conflict = () => Error('草稿或原操作已在另一页面改变，请重新读取后继续。');
const keyFor = (scope: WorkspaceScope) =>
  canonical(['moor-desktop-ledger-v1', scopeSchema.parse(scope)]);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Private client state. It is never imported into the host or relayed to other clients. */
export class WorkspaceStore {
  constructor(
    readonly backend: SecureStorageBackend = new IndexedSecureStorage({
      databaseName: 'moor-desktop-workspace-v1',
    }),
  ) {}
  async read(scope: WorkspaceScope, current: () => void): Promise<WorkspaceLedger> {
    const normalized = scopeSchema.parse(scope);
    current();
    const raw = await this.backend.read(keyFor(normalized));
    current();
    const value =
      raw == null
        ? { version: 1 as const, scope: normalized, revision: 0, drafts: {}, operations: [] }
        : ledgerSchema.parse(raw);
    return this.#validateLedger(value, normalized, current);
  }
  async #validateLedger(value: WorkspaceLedger, normalized: WorkspaceScope, current: () => void) {
    if (!same(value.scope, normalized)) throw conflict();
    for (const [origin, sessionId] of Object.entries(value.legacyDraftSlots ?? {}))
      if (
        !value.legacyDrafts?.some(
          (record) => record.scope.origin === origin && record.sessionId === sessionId,
        )
      )
        throw Error('旧新会话草稿的来源映射不完整。');
    for (const operation of value.operations)
      this.#validateOriginal(normalized, operation.original);
    for (const operation of value.operations)
      if (
        operation.mcpReview &&
        (operation.original.kind !== 'mutation' ||
          (operation.status === 'pending' &&
            !same(
              operation.mcpReview,
              value.mcp?.[operation.original.value.sessionId]?.delivery?.review ?? null,
            )))
      )
        throw Error('原 MCP 授权记录不完整。');
    for (const recovered of [
      ...(value.legacy ?? []),
      ...(value.legacyDrafts ?? []),
      ...(value.legacyRevisions ?? []),
    ])
      this.#validateRecovery(normalized, recovered);
    for (const operation of value.operations)
      if (
        operation.taskReview &&
        (operation.original.kind !== 'mutation' ||
          operation.original.value.kind !== 'turn' ||
          (operation.status === 'pending' &&
            !same(
              operation.taskReview,
              value.tasks?.[operation.original.value.sessionId]?.delivery?.review ?? null,
            )))
      )
        throw Error('原任务授权记录不完整。');
    for (const [sessionId, document] of Object.entries(value.tasks ?? {})) {
      validateWorkspaceTasks(document, { ...normalized.target, sessionId });
      if (document.delivery) {
        const operation = value.operations.find(
          (entry) =>
            entry.status === 'pending' &&
            entry.original.value.operationId === document.delivery!.operationId,
        );
        if (
          !operation ||
          operation.original.kind !== 'mutation' ||
          operation.original.value.kind !== 'turn' ||
          operation.original.value.sessionId !== sessionId ||
          !same(operation.taskReview ?? null, document.delivery.review) ||
          (await taskMutationVersion(operation.original.value)) !== document.delivery.requestVersion
        )
          throw Error('任务授权缺少匹配的原指令。');
        current();
      }
    }
    for (const [key, document] of Object.entries(value.attention ?? {})) {
      validateWorkspaceAttentionBucket(document, normalized.target);
      if (key !== attentionScopeKey(document.route)) throw Error('待办存储身份键不匹配。');
    }
    for (const [sessionId, document] of Object.entries(value.github ?? {}))
      validateWorkspaceGithub(document, { ...normalized.target, sessionId });
    for (const [sessionId, document] of Object.entries(value.githubWrite ?? {}))
      validateWorkspaceGithubWrite(document, { ...normalized.target, sessionId });
    for (const [sessionId, document] of Object.entries(value.roles ?? {}))
      validateWorkspaceRoles(document, { ...normalized.target, sessionId });
    for (const [sessionId, document] of Object.entries(value.roleApplied ?? {}))
      validateWorkspaceRoleApplied(document, { ...normalized.target, sessionId });
    for (const operation of value.operations)
      if (
        operation.annotations &&
        (operation.original.kind !== 'mutation' ||
          operation.original.value.kind !== 'turn' ||
          !same(
            operation.annotations.target,
            workspaceFeatureTarget({
              ...normalized.target,
              sessionId: operation.original.value.sessionId,
            }),
          ))
      )
        throw Error('标注发送记录与原指令不匹配。');
    for (const [sessionId, document] of Object.entries(value.previews ?? {}))
      validateWorkspacePreview(document, { ...normalized.target, sessionId });
    for (const [sessionId, document] of Object.entries(value.annotations ?? {})) {
      await validateWorkspaceAnnotations(document, { ...normalized.target, sessionId });
      current();
    }
    for (const [sessionId, document] of Object.entries(value.git ?? {}))
      validateWorkspaceGit(document, { ...normalized.target, sessionId });
    for (const [sessionId, document] of Object.entries(value.forks ?? {}))
      validateWorkspaceFork(document, { ...normalized.target, sessionId });
    for (const [sessionId, document] of Object.entries(value.interactions ?? {}))
      this.#validateInteraction(normalized, sessionId, document.value);
    for (const [sessionId, document] of Object.entries(value.mcp ?? {})) {
      validateWorkspaceMcp(document, { ...normalized.target, sessionId });
      if (document.delivery) {
        const operation = value.operations.find(
          (entry) =>
            entry.status === 'pending' &&
            entry.original.value.operationId === document.delivery!.operationId,
        );
        if (
          !operation ||
          operation.original.kind !== 'mutation' ||
          operation.original.value.kind !== 'turn' ||
          operation.original.value.sessionId !== sessionId ||
          !same(operation.mcpReview ?? null, document.delivery.review) ||
          (await mcpMutationVersion(operation.original.value)) !== document.delivery.requestVersion
        )
          throw Error('MCP 授权缺少匹配的原指令，请保留本机记录后核对。');
        current();
      }
    }
    for (const [sessionId, attachments] of Object.entries(value.attachments ?? {})) {
      await validateWorkspaceAttachments(attachments, { ...normalized.target, sessionId }, current);
      for (const item of attachments.items)
        if (
          item.pending &&
          !value.operations.some(
            (operation) =>
              operation.status === 'pending' &&
              operation.original.kind === 'attachment' &&
              same(operation.original.value, item.pending!.request),
          )
        )
          throw conflict();
    }
    for (const operation of value.operations)
      if (
        operation.status === 'pending' &&
        operation.original.kind === 'attachment' &&
        !value.attachments?.[operation.original.value.sessionId]?.items.some(
          (item) => item.pending && same(item.pending.request, operation.original.value),
        )
      )
        throw conflict();
    return value;
  }
  async #change<T>(
    scope: WorkspaceScope,
    current: () => void,
    task: (value: WorkspaceLedger) => T | Promise<T>,
  ): Promise<T> {
    const key = keyFor(scope);
    return this.backend.exclusive(key, current, async () => {
      const before = await this.read(scope, current);
      const value = structuredClone(before);
      const result = await task(value);
      value.revision++;
      ledgerSchema.parse(value);
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024 * 1024)
        throw Error('本机草稿和原操作存储已满，请先处理待确认操作。');
      current();
      await this.backend.compareAndSet(key, before.revision === 0 ? null : before, value, current);
      current();
      return result;
    });
  }
  async saveDraft(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    text: string,
    selection: RunSelection,
    current: () => void,
    actor?: AttentionActor,
  ) {
    if (actor && actorSchema.parse(actor).accountId !== scope.target.owner)
      throw Error('草稿账号与原范围不匹配。');
    desktopWorkspaceTargetSchema.parse({ ...scope.target, sessionId });
    return this.#change(scope, current, (state) => {
      const previous = Object.hasOwn(state.drafts, sessionId)
        ? state.drafts[sessionId]!
        : emptyDraft();
      if (previous.revision !== expectedRevision) throw conflict();
      const draft = draftSchema.parse({
        revision: previous.revision + 1,
        text,
        selection,
        ...(actor ? { actor } : {}),
      });
      Object.defineProperty(state.drafts, sessionId, {
        value: draft,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return structuredClone(draft);
    });
  }
  #validateOriginal(scope: WorkspaceScope, original: SessionOriginalOperation) {
    const input = sessionOriginalOperationSchema.parse(original).value,
      target = scope.target;
    if (
      input.workspaceId !== target.workspaceId ||
      ('localProjectId' in input && input.localProjectId !== target.localProjectId) ||
      ('userId' in input &&
        (input.userId !== target.userId || input.machineId !== target.machineId))
    )
      throw Error('原操作与电脑、项目范围不匹配。');
    desktopWorkspaceTargetSchema.parse({ ...target, sessionId: input.sessionId });
  }
  async stage(
    scope: WorkspaceScope,
    original: SessionOriginalOperation,
    draft: WorkspaceOperation['draft'],
    current: () => void,
    mcpReview?: McpReview,
    annotations?: PreviewAnnotationSubmission,
    taskReview?: ReviewedTasks,
  ) {
    original = sessionOriginalOperationSchema.parse(original);
    draft = draft === undefined ? undefined : operationSchema.shape.draft.parse(draft);
    this.#validateOriginal(scope, original);
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
      original.kind === 'mutation' && draft ? await mcpMutationVersion(original.value) : undefined;
    return this.#change(scope, current, (state) => {
      if (
        original.kind === 'mutation' &&
        draft &&
        this.recoveryBlocked(state, original.value.sessionId)
      )
        throw Error('此会话还有未识别的旧记录，请先完成恢复；原草稿保持可编辑。');
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
            item.status === 'pending' && item.original.value.sessionId === original.value.sessionId,
        )
      )
        throw Error('请先核查此会话尚未确认的原操作。');
      if (
        draft &&
        (draft.sessionId !== original.value.sessionId ||
          (state.drafts[draft.sessionId]?.revision ?? 0) !== draft.revision)
      )
        throw conflict();
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
          !same(tasks?.enabled ?? null, taskReview ?? null)
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
          !same(selection, annotations?.selection ?? [])
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
          !same(mcpReview ?? null, mcp?.review?.servers.length ? mcp.review : null)
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
          attachments.items.some((item) => !item.uploaded || item.pending)
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
    });
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
  recoveryBlocked(ledger: WorkspaceLedger, sessionId: string) {
    return [...(ledger.legacy ?? []), ...(ledger.legacyDrafts ?? [])].some(
      (item) => item.sessionId === sessionId && item.unresolvedKeys.length > 0,
    );
  }
  #validateRecovery(scope: WorkspaceScope, value: LegacyRestorable) {
    const record = legacyRestorableSchema.parse(value);
    if (!same(scope, { source: record.scope.source, target: record.scope.target }))
      throw conflict();
    if (record.content)
      for (const entry of record.content)
        parseLegacyContentEntry(entry, { ...scope.target, sessionId: record.sessionId });
    if (
      record.attachments &&
      !same(record.attachments.scope, {
        owner: scope.target.owner,
        deviceId: scope.target.deviceId,
        workspaceId: scope.target.workspaceId,
        localProjectId: scope.target.localProjectId,
        sessionId: record.sessionId,
      })
    )
      throw conflict();
    if ('snapshot' in record)
      readLegacyClientSession(legacySessionRead(record), {
        ...scope.target,
        sessionId: record.sessionId,
      });
    if (record.draftActor && record.draftActor.accountId !== scope.target.owner) throw conflict();
    if (record.attention) {
      const bucket = validateWorkspaceAttentionBucket(record.attention, scope.target);
      if (
        bucket.route.origin !== record.scope.origin ||
        Object.keys(bucket.entries).some((key) => {
          const entry = workspaceAttentionKey(bucket.route, key);
          return entry.kind === 'page' || entry.sessionId !== record.sessionId;
        })
      )
        throw conflict();
      for (const pending of workspaceAttentionPending({ recovered: bucket }, record.sessionId))
        if (pending.operation.kind === 'continue')
          this.#validateOriginal(scope, {
            kind: 'mutation',
            value: pending.operation.body.mutation,
          });
    }
    if (record.interactions)
      this.#validateInteraction(scope, record.sessionId, record.interactions);
    if (record.git)
      validateWorkspaceGit(record.git, { ...scope.target, sessionId: record.sessionId });
    if (record.fork)
      validateWorkspaceFork(record.fork, { ...scope.target, sessionId: record.sessionId });
    if (record.mcp)
      validateWorkspaceMcp(record.mcp, { ...scope.target, sessionId: record.sessionId });
    if (record.tasks)
      validateWorkspaceTasks(record.tasks, { ...scope.target, sessionId: record.sessionId });
    if (record.github)
      validateWorkspaceGithub(record.github, { ...scope.target, sessionId: record.sessionId });
    if (record.githubWrite)
      validateWorkspaceGithubWrite(record.githubWrite, {
        ...scope.target,
        sessionId: record.sessionId,
      });
    if (record.roles)
      validateWorkspaceRoles(record.roles, { ...scope.target, sessionId: record.sessionId });
    if (record.roleApplied)
      validateWorkspaceRoleApplied(record.roleApplied, {
        ...scope.target,
        sessionId: record.sessionId,
      });
    if (record.preview)
      validateWorkspacePreview(record.preview, { ...scope.target, sessionId: record.sessionId });
    if (
      record.annotationDelivery &&
      (!record.pending ||
        record.pending.kind !== 'turn' ||
        !same(
          record.annotationDelivery.target,
          workspaceFeatureTarget({ ...scope.target, sessionId: record.sessionId }),
        ))
    )
      throw Error('旧标注发送记录与原指令不匹配。');
    return record;
  }
  async restoreLegacyDraft(
    scope: WorkspaceScope,
    input: LegacyDraftRecovery,
    reservedId: string,
    current: () => void,
  ) {
    const source = legacyDraftRecoverySchema.parse(input);
    if (source.sessionId && source.sessionId !== reservedId)
      throw Error('旧草稿的预留会话编号不能改变。');
    return this.#restoreLegacy(
      scope,
      legacyReservedDraftSchema.parse({ ...source, sessionId: reservedId }),
      current,
      source.sessionId === undefined,
    );
  }
  /** Atomic, explicit import. The original profile and original operation bodies are immutable. */
  async restoreLegacy(scope: WorkspaceScope, input: LegacySessionRecovery, current: () => void) {
    return this.#restoreLegacy(scope, legacySessionRecoverySchema.parse(input), current);
  }
  #mergeLegacyAttachments(
    state: WorkspaceLedger,
    previous: LegacyRestorable,
    record: LegacyRestorable,
  ) {
    if (same(previous.attachments ?? null, record.attachments ?? null)) return;
    const existing = state.attachments?.[record.sessionId] ?? emptyWorkspaceAttachments();
    const items = structuredClone(existing.items);
    for (const source of record.attachments?.items ?? []) {
      const prior = previous.attachments?.items.find(
        (item) => item.reference.attachmentId === source.reference.attachmentId,
      );
      if (prior && same(prior, source)) continue;
      if (prior && (!same(prior.reference, source.reference) || prior.data !== source.data))
        throw Error('同一旧附件编号的内容发生变化，不能覆盖原附件。');
      const incoming = structuredClone(source);
      let confirmedUpload = false;
      const index = items.findIndex(
        (item) => item.reference.attachmentId === incoming.reference.attachmentId,
      );
      const local = items[index];
      if (local && (!same(local.reference, incoming.reference) || local.data !== incoming.data))
        throw Error('同一旧附件编号的内容发生变化，不能覆盖已有附件。');
      if (incoming.pending) {
        const settled = state.operations.find(
          (item) => item.original.value.operationId === incoming.pending!.request.operationId,
        );
        if (
          settled &&
          (settled.original.kind !== 'attachment' ||
            !same(settled.original.value, incoming.pending.request))
        )
          throw Error('同一旧附件操作编号的内容发生变化。');
        if (settled && settled.status !== 'pending') {
          if (
            settled.status === 'confirmed' &&
            incoming.pending.request.action === 'remove' &&
            !local
          )
            continue;
          if (settled.status === 'confirmed' && incoming.pending.request.action === 'upload') {
            incoming.uploaded = true;
            confirmedUpload = true;
          }
          delete incoming.pending;
        }
      }
      if (local?.pending && incoming.pending && !same(local.pending, incoming.pending))
        throw Error('此附件还有另一份未确认原请求，请先核查原上传或移除操作后恢复更新。');
      if (local)
        items[index] = {
          ...incoming,
          uploaded: local.uploaded || confirmedUpload,
          ...(local.pending ? { pending: local.pending } : {}),
        };
      else items.push(incoming);
    }
    Object.defineProperty((state.attachments ??= {}), record.sessionId, {
      value: { revision: existing.revision + 1, items },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  async #refreshLegacy(
    state: WorkspaceLedger,
    previous: LegacyRestorable,
    record: LegacyRestorable,
    check: () => void,
  ) {
    // Read-only projections and composer edits may change independently of an
    // original request. Other feature outboxes retain their own recovery rules.
    const execution = (value: LegacyRestorable) => {
      const {
        draft: _draft,
        draftActor: _actor,
        selection: _selection,
        content: _content,
        pending: _pending,
        metadata: _metadata,
        attachments: _attachments,
        git: _git,
        fork: _fork,
        github: _github,
        githubWrite: _githubWrite,
        roles: _roles,
        roleApplied: _roleApplied,
        tasks: _tasks,
        preview: _preview,
        annotations: _annotations,
        annotationDelivery: _annotationDelivery,
        mcp: _mcp,
        interactions: _interactions,
        attention: _attention,
        ...rest
      } = value;
      if ('snapshot' in rest) {
        const { snapshot: _snapshot, title: _title, ...binding } = rest;
        return binding;
      }
      return rest;
    };
    if (
      'snapshot' in previous &&
      'snapshot' in record &&
      previous.snapshot.meta.agentConfigId !== record.snapshot.meta.agentConfigId
    )
      throw Error('旧会话的 Agent 绑定发生变化，不能替换原执行身份。');
    if (!same(execution(previous), execution(record)))
      throw Error('旧来源的工具恢复记录发生变化，请先核查原操作；当前草稿与原记录均保留。');
    this.#mergeLegacyAttachments(state, previous, record);
    const featureFields = {
      git: 'git',
      fork: 'forks',
      github: 'github',
      githubWrite: 'githubWrite',
      roles: 'roles',
      roleApplied: 'roleApplied',
      tasks: 'tasks',
      preview: 'previews',
      annotations: 'annotations',
      mcp: 'mcp',
    } as const;
    for (const [source, field] of Object.entries(featureFields) as [
      keyof typeof featureFields,
      (typeof featureFields)[keyof typeof featureFields],
    ][]) {
      const old = previous[source],
        incoming = record[source];
      if (same(old ?? null, incoming ?? null)) continue;
      if (source === 'roleApplied') {
        const draft = state.drafts[record.sessionId];
        if (
          draft &&
          (draft.text !== (previous.draft ?? '') ||
            !same(draft.selection, previous.selection ?? {}) ||
            !same(draft.actor ?? null, previous.draftActor ?? null))
        )
          continue;
      }
      let local: unknown = state[field]?.[record.sessionId];
      if (
        source === 'fork' &&
        local &&
        !workspaceForkPending(local as NonNullable<WorkspaceLedger['forks']>[string]) &&
        record.fork?.operation
      ) {
        const saved = local as Record<string, unknown>;
        local = { ...saved, operation: undefined, receipt: undefined };
      }
      const merged = mergeLegacyToolState(old, incoming, local);
      if (merged === undefined) continue;
      if (!legacyObject(merged)) throw Error('旧工具恢复记录无效。');
      const existing = state[field]?.[record.sessionId];
      const value =
        source === 'roleApplied'
          ? merged
          : {
              ...merged,
              cacheRevision:
                (existing && 'cacheRevision' in existing ? existing.cacheRevision : 0) + 1,
            };
      Object.defineProperty((state[field] ??= {}), record.sessionId, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (!same(previous.interactions ?? null, record.interactions ?? null)) {
      const local = state.interactions?.[record.sessionId];
      const value = mergeLegacyToolState(previous.interactions, record.interactions, local?.value);
      if (value !== undefined)
        Object.defineProperty((state.interactions ??= {}), record.sessionId, {
          value: { revision: (local?.revision ?? 0) + 1, value },
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
    if (record.attention && !same(previous.attention ?? null, record.attention)) {
      if (previous.attention && !same(previous.attention.route, record.attention.route))
        throw Error('旧待办账号或执行范围发生变化。');
      const key = attentionScopeKey(record.attention.route);
      const local = state.attention?.[key];
      const entries = { ...local?.entries };
      for (const [entryKey, incoming] of Object.entries(record.attention.entries)) {
        const kind = workspaceAttentionKey(record.attention.route, entryKey);
        const value = mergeLegacyToolState(
          previous.attention?.entries[entryKey],
          incoming,
          entries[entryKey],
          kind.kind === 'pending' ? 'pending' : kind.kind,
        );
        if (value !== undefined)
          Object.defineProperty(entries, entryKey, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
      }
      Object.defineProperty((state.attention ??= {}), key, {
        value: { route: record.attention.route, entries },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    const originals: SessionOriginalOperation[] = [
      ...(record.pending ? [{ kind: 'mutation' as const, value: record.pending }] : []),
      ...(record.metadata ? [{ kind: 'metadata' as const, value: record.metadata.request }] : []),
      ...(state.attachments?.[record.sessionId]?.items.flatMap((item) =>
        item.pending ? [{ kind: 'attachment' as const, value: item.pending.request }] : [],
      ) ?? []),
    ];
    for (const original of originals) {
      this.#validateOriginal(state.scope, original);
      const found = state.operations.find(
        (item) => item.original.value.operationId === original.value.operationId,
      );
      if (found && !same(found.original, original))
        throw Error('同一旧操作编号的内容发生变化，不能覆盖原请求。');
      if (!found)
        state.operations.push({
          original: structuredClone(original),
          status: 'pending',
          ...(original.kind === 'mutation' && record.annotationDelivery
            ? { annotations: structuredClone(record.annotationDelivery) }
            : {}),
          ...(record.mcp?.delivery?.operationId === original.value.operationId
            ? { mcpReview: structuredClone(record.mcp.delivery.review) }
            : {}),
          ...(record.tasks?.delivery?.operationId === original.value.operationId
            ? { taskReview: structuredClone(record.tasks.delivery.review) }
            : {}),
        });
    }
    const current = state.drafts[record.sessionId];
    const composer = (value: LegacyRestorable) => ({
      text: value.draft ?? '',
      selection: value.selection ?? {},
      ...(value.draftActor ? { actor: value.draftActor } : {}),
    });
    if (
      !current ||
      same(
        {
          text: current.text,
          selection: current.selection,
          ...(current.actor ? { actor: current.actor } : {}),
        },
        composer(previous),
      )
    ) {
      Object.defineProperty(state.drafts, record.sessionId, {
        value: { ...composer(record), revision: (current?.revision ?? 0) + 1 },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    // Prior source versions remain reviewable; current edits and operation
    // confirmations are never rolled back by a second import.
    (state.legacyRevisions ??= []).push(structuredClone(previous));
    if ('snapshot' in record) {
      const index = state.legacy!.findIndex(
        (item) =>
          item.scope.origin === previous.scope.origin && item.sessionId === previous.sessionId,
      );
      state.legacy![index] = structuredClone(record);
    } else {
      const index = state.legacyDrafts!.findIndex(
        (item) =>
          item.scope.origin === previous.scope.origin && item.sessionId === previous.sessionId,
      );
      state.legacyDrafts![index] = structuredClone(record);
    }
    await this.#validateLedger(state, state.scope, check);
  }
  async #restoreLegacy(
    scope: WorkspaceScope,
    input: LegacyRestorable,
    current: () => void,
    unassignedSlot = false,
  ) {
    const record = this.#validateRecovery(scope, input);
    if (
      record.tasks?.delivery &&
      (!record.pending ||
        record.pending.kind !== 'turn' ||
        record.pending.operationId !== record.tasks.delivery.operationId ||
        (await taskMutationVersion(record.pending)) !== record.tasks.delivery.requestVersion)
    )
      throw Error('旧任务授权与原父指令不匹配。');
    if (record.annotations)
      await validateWorkspaceAnnotations(record.annotations, {
        ...scope.target,
        sessionId: record.sessionId,
      });
    if (
      record.mcp?.delivery &&
      (!record.pending ||
        record.pending.kind !== 'turn' ||
        record.pending.operationId !== record.mcp.delivery.operationId ||
        (await mcpMutationVersion(record.pending)) !== record.mcp.delivery.requestVersion)
    )
      throw Error('旧 MCP 授权与原指令不匹配。');
    current();
    if (record.content)
      await validateLegacyContent(
        record.content,
        { ...scope.target, sessionId: record.sessionId },
        current,
      );
    if (record.attachments)
      await validateWorkspaceAttachments(
        { revision: 0, items: record.attachments.items },
        { ...scope.target, sessionId: record.sessionId },
        current,
      );
    return this.#change(scope, current, (state) => {
      if (unassignedSlot) {
        const existing = state.legacyDraftSlots?.[record.scope.origin];
        if (existing && existing !== record.sessionId) throw conflict();
        Object.defineProperty((state.legacyDraftSlots ??= {}), record.scope.origin, {
          value: record.sessionId,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      const previous =
        'snapshot' in record
          ? state.legacy?.find(
              (item) =>
                item.scope.origin === record.scope.origin && item.sessionId === record.sessionId,
            )
          : state.legacyDrafts?.find(
              (item) =>
                item.scope.origin === record.scope.origin && item.sessionId === record.sessionId,
            );
      if (previous) {
        if (!same(previous, record)) return this.#refreshLegacy(state, previous, record, current);
        return;
      }
      if (record.attention) {
        const bucketKey = attentionScopeKey(record.attention.route),
          old = state.attention?.[bucketKey];
        if (
          old &&
          (!same(old.route, record.attention.route) ||
            Object.keys(record.attention.entries).some((key) => old.entries[key] !== undefined))
        )
          throw Error('当前事项已有草稿或原操作，请先处理后再恢复。');
        Object.defineProperty((state.attention ??= {}), bucketKey, {
          value: {
            route: record.attention.route,
            entries: { ...old?.entries, ...record.attention.entries },
          },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const draft = state.drafts[record.sessionId];
      const tasks = state.tasks?.[record.sessionId];
      if (
        record.tasks &&
        tasks &&
        (tasks.draft.tasks.length || tasks.enabled || tasks.delivery || tasks.pending)
      )
        throw Error('当前会话已有任务草稿或原操作，请先处理后再恢复。');
      for (const kind of ['github', 'githubWrite'] as const) {
        const old = state[kind]?.[record.sessionId];
        if (
          record[kind] &&
          old &&
          (old.pending || ('drafts' in old && (Object.keys(old.drafts).length || old.receipt)))
        )
          throw Error('当前会话已有 GitHub 草稿或原操作，请先处理后再恢复。');
      }
      const roles = state.roles?.[record.sessionId];
      if (record.roles && roles?.pending) throw Error('当前会话已有角色原操作，请先处理后再恢复。');
      if (record.roleApplied && state.roleApplied?.[record.sessionId]?.applied.length)
        throw Error('当前草稿已有角色应用记录，请先处理后再恢复。');
      const annotations = state.annotations?.[record.sessionId];
      const preview = state.previews?.[record.sessionId];
      if (record.annotations && annotations?.annotations.length)
        throw Error('当前会话已有标注草稿，请先处理后再恢复。');
      if (record.preview && (preview?.open || preview?.pending || preview?.receipt))
        throw Error('当前会话已有预览连接记录，请先处理后再恢复。');
      const interaction = state.interactions?.[record.sessionId];
      const git = state.git?.[record.sessionId];
      const fork = state.forks?.[record.sessionId];
      if (record.fork && (fork?.operation || fork?.resources.length))
        throw Error('当前会话已有 Fork 操作，请先处理后再恢复。');
      if (record.git && (git?.pending || git?.receipt))
        throw Error('当前会话已有 Git 操作，请先处理后再恢复。');
      const mcp = state.mcp?.[record.sessionId];
      if (record.mcp && (mcp?.review || mcp?.delivery))
        throw Error('当前会话已有 MCP 选择，请先处理后再恢复。');
      if (record.interactions && interaction && !same(interaction.value, emptyInteractionSaved()))
        throw Error('当前会话已有问答或追加草稿，请先处理后再恢复。');
      const attachments = state.attachments?.[record.sessionId] ?? emptyWorkspaceAttachments();
      if (attachments.items.length) throw Error('当前会话已有附件，请先处理现有附件再恢复。');
      if (draft && (draft.text || Object.keys(draft.selection).length))
        throw Error('当前会话已有草稿，请先处理现有草稿，再恢复旧记录。');
      const originals: SessionOriginalOperation[] = [
        ...(record.pending ? [{ kind: 'mutation' as const, value: record.pending }] : []),
        ...(record.metadata ? [{ kind: 'metadata' as const, value: record.metadata.request }] : []),
        ...(record.attachments?.items.flatMap((item) =>
          item.pending ? [{ kind: 'attachment' as const, value: item.pending.request }] : [],
        ) ?? []),
      ];
      for (const original of originals) {
        this.#validateOriginal(scope, original);
        const found = state.operations.find(
          (item) => item.original.value.operationId === original.value.operationId,
        );
        if (found && !same(found.original, original)) throw conflict();
        const taskReview =
          record.tasks?.delivery?.operationId === original.value.operationId
            ? record.tasks.delivery.review
            : undefined;
        if (found && taskReview) {
          if (found.taskReview && !same(found.taskReview, taskReview)) throw conflict();
          found.taskReview = taskReview;
        }
        const annotationDelivery =
          original.kind === 'mutation' ? record.annotationDelivery : undefined;
        if (found && annotationDelivery) {
          if (found.annotations && !same(found.annotations, annotationDelivery)) throw conflict();
          found.annotations = annotationDelivery;
        }
        const mcpReview =
          record.mcp?.delivery?.operationId === original.value.operationId
            ? record.mcp.delivery.review
            : undefined;
        if (found && mcpReview) {
          if (found.mcpReview && !same(found.mcpReview, mcpReview)) throw conflict();
          found.mcpReview = mcpReview;
        }
        // Do not attach an unproven draft revision to a legacy receipt: the old
        // editor may have changed after submission. Confirmation cannot erase it.
        if (!found)
          state.operations.push({
            original,
            status: 'pending',
            ...(mcpReview ? { mcpReview } : {}),
            ...(taskReview ? { taskReview } : {}),
            ...(annotationDelivery ? { annotations: annotationDelivery } : {}),
          });
      }
      Object.defineProperty(state.drafts, record.sessionId, {
        value: {
          revision: (draft?.revision ?? 0) + 1,
          text: record.draft ?? '',
          ...(record.draftActor ? { actor: record.draftActor } : {}),
          selection: record.selection ?? {},
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      for (const kind of ['github', 'githubWrite'] as const) {
        const recovered = record[kind];
        if (recovered)
          Object.defineProperty((state[kind] ??= {}), record.sessionId, {
            value: {
              ...recovered,
              cacheRevision: (state[kind]?.[record.sessionId]?.cacheRevision ?? 0) + 1,
            },
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      if (record.roles)
        Object.defineProperty((state.roles ??= {}), record.sessionId, {
          value: { ...record.roles, cacheRevision: (roles?.cacheRevision ?? 0) + 1 },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      if (record.tasks) {
        if (
          record.tasks.delivery &&
          !state.operations.some(
            (item) =>
              item.status === 'pending' &&
              item.original.value.operationId === record.tasks!.delivery!.operationId,
          )
        )
          throw Error('任务原指令已有结果，请先核对原恢复记录。');
        Object.defineProperty((state.tasks ??= {}), record.sessionId, {
          value: { ...record.tasks, cacheRevision: (tasks?.cacheRevision ?? 0) + 1 },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (record.roleApplied)
        Object.defineProperty((state.roleApplied ??= {}), record.sessionId, {
          value: record.roleApplied,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      if (record.annotations)
        Object.defineProperty((state.annotations ??= {}), record.sessionId, {
          value: { ...record.annotations, cacheRevision: (annotations?.cacheRevision ?? 0) + 1 },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      if (record.preview)
        Object.defineProperty((state.previews ??= {}), record.sessionId, {
          value: { ...record.preview, cacheRevision: (preview?.cacheRevision ?? 0) + 1 },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      if (record.attachments) {
        const items = structuredClone(record.attachments.items);
        for (const item of items)
          if (item.pending) {
            const operation = state.operations.find(
              (entry) => entry.original.value.operationId === item.pending!.request.operationId,
            )!;
            if (operation.status !== 'pending')
              throw Error('附件原操作已有结果，请先核对原恢复记录。');
          }
        Object.defineProperty((state.attachments ??= {}), record.sessionId, {
          value: { revision: attachments.revision + 1, items },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if ('snapshot' in record) (state.legacy ??= []).push(structuredClone(record));
      else (state.legacyDrafts ??= []).push(structuredClone(record));
      if (record.fork)
        Object.defineProperty((state.forks ??= {}), record.sessionId, {
          value: { ...record.fork, cacheRevision: (fork?.cacheRevision ?? 0) + 1 },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      if (record.git)
        Object.defineProperty((state.git ??= {}), record.sessionId, {
          value: { ...record.git, cacheRevision: (git?.cacheRevision ?? 0) + 1 },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      if (record.mcp) {
        if (
          record.mcp.delivery &&
          !state.operations.some(
            (item) =>
              item.status === 'pending' &&
              item.original.value.operationId === record.mcp!.delivery!.operationId,
          )
        )
          throw Error('旧 MCP 原指令已有结果，请先核对恢复记录。');
        Object.defineProperty((state.mcp ??= {}), record.sessionId, {
          value: { ...record.mcp, cacheRevision: (mcp?.cacheRevision ?? 0) + 1 },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (record.interactions)
        Object.defineProperty((state.interactions ??= {}), record.sessionId, {
          value: { revision: (interaction?.revision ?? 0) + 1, value: record.interactions },
          enumerable: true,
          writable: true,
          configurable: true,
        });
    });
  }
  #validateInteraction(scope: WorkspaceScope, sessionId: string, input: InteractionSaved) {
    const value = interactionSavedSchema.parse(input),
      target = { ...scope.target, sessionId };
    desktopWorkspaceTargetSchema.parse(target);
    for (const operation of [value.pending, ...value.closed.map((item) => item.operation)])
      if (
        operation &&
        (interactionKey(interactionScope(operation)) !== interactionKey(target) ||
          operation.catalogWorkspaceId !== target.catalogWorkspaceId ||
          operation.replicaId !== target.replicaId)
      )
        throw Error('交互原操作与原账号、电脑和项目不匹配。');
    return value;
  }
  async saveInteraction(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: InteractionSaved,
    current: () => void,
  ) {
    const value = this.#validateInteraction(scope, sessionId, input);
    return this.#change(scope, current, (state) => {
      if ((state.interactions?.[sessionId]?.revision ?? 0) !== expectedRevision) throw conflict();
      if (
        value.pending &&
        !state.interactions?.[sessionId]?.value.pending &&
        (this.forkBlocked(state, sessionId) ||
          this.githubBlocked(state, sessionId) ||
          this.attentionBlocked(state, sessionId) ||
          state.git?.[sessionId]?.pending ||
          state.operations.some(
            (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
          ))
      )
        throw Error('请先核查此会话原操作，再提交交互。');
      const document = { revision: expectedRevision + 1, value };
      Object.defineProperty((state.interactions ??= {}), sessionId, {
        value: document,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return structuredClone(document);
    });
  }
  async saveFork(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: ForkSaved,
    current: () => void,
  ) {
    const value = validateWorkspaceFork(input, { ...scope.target, sessionId });
    return this.#change(scope, current, (state) => {
      const previous = state.forks?.[sessionId],
        pending = workspaceForkPending(value),
        old = workspaceForkPending(previous);
      if (
        (previous?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1
      )
        throw conflict();
      if (old && !same(old, value.operation ?? null)) throw conflict();
      if (
        pending &&
        !old &&
        (this.forkBlocked(state, sessionId) ||
          this.githubBlocked(state, sessionId) ||
          this.attentionBlocked(state, sessionId) ||
          this.forkBlocked(state, pending.request.childSessionId) ||
          state.git?.[sessionId]?.pending ||
          state.operations.some(
            (item) =>
              item.status === 'pending' &&
              [sessionId, pending.request.childSessionId].includes(item.original.value.sessionId),
          ) ||
          state.interactions?.[sessionId]?.value.pending ||
          state.mcp?.[sessionId]?.delivery ||
          this.recoveryBlocked(state, sessionId))
      )
        throw Error('请先核查原会话操作，再创建副本。');
      Object.defineProperty((state.forks ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async saveAttention(
    scope: WorkspaceScope,
    route: AttentionRoute,
    key: string,
    input: unknown,
    current: () => void,
    compare?: { expected: unknown },
  ) {
    const value = validateWorkspaceAttentionEntry(route, key, input);
    const bucketKey = attentionScopeKey(route),
      kind = workspaceAttentionKey(route, key);
    validateWorkspaceAttentionBucket({ route, entries: {} }, scope.target);
    return this.#change(scope, current, (state) => {
      const bucket = state.attention?.[bucketKey] ?? { route, entries: {} };
      if (!same(bucket.route, route)) throw conflict();
      const previous = bucket.entries[key];
      if (compare && !same(previous ?? null, compare.expected ?? null)) return false;
      if (kind.kind === 'pending' && value !== undefined) {
        const pending = pendingAttentionSchema.parse(value);
        if (previous && !same(previous, value)) throw conflict();
        if (!previous && ['continue', 'permission'].includes(pending.operation.kind)) {
          const sessionId = pending.sessionId;
          if (
            this.attentionBlocked(state, sessionId) ||
            this.githubBlocked(state, sessionId) ||
            this.forkBlocked(state, sessionId) ||
            state.git?.[sessionId]?.pending ||
            state.interactions?.[sessionId]?.value.pending ||
            state.tasks?.[sessionId]?.pending ||
            state.mcp?.[sessionId]?.delivery ||
            this.recoveryBlocked(state, sessionId) ||
            state.operations.some(
              (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
            )
          )
            throw Error('请先核查原会话操作，再发送待办指令或审批。');
        }
        if (pending.operation.kind === 'continue')
          this.#validateOriginal(scope, {
            kind: 'mutation',
            value: pending.operation.body.mutation,
          });
      }
      const entries = { ...bucket.entries };
      if (value === undefined) delete entries[key];
      else
        Object.defineProperty(entries, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      Object.defineProperty((state.attention ??= {}), bucketKey, {
        value: { route, entries },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return true;
    });
  }
  async saveGithub(
    scope: WorkspaceScope,
    sessionId: string,
    kind: 'github' | 'githubWrite',
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const target = { ...scope.target, sessionId };
    const value =
      kind === 'github'
        ? validateWorkspaceGithub(input, target)
        : validateWorkspaceGithubWrite(input, target);
    return this.#change(scope, current, (state) => {
      const previous = state[kind]?.[sessionId];
      if (
        (previous?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1
      )
        throw conflict();
      if (
        value.pending &&
        !previous?.pending &&
        (this.githubBlocked(state, sessionId) ||
          this.attentionBlocked(state, sessionId) ||
          this.forkBlocked(state, sessionId) ||
          state.git?.[sessionId]?.pending ||
          state.interactions?.[sessionId]?.value.pending ||
          state.operations.some(
            (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
          ) ||
          this.recoveryBlocked(state, sessionId))
      )
        throw Error('请先核查此会话原操作，再保存新的 GitHub 操作。');
      if (value.pending && previous?.pending) {
        const { abandon: oldAbandon, ...oldPending } =
          previous.pending as typeof previous.pending & { abandon?: true };
        const { abandon: nextAbandon, ...nextPending } = value.pending as typeof value.pending & {
          abandon?: true;
        };
        if (!same(oldPending, nextPending) || (oldAbandon && !nextAbandon)) throw conflict();
      }
      Object.defineProperty((state[kind] ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async saveGit(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: GitSaved,
    current: () => void,
  ) {
    const value = validateWorkspaceGit(input, { ...scope.target, sessionId });
    return this.#change(scope, current, (state) => {
      const previous = state.git?.[sessionId];
      if (
        value.pending &&
        !previous?.pending &&
        (this.forkBlocked(state, sessionId) ||
          this.githubBlocked(state, sessionId) ||
          this.attentionBlocked(state, sessionId) ||
          state.operations.some(
            (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
          ) ||
          state.interactions?.[sessionId]?.value.pending ||
          state.mcp?.[sessionId]?.delivery ||
          this.recoveryBlocked(state, sessionId))
      )
        throw Error('请先核查此会话原操作，再改变工作目录。');
      if (
        (previous?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1
      )
        throw conflict();
      if (previous?.pending) {
        if (value.pending && !same(previous.pending, value.pending)) throw conflict();
        if (!value.pending) {
          const receipt = validateGitActionReceipt(value.receipt, previous.pending.request);
          if (receipt.phase === 'unknown') throw conflict();
        }
      }
      Object.defineProperty((state.git ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async saveTasks(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const value = validateWorkspaceTasks(input, { ...scope.target, sessionId });
    return this.#change(scope, current, (state) => {
      const previous = state.tasks?.[sessionId];
      if (
        value.enabled &&
        value.enabled.reviewId !== previous?.enabled?.reviewId &&
        (this.recoveryBlocked(state, sessionId) ||
          this.forkBlocked(state, sessionId) ||
          this.githubBlocked(state, sessionId) ||
          this.attentionBlocked(state, sessionId) ||
          state.git?.[sessionId]?.pending ||
          state.interactions?.[sessionId]?.value.pending ||
          state.operations.some(
            (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
          ))
      )
        throw Error('请先确认原父指令或会话操作，再启用任务计划。');
      if (
        (previous?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1 ||
        !same(previous?.delivery ?? null, value.delivery ?? null) ||
        (previous?.pending &&
          value.pending &&
          !same(previous.pending, value.pending) &&
          !(
            previous.pending.action !== 'revoke' &&
            value.pending.action === 'abandon' &&
            previous.pending.operationId === value.pending.operationId &&
            previous.pending.grantId === value.pending.grantId
          ))
      )
        throw conflict();
      Object.defineProperty((state.tasks ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async saveRoles(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const value = validateWorkspaceRoles(input, { ...scope.target, sessionId });
    return this.#change(scope, current, (state) => {
      const previous = state.roles?.[sessionId];
      if (
        (previous?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1 ||
        (previous?.pending && value.pending && !same(previous.pending, value.pending)) ||
        (previous?.ending && value.pending && !value.ending)
      )
        throw conflict();
      Object.defineProperty((state.roles ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async applyRole(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    base: string,
    input: RoleView,
    selection: RunSelection,
    current: () => void,
  ) {
    const role = roleViewSchema.parse(input);
    return this.#change(scope, current, (state) => {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      if (draft.revision !== expectedRevision) throw conflict();
      if (
        this.recoveryBlocked(state, sessionId) ||
        this.forkBlocked(state, sessionId) ||
        this.githubBlocked(state, sessionId) ||
        this.attentionBlocked(state, sessionId) ||
        state.roles?.[sessionId]?.pending ||
        state.git?.[sessionId]?.pending ||
        state.interactions?.[sessionId]?.value.pending ||
        state.operations.some(
          (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
        )
      )
        throw Error('请先确认原操作，再应用角色。');
      const marker = state.roleApplied?.[sessionId];
      const applied = marker?.base === base ? marker.applied : [];
      if (applied.some((item) => item.roleId === role.id && item.revision === role.revision))
        throw Error('此角色版本已应用到当前草稿，不会重复追加。');
      const instruction = roleInstruction(role);
      const next = draftSchema.parse({
        revision: draft.revision + 1,
        selection,
        text: draft.text + (instruction ? (draft.text ? '\n\n' : '') + instruction : ''),
      });
      const updated = roleAppliedSchema.parse({
        version: 1,
        target: workspaceFeatureTarget({ ...scope.target, sessionId }),
        base,
        applied: [...applied, { roleId: role.id, revision: role.revision }],
      });
      Object.defineProperty(state.drafts, sessionId, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty((state.roleApplied ??= {}), sessionId, {
        value: updated,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async savePreview(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const value = validateWorkspacePreview(input, { ...scope.target, sessionId });
    return this.#change(scope, current, (state) => {
      if (
        (state.previews?.[sessionId]?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1
      )
        throw conflict();
      Object.defineProperty((state.previews ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async saveAnnotations(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const value = await validateWorkspaceAnnotations(input, { ...scope.target, sessionId });
    current();
    return this.#change(scope, current, (state) => {
      if (
        (state.annotations?.[sessionId]?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1
      )
        throw conflict();
      Object.defineProperty((state.annotations ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async saveMcp(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: McpSaved,
    current: () => void,
  ) {
    const value = validateWorkspaceMcp(input, { ...scope.target, sessionId });
    return this.#change(scope, current, (state) => {
      const before = state.mcp?.[sessionId];
      if (
        (before?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1 ||
        !same(before?.delivery ?? null, value.delivery ?? null)
      )
        throw conflict();
      Object.defineProperty((state.mcp ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  async saveAttachments(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: WorkspaceAttachmentDraft['items'],
    current: () => void,
  ) {
    desktopWorkspaceTargetSchema.parse({ ...scope.target, sessionId });
    const next = await validateWorkspaceAttachments(
      { revision: expectedRevision + 1, items: input },
      { ...scope.target, sessionId },
      current,
    );
    return this.#change(scope, current, (state) => {
      const before = state.attachments?.[sessionId] ?? emptyWorkspaceAttachments();
      if (before.revision !== expectedRevision) throw conflict();
      for (const item of before.items)
        if (item.pending && !next.items.some((other) => same(item, other)))
          throw Error('待确认附件必须先核查原操作。');
      for (const item of next.items) {
        const previous = before.items.find(
          (other) => other.reference.attachmentId === item.reference.attachmentId,
        );
        if (previous ? !same(previous, item) : item.uploaded || item.pending) throw conflict();
      }
      for (const item of before.items)
        if (
          item.uploaded &&
          !next.items.some((other) => other.reference.attachmentId === item.reference.attachmentId)
        )
          throw Error('移除已上传附件需要主机确认。');
      Object.defineProperty((state.attachments ??= {}), sessionId, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return structuredClone(next);
    });
  }
  /** Caller holds this across the actual host request; another page cannot retry it concurrently. */
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
    return this.#change(scope, current, (state) => {
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
      if (
        status === 'confirmed' &&
        draft &&
        state.drafts[draft.sessionId]?.revision === draft.revision
      ) {
        state.drafts[draft.sessionId] = {
          ...state.drafts[draft.sessionId]!,
          revision: draft.revision + 1,
          text: '',
        };
      }
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
    });
  }
  async cacheSession(scope: WorkspaceScope, sessionId: string, raw: unknown, current: () => void) {
    readClientSession(raw, { ...scope.target, sessionId });
    const value = sessionReadResponseSchema.parse(raw);
    // An unpersisted host view must never replace a confirmed offline snapshot.
    if (value.persisted === false || value.persistenceError) return;
    const key = canonical(['moor-desktop-session-v1', scopeSchema.parse(scope), sessionId]);
    await this.backend.exclusive(key, current, async () => {
      const before = await this.backend.read(key);
      current();
      await this.backend.compareAndSet(key, before, value, current);
    });
  }
  async attachmentContent(
    scope: WorkspaceScope,
    sessionId: string,
    reference: AttachmentReference,
    current: () => void,
    input?: unknown,
  ) {
    const target = scopeSchema.parse(scope).target;
    desktopWorkspaceTargetSchema.parse({ ...target, sessionId });
    const key = canonical(['moor-desktop-attachment-cache-v1', scope, sessionId, reference]);
    current();
    const raw = input === undefined ? await this.backend.read(key) : input;
    current();
    if (raw == null) return null;
    const value = attachmentContentSchema.parse(raw);
    if (
      value.workspaceId !== target.workspaceId ||
      value.localProjectId !== target.localProjectId ||
      value.sessionId !== sessionId ||
      !same(value.attachment, reference)
    )
      throw Error('附件缓存与原引用不匹配。');
    await verifyAttachmentBytes(reference, value.data);
    current();
    if (input !== undefined)
      await this.backend.exclusive(key, current, async () => {
        const before = await this.backend.read(key);
        current();
        await this.backend.compareAndSet(key, before, value, current);
      });
    current();
    return value;
  }
  async cachedSession(scope: WorkspaceScope, sessionId: string, current: () => void) {
    current();
    const raw = await this.backend.read(
      canonical(['moor-desktop-session-v1', scopeSchema.parse(scope), sessionId]),
    );
    current();
    if (raw != null) return readClientSession(raw, { ...scope.target, sessionId });
    const ledger = await this.read(scope, current);
    const legacy = ledger.legacy?.find((item) => item.sessionId === sessionId);
    return legacy
      ? readLegacyClientSession(legacySessionRead(legacy), { ...scope.target, sessionId })
      : null;
  }
  close() {
    this.backend.close?.();
  }
}
