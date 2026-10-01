import type { DatabaseSync } from 'node:sqlite';
import type { CollaborationDocuments } from '@moor/sync/document/documents';
import { SqliteTaskLedger } from '../persistence/task-ledger';
import { CollaborationTaskQueue } from '../../features/collaboration/task-queue';

export function createCollaborationTaskQueue(
  database: DatabaseSync,
  documents: CollaborationDocuments,
  now: () => number,
) {
  return new CollaborationTaskQueue(documents, new SqliteTaskLedger(database), now);
}
