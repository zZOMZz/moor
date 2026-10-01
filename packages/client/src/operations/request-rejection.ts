import { productCanonicalJson } from '@moor/protocol/canonical-json';
import { isRequestRejected, type RequestFailure } from '@moor/protocol/request-failure';

/** Ephemeral proof for the fresh attempt; never a fabricated Host operation receipt. */
export type FreshRequestRejection = {
  request: unknown;
  failure: RequestFailure;
};

export function matchesFreshRequestRejection(
  request: unknown,
  evidence: FreshRequestRejection | undefined,
): boolean {
  return (
    !!evidence &&
    isRequestRejected(evidence.failure) &&
    productCanonicalJson(evidence.request) === productCanonicalJson(request)
  );
}
