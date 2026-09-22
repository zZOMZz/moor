import { randomUUID } from 'node:crypto';
import { CliHttp, CliHttpError } from './http';
import { CliError } from '../error';
import { WorkspaceTransportClient, type LocalWorkspaceIdentity } from '../workspace-transport';
import type { DesktopWorkspaceSource } from '../workspace-protocol';
export { type LocalWorkspaceIdentity } from '../workspace-transport';

/** Node owns credentials; the shared client owns the finite business protocol. */
export class DesktopWorkspaceClient extends WorkspaceTransportClient {
  constructor(options: {
    source: DesktopWorkspaceSource;
    origin: string;
    cookie: string;
    localIdentity?: LocalWorkspaceIdentity;
    current(): void;
    fetch?: typeof fetch;
    uuid?: () => string;
  }) {
    super({
      ...options,
      uuid: options.uuid ?? randomUUID,
      createHttp: (context) =>
        new CliHttp(
          { origin: options.origin, cookie: options.cookie, owner: options.localIdentity?.owner },
          {
            current: context.current,
            signal: context.signal,
            fetch: options.fetch,
          },
        ),
      classifyHttpError: (error) => (error instanceof CliHttpError ? error : undefined),
      isNetworkError: (error) =>
        error instanceof CliError && ['network', 'deadline'].includes(error.code),
    });
  }
}
