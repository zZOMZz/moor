import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Flock } from '../model';
import { AppError, assert, id } from '../protocol';
import { runCapabilitiesSchema, type RunCapabilities } from '../run-config';
import {
  promptInputCapabilitiesSchema,
  type PromptInputCapabilities,
} from '../attachment-protocol';
import type { AgentConfig, AgentDriver, AgentSession } from './agent';
import type { RuntimeStore } from './store';
import { localCodexPath, withLocalCodex } from '../bridge/local-codex';

const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const text = z.string().regex(/^[^\0]*$/u);
export const agentSettingsActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('builtin'),
      expectedRevision: revision,
      agentType: z.enum(['codex', 'claude']),
    })
    .strict(),
  z
    .object({
      action: z.literal('save'),
      expectedRevision: revision,
      id: id.optional(),
      name: text.min(1).max(100),
      command: text.min(1).max(4096),
      args: z.array(text.max(4096)).max(128),
      enabled: z.boolean().default(false),
    })
    .strict(),
  z
    .object({ action: z.literal('enabled'), expectedRevision: revision, id, enabled: z.boolean() })
    .strict(),
  z.object({ action: z.literal('remove'), expectedRevision: revision, id }).strict(),
  z.object({ action: z.literal('check'), expectedRevision: revision, id, versionId: id }).strict(),
]);
export type AgentSettingsAction = z.infer<typeof agentSettingsActionSchema>;
export type AgentCheck = {
  versionId: string;
  ok: boolean;
  runConfig?: RunCapabilities;
  inputCapabilities?: PromptInputCapabilities;
  error?: string;
};
export type AgentPreset = {
  id: string;
  name: string;
  versionId: string;
  cliType: string;
  agentType: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  runConfig?: RunCapabilities;
  inputCapabilities?: PromptInputCapabilities;
  checked?: AgentCheck;
};
export type AgentSettingsState = { revision: number; presets: AgentPreset[] };
const identitySchema = z
  .object({ workspaceId: id, userId: z.string().min(1).max(200), machineId: id })
  .strict();
const checkedSchema = z
  .object({
    versionId: id,
    ok: z.boolean(),
    runConfig: runCapabilitiesSchema.optional(),
    inputCapabilities: promptInputCapabilitiesSchema.optional(),
    error: z.string().max(200).optional(),
  })
  .strict();
const presetSchema = z
  .object({
    id,
    versionId: id,
    enabled: z.boolean(),
    removed: z.boolean().optional(),
    checked: checkedSchema.optional(),
  })
  .strict();
const savedSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    revision,
    presets: z.array(presetSchema).max(200),
  })
  .strict();
type Saved = z.infer<typeof savedSchema>;
const key = 'agent-settings-v1';
const failure = 'Agent 能力检查未完成；请检查本机程序和参数后手动重试';

