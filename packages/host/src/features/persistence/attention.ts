import {
  type AttentionActor,
  type AttentionCause,
  type AttentionContext,
  type AttentionContinue,
  type AttentionDisposition,
  type AttentionItem,
  type AttentionItemPage,
  type AttentionListQuery,
  type AttentionPage,
  type AttentionReceipt,
  type AttentionSeen,
} from '@moor/protocol/attention';
export type AttentionFactInput = {
  sessionId: string;
  assistantTurnId: string;
  userTurnId: string;
  localProjectId: string;
  summary?: string;
};
export interface AttentionPersistence {
  summary(items: unknown): string;
  recordPermission(
    input: AttentionFactInput & {
      requestId: string;
    },
    occurredAt?: number,
  ): string;
  recordOutcome(
    input: AttentionFactInput & {
      cause: AttentionCause;
      historical?: boolean;
    },
    occurredAt?: number | null,
  ): string;
  resolvePermission(
    sessionId: string,
    assistantTurnId: string,
    requestId: string,
    lifecycle?: 'resolved' | 'invalidated',
  ): void;
  invalidateTurn(sessionId: string, assistantTurnId: string): void;
  invalidatePermissions(): void;
  rebuildSummaries(): void;
  reconcilePermissions(localProjectId: string, isActive: (item: AttentionItem) => boolean): void;
  get(context: AttentionContext, itemId: string): AttentionItem;
  sessionItems(context: AttentionContext, input?: Partial<AttentionListQuery>): AttentionItemPage;
  list(context: AttentionContext, input?: Partial<AttentionListQuery>): AttentionPage;
  lookupReceipt(
    context: AttentionContext,
    itemId: string,
    method: string,
    request: unknown,
    operationId: string,
  ): AttentionReceipt | undefined;
  hasReceipt(actor: AttentionActor, operationId: string): boolean;
  acceptReceipt(
    context: AttentionContext,
    itemId: string,
    method: string,
    request: unknown,
    operationId: string,
    result?: AttentionReceipt,
  ): AttentionReceipt;
  seen(context: AttentionContext, itemId: string, input: AttentionSeen): AttentionReceipt;
  disposition(
    context: AttentionContext,
    itemId: string,
    input: AttentionDisposition,
  ): AttentionReceipt;
  prepareContinue(
    context: AttentionContext,
    itemId: string,
    input: AttentionContinue,
  ): AttentionItem;
  continue(
    context: AttentionContext,
    itemId: string,
    input: AttentionContinue,
    followupUserTurnId: string,
  ): AttentionReceipt;
}
