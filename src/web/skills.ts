import {
  SKILLS_LIMITS,
  skillsReadSchema,
  validateSkillsRead,
  type SkillDetail,
  type SkillsList,
  type SkillsRead,
  type SkillSummary,
} from '../skills-protocol';
import { gitTargetSchema, gitWorkspaceKey, type GitTarget } from './git-workspace';

export type SkillsTarget = GitTarget;
export const skillsKey = (target: SkillsTarget) =>
  gitWorkspaceKey(target).replace('git-workspace-v1/', 'skills-v1/');
type Dependencies = {
  request(path: string, value: SkillsRead): Promise<unknown>;
  current(): boolean;
  online(): boolean;
  changed(): void;
};

export function agentCommandText(command: string) {
  return command.startsWith('$') || command.startsWith('/') ? command : '/' + command;
}

export function skillInstruction(detail: SkillDetail) {
  return [
    '[Skill 说明快照]',
    `名称：${detail.skill.name}`,
    `来源：${detail.source.scope === 'project' ? '项目' : '主机全局'} · ${detail.source.label}`,
    `相对路径：${detail.skill.path}`,
    `版本：${detail.skill.version}`,
    '以下为本次选择的完整说明。此引用不安装或启用原生 Skill，附带脚本和资源未自动读取。',
    '',
    detail.text,
    '',
    '[/Skill 说明快照]',
  ].join('\n');
}

/** Read-only, ephemeral content. Opening this controller never starts an Agent. */
export class SkillsController {
  readonly target: SkillsTarget;
  list?: SkillsList;
  detail?: SkillDetail;
  busy = false;
  error = '';
  private generation = 0;
  constructor(
    target: SkillsTarget,
    private deps: Dependencies,
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  invalidate(reason = '') {
    this.generation++;
    this.list = this.detail = undefined;
    this.busy = false;
    this.error = reason;
    this.deps.changed();
  }
  private assertCurrent(generation: number) {
    if (generation !== this.generation || !this.deps.current())
      throw new Error('Skills 所属会话已改变，请重新打开。');
    if (!this.deps.online()) throw new Error('执行电脑离线，请连接后手动重新读取 Skills。');
  }
  private base() {
    return {
      skillsVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private async read(request: SkillsRead, generation: number) {
    this.assertCurrent(generation);
    const value = await this.deps.request(
      `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/skills/read`,
      skillsReadSchema.parse(request),
    );
    this.assertCurrent(generation);
    const result = validateSkillsRead(value, request);
    if (result.view === 'detail') {
      const bytes = new TextEncoder().encode(result.text);
      if (bytes.length > SKILLS_LIMITS.fileBytes || result.text.includes('\0'))
        throw new Error('Skill 说明不是可读取的完整文本。');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      this.assertCurrent(generation);
      const version =
        'sha256:' + [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
      if (version !== result.skill.version) throw new Error('Skill 说明校验失败，请重新读取。');
    }
    return result;
  }
  private async work<T>(callback: (generation: number) => Promise<T>) {
    const generation = ++this.generation;
    this.busy = true;
    this.error = '';
    this.deps.changed();
    try {
      this.assertCurrent(generation);
      return await callback(generation);
    } catch (error) {
      if (generation === this.generation && this.deps.current()) {
        this.list = this.detail = undefined;
        this.error = error instanceof Error ? error.message : '读取 Skills 失败，请手动重试。';
      }
      throw error;
    } finally {
      if (generation === this.generation && this.deps.current()) {
        this.busy = false;
        this.deps.changed();
      }
    }
  }
  async refresh() {
    this.list = this.detail = undefined;
    return this.work(async (generation) => {
      const result = await this.read({ ...this.base(), view: 'list' }, generation);
      if (result.view !== 'list') throw new Error('Skills 列表响应无效。');
      this.list = result;
    });
  }
  private async readDetail(skill: SkillSummary, catalog: SkillsList, generation: number) {
    const result = await this.read(
      {
        ...this.base(),
        view: 'detail',
        sourceId: skill.sourceId,
        skillId: skill.id,
        version: skill.version,
        catalogVersion: catalog.catalogVersion,
        executionRevision: catalog.executionRevision,
      },
      generation,
    );
    if (
      result.view !== 'detail' ||
      JSON.stringify(result.skill) !== JSON.stringify(skill) ||
      JSON.stringify(result.source) !==
        JSON.stringify(catalog.sources.find((source) => source.id === skill.sourceId))
    )
      throw new Error('Skill 来源或内容已改变，请重新读取列表。');
    return result;
  }
  async select(skillId: string) {
    const catalog = this.list,
      skill = catalog?.skills.find((value) => value.id === skillId);
    this.detail = undefined;
    if (!catalog || !skill) throw new Error('请先读取并选择 Skill。');
    return this.work(async (generation) => {
      this.detail = await this.readDetail(skill, catalog, generation);
    });
  }
  async instructionForDraft() {
    const catalog = this.list,
      selected = this.detail;
    if (!catalog || !selected || this.busy) throw new Error('请先查看要引用的 Skill 说明。');
    return this.work(async (generation) => {
      const fresh = await this.readDetail(selected.skill, catalog, generation);
      this.detail = fresh;
      return skillInstruction(fresh);
    });
  }
}
