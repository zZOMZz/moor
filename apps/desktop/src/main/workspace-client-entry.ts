import { NodeWorkspaceClient as Client } from '@moor/client/adapters/node/workspace-client';
import {
  workspaceCatalogSchema,
  type WorkspaceChange,
} from '@moor/protocol/workspace-client-protocol';
import { WorkspaceEvents } from './workspace-events';
/** @nativeEntry Loaded by account.cjs through main.cjs's packaged workspace-client.mjs loader. */
export {
  accountManagementPlan,
  validateAccountManagementResult,
} from '@moor/protocol/account-management';

/** @nativeEntry Loaded by workspace-bridge.cjs from the packaged workspace-client.mjs module. */
export class NodeWorkspaceClient extends Client {
  #events?: WorkspaceEvents;
  #closed = false;
  constructor(
    private readonly native: ConstructorParameters<typeof Client>[0] & {
      onSync?(value: WorkspaceChange): void;
    },
  ) {
    super(native);
  }
  override async request(raw: unknown) {
    const result = await super.request(raw);
    if (
      !this.#closed &&
      !this.#events &&
      this.native.onSync &&
      (raw as { action?: string })?.action === 'catalog' &&
      (result as { ok?: boolean })?.ok
    ) {
      const catalog = workspaceCatalogSchema.parse((result as { value: unknown }).value);
      this.#events = new WorkspaceEvents({
        origin: this.native.origin,
        cookie: this.native.cookie,
        current: this.native.current,
        changed: (notice) =>
          this.native.onSync!({
            ...notice,
            source: catalog.source,
            owner: catalog.owner,
            connectionId: catalog.connectionId,
          }),
      });
    }
    return result;
  }
  override close() {
    this.#closed = true;
    this.#events?.close();
    super.close();
  }
}
