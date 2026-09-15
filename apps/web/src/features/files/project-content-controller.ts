import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import { CONTENT_LIMITS, projectFilePathSchema } from '@moor/protocol/content-protocol';
import { productCanonicalJson } from '@moor/client/encrypted-product';
import {
  projectDiffReferenceSchema,
  type ProjectDiffChange,
} from '@moor/protocol/project-content-protocol';
import {
  readProjectTree,
  readCurrentProjectFile,
  readProjectTurnDiff,
  readProjectDiffFile,
  type ProjectContentDependencies,
  type ProjectContentTarget,
} from './project-content';
import type { ProjectContentPanelProps, ProjectTurnChoice } from './project-content-ui';

export type ProjectContentMethod =
  | 'read-project-tree'
  | 'file-content'
  | 'read-turn-diff'
  | 'read-diff-file';
export type ProjectContentContext<T> = {
  target: T | null;
  online: boolean;
  // The owner increments this on identity, selection or connection changes, including ABA changes.
  generation: number;
};
export type ProjectContentState<T> = Pick<
  ProjectContentPanelProps,
  | 'title'
  | 'mode'
  | 'busy'
  | 'error'
  | 'tree'
  | 'currentFile'
  | 'currentUnavailable'
  | 'turns'
  | 'turnId'
  | 'diff'
  | 'diffFile'
> & { target: T };
const turnsSchema = z
  .array(
    z
      .object({ id, label: z.string().max(2000), reference: projectDiffReferenceSchema.optional() })
      .strict(),
  )
  .max(5000)
  .refine(
    (turns) =>
      new Set(turns.map((turn) => turn.id)).size === turns.length &&
      turns.every((turn) => !turn.reference || turn.reference.turnId === turn.id),
    '回合选择与已读取的文件基线不匹配。',
  );
const canonical = productCanonicalJson;
type BoundContext<T> = ProjectContentContext<T> & { target: T };

/** Shared scoped content reads; identity and finite transport are supplied by the connection owner. */
export class ProjectContentController<T> {
  #state: ProjectContentState<T> | null = null;
  #context?: BoundContext<T>;
  #generation = 0;
  #listeners = new Set<() => void>();

