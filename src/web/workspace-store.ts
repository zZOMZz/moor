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
import { readClientSession } from '../session-client';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';
import { IndexedSecureStorage, type SecureStorageBackend } from './secure-store';
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
    const retired = ['legacy', 'legacyDrafts', 'legacyDraftSlots', 'legacyRevisions'];
    const hasRetired =
      raw !== null && typeof raw === 'object' && retired.some((key) => Object.hasOwn(raw, key));
    const cleaned = hasRetired
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => !retired.includes(key)))
      : raw;
    const value =
      raw == null
        ? { version: 1 as const, scope: normalized, revision: 0, drafts: {}, operations: [] }
        : ledgerSchema.parse(cleaned);
    await this.#validateLedger(value, normalized, current);
    if (hasRetired) {
      // Drop obsolete recovery copies only after validating the current ledger.
      // CAS prevents cleanup from overwriting another page's edits or receipts.
      value.revision++;
      ledgerSchema.parse(value);
      current();
      await this.backend.compareAndSet(keyFor(normalized), raw, value, current);
      current();
    }
    return value;
  }
  async #validateLedger(value: WorkspaceLedger, normalized: WorkspaceScope, current: () => void) {
    if (!same(value.scope, normalized)) throw conflict();
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
    plainTurn = false,
  ) {
    if (plainTurn && (mcpReview || annotations || taskReview)) throw conflict();
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
          (!plainTurn && !same(mcpReview ?? null, mcp?.review?.servers.length ? mcp.review : null))
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
          state.mcp?.[sessionId]?.delivery)
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
          ))
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
          state.mcp?.[sessionId]?.delivery)
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
        (this.forkBlocked(state, sessionId) ||
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
    return null;
  }
  close() {
    this.backend.close?.();
  }
}
