import { E2EE_CRYPTO_FAILED } from '../security/e2ee-crypto';
import {
  E2eeChannel,
  E2EE_RECORD_LIMITS,
  type EncryptedRecord,
  type EncryptedResource,
} from '../security/e2ee-channel';
import { taskAuthoritySchema } from '../task-protocol';
import {
  encryptedCatalogRequestSchema as catalogCommandSchema,
  encryptedCatalogSchema as encryptedHostCatalogSchema,
  type EncryptedCatalog as EncryptedHostCatalog,
} from '../security/encrypted-bridge-protocol';
export { encryptedHostCatalogSchema, type EncryptedHostCatalog };
import { hostCommandSchema, HostCommandDispatcher, type HostCommand } from './host-command';

export const ENCRYPTED_HOST_COMMAND_REJECTED = '加密命令参数或执行范围无效';
export const ENCRYPTED_HOST_COMMAND_LIMIT = E2EE_RECORD_LIMITS.pending;
// One dispatcher serves the Host's channels. Hold admission through Host work and
// response encryption, not just while crypto is pending. There is no waiting queue.
const admissions = new WeakMap<HostCommandDispatcher, { active: number }>();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function matchesResource(command: HostCommand, resource: EncryptedResource): boolean {
  if (
    resource.kind === 'catalog' ||
    command.workspaceId !== resource.workspaceId ||
    command.localProjectId !== resource.projectId
  )
    return false;
  const params = object(command.params)!;
  const request = object(params.request);
  const sessionId = params.sessionId ?? request?.sessionId;
  if (sessionId === undefined) {
    if (resource.kind !== 'project' || !['sessions', 'agent-options'].includes(command.method))
      return false;
  } else if (resource.kind !== 'session' || sessionId !== resource.sessionId) return false;
  // Check the protocol's recovery wrappers, including session-operations' original
  // value. Do not traverse arbitrary CRDT document data or reinterpret childSessionId.
  for (const scope of [params, request, object(request?.value)]) {
    if (!scope) continue;
    if (scope.workspaceId !== undefined && scope.workspaceId !== resource.workspaceId) return false;
    if (scope.localProjectId !== undefined && scope.localProjectId !== resource.projectId)
      return false;
    if (scope.sessionId !== undefined && scope.sessionId !== resource.sessionId) return false;
  }
  return true;
}

/**
 * No networking or retry queue. A command accepted by the Host may finish after
 * revocation, but the original channel can no longer deliver its response.
 * Clients still validate detailed Host result schemas after decrypting.
 */
export class EncryptedHostCommands {
  private readonly channel: E2eeChannel;
  private readonly dispatcher: HostCommandDispatcher;
  private readonly admission: { active: number };
  private readonly catalog?: () => EncryptedHostCatalog | Promise<EncryptedHostCatalog>;
  private readonly runtimeScopesOnly: boolean;
  constructor(options: {
    channel: E2eeChannel;
    dispatcher: HostCommandDispatcher;
    catalog?: () => EncryptedHostCatalog | Promise<EncryptedHostCatalog>;
    runtimeScopesOnly?: boolean;
  }) {
    this.channel = options.channel;
    this.dispatcher = options.dispatcher;
    this.catalog = options.catalog;
    this.runtimeScopesOnly = options.runtimeScopesOnly ?? false;
    let admission = admissions.get(options.dispatcher);
    if (!admission) {
      admission = { active: 0 };
      admissions.set(options.dispatcher, admission);
    }
    this.admission = admission;
  }
  async execute(record: unknown): Promise<EncryptedRecord> {
    let reserved = false;
    try {
      if (this.admission.active >= ENCRYPTED_HOST_COMMAND_LIMIT)
        throw new Error(E2EE_CRYPTO_FAILED);
      this.admission.active++;
      reserved = true;
      return await this.executeCurrent(record);
    } catch {
      // Shutdown can also invalidate journal/error serialization. Never let a
      // failure outside an encrypted response expose an internal diagnostic.
      throw new Error(E2EE_CRYPTO_FAILED);
    } finally {
      if (reserved) this.admission.active--;
    }
  }
  private async executeCurrent(record: unknown): Promise<EncryptedRecord> {
    const { channel, dispatcher } = this;
    const received = await channel.receive(record);
    if (received.header.direction !== 'client-to-host' || received.header.kind !== 'request')
      throw new Error(E2EE_CRYPTO_FAILED);
    const { header } = received;
    const respond = (plaintext: Uint8Array) => {
      channel.assertCurrent();
      return channel.send({
        kind: 'response',
        requestId: header.requestId,
        resource: header.resource,
        plaintext,
      });
    };
    let command: HostCommand;
    try {
      const input: unknown = JSON.parse(decoder.decode(received.plaintext));
      if (header.resource.kind === 'catalog') {
        catalogCommandSchema.parse(input);
        if (!this.catalog) throw new Error(ENCRYPTED_HOST_COMMAND_REJECTED);
        channel.assertCurrent();
        const result = encryptedHostCatalogSchema.parse(await this.catalog());
        return respond(encoder.encode(JSON.stringify({ ok: true, result })));
      }
      // Logical workspace replicas need a separate Host-confirmed mapping. This
      // transport currently authorizes only the exact runtime/project identity.
      if (
        this.runtimeScopesOnly &&
        (header.resource.catalogWorkspaceId !== null || header.resource.replicaId !== null)
      )
        throw new Error(ENCRYPTED_HOST_COMMAND_REJECTED);
      command = hostCommandSchema.parse(input);
      if (!matchesResource(command, header.resource))
        throw new Error(ENCRYPTED_HOST_COMMAND_REJECTED);
    } catch {
      return respond(
        encoder.encode(
          JSON.stringify({
            ok: false,
            error: {
              status: 400,
              message: ENCRYPTED_HOST_COMMAND_REJECTED,
              rejected: true,
            },
          }),
        ),
      );
    }
    const binding = channel.binding;
    const authority = taskAuthoritySchema.parse({
      serverOrigin: binding.serverOrigin,
      ownerId: binding.accountId,
      deviceId: binding.hostDeviceId,
      secureChannel: {
        version: 1,
        clientDeviceId: binding.clientDeviceId,
        clientKeyId: binding.clientKeyId,
        rootKeyId: binding.rootKeyId,
        trustEpoch: binding.trustEpoch,
        trustDigest: binding.trustDigest,
        hostChallenge: binding.hostChallenge,
        clientChallenge: binding.clientChallenge,
      },
    });
    let plaintext: Uint8Array;
    try {
      channel.assertCurrent();
      const result = await dispatcher.execute(command, {
        current: () => channel.assertCurrent(),
        authority: { ...authority, current: () => channel.assertCurrent() },
      });
      plaintext = encoder.encode(JSON.stringify({ ok: true, result }));
    } catch (error) {
      plaintext = encoder.encode(
        JSON.stringify({ ok: false, error: dispatcher.error(command, error) }),
      );
    }
    return respond(plaintext);
  }
}
