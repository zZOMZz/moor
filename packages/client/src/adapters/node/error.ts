import { RequestFailure, type RequestDeliveryEvidence } from '@moor/protocol/request-failure';

export class NodeClientError extends RequestFailure {
  constructor(
    public code: string,
    message: string,
    public exitCode = 2,
    public operationId?: string,
    evidence: { status: number; delivery: RequestDeliveryEvidence } | undefined = undefined,
  ) {
    super(message, code, evidence?.status ?? null, evidence?.delivery ?? 'unconfirmed');
  }
}
