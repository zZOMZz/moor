import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import {
  skillsReadResultSchema,
  skillsReadSchema,
  type SkillDetail,
  type SkillsList,
  type SkillsRead,
} from '../skills-protocol';
import { SkillsController } from './skills';

export type SecureSkillsContext = {
  target: SecureCliTarget | null;
  online: boolean;
  /** Increment on identity, selection and connection changes, including ABA changes. */
  generation: number;
};
export type SecureSkillsDependencies = {
  context(): SecureSkillsContext;
  request(target: SecureCliTarget, method: 'skills-read', params: SkillsRead): Promise<unknown>;
  /** Read the latest draft and compare-and-set it under this original target and guard. */
  appendInstruction(
    target: SecureCliTarget,
    instruction: string,
    current: () => void,
  ): Promise<void>;
};
type BoundContext = SecureSkillsContext & { target: SecureCliTarget };
export type SecureSkillsReview = {
  target: SecureCliTarget;
  generation: number;
  panel: number;
};
export type SecureSkillsState = {
  target: SecureCliTarget;
  review: SecureSkillsReview;
  controller: SkillsController;
  adding: boolean;
  error: string;
};
const canonical = productCanonicalJson;

/** The legacy controller supplies validation and presentation; transport and lifetime are scoped. */
export class SecureSkillsController {
  #context?: BoundContext;
  #controller?: SkillsController;
  #generation = 0;
  #panel = 0;
  #adding = false;
  #error = '';
  #listeners = new Set<() => void>();
  constructor(private readonly options: SecureSkillsDependencies) {}

  get state(): SecureSkillsState | null {
    if (!this.#context || !this.#controller || !this.#matches(this.#context)) return null;
    return {
      target: structuredClone(this.#context.target),
      review: {
        target: structuredClone(this.#context.target),
        generation: this.#context.generation,
        panel: this.#panel,
      },
      controller: this.#controller,
      adding: this.#adding,
      error: this.#error,
    };
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  #bind(): BoundContext {
    const input = this.options.context();
    if (!input.target || !Number.isSafeInteger(input.generation) || input.generation < 0)
      throw Error('请先确认账号并打开当前项目会话。');
    const target = secureTargetSchema.parse(input.target);
    if (!target.product) throw Error('请先选择已确认的项目副本。');
    if (input.online !== true) throw Error('执行电脑离线，请连接后手动重新读取 Skills。');
    return { target, online: true, generation: input.generation };
  }
  #matches(context: BoundContext) {
    try {
      return canonical(context) === canonical(this.#bind());
    } catch {
      return false;
    }
  }
  #current(context: BoundContext, controller: SkillsController, generation: number) {
    if (
      this.#controller !== controller ||
      generation !== this.#generation ||
      !this.#matches(context)
    )
      throw Error('Skills 所属会话或连接已改变，请重新打开并审阅。');
  }
  close() {
    const previous = this.#controller;
    this.#controller = undefined;
    this.#context = undefined;
    this.#generation++;
    this.#panel++;
    this.#adding = false;
    this.#error = '';
    previous?.invalidate();
    this.#emit();
  }
  sync() {
    if (this.#context && !this.#matches(this.#context)) this.close();
  }
  dispose() {
    this.close();
    this.#listeners.clear();
  }
  async open(expectedTarget: SecureCliTarget) {
    const context = this.#bind();
    if (canonical(context.target) !== canonical(secureTargetSchema.parse(expectedTarget)))
      throw Error('Skills 所属会话已改变，请重新打开。');
    this.close();
    this.#context = context;
    const target = context.target;
    const controller: SkillsController = new SkillsController(
      {
        owner: target.owner,
        deviceId: target.hostDeviceId,
        userId: target.userId,
        machineId: target.machineId,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        catalogWorkspaceId: target.product!.catalogWorkspaceId,
        replicaId: target.product!.replicaId,
      },
      {
        current: () => this.#controller === controller && this.#matches(context),
        online: () => this.#matches(context),
        changed: () => this.#emit(),
        request: async (path, input) => {
          const generation = this.#generation;
          this.#current(context, controller, generation);
          const params = skillsReadSchema.parse(input);
          if (
            path !==
              `/api/workspaces/${target.product!.catalogWorkspaceId}/replicas/${target.product!.replicaId}/skills/read` ||
            params.workspaceId !== target.workspaceId ||
            params.localProjectId !== target.localProjectId ||
            params.sessionId !== target.sessionId
          )
            throw Error('不支持的 Skills 读取范围。');
          const result = await this.options.request(structuredClone(target), 'skills-read', params);
          this.#current(context, controller, generation);
          return result;
        },
      },
    );
    this.#controller = controller;
    this.#emit();
    await this.refresh();
  }
  async #work(callback: (controller: SkillsController, current: () => void) => Promise<void>) {
    const controller = this.#controller,
      context = this.#context;
    if (!controller || !context || !this.#matches(context)) {
      this.sync();
      throw Error('请重新打开当前会话的 Skills。');
    }
    if (controller.busy || this.#adding) throw Error('正在核对 Skills，请稍后再试。');
    const generation = ++this.#generation,
      current = () => this.#current(context, controller, generation);
    this.#error = '';
    try {
      await callback(controller, current);
      current();
    } catch (error) {
      if (this.#controller === controller && this.#matches(context)) {
        this.#error = error instanceof Error ? error.message : '读取 Skills 失败，请手动重试。';
        controller.error = this.#error;
      }
      throw error;
    } finally {
      if (generation === this.#generation) {
        this.#adding = false;
        this.#emit();
      }
    }
  }
  async refresh() {
    await this.#work(async (controller) => controller.refresh());
  }
  #assertReviewed(review: SecureSkillsReview) {
    const state = this.state;
    if (!state || canonical(state.review) !== canonical(review))
      throw Error('Skills 所属会话或面板已改变，请重新打开并审阅。');
  }
  async select(skillId: string, reviewedCatalog: SkillsList, review: SecureSkillsReview) {
    const expected = skillsReadResultSchema.parse(reviewedCatalog);
    this.#assertReviewed(review);
    await this.#work(async (controller) => {
      if (
        expected.view !== 'list' ||
        !controller.list ||
        canonical(controller.list) !== canonical(expected)
      )
        throw Error('Skills 列表已改变，请重新查看后选择。');
      await controller.select(skillId);
    });
  }
  async add(reviewedDetail: SkillDetail, review: SecureSkillsReview) {
    const reviewed = skillsReadResultSchema.parse(reviewedDetail);
    this.#assertReviewed(review);
    await this.#work(async (controller, current) => {
      if (
        reviewed.view !== 'detail' ||
        !controller.detail ||
        canonical(controller.detail) !== canonical(reviewed)
      )
        throw Error('Skill 说明已改变，请重新审阅后加入草稿。');
      this.#adding = true;
      this.#emit();
      const instruction = await controller.instructionForDraft();
      current();
      if (canonical(controller.detail) !== canonical(reviewed))
        throw Error('Skill 说明已改变，请重新审阅后加入草稿。');
      await this.options.appendInstruction(
        structuredClone(this.#context!.target),
        instruction,
        current,
      );
      current();
    });
  }
}
