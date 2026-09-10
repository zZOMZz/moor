import type { Identity } from './api';

export type StartupSource =
  | { kind: 'identity'; identity: Identity | null }
  | { kind: 'cache'; owner: string };

// A stored owner selects local data only. It never authorizes a network request.
// A fast identity response wins over an unavailable or blocked local database.
export function firstStartupSource(
  identity: Promise<Identity | null>,
  owner: Promise<string | undefined>,
): Promise<StartupSource> {
  const confirmed = identity.then(
    (value): StartupSource => ({ kind: 'identity', identity: value }),
  );
  return Promise.race([
    confirmed,
    owner.then((value): StartupSource | Promise<StartupSource> =>
      value ? { kind: 'cache', owner: value } : confirmed,
    ),
  ]);
}
