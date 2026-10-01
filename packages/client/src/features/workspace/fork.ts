import {
  FORK_OPERATIONS_FEATURE,
  forkCutoffSchema,
  forkDirectorySchema,
  SESSION_FORK_FEATURE,
  validateForkOperationResult,
  type ForkCutoff,
  type ForkDirectory,
} from '@moor/protocol/fork-protocol';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import { SessionForkController, sessionForkKey, type ForkSaved } from '../fork/session-fork';
import { workspaceForkPending } from '../fork/workspace-fork';
import { workspaceFeatureTarget } from '../mcp/workspace-mcp';
import type { WorkspaceCatalogService } from './catalog';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
import { same } from './model';
/** Capabilities consumed by fork use cases; supplied only by the workspace composition root. */
export interface WorkspaceForkPorts {
  drafts: Pick<WorkspaceDraftsService, 'flushDraft' | 'reloadLedger'>;
  context: Pick<WorkspaceContextService, 'context' | 'uuid' | 'value' | 'execute' | 'command'>;
  store: Pick<WorkspacePersistence, 'read' | 'saveFork' | 'exclusiveOperation'>;
  catalog: Pick<WorkspaceCatalogService, 'refreshSessions'>;
}
export class WorkspaceForkService {
  constructor(readonly ports: WorkspaceForkPorts) {}
  async openFork(changed: () => void = () => {}) {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    if (!context.sessionId) throw Error('请先打开源会话。');
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = sessionForkKey(target);
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('Fork 面板已关闭。');
    };
    const controller = new SessionForkController(target, {
      uuid: () => this.ports.context.uuid(),
      changed,
      current: () => {
        try {
          current();
          return true;
        } catch {
          return false;
        }
      },
      read: async (requested) => {
        if (requested !== key) throw Error('Fork 缓存范围不匹配。');
        return (await this.ports.store.read(context.scope, current, context.sessionId ?? []))
          .forks?.[sessionId];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('Fork 缓存范围不匹配。');
        const check = () => {
          current();
          if (!valid()) throw Error('Fork 面板已改变。');
        };
        await this.ports.store.saveFork(
          context.scope,
          sessionId,
          revision,
          value as ForkSaved,
          check,
        );
        await this.ports.drafts.reloadLedger({ ...context, current: check });
        return true;
      },
      request: (method, value) => {
        current();
        if (
          this.ports.context.value.offline ||
          !this.ports.context.value.project?.runtime.features?.includes(SESSION_FORK_FEATURE)
        )
          throw Error('执行电脑离线或尚不支持原生会话副本。');
        return this.ports.context.execute(
          { ...context, current },
          this.ports.context.command(context.scope, method, value),
        );
      },
    });
    await controller.load();
    const perform = async (
      kind: 'refresh' | 'create' | 'retry' | 'inspect' | 'abandon',
      input?: { cutoff: ForkCutoff; directory: ForkDirectory },
      turnId?: string,
    ) => {
      const reviewed = structuredClone(controller.options),
        pending = structuredClone(controller.pending);
      const proposal = input && {
        cutoff: forkCutoffSchema.parse(input.cutoff),
        directory: forkDirectorySchema.parse(input.directory),
      };
      await this.ports.drafts.flushDraft();
      current();
      return this.ports.store.exclusiveOperation(
        context.scope,
        'fork:' + sessionId,
        current,
        async () => {
          const ledger = await this.ports.store.read(
              context.scope,
              current,
              context.sessionId ?? [],
            ),
            saved = ledger.forks?.[sessionId];
          if (
            ['create', 'retry'].includes(kind) &&
            (ledger.git?.[sessionId]?.pending ||
              ledger.operations.some(
                (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
              ) ||
              ledger.interactions?.[sessionId]?.value.pending ||
              ledger.mcp?.[sessionId]?.delivery)
          )
            throw Error('请先核查源会话原操作，再创建或重试 Fork。');
          if (
            ['retry', 'inspect', 'abandon'].includes(kind) &&
            (!pending || !same(pending, workspaceForkPending(saved)))
          )
            throw Error('原 Fork 已改变或已有结果，请重新读取。');
          await controller.load();
          if (kind === 'refresh') await controller.refresh(turnId);
          else if (kind === 'create') {
            if (!reviewed || !same(reviewed, controller.options))
              throw Error('Fork 选项已改变，请重新审阅。');
            await controller.create(proposal!.cutoff, proposal!.directory);
          } else if (kind === 'retry') await controller.retry();
          else {
            if (
              this.ports.context.value.offline ||
              !this.ports.context.value.project?.runtime.features?.includes(FORK_OPERATIONS_FEATURE)
            )
              throw Error('此执行电脑尚不支持核查原 Fork。');
            const query = { action: kind, request: pending!.request };
            const result = await validateForkOperationResult(
              await this.ports.context.execute(
                { ...context, current },
                this.ports.context.command(context.scope, 'fork-operations', query),
              ),
              query,
            );
            current();
            if (!result.found) throw Error('主机尚未记录原 Fork，请明确重试或封存。');
            await this.ports.store.saveFork(
              context.scope,
              sessionId,
              saved!.cacheRevision,
              { ...saved!, cacheRevision: saved!.cacheRevision + 1, receipt: result.receipt },
              current,
            );
            await this.ports.drafts.reloadLedger({ ...context, current });
            await controller.load();
            if (result.receipt.phase === 'unknown') throw Error('Fork 结果仍未知，原记录已保留。');
          }
          await this.ports.catalog.refreshSessions();
        },
      );
    };
    return {
      controller,
      close: () => {
        open = false;
      },
      refresh: (turnId?: string) => perform('refresh', undefined, turnId),
      create: (cutoff: ForkCutoff, directory: ForkDirectory) =>
        perform('create', { cutoff, directory }),
      retry: () => perform('retry'),
      inspect: () => perform('inspect'),
      abandon: () => perform('abandon'),
      confirmCleanup: (childSessionId: string) =>
        this.ports.store.exclusiveOperation(
          context.scope,
          'fork:' + sessionId,
          current,
          async () => {
            await controller.load();
            const receipt =
              controller.receipt?.childSessionId === childSessionId
                ? controller.receipt
                : controller.resources.find(
                    (item) => item.receipt.childSessionId === childSessionId,
                  )?.receipt;
            if (!receipt || receipt.execution?.mode !== 'worktree')
              throw Error('清理目录不属于此 Fork。');
            const read = await this.ports.context.execute(
              { ...context, sessionId: childSessionId, current },
              this.ports.context.command(context.scope, 'git-state', {
                gitVersion: 1,
                workspaceId: target.workspaceId,
                localProjectId: target.localProjectId,
                sessionId: childSessionId,
              }),
            );
            await controller.confirmResourceCleanup(
              childSessionId,
              read as import('@moor/protocol/git-protocol').GitStateResult,
            );
          },
        ),
    };
  }
}
