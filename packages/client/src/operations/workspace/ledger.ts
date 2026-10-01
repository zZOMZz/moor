import type { StorageBackend } from '@moor/client/operations/storage';
import {
  sessionOriginalOperationSchema,
  type SessionOriginalOperation,
} from '@moor/protocol/session-control-protocol';
import { workspaceProjectTargetSchema } from '@moor/protocol/workspace-client-protocol';
import { validateWorkspaceAttachments } from '../../features/attachments/workspace-attachments';
import { attentionScopeKey } from '../../features/attention/attention';
import { validateWorkspaceAttentionBucket } from '../../features/attention/workspace-attention';
import { validateWorkspaceFork } from '../../features/fork/workspace-fork';
import { validateWorkspaceGit } from '../../features/git/workspace-git';
import {
  validateWorkspaceGithub,
  validateWorkspaceGithubWrite,
} from '../../features/github/workspace-github';
import {
  interactionKey,
  interactionSavedSchema,
  interactionScope,
  type InteractionSaved,
} from '../../features/interactions/interactions';
import { validateWorkspaceMcp, workspaceFeatureTarget } from '../../features/mcp/workspace-mcp';
import {
  validateWorkspaceAnnotations,
  validateWorkspacePreview,
} from '../../features/preview/workspace-preview';
import {
  validateWorkspaceRoleApplied,
  validateWorkspaceRoles,
} from '../../features/roles/workspace-roles';
import { validateWorkspaceTasks } from '../../features/tasks/workspace-tasks';
import {
  workspaceRecordHeadSchema,
  WorkspaceRecords,
} from '../../features/workspace/workspace-records';
import type { WorkspaceDraftsPersistence } from './drafts';
import {
  conflict,
  keyFor,
  ledgerSchema,
  mutationVersion,
  operationSchema,
  same,
  scopeSchema,
  storedLedgerSchema,
  WorkspaceLedger,
  WorkspaceScope,
} from './model';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceLedgerPersistencePorts {
  drafts: Pick<WorkspaceDraftsPersistence, 'migrateDraft'>;
}
export class WorkspaceLedgerPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceLedgerPersistencePorts,
  ) {}
  get records() {
    return new WorkspaceRecords(this.backend);
  }
  async read(
    scope: WorkspaceScope,
    current: () => void,
    sessionIds?: string | readonly string[],
  ): Promise<WorkspaceLedger> {
    const normalized = scopeSchema.parse(scope);
    current();
    const raw = await this.backend.read(keyFor(normalized));
    current();
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 2) {
      const loaded = await this.records.load(
        normalized,
        raw,
        current,
        typeof sessionIds === 'string' ? [sessionIds] : sessionIds,
      );
      const value = ledgerSchema.parse(loaded.ledger);
      return this.validateLedger(value, normalized, current);
    }
    const retired = ['legacy', 'legacyDrafts', 'legacyDraftSlots', 'legacyRevisions'];
    const hasRetired =
      raw !== null && typeof raw === 'object' && retired.some((key) => Object.hasOwn(raw, key));
    const cleaned = hasRetired
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => !retired.includes(key)))
      : raw;
    const stored =
      raw == null
        ? { version: 1 as const, scope: normalized, revision: 0, operations: [] }
        : storedLedgerSchema.parse(cleaned);
    const legacyDrafts = stored.drafts ?? {};
    const { drafts: _legacyDrafts, ...ledger } = stored;
    const value = ledgerSchema.parse(ledger);
    await this.validateLedger(value, normalized, current);
    for (const [sessionId, draft] of Object.entries(legacyDrafts))
      await this.ports.drafts.migrateDraft(normalized, sessionId, draft, current);
    if (hasRetired || Object.hasOwn(stored, 'drafts')) {
      // Drop obsolete recovery copies and embedded drafts only after validating
      // the current ledger and durably copying each draft to its own record.
      value.revision++;
      ledgerSchema.parse(value);
      current();
      await this.backend.compareAndSet(keyFor(normalized), raw, value, current);
      current();
    }
    return value;
  }
  async operation(scope: WorkspaceScope, operationId: string, current: () => void) {
    const normalized = scopeSchema.parse(scope);
    const raw = await this.backend.read(keyFor(normalized));
    current();
    const value =
      raw && typeof raw === 'object' && 'version' in raw && raw.version === 2
        ? await this.records.operation(normalized, operationId, current)
        : (await this.read(normalized, current)).operations.find(
            (entry) => entry.original.value.operationId === operationId,
          );
    if (value === undefined) return undefined;
    const operation = operationSchema.parse(value);
    this.validateOriginal(normalized, operation.original);
    if (operation.original.value.operationId !== operationId) throw conflict();
    return operation;
  }
  async validateLedger(value: WorkspaceLedger, normalized: WorkspaceScope, current: () => void) {
    if (!same(value.scope, normalized)) throw conflict();
    for (const operation of value.operations) this.validateOriginal(normalized, operation.original);
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
          (await mutationVersion(operation.original.value)) !== document.delivery.requestVersion
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
      this.validateInteraction(normalized, sessionId, document.value);
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
          (await mutationVersion(operation.original.value)) !== document.delivery.requestVersion
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
  async change<T>(
    scope: WorkspaceScope,
    current: () => void,
    sessionIds: readonly string[],
    task: (value: WorkspaceLedger) => T | Promise<T>,
    operationIds: readonly string[] = [],
  ): Promise<T> {
    const key = keyFor(scope);
    return this.backend.exclusive(key, current, async () => {
      let raw = await this.backend.read(key);
      current();
      const loaded = workspaceRecordHeadSchema.safeParse(raw).success
        ? await this.records.load(scope, raw, current, sessionIds, operationIds)
        : undefined;
      const before = loaded ? ledgerSchema.parse(loaded.ledger) : await this.read(scope, current);
      if (loaded) await this.validateLedger(before, scope, current);
      else {
        // read may have moved embedded drafts to their independent records.
        raw = await this.backend.read(key);
        current();
      }
      const value = structuredClone(before);
      const result = await task(value);
      value.revision++;
      ledgerSchema.parse(value);
      current();
      await this.records.commit(scope, raw, before, value, current, loaded);
      current();
      return result;
    });
  }
  validateOriginal(scope: WorkspaceScope, original: SessionOriginalOperation) {
    const input = sessionOriginalOperationSchema.parse(original).value,
      target = scope.target;
    if (
      input.workspaceId !== target.workspaceId ||
      ('localProjectId' in input && input.localProjectId !== target.localProjectId) ||
      ('userId' in input &&
        (input.userId !== target.userId || input.machineId !== target.machineId))
    )
      throw Error('原操作与电脑、项目范围不匹配。');
    workspaceProjectTargetSchema.parse({ ...target, sessionId: input.sessionId });
  }
  validateInteraction(scope: WorkspaceScope, sessionId: string, input: InteractionSaved) {
    const value = interactionSavedSchema.parse(input),
      target = { ...scope.target, sessionId };
    workspaceProjectTargetSchema.parse(target);
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
}
