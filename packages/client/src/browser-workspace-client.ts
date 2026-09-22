import { WorkspaceTransportClient, type LocalWorkspaceIdentity } from './workspace-transport';
import { BrowserHttpError, createBrowserWorkspaceHttp } from './browser-http';
import type { DesktopWorkspaceSource } from './workspace-protocol';

/** The browser supplies its same-origin cookie; no credential reaches application state. */
export class BrowserWorkspaceClient extends WorkspaceTransportClient {
  constructor(options: {
    origin: string;
    source?: DesktopWorkspaceSource;
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
