import type { TestContext } from 'node:test';
import { HostProductCatalog } from '../../src/bridge/host-product-catalog';
import { HostCommandDispatcher, type HostCommand } from '../../src/bridge/host-command';
import { EncryptedHostCommands } from '../../src/bridge/encrypted-host-command';
import type { HostWorkspace } from '../../src/bridge/host-workspace';
import { E2eeChannel, newChannelChallenge } from '../../src/security/e2ee-channel';
import { generateDeviceEncryptionKey } from '../../src/security/e2ee-crypto';
import {
  generateTrustRoot,
  encryptionKeyId,
  signTrustManifest,
  VerifiedTrust,
} from '../../src/security/e2ee-trust';
import type { EncryptedProductTarget } from '../../src/security/encrypted-product-catalog';

/** Synthetic keys with real authenticated records, product leases, and Host dispatch. */
export async function encryptedCommandHost(t: TestContext, workspace: () => HostWorkspace) {
  const [root, clientKey, hostKey] = await Promise.all([
    generateTrustRoot(),
    generateDeviceEncryptionKey(),
    generateDeviceEncryptionKey(),
  ]);
  const pin = {
    serverOrigin: 'https://relay.synthetic.invalid',
    accountId: 'owner',
    rootKeyId: root.keyId,
  };
  const signed = await signTrustManifest({
    rootPrivateKey: root.privateKey,
    rootPublicKey: root.publicKey,
    manifest: {
      ...pin,
      version: 1,
      epoch: 1,
      previous: null,
      devices: [
        {
          deviceId: 'client',
          keyId: await encryptionKeyId(clientKey.publicKey),
          publicKey: clientKey.publicKey,
          roles: ['client'],
        },
        {
          deviceId: 'host',
          keyId: await encryptionKeyId(hostKey.publicKey),
          publicKey: hostKey.publicKey,
          roles: ['host'],
        },
      ],
    },
  });
  const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
  const products = new HostProductCatalog({
    db: workspace().store.journal.db,
    authority: { ...pin, hostDeviceId: 'host' },
    runtime: () => ({
      catalogVersion: 1,
      machineId: workspace().workspace.machineId,
      workspaces: [workspace().workspace],
    }),
  });
  const replica = products.read().replicas.find((item) => item.localProjectId === 'project')!;
  const target: EncryptedProductTarget = {
    catalogWorkspaceId: replica.catalogWorkspaceId,
    projectId: replica.projectId,
    replicaId: replica.id,
    revision: replica.revision,
  };
  const dispatcher = new HostCommandDispatcher({
    ready: () => !workspace().closed,
    workspace: (id) => (id === workspace().workspace.id ? workspace() : undefined),
    hasOperation: (id) => workspace().store.journal.has(id),
  });
  async function connect() {
    let active = true;
    const common = {
      trust,
      clientDeviceId: 'client',
      hostDeviceId: 'host',
      hostChallenge: newChannelChallenge(),
      clientChallenge: newChannelChallenge(),
    };
    const [client, host] = await Promise.all([
      E2eeChannel.create({
        ...common,
        side: 'client',
        privateKey: clientKey.privateKey,
        current: () => trust,
      }),
      E2eeChannel.create({
        ...common,
        side: 'host',
        privateKey: hostKey.privateKey,
        current: () => (active ? trust : undefined),
      }),
    ]);
    const adapter = new EncryptedHostCommands({ channel: host, dispatcher, products });
    t.after(() => {
      client.close();
      host.close();
    });
    return {
      async execute(command: HostCommand, sessionId: string) {
        if (!command.localProjectId) throw new Error('Synthetic mapped command requires a project');
        const record = await client.send({
          kind: 'request',
          requestId: newChannelChallenge(),
          resource: {
            kind: 'session',
            workspaceId: command.workspaceId,
            projectId: command.localProjectId,
            sessionId,
            catalogWorkspaceId: target.catalogWorkspaceId,
            replicaId: target.replicaId,
          },
          plaintext: new TextEncoder().encode(
            JSON.stringify({ method: 'mapped-command', target, command }),
          ),
        });
        return JSON.parse(
          new TextDecoder().decode((await client.receive(await adapter.execute(record))).plaintext),
        );
      },
      retire() {
        active = false;
        host.close();
      },
    };
  }
  return { connect };
}
