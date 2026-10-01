import type { AttachmentReference } from '@moor/protocol/content-protocol';
import type { RuntimeWorkspace } from '@moor/protocol/protocol';
import type { Flock, LoroDoc, VersionVector } from '@moor/session/model';
import type { CollaborationPlanes } from '../collaboration/service';
import type { AgentConfig } from '../agents/driver';
import type { AttachmentScope } from '../attachments/model';
import type { AgentPersistence } from './agent';
import type { AttentionPersistence } from './attention';
import type { ExecutionPersistence } from './execution';
import type { ForkPersistence } from './fork';
import type { GithubBindingPersistence } from './github';
import type { ProjectHistoryPersistence } from './history';
import type { OperationJournal } from './journal';
import type { SessionMetadataPersistence } from './metadata';
import type { NotificationPersistence } from './notifications';
import type { RetiredRolePersistence } from './retired-roles';
import type { SearchScope, SessionSearchPersistence } from './search';
import type { RetiredTaskPersistence } from './tasks';
export type StoredAttachment = {
  reference: AttachmentReference;
  bytes?: Uint8Array;
  referenced: boolean;
};
/** The Host transaction owns documents, receipts and projections together.
 * Consumers select their needed capabilities; no connection is exposed here. */
export interface WorkspacePersistence {
  readonly collaborationPlanes: CollaborationPlanes;
  journal: OperationJournal;
  projectHistory: ProjectHistoryPersistence;
  sessionSearch: SessionSearchPersistence;
  notifications: NotificationPersistence;
  executions: ExecutionPersistence;
  forks: ForkPersistence;
  github: GithubBindingPersistence;
  agents: AgentPersistence;
  tasks: RetiredTaskPersistence;
  retiredRoles: RetiredRolePersistence;
  hasSession(sessionId: string): boolean;
  sessionPages: SessionMetadataPersistence;
  attention: AttentionPersistence;
  meta: Flock;
  machine: Flock;
  workspace: RuntimeWorkspace;
  load(key: string): Uint8Array | undefined;
  save(key: string, bytes: Uint8Array): void;
  saveMetadata(flock: Flock, sessionIds: readonly string[]): void;
  loadFlock(key: string): Flock;
  doc(id: string): LoroDoc;
  transaction<T>(work: () => T): T;
  inTransaction(): boolean;
  persist(id: string, doc: LoroDoc, from?: VersionVector): void;
  persistOutput(id: string, candidate: LoroDoc, from: VersionVector): Uint8Array | undefined;
  confirmOutput(
    id: string,
    doc: LoroDoc,
    from: VersionVector,
    update: Uint8Array,
    version: Uint8Array,
  ): void;
  searchSource(id: string): { revision: number; bytes: number } | undefined;
  searchIndexVersion(
    scope: SearchScope,
  ): { revision: number; projectionVersion: number } | undefined;
  markSearchIndexed(scope: SearchScope, revision: number, projectionVersion: number): void;
  registerProject(path: string): string;
  saveMachine(): void;
  registerAgent(
    presetId: string,
    config: AgentConfig,
    registered?: (next: AgentConfig) => void,
  ): AgentConfig;
  hasNativeSession(id: string): boolean;
  nativeSession(
    id: string,
    execution?: { executionId: string; executionRevision: number },
    agentId?: string,
  ): string | undefined;
  setNativeSession(
    id: string,
    nativeId: string,
    execution?: { executionId: string; executionRevision: number },
    agentId?: string,
  ): void;
  attachmentScopeMatches(scope: AttachmentScope): boolean;
  reserveAttachmentScope(scope: AttachmentScope): void;
  attachment(scope: AttachmentScope, id: string): StoredAttachment | undefined;
  generatedAttachment(
    scope: AttachmentScope,
    reference: AttachmentReference,
  ): AttachmentReference | undefined;
  attachmentBytes(scope: AttachmentScope): number;
  saveAttachment(scope: AttachmentScope, reference: AttachmentReference, bytes: Uint8Array): void;
  removeAttachment(scope: AttachmentScope, id: string): void;
  referenceAttachment(scope: AttachmentScope, id: string): void;
  close(): void;
}
