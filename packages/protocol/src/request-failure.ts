export type RequestDeliveryEvidence = 'not-dispatched' | 'unconfirmed';

/** Evidence describes this attempt, never an earlier attempt with the same operation id. */
export class RequestFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
    readonly delivery: RequestDeliveryEvidence,
  ) {
    super(message);
  }
}

export const isRequestRejected = (error: unknown): error is RequestFailure =>
  error instanceof RequestFailure && error.delivery === 'not-dispatched';