  constructor(
    private readonly options: {
      context(): ProjectContentContext<T>;
      parseTarget(input: unknown): T;
      contentTarget(target: T): ProjectContentTarget;
      request(target: T, method: ProjectContentMethod, params: unknown): Promise<unknown>;
      cache: {
        read(target: T, key: string, current: () => void): Promise<unknown>;
        writeBatch(
          target: T,
          values: ReadonlyMap<string, unknown>,
          current: () => void,
        ): Promise<void>;
      };
    },
  ) {}
  get state(): ProjectContentState<T> | null {
    return this.#context && this.#matches(this.#context) ? structuredClone(this.#state) : null;
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
  #bind(): BoundContext<T> {
    const input = this.options.context();
    if (!input.target || !Number.isSafeInteger(input.generation) || input.generation < 0)
      throw Error('请先确认账号并打开当前项目会话。');
    const target = this.options.parseTarget(input.target);
    return { target, online: input.online === true, generation: input.generation };
  }
  #matches(context: BoundContext<T>) {
    try {
      return canonical(this.#bind()) === canonical(context);
    } catch {
      return false;
    }
  }
  #current(context: BoundContext<T>, generation: number) {
    if (!this.#state || generation !== this.#generation || !this.#matches(context))
      throw Error('文件读取范围或连接已改变，请重新打开。');
  }
  #target(target: T): ProjectContentTarget {
    return this.options.contentTarget(target);
  }
  async #read(
    work: (
      panel: ProjectContentState<T>,
      online: boolean,
      dependencies: ProjectContentDependencies,
    ) => Promise<Partial<ProjectContentState<T>>>,
  ) {
    if (!this.#state || !this.#context || !this.#matches(this.#context)) {
      this.invalidate();
      return;
    }
    const panel = structuredClone(this.#state),
      context = structuredClone(this.#context),
      generation = ++this.#generation,
      current = () => this.#current(context, generation),
      writes = new Map<string, unknown>();
    this.#state = { ...panel, busy: true, error: undefined };
    this.#emit();
    const dependencies: ProjectContentDependencies = {
      read: async (key) => {
        current();
        const value = await this.options.cache.read(context.target, key, current);
        current();
        return value;
      },
      write: async (key, value) => {
        current();
        writes.set(key, structuredClone(value));
      },
      request: async (path, params) => {
        current();
        if (!context.online) throw Error('执行电脑离线，未发送文件读取请求。');
        const projected = this.#target(context.target);
        const prefix = `/api/workspaces/${projected.catalogWorkspaceId}/replicas/${projected.replicaId}/`;
        const names: Record<string, ProjectContentMethod> = {
          'project-tree': 'read-project-tree',
          'file-content': 'file-content',
          'turn-diff': 'read-turn-diff',
          'diff-file': 'read-diff-file',
        };
        const method = path.startsWith(prefix) ? names[path.slice(prefix.length)] : undefined;
        if (!method) throw Error('不支持的文件读取操作。');
        const result = await this.options.request(structuredClone(context.target), method, params);
        current();
        return result;
      },
    };
    try {
      const patch = await work(panel, context.online, dependencies);
      current();
      try {
        await this.options.cache.writeBatch(context.target, writes, current);
      } catch {
        current();
        for (const view of [patch.tree, patch.currentFile, patch.diff, patch.diffFile])
          if (view) view.cacheSaved = false;
      }
      current();
      this.#state = { ...this.#state!, ...patch, busy: false };
    } catch (error) {
      if (generation === this.#generation && this.#matches(context))
        this.#state = {
          ...this.#state!,
          busy: false,
          error: error instanceof Error ? error.message : '文件读取失败，请重新读取。',
        };
    } finally {
      if (generation === this.#generation) this.#emit();
    }
  }
  async open(
    mode: 'tree' | 'changes',
    turns: ProjectTurnChoice[],
    title = '项目内容',
    turnId?: string,
  ) {
    const context = this.#bind(),
      choices = turnsSchema.parse(turns);
    this.#context = context;
    this.#generation++;
    this.#state = {
      target: this.#context.target,
      title,
      mode,
      turns: choices,
    };
    this.#emit();
    if (mode === 'tree') await this.#tree(false);
    else await this.turn(turnId ?? this.#state.turns[0]?.id);
  }
  async setMode(mode: 'tree' | 'changes') {
    const panel = this.state;
    if (panel) await this.open(mode, panel.turns, panel.title, panel.turnId);
  }
  async #tree(more: boolean) {
    if (!this.#state) return;
    if (more && this.#state.tree?.result.nextOffset === undefined) return;
    if (!more)
      this.#state = {
        ...this.#state,
        tree: undefined,
        currentFile: undefined,
        currentUnavailable: undefined,
      };
    await this.#read(async (panel, online, dependencies) => {
      const old = more ? panel.tree : undefined;
      const tree = await readProjectTree(
        this.#target(panel.target),
        old ? { offset: old.result.nextOffset, knownVersion: old.result.version } : {},
        online,
        dependencies,
      );
      if (!old) return { tree };
      const metadata = (value: typeof tree.result) => {
        const { offset: _offset, entries: _entries, nextOffset: _next, ...metadata } = value;
        return metadata;
      };
      const previous = new Set(old.result.entries.map((entry) => entry.path));
      if (
        canonical(metadata(old.result)) !== canonical(metadata(tree.result)) ||
        tree.result.entries.some((entry) => previous.has(entry.path))
      )
        throw Error('目录读取期间发生变化，请重新读取文件树。');
      return {
        tree: {
          ...tree,
          cacheSaved: old.cacheSaved && tree.cacheSaved,
          result: {
            ...tree.result,
            offset: 0,
            entries: [...old.result.entries, ...tree.result.entries],
          },
        },
      };
    });
  }
  async treeMore() {
    await this.#tree(true);
  }
  async file(path: string, size: number) {
    const panel = this.state;
    if (!panel) return;
    projectFilePathSchema.parse(path);
    if (
      !panel.tree?.result.entries.some(
        (entry) => entry.path === path && entry.type === 'file' && entry.size === size,
      )
    )
      throw Error('所选文件不属于已读取的文件树，请重新读取。');
    this.#state = { ...panel, currentFile: undefined, currentUnavailable: undefined };
    if (size > CONTENT_LIMITS.fileBytes) {
      this.#generation++;
      this.#state = {
        ...this.#state,
        busy: false,
        error: undefined,
        currentUnavailable: { path, message: '文件超过 1 MiB，只显示目录信息，不提供文本预览。' },
      };
      this.#emit();
      return;
    }
    await this.#read(async (value, online, dependencies) => ({
      currentFile: await readCurrentProjectFile(
        this.#target(value.target),
        path,
        online,
        dependencies,
      ),
    }));
  }
  async turn(turnId?: string) {
    const panel = this.state;
    if (!panel) return;
    if (turnId && !panel.turns.some((turn) => turn.id === turnId))
      throw Error('所选回合不属于已读取的会话。');
    this.#state = { ...panel, turnId, diff: undefined, diffFile: undefined };
    if (!turnId) {
      this.#generation++;
      this.#state = { ...this.#state, busy: false, error: undefined };
      this.#emit();
      return;
    }
    await this.#read(async (value, online, dependencies) => {
      const expected = value.turns.find((turn) => turn.id === turnId)?.reference;
      const diff = await readProjectTurnDiff(
        this.#target(value.target),
        turnId,
        online,
        dependencies,
        expected,
      );
      if (expected?.version && canonical(expected) !== canonical(diff.result.reference))
        throw Error('回合变更与已读取的完整基线引用不匹配。');
      return { diff };
    });
  }
  async diffFile(input: ProjectDiffChange) {
    const panel = this.state,
      change = structuredClone(input),
      reference = panel?.diff?.result.reference;
    if (!panel || !reference) return;
    if (!panel.diff!.result.changes.some((entry) => canonical(entry) === canonical(change)))
      throw Error('所选历史文件不属于已读取的回合基线。');
    this.#state = { ...panel, diffFile: undefined };
    await this.#read(async (value, online, dependencies) => ({
      diffFile: await readProjectDiffFile(
        this.#target(value.target),
        reference,
        change,
        online,
        dependencies,
      ),
    }));
  }
  async refresh() {
    const panel = this.state;
    if (!panel) return;
    if (panel.mode === 'tree') await this.#tree(false);
    else await this.turn(panel.turnId);
  }
  invalidate() {
    this.#generation++;
    this.#state = null;
    this.#context = undefined;
    this.#emit();
  }
  sync() {
    if (this.#context && !this.#matches(this.#context)) this.invalidate();
  }
  close() {
    this.invalidate();
  }
}
