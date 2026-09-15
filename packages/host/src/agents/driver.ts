import type { RunCapabilities } from '@moor/protocol/run-config';
import type { AgentProgramCheck } from './program';
import type { PromptInputCapabilities } from '@moor/protocol/attachment-protocol';
import type { QuestionAnswer, QuestionRequest } from '@moor/protocol/interaction-protocol';
import type {
  RuntimeFeatureReport,
  SessionEvent,
  SessionEventState,
} from '@moor/protocol/session-events';
import type {
  AgentForkAnchor,
  AgentForkCapabilities,
  AgentForkInput,
  AgentForkResult,
} from './fork';

export const LOCAL_CODEX_NOT_INSTALLED =
  '未找到可用的本机 Codex；请先安装 Codex CLI 或配置 MOOR_CODEX_PATH';

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
export type AgentRunBinding = Pick<
  QuestionRequest,
  'workspaceId' | 'localProjectId' | 'sessionId' | 'expectedTurnId'
>;
export type AgentCallbacks = {
  update(value: any): void;
  permission(value: any): Promise<{ outcome: PermissionOutcome }>;
  event?(event: SessionEvent, binding: AgentRunBinding): void;
  question?(request: QuestionRequest): Promise<QuestionAnswer>;
  forkAnchor?(anchor: AgentForkAnchor, binding: AgentRunBinding): void;
};
export type AgentInteractionCapabilities = {
  questions: boolean;
  steer: boolean;
  steerUnavailableReason?: string;
};
export type AgentSteerResult =
  | { outcome: 'injected' }
  | { outcome: 'promptRequired'; reason: 'noRunningTurn' };
// Ephemeral execution-host capability; never persisted in AgentConfig or a
// shared user input. The caller owns the service and revokes it with the turn.
export type AgentMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }
  | {
      type: 'http' | 'sse';
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
export type AgentOpenOptions = {
  /** Host invocation guard, including recovery loads; never serialized into ACP. */
  assertCurrent?: () => void;
  mcp?: {
    servers: AgentMcpServer[];
    redact: string[];
    assertCurrent(): void;
  };
  taskTools?: {
    url: string;
    token: string;
    assertCurrent(): void;
    onPromptDispatch(): void;
  };
};
export type AgentSession = {
  id: string;
  capabilities: RunCapabilities;
  /** Temporary capability probes only; changes configuration without sending a prompt. */
  configureModel?(modelId: string): Promise<RunCapabilities>;
  inputCapabilities?: PromptInputCapabilities;
  // Protocol observations are distinct from implemented, safe driver actions.
  runtimeFeatures?: RuntimeFeatureReport;
  interactionCapabilities?: AgentInteractionCapabilities;
  currentEvents?: SessionEventState;
  forkCapabilities?: AgentForkCapabilities;
  fork?(input: AgentForkInput): Promise<AgentForkResult>;
  prompt(input: any, binding?: AgentRunBinding): Promise<void>;
  steer?(input: { expectedTurnId: string; prompt: string }): Promise<AgentSteerResult>;
  cancel(): Promise<void>;
  close(): void | Promise<void>;
};
export type AgentDriver = {
  diagnose?(config: AgentConfig, cwd: string): Promise<AgentProgramCheck>;
  fork?(config: AgentConfig, input: AgentForkInput): Promise<AgentForkResult>;
  open(
    config: AgentConfig,
    cwd: string,
    nativeId: string | undefined,
    callbacks: AgentCallbacks,
    options?: AgentOpenOptions,
  ): Promise<AgentSession>;
};
