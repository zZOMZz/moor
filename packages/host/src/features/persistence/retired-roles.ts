import type { RolesActionRequest } from '@moor/protocol/role-protocol';
import type { AttachmentScope } from '../attachments/model';
export interface RetiredRolePersistence {
  catalog(scope: AttachmentScope): { revision: number; roles: string } | undefined;
  original(
    scope: AttachmentScope,
    request: Extract<RolesActionRequest, { operationId: string }>,
  ): { fingerprint: string; phase: string; result: string } | undefined;
}