/** Local IPC/CLI only. Neither launch fields nor this state belong in a catalogue. */
export class AgentSettings {
  private identity: z.infer<typeof identitySchema>;
  private closed = false;
  private checks = new Set<string>();
  private pending = new Set<Promise<AgentSettingsState>>();
  constructor(
    private store: RuntimeStore,
    private driver: AgentDriver,
    private changed: () => void = () => {},
  ) {
    this.identity = this.currentIdentity();
  }
  private currentIdentity() {
    return {
      workspaceId: this.store.workspace.id,
      userId: this.store.workspace.userId,
      machineId: this.store.workspace.machineId,
    };
  }
  private assertIdentity() {
    assert(
      !this.closed && isDeepStrictEqual(this.identity, this.currentIdentity()),
      409,
      '本机 Agent 设置范围已改变，请重新打开设置',
    );
  }
  private load(): Saved {
    this.assertIdentity();
    const bytes = this.store.load(key);
    let saved: Saved;
    try {
      saved = bytes
        ? savedSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
        : { version: 1, identity: { ...this.identity }, revision: 0, presets: [] };
    } catch {
      throw new AppError(409, '本机 Agent 设置无法安全读取');
    }
    assert(
      isDeepStrictEqual(saved.identity, this.identity),
      409,
      '本机 Agent 设置属于其他主机身份',
    );
    assert(
      new Set(saved.presets.map((p) => p.id)).size === saved.presets.length,
      409,
      '本机 Agent 预设编号重复',
    );
    return saved;
  }
  private merged(saved: Saved) {
    const presets = [...saved.presets];
    for (const row of this.store.machine.scan({ prefix: ['agentPreset'] })) {
      if (
        typeof row.key[1] !== 'string' ||
        typeof row.value !== 'string' ||
        presets.some((p) => p.id === row.key[1])
      )
        continue;
      presets.push({
        id: row.key[1],
        versionId: row.value,
        enabled: this.store.machine.get(['disabledAgent', row.value]) !== true,
      });
    }
    // Legacy hosts stored current configs without a separate preset pointer.
    // Listing remains read-only; the first edit materializes the same ID.
    for (const row of this.store.machine.scan({ prefix: ['agentConfig'] })) {
      const versionId = row.key[1];
      if (
        typeof versionId !== 'string' ||
        this.store.machine.get(['retiredAgent', versionId]) === true ||
        presets.some((p) => p.versionId === versionId || p.id === versionId)
      )
        continue;
      presets.push({
        id: versionId,
        versionId,
        enabled: this.store.machine.get(['disabledAgent', versionId]) !== true,
      });
    }
    return presets;
  }
  wasConfigured(presetId: string) {
    return this.load().presets.some((p) => p.id === presetId);
  }
  read(): AgentSettingsState {
    const saved = this.load();
    const presets = this.merged(saved)
      .filter((p) => !p.removed)
      .map((p): AgentPreset => {
        const config = this.store.agents.get(p.versionId);
        assert(
          config &&
            config.machineId === this.identity.machineId &&
            (this.store.machine.get(['agentPreset', p.id]) === p.versionId ||
              (this.store.machine.get(['agentPreset', p.id]) === undefined &&
                p.id === p.versionId)),
          409,
          '本机 Agent 预设版本不匹配',
        );
        const capabilities = runCapabilitiesSchema.safeParse(
          this.store.machine.get(['capabilities', config.id]),
        );
        const inputs = promptInputCapabilitiesSchema.safeParse(
          this.store.machine.get(['inputCapabilities', config.id]),
        );
        return {
          id: p.id,
          name: config.name,
          versionId: config.id,
          cliType: config.cliType,
          agentType: config.agentType,
          enabled: p.enabled,
          ...(config.customAcp
            ? { command: config.customAcp.command, args: [...config.customAcp.args] }
            : {}),
          ...(capabilities.success ? { runConfig: capabilities.data } : {}),
          ...(inputs.success ? { inputCapabilities: inputs.data } : {}),
          ...(p.checked?.versionId === config.id ? { checked: { ...p.checked } } : {}),
        };
      });
    return { revision: saved.revision, presets };
  }
  private expected(expectedRevision: number) {
    const saved = this.load();
    assert(saved.revision === expectedRevision, 409, 'Agent 设置已更新，请重新读取后再操作');
    return saved;
  }
  private persist(saved: Saved) {
    this.assertIdentity();
    assert(
      saved.presets.length <= 200 && saved.presets.filter((p) => !p.removed).length <= 100,
      409,
      '本机 Agent 预设数量已达上限',
    );
    for (const preset of saved.presets) {
      const pointer = this.store.machine.get(['agentPreset', preset.id]);
      assert(
        pointer === undefined || pointer === preset.versionId,
        409,
        '本机 Agent 预设版本已改变',
      );
      if (pointer === undefined)
        this.store.machine.set(['agentPreset', preset.id], preset.versionId);
    }
    for (const versionId of new Set(saved.presets.map((p) => p.versionId))) {
      const references = saved.presets.filter((p) => p.versionId === versionId && !p.removed);
      this.store.machine.set(['disabledAgent', versionId], !references.some((p) => p.enabled));
      if (!references.length) this.store.machine.set(['retiredAgent', versionId], true);
    }
    this.store.save(key, Buffer.from(JSON.stringify(saved)));
  }
  private notify() {
    try {
      this.changed();
    } catch {
      /* Persistence already succeeded. */
    }
  }
  private update(expectedRevision: number, mutate: (saved: Saved) => void) {
    const previous = this.store.machine;
    this.store.machine = Flock.fromFile(previous.exportFile());
    try {
      this.store.transaction(() => {
        const saved = this.expected(expectedRevision);
        saved.presets = this.merged(saved);
        mutate(saved);
        saved.revision++;
        this.persist(saved);
        this.store.saveMachine();
      });
    } catch (error) {
      this.store.machine = previous;
      throw error;
    }
    this.notify();
    return this.read();
  }
  async handle(input: unknown): Promise<AgentSettingsState> {
    const parsed = agentSettingsActionSchema.safeParse(input);
    assert(
      parsed.success && Buffer.byteLength(JSON.stringify(input), 'utf8') <= 64 * 1024,
      400,
      '本机 Agent 设置请求无效',
    );
    const action = parsed.data;
    if (action.action === 'read') return this.read();
    const saved = this.expected(action.expectedRevision);
    saved.presets = this.merged(saved);
    if (action.action === 'builtin') {
      const presetId = 'personal-' + action.agentType;
      assert(
        !saved.presets.some((p) => p.id === presetId && !p.removed),
        409,
        '此内置 Agent 已登记',
      );
      let config: AgentConfig;
      try {
        config = withLocalCodex(
          {
            id: presetId,
            name: action.agentType === 'codex' ? 'Codex' : 'Claude',
            cliType: 'builtin',
            agentType: action.agentType,
            machineId: this.identity.machineId,
          },
          action.agentType === 'codex' ? localCodexPath() : undefined,
        );
      } catch {
        throw new AppError(400, '内置 Agent 程序配置不可用，请检查本机安装');
      }
      this.store.registerAgent(presetId, config, (next) => {
        this.expected(action.expectedRevision);
        saved.presets = saved.presets.filter((p) => p.id !== presetId);
        saved.presets.push({ id: presetId, versionId: next.id, enabled: false });
        saved.revision++;
        this.persist(saved);
      });
      this.notify();
      return this.read();
    }
    const preset =
      'id' in action && action.id
        ? saved.presets.find((p) => p.id === action.id && !p.removed)
        : undefined;
    if (action.action === 'save') {
      assert(!action.id || preset, 404, 'Agent 预设不存在');
      assert(
        !preset || this.store.agents.get(preset.versionId)?.cliType === 'custom',
        400,
        '内置 Agent 只支持检查、启用或移除',
      );
      const command = executable(action.command),
        presetId = preset?.id ?? 'preset_' + randomUUID();
      const config: AgentConfig = {
        id: preset?.versionId ?? 'agent_' + randomUUID(),
        name: action.name,
        cliType: 'custom',
        agentType: 'custom',
        machineId: this.identity.machineId,
        customAcp: { command, args: [...action.args] },
      };
      this.store.registerAgent(presetId, config, (next) => {
        this.expected(action.expectedRevision);
        saved.presets = saved.presets.filter((p) => p.id !== presetId);
        saved.presets.push({
          id: presetId,
          versionId: next.id,
          enabled: action.enabled,
          ...(preset?.versionId === next.id && preset.checked ? { checked: preset.checked } : {}),
        });
        saved.revision++;
        this.persist(saved);
      });
      this.notify();
      return this.read();
    }
    assert(preset, 404, 'Agent 预设不存在');
    if (action.action === 'check') {
      const pending = this.check(action, preset);
      this.pending.add(pending);
      try {
        return await pending;
      } finally {
        this.pending.delete(pending);
      }
    }
    return this.update(action.expectedRevision, (next) => {
      const target = next.presets.find((p) => p.id === preset.id)!;
      if (action.action === 'enabled') target.enabled = action.enabled;
      else {
        target.enabled = false;
        target.removed = true;
      }
    });
  }
  private async check(
    action: Extract<AgentSettingsAction, { action: 'check' }>,
    preset: Saved['presets'][number],
  ) {
    assert(action.versionId === preset.versionId, 409, 'Agent 预设版本已改变，请重新读取');
    assert(!this.checks.has(preset.id), 409, '此 Agent 正在检查，请等待完成');
    const config = this.store.agents.get(preset.versionId);
    assert(config && config.machineId === this.identity.machineId, 409, 'Agent 预设版本不可用');
    if (config.customAcp) executable(config.customAcp.command);
    this.checks.add(preset.id);
    let directory: string | undefined, session: AgentSession | undefined;
    let runConfig: RunCapabilities | undefined,
      inputs: PromptInputCapabilities | undefined,
      ok = false;
    try {
      directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-agent-check-')));
      session = await this.driver.open(config, directory, undefined, {
        update: () => {},
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
      this.expected(action.expectedRevision);
      runConfig = runCapabilitiesSchema.parse(session.capabilities);
      inputs =
        session.inputCapabilities === undefined
          ? undefined
          : promptInputCapabilitiesSchema.parse(session.inputCapabilities);
      ok = true;
    } catch {
      ok = false;
    } finally {
      try {
        await session?.close();
      } catch {
        ok = false;
      }
      if (directory) rmSync(directory, { recursive: true, force: true });
      this.checks.delete(preset.id);
    }
    // Settings edits, logout/replacement and shutdown invalidate any late check.
    return this.update(action.expectedRevision, (next) => {
      const target = next.presets.find((p) => p.id === preset.id);
      assert(
        target && !target.removed && target.versionId === action.versionId,
        409,
        'Agent 预设版本已改变，请重新读取',
      );
      target.checked = {
        versionId: action.versionId,
        ok,
        ...(ok
          ? { runConfig, ...(inputs ? { inputCapabilities: inputs } : {}) }
          : { error: failure }),
      };
      if (ok) {
        this.store.machine.set(['capabilities', action.versionId], runConfig as never);
        this.store.machine.set(['inputCapabilities', action.versionId], inputs as never);
      }
    });
  }
  close() {
    this.closed = true;
    // The driver bounds initialization and owns process termination. Wait for
    // finally/close before the host exits, including an open still in flight.
    return Promise.allSettled([...this.pending]).then(() => {});
  }
}

function executable(path: string) {
  try {
    assert(isAbsolute(path), 400, 'Agent 程序必须是绝对路径的可执行普通文件');
    const canonical = join(realpathSync(dirname(path)), basename(path));
    const stat = lstatSync(canonical);
    assert(
      stat.isFile() && !stat.isSymbolicLink(),
      400,
      'Agent 程序必须是绝对路径的可执行普通文件',
    );
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    throw new AppError(400, 'Agent 程序必须是绝对路径的可执行普通文件');
  }
}
