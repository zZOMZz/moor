import type { ContentScope } from '@moor/protocol/content-protocol';
/** The Host's full persisted execution scope, independent of a database or filesystem. */
export type AttachmentScope = ContentScope & { userId: string; machineId: string };
