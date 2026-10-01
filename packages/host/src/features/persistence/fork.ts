import type { AgentConfig } from '../agents/driver';
import { type AgentForkAnchor, type AgentForkCapabilities } from '../agents/fork-model';
import type { AttachmentScope } from '../attachments/model';
import type { ForkRecord } from '../fork/model';
import type { ExecutionLease } from '../git/execution-model';

/** Capabilities consumed by Host session policies; no storage implementation is imported. */
export interface ForkPersistence {
  record(operationId: string): ForkRecord | undefined;
  child(sessionId: string): ForkRecord | undefined;
  blocked(sessionId: string): boolean;
  allowsGit(sessionId: string, operationId: string): boolean;
  stage(record: ForkRecord): void;
  save(record: ForkRecord): void;
  saveCapabilities(
    scope: AttachmentScope,
    execution: ExecutionLease,
    nativeId: string,
    capabilities: AgentForkCapabilities,
    agent: AgentConfig,
  ): void;
  capabilities(
    scope: AttachmentScope,
    execution: ExecutionLease,
    nativeId: string,
    agent: AgentConfig,
  ): AgentForkCapabilities | undefined;
  saveAnchor(
    scope: AttachmentScope,
    execution: ExecutionLease,
    turnId: string,
    anchor: AgentForkAnchor,
    agent: AgentConfig,
  ): void;
  anchor(
    scope: AttachmentScope,
    execution: ExecutionLease,
    nativeId: string,
    turnId: string,
    agent: AgentConfig,
  ): AgentForkAnchor | undefined;
}
