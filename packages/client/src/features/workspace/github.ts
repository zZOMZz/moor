import { GITHUB_FEATURE } from '@moor/protocol/github-protocol';
import { GITHUB_WRITE_FEATURE } from '@moor/protocol/github-write-protocol';
import { workspaceProjectTargetSchema } from '@moor/protocol/workspace-client-protocol';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import { githubKey } from '../github/github';
import { GithubSessionController, type GithubSessionMode } from '../github/github-session';
import { githubWriteKey } from '../github/github-write';
import { workspaceFeatureTarget } from '../mcp/workspace-mcp';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
import { same } from './model';
/** Capabilities consumed by github use cases; supplied only by the workspace composition root. */
export interface WorkspaceGithubPorts {
  drafts: Pick<WorkspaceDraftsService, 'flushDraft' | 'reloadLedger'>;
  context: Pick<
    WorkspaceContextService,
    'context' | 'contextRevision' | 'value' | 'uuid' | 'execute' | 'command'
  >;
  store: Pick<
    WorkspacePersistence,
    | 'read'
    | 'saveGithub'
    | 'exclusiveOperation'
    | 'githubBlocked'
    | 'attentionBlocked'
    | 'forkBlocked'
    | 'saveDraft'
  >;
}
export class WorkspaceGithubService {
  constructor(readonly ports: WorkspaceGithubPorts) {}
  async openGithub(changed: () => void = () => {}, mode: GithubSessionMode = 'read') {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    if (!context.sessionId) throw Error('请先打开会话。');
    const sessionId = context.sessionId;
    const identity = { ...context.scope.target, sessionId };
    type Target = typeof identity;
    const checkTarget = (target: Target, check: () => void) => {
      context.current();
      check();
      if (!same(identity, target)) throw Error('GitHub 原执行范围已改变。');
    };
    const kindFor = (target: Target, key: string) => {
      const projected = workspaceFeatureTarget(target);
      if (key === githubKey(projected)) return 'github' as const;
      if (key === githubWriteKey(projected)) return 'githubWrite' as const;
      throw Error('GitHub 缓存键不属于原会话。');
    };
    const panel = new GithubSessionController<Target>({
      context: () => {
        try {
          context.current();
          return {
            target: identity,
            generation: this.ports.context.contextRevision,
            online: !this.ports.context.value.offline,
          };
        } catch {
          return { target: null, generation: this.ports.context.contextRevision, online: false };
        }
      },
      parseTarget: (input) => {
        const target = workspaceProjectTargetSchema.parse(input);
        if (!target.sessionId || !same(target, identity))
          throw Error('GitHub 目标不属于当前会话。');
        return { ...target, sessionId: target.sessionId };
      },
      gitTarget: workspaceFeatureTarget,
      uuid: () => this.ports.context.uuid(),
      storage: {
        forTarget: (target, check) => ({
          read: async (key) => {
            checkTarget(target, check);
            return (await this.ports.store.read(context.scope, check, sessionId))[
              kindFor(target, key)
            ]?.[sessionId];
          },
          compareWrite: async (key, revision, value, valid) => {
            const current = () => {
              checkTarget(target, check);
              if (!valid()) throw Error('GitHub 面板已改变。');
            };
            current();
            await this.ports.store.saveGithub(
              context.scope,
              sessionId,
              kindFor(target, key),
              revision,
              value,
              current,
            );
            return true;
          },
        }),
        list: async (target, current) => {
          checkTarget(target, current);
          const ledger = await this.ports.store.read(
            context.scope,
            current,
            context.sessionId ?? [],
          );
          const projected = workspaceFeatureTarget(target);
          return [
            ...(ledger.github?.[sessionId]
              ? [{ target, key: githubKey(projected), value: ledger.github[sessionId] }]
              : []),
            ...(ledger.githubWrite?.[sessionId]
              ? [{ target, key: githubWriteKey(projected), value: ledger.githubWrite[sessionId] }]
              : []),
          ];
        },
        exclusive: (target, _namespace, current, work) => {
          checkTarget(target, current);
          return this.ports.store.exclusiveOperation(
            context.scope,
            'github:' + sessionId,
            current,
            work,
          );
        },
      },
      request: (target, method, params, current) => {
        checkTarget(target, current);
        const feature = method.startsWith('github-write-') ? GITHUB_WRITE_FEATURE : GITHUB_FEATURE;
        if (
          this.ports.context.value.offline ||
          !this.ports.context.value.project?.runtime.features?.includes(feature)
        )
          throw Error('执行电脑离线或尚未提供此 GitHub 能力。');
        return this.ports.context.execute(
          { ...context, current },
          this.ports.context.command(context.scope, method, params),
        );
      },
      beforeWrite: async (target, current) => {
        await this.ports.drafts.flushDraft();
        checkTarget(target, current);
        const ledger = await this.ports.store.read(context.scope, current, context.sessionId ?? []);
        if (
          this.ports.store.githubBlocked(ledger, sessionId) ||
          this.ports.store.attentionBlocked(ledger, sessionId) ||
          this.ports.store.forkBlocked(ledger, sessionId) ||
          ledger.git?.[sessionId]?.pending ||
          ledger.interactions?.[sessionId]?.value.pending ||
          ledger.operations.some(
            (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
          )
        )
          throw Error('请先核查此会话原操作，再确认新的 GitHub 操作。');
      },
      appendInstruction: async (target, text, current) => {
        await this.ports.drafts.flushDraft();
        checkTarget(target, current);
        if (
          !this.ports.context.value.session?.persisted ||
          this.ports.context.value.session.persistenceError ||
          this.ports.context.value.session.meta.isArchived
        )
          throw Error('请先读取可编辑的原会话。');
        const draft = structuredClone(this.ports.context.value.draft!);
        await this.ports.store.saveDraft(
          context.scope,
          sessionId,
          draft.revision,
          [draft.text, text].filter(Boolean).join('\n\n'),
          draft.selection,
          current,
          this.ports.context.value.catalogs[context.scope.source]?.actor,
        );
        await this.ports.drafts.reloadLedger({ ...context, current });
      },
      changed: async (target, current) => {
        checkTarget(target, current);
        await this.ports.drafts.reloadLedger({ ...context, current });
      },
    });
    panel.subscribe(changed);
    try {
      await panel.open(identity, mode);
    } catch (error) {
      if (!panel.state) {
        panel.dispose();
        throw error;
      }
    }
    return panel;
  }
}
