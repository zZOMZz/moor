import { SKILLS_FEATURE } from '@moor/protocol/skills-protocol';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import { SkillsController } from '../skills/skills';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
/** Capabilities consumed by skills use cases; supplied only by the workspace composition root. */
export interface WorkspaceSkillsPorts {
  context: Pick<WorkspaceContextService, 'context' | 'value' | 'execute' | 'command'>;
  drafts: Pick<WorkspaceDraftsService, 'flushDraft' | 'reloadLedger'>;
  store: Pick<WorkspacePersistence, 'saveDraft'>;
}
export class WorkspaceSkillsService {
  constructor(readonly ports: WorkspaceSkillsPorts) {}
  openSkills(changed: () => void = () => {}) {
    const context = this.ports.context.context();
    if (!context.sessionId) throw Error('请先打开会话。');
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('Skills 面板已关闭，请重新打开。');
      if (this.ports.context.value.offline)
        throw Error('执行电脑离线，请连接后手动重新读取 Skills。');
    };
    const {
      owner,
      deviceId,
      userId,
      machineId,
      workspaceId,
      localProjectId,
      catalogWorkspaceId,
      replicaId,
    } = context.scope.target;
    const skills = new SkillsController(
      {
        owner,
        deviceId,
        userId,
        machineId,
        workspaceId,
        localProjectId,
        catalogWorkspaceId,
        replicaId,
        sessionId: context.sessionId,
      },
      {
        current: () => {
          try {
            current();
            return true;
          } catch {
            return false;
          }
        },
        online: () => !this.ports.context.value.offline,
        changed,
        request: (_method, value) => {
          current();
          if (!this.ports.context.value.project?.runtime.features?.includes(SKILLS_FEATURE))
            throw Error('此执行电脑尚未提供 Skills 读取能力。');
          return this.ports.context.execute(
            { ...context, current },
            this.ports.context.command(context.scope, 'skills-read', value),
          );
        },
      },
    );
    return {
      controller: skills,
      close: () => {
        open = false;
        skills.invalidate();
      },
      addToDraft: async () => {
        await this.ports.drafts.flushDraft();
        current();
        const draft = structuredClone(this.ports.context.value.draft!);
        if (
          !draft ||
          !this.ports.context.value.session?.persisted ||
          this.ports.context.value.session.persistenceError ||
          this.ports.context.value.session.meta.isArchived
        )
          throw Error('请先读取可编辑的原会话。');
        const instruction = await skills.instructionForDraft();
        await this.ports.drafts.flushDraft();
        current();
        await this.ports.store.saveDraft(
          context.scope,
          context.sessionId!,
          draft.revision,
          [draft.text, instruction].filter(Boolean).join('\n\n'),
          draft.selection,
          current,
          this.ports.context.value.catalogs[context.scope.source]?.actor,
        );
        await this.ports.drafts.reloadLedger({ ...context, current });
      },
    };
  }
}
