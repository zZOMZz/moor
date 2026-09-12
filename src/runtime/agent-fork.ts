import { isAbsolute } from 'node:path';
import type { InitializeResponse, ForkSessionRequest } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { AgentConfig } from './agent';
import { AppError } from '../protocol';

const opaqueId = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\s\x00-\x1f\x7f]/u.test(value));
export const agentForkAnchorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('completed-turn'),
    adapter: z.enum(['codex-acp', 'claude-agent-acp']),
    adapterVersion: z.enum(['1.11.0', '0.76.0']),
    sourceNativeId: opaqueId,
    messageId: opaqueId,
  })
  .strict();
export type AgentForkAnchor = z.infer<typeof agentForkAnchorSchema>;
export type AgentForkCapabilities = {
  sameDirectory: boolean;
  worktree: boolean;
  turnCutoff: boolean;
  adapter?: AgentForkAnchor['adapter'];
  adapterVersion?: AgentForkAnchor['adapterVersion'];
  sameDirectoryUnavailableReason?: string;
  worktreeUnavailableReason?: string;
  turnCutoffUnavailableReason?: string;
};
export type AgentForkInput = {
  sourceNativeId: string;
  sourceCwd: string;
  targetCwd: string;
  anchor?: AgentForkAnchor;
  // Host-local hooks; neither callback is accepted from a remote request or
  // serialized into ACP. Persist the known child before any second-stage load.
  assertCurrent?: () => void;
  onNativeId?: (nativeId: string) => void | Promise<void>;
};
export type AgentForkResult = { nativeId: string };

export function pinnedForkAdapter(config: AgentConfig) {
  if (config.customAcp) return undefined;
  return config.agentType === 'codex'
    ? { adapter: 'codex-acp' as const, adapterVersion: '1.11.0' as const }
    : config.agentType === 'claude'
      ? { adapter: 'claude-agent-acp' as const, adapterVersion: '0.76.0' as const }
      : undefined;
}
export function forkCapabilities(
  config: AgentConfig,
  init: InitializeResponse,
): AgentForkCapabilities {
  const pinned = pinnedForkAdapter(config);
  const native =
    !!pinned &&
    init.agentInfo?.name === '@agentclientprotocol/' + pinned.adapter &&
    init.agentInfo.version === pinned.adapterVersion &&
    !!init.agentCapabilities?.sessionCapabilities?.fork &&
    init.agentCapabilities.loadSession === true;
  return {
    sameDirectory: native,
    turnCutoff: native,
    ...pinned,
    // Claude uses source-directory fork followed by child-only load at the target;
    // Codex passes target cwd directly to its native thread/fork operation.
    worktree: native,
    ...(!native
      ? {
          sameDirectoryUnavailableReason: '此 Agent 尚未验证支持原生会话 Fork',
          worktreeUnavailableReason: '此 Agent 尚未验证支持原生会话 Fork',
          turnCutoffUnavailableReason: '此 Agent 尚未验证支持指定回合 Fork',
        }
      : {}),
  };
}
export function validateForkInput(config: AgentConfig, input: AgentForkInput): void {
  const anchor =
      input.anchor === undefined ? undefined : agentForkAnchorSchema.safeParse(input.anchor),
    pinned = pinnedForkAdapter(config);
  if (
    !pinned ||
    !opaqueId.safeParse(input.sourceNativeId).success ||
    (anchor &&
      (!anchor.success ||
        anchor.data.adapter !== pinned.adapter ||
        anchor.data.adapterVersion !== pinned.adapterVersion ||
        anchor.data.sourceNativeId !== input.sourceNativeId)) ||
    !isAbsolute(input.sourceCwd) ||
    !isAbsolute(input.targetCwd) ||
    input.sourceCwd.includes('\0') ||
    input.targetCwd.includes('\0')
  )
    throw new AppError(409, '缺少可验证的原生回合锚点，无法从该回合 Fork', true);
}
export function nativeForkRequest(
  input: AgentForkInput,
  adapter: AgentForkAnchor['adapter'],
): ForkSessionRequest {
  return {
    sessionId: input.sourceNativeId,
    cwd: adapter === 'claude-agent-acp' ? input.sourceCwd : input.targetCwd,
    mcpServers: [],
    // This extension is implemented by both exact pinned adapters. Its name is
    // their wire contract; Moor never copies history or uses a text fingerprint.
    ...(input.anchor
      ? {
          _meta: {
            jetbrains: { air: { fork: { version: 1, messageId: input.anchor.messageId } } },
          },
        }
      : {}),
  };
}
export function forkResult(value: unknown, sourceNativeId: string): AgentForkResult {
  const result = z.object({ sessionId: opaqueId }).safeParse(value);
  if (!result.success || result.data.sessionId === sourceNativeId)
    throw new AppError(502, 'Agent 未确认创建独立原生会话');
  return { nativeId: result.data.sessionId };
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** Holds at most one native ID; it never retains user/Agent text or tool bodies. */
export class ForkAnchorObservation {
  private messageId?: string;
  observe(value: unknown) {
    const update = record(value);
    if (!update) return;
    const meta = record(update._meta),
      claude = record(meta?.claudeCode);
    if (claude?.parentToolUseId || meta?.parentToolUseId || meta?.subagent) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const parsed = opaqueId.safeParse(update.messageId);
      this.messageId = parsed.success ? parsed.data : undefined;
    } else if (
      ['tool_call', 'tool_call_update', 'user_message_chunk'].includes(String(update.sessionUpdate))
    ) {
      // Claude's cutoff is inclusive at the message, not at the containing turn.
      // Tool/user work after that message must not be lost behind a stale ID.
      this.messageId = undefined;
    } else if (
      update.sessionUpdate === 'agent_thought_chunk' &&
      update.messageId !== this.messageId
    ) {
      this.messageId = undefined;
    }
  }
  complete(config: AgentConfig, sourceNativeId: string): AgentForkAnchor | undefined {
    const pinned = pinnedForkAdapter(config);
    return pinned && this.messageId
      ? {
          version: 1,
          kind: 'completed-turn',
          ...pinned,
          sourceNativeId,
          messageId: this.messageId,
        }
      : undefined;
  }
}
