import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scenes, type Scene } from './scenes';

export type AcceptanceScope = {
  accountId: string;
  deviceId: string;
  workspaceId: string;
  projectId: string;
  sessionId: string;
};
export type AcceptanceRun = {
  id: string;
  sceneId: Scene['id'];
  buildId: string;
  status: 'preparing' | 'ready' | 'failed' | 'stopped';
  stage: string;
  createdAt: string;
  scope?: AcceptanceScope;
  error?: string;
  decision?: 'accepted' | 'changes_requested';
  feedback?: string;
};
export type AcceptanceSnapshot = { scenes: typeof scenes; run?: AcceptanceRun };
export type PreparedScene = {
  buildId: string;
  scope: AcceptanceScope;
  dispose(): Promise<void>;
};
const runCommand = { runId: z.string().min(1).max(100) };
const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('prepare'),
      sceneId: z.enum(['narrow-dialog', 'settings-save', 'session-drawer']),
    })
    .strict(),
  z.object({ type: z.literal('reset'), ...runCommand }).strict(),
  z.object({ type: z.literal('stop'), ...runCommand }).strict(),
  z.object({ type: z.literal('accept'), ...runCommand }).strict(),
  z
    .object({
      type: z.literal('feedback'),
      ...runCommand,
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
]);

// Readiness belongs to the local preparer. It is separate from both an Agent's
// end-of-turn and the user's acceptance decision. Nothing resumes on reload.
export class AcceptanceController {
  private run?: AcceptanceRun;
  private resource?: PreparedScene;
  private abort?: AbortController;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Set<Promise<void>>();

  constructor(
    private readonly options: {
      prepare(
        scene: Scene,
        runId: string,
        signal: AbortSignal,
        stage: (value: string) => void,
      ): Promise<PreparedScene>;
      changed(snapshot: AcceptanceSnapshot): void;
      now?: () => Date;
      id?: () => string;
    },
  ) {}

  snapshot(): AcceptanceSnapshot {
    return structuredClone({ scenes, run: this.run });
  }
  private emit() {
    this.options.changed(this.snapshot());
  }
  private current(id: string) {
    if (this.closed || !this.run || this.run.id !== id)
      throw new Error('验收现场已改变，请查看当前版本后再操作。');
    return this.run;
  }
  async command(raw: unknown) {
    if (this.closed) throw new Error('验收窗口已关闭。');
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) throw new Error('验收操作无效。');
    const command = parsed.data;
    if (command.type === 'prepare') {
      this.start(scenes.find((scene) => scene.id === command.sceneId)!);
    } else {
      const run = this.current(command.runId);
      if (command.type === 'reset') {
        this.start(scenes.find((scene) => scene.id === run.sceneId)!);
      } else if (command.type === 'stop') {
        this.abort?.abort();
        run.status = 'stopped';
        run.stage = '现场已停止，可手动重新准备';
        try {
          this.emit();
        } finally {
          await this.release();
        }
      } else {
        if (run.status !== 'ready') throw new Error('现场尚未就绪，不能记录验收结果。');
        if (command.type === 'accept') run.decision = 'accepted';
        else {
          run.decision = 'changes_requested';
          run.feedback = command.text;
        }
        this.emit();
      }
    }
    return this.snapshot();
  }
  private start(scene: Scene) {
    this.abort?.abort();
    const previous = this.resource;
    this.resource = undefined;
    const abort = new AbortController();
    this.abort = abort;
    const run: AcceptanceRun = {
      id: (this.options.id ?? randomUUID)(),
      sceneId: scene.id,
      buildId: '',
      status: 'preparing',
      stage: '正在准备独立的验收环境',
      createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
    this.run = run;
    this.emit();
    const active = () => !this.closed && !abort.signal.aborted && this.run === run;
    const prepare = async () => {
      try {
        await previous?.dispose();
        if (!active()) return;
        const resource = await this.options.prepare(scene, run.id, abort.signal, (stage) => {
          if (active()) {
            run.stage = stage;
            this.emit();
          }
        });
        if (!active()) {
          await resource.dispose();
          return;
        }
        this.resource = resource;
        run.scope = resource.scope;
        run.buildId = resource.buildId;
        run.status = 'ready';
        run.stage = '现场已就绪，可以亲手操作';
        this.emit();
      } catch (error) {
        if (!active()) return;
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : '准备验收现场失败';
        this.emit();
      }
    };
    this.track(prepare());
  }
  private track(work: Promise<void>) {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  private release() {
    const resource = this.resource;
    this.resource = undefined;
    // Retain ownership of cleanup after detaching the current resource. A close
    // arriving during a stop must still wait for this disposal to finish.
    return this.track(Promise.resolve().then(() => resource?.dispose()));
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort?.abort();
    this.release();
    const failures: unknown[] = [];
    if (this.run) {
      this.run.status = 'stopped';
      this.run.stage = '现场已关闭';
      try {
        this.emit();
      } catch (error) {
        failures.push(error);
      }
    }
    this.closing = Promise.allSettled(this.pending).then((results) => {
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, '验收窗口关闭时未能完成全部清理。');
    });
    return this.closing;
  }
}
