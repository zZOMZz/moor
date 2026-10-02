import { systemClientRuntime } from '@moor/client/adapters/shared/runtime';

let nextOperation = 0;
/** Explicit synthetic identities and clock; individual journeys override timer barriers. */
export const syntheticClientRuntime = {
  ...systemClientRuntime,
  uuid: () => `00000000-0000-4000-8000-${(++nextOperation).toString(16).padStart(12, '0')}`,
  now: () => '2026-01-01T00:00:00.000Z',
};
