import { HostProductCatalog } from '@moor/host/commands/product-catalog';
import { HostCommandDispatcher, type HostCommand } from '@moor/host/commands/host-command';
import type { HostWorkspace } from '@moor/host/sessions/workspace';
import type { EncryptedProductTarget } from '@moor/e2ee/encrypted-product-catalog';

/** Real product claims and Host dispatch, with synthetic authority and no network writes. */
export function mappedHost(host: () => HostWorkspace) {
  const authority = {
    serverOrigin: 'https://relay.synthetic.invalid',
    accountId: 'owner',
    rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
    hostDeviceId: 'host',
  };
  const open = () =>
    new HostProductCatalog({
      db: host().store.journal.db,
      authority,
      runtime: () => ({
        catalogVersion: 1,
        machineId: host().workspace.machineId,
        workspaces: [host().workspace],
      }),
    });
  let products = open();
  const dispatcher = new HostCommandDispatcher({
    ready: () => !host().closed,
    workspace: (id) => (id === host().workspace.id ? host() : undefined),
    hasOperation: (id) => host().store.journal.has(id),
  });
  return {
    get products() {
      return products;
    },
    reopen() {
      products = open();
    },
    target(): EncryptedProductTarget {
      const replica = products
        .read()
        .replicas.find((replica) => replica.localProjectId === 'project')!;
      return {
        catalogWorkspaceId: replica.catalogWorkspaceId,
        projectId: replica.projectId,
        replicaId: replica.id,
        revision: replica.revision,
      };
    },
    move() {
      products.action({
        version: 1,
        action: 'create-workspace',
        operationId: 'create-space',
        expectedRevision: products.read().revision,
        id: 'other-space',
        name: 'Other',
      });
      products.action({
        version: 1,
        action: 'move-host',
        operationId: 'move-host',
        expectedRevision: products.read().revision,
        runtimeWorkspaceId: host().workspace.id,
        targetWorkspaceId: 'other-space',
      });
    },
    async execute(target: EncryptedProductTarget, command: HostCommand) {
      const lease = products.acquire(target, command);
      try {
        products.bindOperation(target, command);
        return await dispatcher.execute(command, { current: () => lease.current() });
      } finally {
        lease.release();
      }
    },
  };
}
