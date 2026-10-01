import type { SearchHit } from '@moor/protocol/search-protocol';
import type { SearchDocument } from '@moor/session/session-search-document';
import type { AttachmentScope } from '../attachments/model';
export type SearchScope = AttachmentScope;
export interface SessionSearchPersistence {
  replace(scope: SearchScope, document: SearchDocument): void;
  search(
    scope: SearchScope,
    query: string,
    range: 'session' | 'project',
    limit?: number,
    allowedSessionIds?: readonly string[],
  ): { hits: SearchHit[]; more: boolean; partial: boolean };
}
