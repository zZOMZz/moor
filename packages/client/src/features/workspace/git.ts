import type { FeatureContext } from './feature-context';
import {
  GIT_OPERATIONS_FEATURE,
  GIT_WORKTREE_FEATURE,
  gitStateResultSchema,
  validateGitOperationResult,
} from '@moor/protocol/git-protocol';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import { GitWorkspaceController, gitWorkspaceKey, type GitSaved } from '../git/git-workspace';
import { workspaceFeatureTarget } from '../mcp/workspace-mcp';
import type { WorkspaceDraftsService } from './drafts';
import { same } from './model';
import type { WorkspaceSessionsService } from './sessions';
/** Capabilities consumed by git use cases; supplied only by the workspace composition root. */
export interface WorkspaceGitPorts {
  context: FeatureContext<
    'context' | 'execute' | 'command' | 'value' | 'uuid',
    'offline' | 'project' | 'sessionId',
    'git-state' | 'git-action' | 'git-operations',
    never
  >;
  drafts: Pick<WorkspaceDraftsService, 'flushDraft' | 'reloadLedger'>;
  store: Pick<
    WorkspacePersistence,
    'read' | 'saveGit' | 'exclusiveOperation' | 'forkBlocked' | 'githubBlocked' | 'attentionBlocked'
  >;
  sessions: Pick<WorkspaceSessionsService, 'refreshSession'>;
}
export class WorkspaceGitService {
  constructor(readonly ports: WorkspaceGitPorts) {}
  async readGitContext() {
    const context = this.ports.context.context();
    if (!context.sessionId || !context.project.runtime.features?.includes(GIT_WORKTREE_FEATURE))
      return;
    return gitStateResultSchema.parse(
      await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'git-state', {
          gitVersion: 1,
          workspaceId: context.scope.target.workspaceId,
          localProjectId: context.scope.target.localProjectId,
          sessionId: context.sessionId,
        }),
      ),
    );
  }
  async openGit(changed: () => void = () => {}, resourceSessionId?: string) {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context(
      resourceSessionId ?? this.ports.context.value.sessionId,
    );
    if (!context.sessionId) throw Error('请先打开会话。');
    if (resourceSessionId && resourceSessionId !== this.ports.context.value.sessionId) {
      const ledger = await this.ports.store.read(
        context.scope,
        context.current,
        context.sessionId ?? [],
      );
      const receipts = Object.values(ledger.forks ?? {}).flatMap((record) => [
        record.receipt,
        ...record.resources.map((item) => item.receipt),
      ]);
      if (
        !receipts.some(
          (receipt) =>
            receipt?.childSessionId === resourceSessionId &&
            receipt.execution?.mode === 'worktree' &&
            receipt.phase !== 'unknown',
        )
      )
        throw Error('未找到属于当前项目的已确认 Fork 目录。');
    }
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = gitWorkspaceKey(target);
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('Git 面板已关闭。');
    };
    const controller = new GitWorkspaceController(target, {
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
        if (requested !== key) throw Error('Git 缓存范围不匹配。');
        return (await this.ports.store.read(context.scope, current, context.sessionId ?? [])).git?.[
          sessionId
        ];
      },
      compareWrite: async (requested, revision, value, valid, freshRejection) => {
        if (requested !== key) throw Error('Git 缓存范围不匹配。');
        const check = () => {
          current();
          if (!valid()) throw Error('Git 面板已改变。');
        };
        await this.ports.store.saveGit(
          context.scope,
          sessionId,
          revision,
          value as GitSaved,
          check,
          freshRejection,
        );
        await this.ports.drafts.reloadLedger({ ...context, current: check });
        return true;
      },
      request: (method, value) => {
        current();
        if (
          this.ports.context.value.offline ||
          !this.ports.context.value.project?.runtime.features?.includes(GIT_WORKTREE_FEATURE)
        )
          throw Error('执行电脑离线或尚不支持 Git 工作目录操作。');
        return this.ports.context.execute(
          { ...context, current },
          this.ports.context.command(context.scope, method, value),
        );
      },
    });
    await controller.load();
    const perform = async (
      kind: 'refresh' | 'retry' | 'inspect' | 'abandon' | 'prepare' | 'remove' | 'detach',
      args: string[] = [],
    ) => {
      const reviewed = structuredClone(controller.state),
        pending = structuredClone(controller.pending);
      await this.ports.drafts.flushDraft();
      current();
      const recovery = ['retry', 'inspect', 'abandon'].includes(kind);
      return this.ports.store.exclusiveOperation(
        context.scope,
        'git:' + sessionId,
        current,
        async () => {
          const ledger = await this.ports.store.read(
            context.scope,
            current,
            context.sessionId ?? [],
          );
          if (
            kind !== 'refresh' &&
            (!recovery || kind === 'retry') &&
            (ledger.operations.some(
              (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
            ) ||
              ledger.interactions?.[sessionId]?.value.pending ||
              this.ports.store.forkBlocked(ledger, sessionId) ||
              this.ports.store.githubBlocked(ledger, sessionId) ||
              this.ports.store.attentionBlocked(ledger, sessionId) ||
              ledger.mcp?.[sessionId]?.delivery)
          )
            throw Error('请先核查此会话原操作，再改变工作目录。');
          if (recovery && (!pending || !same(pending, ledger.git?.[sessionId]?.pending)))
            throw Error('原 Git 操作已改变或已有结果，请重新读取。');
          await controller.load();
          if (kind === 'refresh') await controller.refresh();
          else if (kind === 'retry') await controller.retry();
          else if (kind === 'inspect' || kind === 'abandon') {
            if (
              this.ports.context.value.offline ||
              !this.ports.context.value.project?.runtime.features?.includes(GIT_OPERATIONS_FEATURE)
            )
              throw Error('此执行电脑尚不支持核查 Git 原操作。');
            const query = { action: kind, request: pending!.request };
            const result = await validateGitOperationResult(
              await this.ports.context.execute(
                { ...context, current },
                this.ports.context.command(context.scope, 'git-operations', query),
              ),
              query,
            );
            current();
            if (!result.found)
              throw Error('主机尚未记录此原操作；本机原请求保留，请明确重试或封存。');
            const saved = ledger.git![sessionId]!;
            await this.ports.store.saveGit(
              context.scope,
              sessionId,
              saved.cacheRevision,
              {
                ...saved,
                cacheRevision: saved.cacheRevision + 1,
                receipt: result.receipt,
                pending: result.receipt.phase === 'unknown' ? saved.pending : undefined,
              },
              current,
            );
            await this.ports.drafts.reloadLedger({ ...context, current });
            await controller.load();
            if (result.receipt.phase === 'unknown')
              throw Error('Git 原操作结果仍未知，原请求已保留。');
          } else if (kind === 'prepare') await controller.prepare(args[0]!, args[1]!, args[2]!);
          else {
            if (!reviewed) throw Error('请先读取并审阅工作目录。');
            await controller[kind](reviewed);
          }
          await this.ports.sessions.refreshSession();
        },
      );
    };
    return {
      controller,
      close: () => {
        open = false;
      },
      refresh: () => perform('refresh'),
      retry: () => perform('retry'),
      inspect: () => perform('inspect'),
      abandon: () => perform('abandon'),
      prepare: (branch: string, oid: string, name: string) =>
        perform('prepare', [branch, oid, name]),
      remove: () => perform('remove'),
      detach: () => perform('detach'),
    };
  }
}
