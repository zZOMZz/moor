import type { TaskAction, TaskGrantView, TaskOrigin } from '@moor/protocol/task-protocol';
import type { AttachmentScope } from '../attachments/model';
import type { Grant, RetiredTaskOperation } from '../tasks/retired-model';
/** Read-only compatibility. No creation, queueing or execution capability exists here. */
export interface RetiredTaskPersistence {
  get(grantId: string): Grant | undefined;
  grant(scope: AttachmentScope, grantId: string): Grant;
  list(scope: AttachmentScope): Grant[];
  operations(grant: Grant): RetiredTaskOperation[];
  operation(grant: Grant, operationId: string): RetiredTaskOperation | undefined;
  hasRevocation(grant: Grant, request: TaskAction): boolean;
  origin(scope: AttachmentScope): TaskOrigin | undefined;
  allows(sessionId: string): boolean;
  view(grant: Grant, sessionExists: (sessionId: string) => boolean): TaskGrantView;
  operationView(
    operation: RetiredTaskOperation,
  ): import('zod').infer<typeof import('@moor/protocol/task-protocol').taskOperationViewSchema>;
}
