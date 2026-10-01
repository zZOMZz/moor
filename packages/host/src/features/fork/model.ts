import { type ForkOrigin, type SessionFork } from '@moor/protocol/fork-protocol';
import type { AgentConfig } from '../agents/driver';
import {
  pinnedForkAdapter,
  type AgentForkAnchor,
  type AgentForkCapabilities,
} from '../agents/fork-model';
import type { AttachmentScope } from '../attachments/model';
import type { ExecutionLease } from '../git/execution-model';
export type ForkRecord = {
  scope: AttachmentScope;
  request: SessionFork;
  origin: ForkOrigin;
  sourceExecution: ExecutionLease;
  sourceNativeId: string;
  agent: AgentConfig;
  capabilities: AgentForkCapabilities;
  anchor?: AgentForkAnchor;
  phase: 'preparing' | 'dispatched' | 'returned' | 'accepted' | 'rejected' | 'abandoned';
  gitOperationId?: string;
  targetExecution?: ExecutionLease;
  targetDirectory?: import('../git/model').DirectoryIdentity;
  nativeId?: string;
};
export function supportedForkRecord(record: ForkRecord) {
  const provider = pinnedForkAdapter(record.agent);
  return (
    provider !== undefined &&
    record.capabilities.adapter === provider.adapter &&
    record.capabilities.adapterVersion === provider.adapterVersion &&
    (record.anchor === undefined ||
      (record.anchor.adapter === provider.adapter &&
        record.anchor.adapterVersion === provider.adapterVersion &&
        record.anchor.sourceNativeId === record.sourceNativeId))
  );
}
