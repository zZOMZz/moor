import { z } from 'zod';
import type { AgentConfig } from './driver';

export const opaqueId = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\s\x00-\x1f\x7f]/u.test(value));
export const codexAgentForkAnchorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('completed-turn'),
    adapter: z.literal('codex-acp'),
    adapterVersion: z.literal('1.11.0'),
    sourceNativeId: opaqueId,
    messageId: opaqueId,
  })
  .strict();
const legacyClaudeAgentForkAnchorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('completed-turn'),
    adapter: z.literal('claude-agent-acp'),
    adapterVersion: z.literal('0.76.0'),
    sourceNativeId: opaqueId,
    messageId: opaqueId,
  })
  .strict();
/** Durable reader only; runtime capability and anchor generation remain Codex-only. */
export const agentForkAnchorSchema = z.discriminatedUnion('adapter', [
  codexAgentForkAnchorSchema,
  legacyClaudeAgentForkAnchorSchema,
]);
export type AgentForkAnchor = z.infer<typeof agentForkAnchorSchema>;
export type CodexAgentForkAnchor = z.infer<typeof codexAgentForkAnchorSchema>;
export type AgentForkCapabilities = {
  sameDirectory: boolean;
  worktree: boolean;
  turnCutoff: boolean;
  adapter?: CodexAgentForkAnchor['adapter'];
  adapterVersion?: CodexAgentForkAnchor['adapterVersion'];
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
    : undefined;
}
