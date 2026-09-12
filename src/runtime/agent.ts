import type { RunCapabilities } from '../run-config';
import type { PromptInputCapabilities } from '../attachment-protocol';
import type { QuestionAnswer, QuestionRequest } from '../interaction-protocol';
import type { RuntimeFeatureReport, SessionEvent, SessionEventState } from './session-events';
import type {
  AgentForkAnchor,
  AgentForkCapabilities,
  AgentForkInput,
  AgentForkResult,
} from './agent-fork';
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
export type AgentOpenOptions = {
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
  fork?(config: AgentConfig, input: AgentForkInput): Promise<AgentForkResult>;
  open(
    config: AgentConfig,
    cwd: string,
    nativeId: string | undefined,
    callbacks: AgentCallbacks,
    options?: AgentOpenOptions,
  ): Promise<AgentSession>;
};
