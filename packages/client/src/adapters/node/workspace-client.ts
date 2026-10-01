import { randomUUID } from 'node:crypto';
import { NodeHttp, NodeHttpError } from './http';
import { NodeClientError } from './error';
import {
  WorkspaceTransportClient,
  type LocalWorkspaceIdentity,
} from '../shared/workspace-transport';
import type { WorkspaceSource } from '@moor/protocol/workspace-client-protocol';
export { type LocalWorkspaceIdentity } from '../shared/workspace-transport';

/** Node owns credentials; the shared client owns the finite business protocol. */
export class NodeWorkspaceClient extends WorkspaceTransportClient {
  constructor(options: {
    source: WorkspaceSource;
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
        new NodeHttp(
          { origin: options.origin, cookie: options.cookie, owner: options.localIdentity?.owner },
          {
            current: context.current,
            signal: context.signal,
            fetch: options.fetch,
          },
        ),
      classifyHttpError: (error) => (error instanceof NodeHttpError ? error : undefined),
      isNetworkError: (error) =>
        error instanceof NodeClientError && ['network', 'deadline'].includes(error.code),
    });
  }
}
