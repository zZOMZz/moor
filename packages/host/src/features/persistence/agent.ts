import type { AgentConfig } from '../agents/driver';
import type { AttachmentScope } from '../attachments/model';

/** Capabilities consumed by Host session policies; no storage implementation is imported. */
export interface AgentPersistence {
  get(agentId: string): AgentConfig | undefined;
  remember(value: AgentConfig): AgentConfig;
  bySession(sessionId: string):
    | {
        scope: AttachmentScope;
        config: AgentConfig;
      }
    | undefined;
  binding(value: AttachmentScope): AgentConfig | undefined;
  bind(value: AttachmentScope, input: AgentConfig): AgentConfig;
  assertCurrent(scope: AttachmentScope, config: AgentConfig): void;
}
