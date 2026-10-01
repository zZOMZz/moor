import type { StorageBackend } from '@moor/client/operations/storage';
import { type McpSaved } from '../../features/mcp/mcp';
import { validateWorkspaceMcp } from '../../features/mcp/workspace-mcp';
import {
  validateWorkspaceAnnotations,
  validateWorkspacePreview,
} from '../../features/preview/workspace-preview';
import { validateWorkspaceRoles } from '../../features/roles/workspace-roles';
import { validateWorkspaceTasks } from '../../features/tasks/workspace-tasks';
import type { WorkspaceLedgerPersistence } from './ledger';
import { conflict, same, WorkspaceScope } from './model';
import type { WorkspaceOperationsPersistence } from './operations';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceRetiredPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'change'>;
  operations: Pick<
    WorkspaceOperationsPersistence,
    'forkBlocked' | 'githubBlocked' | 'attentionBlocked'
  >;
}
export class WorkspaceRetiredPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceRetiredPersistencePorts,
  ) {}
  async saveTasks(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const value = validateWorkspaceTasks(input, { ...scope.target, sessionId });
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
      const previous = state.tasks?.[sessionId];
      if (
        value.enabled &&
        value.enabled.reviewId !== previous?.enabled?.reviewId &&
        (this.ports.operations.forkBlocked(state, sessionId) ||
          this.ports.operations.githubBlocked(state, sessionId) ||
          this.ports.operations.attentionBlocked(state, sessionId) ||
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
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
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
  async savePreview(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const value = validateWorkspacePreview(input, { ...scope.target, sessionId });
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
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
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
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
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
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
}
