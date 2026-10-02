import type { WorkspaceOptions } from '../../features/workspace/model';

/** Applications choose this runtime explicitly; use cases never create timers or IDs. */
export const systemClientRuntime: Pick<
  WorkspaceOptions,
  'uuid' | 'now' | 'schedule' | 'yieldCache'
> = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  schedule(milliseconds, work) {
    const timer = setTimeout(work, milliseconds);
    return () => clearTimeout(timer);
  },
  yieldCache: () => new Promise<void>((done) => setTimeout(done, 0)),
};
