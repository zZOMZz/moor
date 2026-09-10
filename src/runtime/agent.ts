import type { RunCapabilities } from '../run-config';
export type AgentConfig = {
  id: string;
  name: string;
  cliType: string;
  agentType: string;
  machineId: string;
  runtimeOverrides?: { codexPath?: string };
  // Launch configuration is local-only, never accepted from shared session documents.
  customAcp?: { command: string; args: string[] };
};
export type PermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };
export type AgentSession = {
  id: string;
  capabilities: RunCapabilities;
  prompt(input: any): Promise<void>;
  cancel(): Promise<void>;
  close(): void | Promise<void>;
};
export type AgentDriver = {
  open(
    config: AgentConfig,
    cwd: string,
    nativeId: string | undefined,
    callbacks: {
      update(value: any): void;
      permission(value: any): Promise<{ outcome: PermissionOutcome }>;
    },
  ): Promise<AgentSession>;
};
