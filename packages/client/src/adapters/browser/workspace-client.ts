import {
  WorkspaceTransportClient,
  type LocalWorkspaceIdentity,
} from '../shared/workspace-transport';
import { BrowserHttpError, createBrowserWorkspaceHttp } from './http';
import type { WorkspaceSource } from '@moor/protocol/workspace-client-protocol';

/** The browser supplies its same-origin cookie; no credential reaches application state. */
export class BrowserWorkspaceClient extends WorkspaceTransportClient {
  constructor(options: {
    origin: string;
    source?: WorkspaceSource;
    localIdentity?: LocalWorkspaceIdentity;
    current(): void;
    fetch?: typeof fetch;
    uuid?: () => string;
    deadline?: (milliseconds: number) => AbortSignal;
  }) {
    super({
      ...options,
      source: options.source ?? 'remote',
      createHttp: (context) => createBrowserWorkspaceHttp(options, context),
      classifyHttpError: (error) => (error instanceof BrowserHttpError ? error : undefined),
    });
  }
}
