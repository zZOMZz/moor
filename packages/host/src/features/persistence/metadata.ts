import type { SessionPageRequest } from '@moor/protocol/session-page';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import type { Flock } from '@moor/session/model';
export type PersistedValue = string | number | bigint | Uint8Array | null;
export type SessionPagePosition = { pin: number; time: number; id: string };
export type MetadataScope = { userId: string; machineId: string; localProjectId: string };
export interface SessionMetadataPersistence {
  ensureCurrent(): void;
  update(flock: Flock, ids: readonly string[]): void;
  version(scope: MetadataScope): PersistedValue[];
  snapshot<T>(read: () => T): T;
  page(
    scope: MetadataScope,
    request: SessionPageRequest,
    position?: SessionPagePosition,
  ): { item: SessionMetadata; position: SessionPagePosition }[];
}
