import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  E2eeChannel,
  E2EE_RECORD_LIMITS,
  encryptedRecordHeaderSchema,
  encryptedRecordSchema,
  newChannelChallenge,
  parseEncryptedRecord,
  serializeEncryptedRecord,
  type EncryptedRecord,
  type EncryptedResource,
} from '../src/security/e2ee-channel';
import {
  E2EE_CRYPTO_FAILED,
  E2EE_CRYPTO_LIMITS,
  E2EE_CRYPTO_SUITE,
  generateDeviceEncryptionKey,
  seal,
} from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustManifest,
} from '../src/security/e2ee-trust';

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const digest = (value: number) => Buffer.alloc(32, value).toString('base64url');
const mutateDigest = (value: string) => {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
};
const [root, clientKey, hostKey, strangerKey] = await Promise.all([
  generateTrustRoot(),
  generateDeviceEncryptionKey(),
  generateDeviceEncryptionKey(),
  generateDeviceEncryptionKey(),
]);
const pin = {
  accountId: 'synthetic-account',
  serverOrigin: 'https://relay.synthetic.invalid',
  rootKeyId: root.keyId,
};
const manifest: TrustManifest = {
  ...pin,
  version: 1,
  epoch: 1,
  previous: null,
  devices: [
    {
      deviceId: 'synthetic-client',
      keyId: await encryptionKeyId(clientKey.publicKey),
      publicKey: clientKey.publicKey,
      roles: ['client'],
    },
    {
      deviceId: 'synthetic-host',
      keyId: await encryptionKeyId(hostKey.publicKey),
      publicKey: hostKey.publicKey,
      roles: ['host'],
    },
  ],
};
const signed = await signTrustManifest({
  manifest,
  rootPublicKey: root.publicKey,
  rootPrivateKey: root.privateKey,
});
const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
const nextTrust = await VerifiedTrust.verify({
  signed: await signTrustManifest({
    manifest: { ...manifest, epoch: 2, previous: trust.checkpoint.digest },
    rootPublicKey: root.publicKey,
    rootPrivateKey: root.privateKey,
  }),
  rootPublicKey: root.publicKey,
  pin,
  previous: trust.checkpoint,
});
const resource: EncryptedResource = {
  kind: 'session',
  workspaceId: 'synthetic-workspace',
  projectId: 'synthetic-project',
  sessionId: 'synthetic-session',
  catalogWorkspaceId: 'synthetic-catalog',
  replicaId: 'synthetic-replica',
};
const plaintext = encoder.encode('synthetic private transcript\u0000合成代码和附件');
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  assert.equal(error.message.includes('synthetic'), false);
  return true;
};
const input = () => ({
  kind: 'request' as const,
  requestId: digest(9),
  resource: structuredClone(resource),
  plaintext: new Uint8Array(plaintext),
});
async function pair(t: TestContext, hostChallenge = digest(1), clientChallenge = digest(2)) {
  let clientCurrent: VerifiedTrust | undefined = trust,
    hostCurrent: VerifiedTrust | undefined = trust;
  const common = {
    trust,
    clientDeviceId: 'synthetic-client',
    hostDeviceId: 'synthetic-host',
    hostChallenge,
    clientChallenge,
  };
  const clientOptions = {
    ...common,
    side: 'client' as const,
    privateKey: clientKey.privateKey,
    current: () => clientCurrent,
  };
  const hostOptions = {
    ...common,
    side: 'host' as const,
    privateKey: hostKey.privateKey,
    current: () => hostCurrent,
  };
  const [client, host] = await Promise.all([
    E2eeChannel.create(clientOptions),
    E2eeChannel.create(hostOptions),
  ]);
  t.after(() => {
    client.close();
    host.close();
  });
  return {
    client,
    host,
    clientOptions,
    hostOptions,
    clientCurrent(value: VerifiedTrust | undefined) {
      clientCurrent = value;
    },
    hostCurrent(value: VerifiedTrust | undefined) {
      hostCurrent = value;
    },
  };
}
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  return { enter, release, entered, waiting };
}
function holdCrypto(
  t: TestContext,
  name: 'encrypt' | 'decrypt',
  count = 1,
  when: (args: any[]) => boolean = () => true,
) {
  const hold = gate();
  let entered = 0;
  const original = crypto.subtle[name].bind(crypto.subtle);
  t.mock.method(crypto.subtle, name, async (...args: any[]) => {
    if (when(args)) {
      if (++entered === count) hold.enter();
      await hold.waiting;
    }
    return Reflect.apply(original, undefined, args);
  });
  t.after(() => hold.release());
  return { ...hold, count: () => entered };
}
function aadSequence(args: any[]) {
  return JSON.parse(decoder.decode(args[0].additionalData)).sequence as number;
}
// A real authenticated synthetic sender chooses sequence numbers directly, so
// replay-window edges need only a few messages rather than hundreds of sends.
async function recordAt(channel: E2eeChannel, sequence: number): Promise<EncryptedRecord> {
  const header = encryptedRecordHeaderSchema.parse({
    version: 1,
    suite: E2EE_CRYPTO_SUITE,
    binding: channel.binding,
    direction: 'client-to-host',
    kind: 'request',
    sequence,
    requestId: digest(9),
    resource,
  });
  return {
    header,
    ...(await seal({
      senderPrivateKey: clientKey.privateKey,
      recipientPublicKey: hostKey.publicKey,
      plaintext,
      aad: encoder.encode(JSON.stringify(header)),
    })),
  };
}

test('E2EE channel encrypts both directions, authenticates the complete scope and serializes no content in plaintext', async (t) => {
  const { client, host } = await pair(t);
  const outgoing = await client.send(input());
  const wire = serializeEncryptedRecord(outgoing);
  assert.equal(wire.includes('synthetic private transcript'), false);
  assert.equal(wire.includes('合成代码和附件'), false);
  assert.equal(wire.includes(Buffer.from(plaintext).toString('base64url')), false);
  assert.deepEqual(Object.keys(JSON.parse(wire)).sort(), ['ciphertext', 'enc', 'header']);
  assert.equal(Buffer.from(outgoing.ciphertext, 'base64url').byteLength, plaintext.byteLength + 16);
  assert.deepEqual(outgoing.header.binding, client.binding);
  assert.equal(outgoing.header.direction, 'client-to-host');
  assert.equal(outgoing.header.sequence, 1);
  const opened = await host.receive(parseEncryptedRecord(wire));
  assert.deepEqual(opened.plaintext, plaintext);
  assert.deepEqual(opened.header.resource, resource);
  for (const kind of ['response', 'event'] as const) {
    const response = await host.send({ ...input(), kind });
    assert.equal(response.header.direction, 'host-to-client');
    assert.deepEqual((await client.receive(response)).plaintext, plaintext);
  }
  assert.equal((await client.send(input())).header.sequence, 2);
  assert.equal(Object.isFrozen(client.binding), true);
  assert.throws(() => {
    (client.binding as any).accountId = 'substituted';
  }, TypeError);
});

test('E2EE channel rejects every changed binding field without poisoning the original record', async (t) => {
  const { client, host } = await pair(t);
  const record = await client.send(input());
  for (const [key, value] of Object.entries(record.header.binding)) {
    const modified = structuredClone(record);
    const replacement =
      key === 'serverOrigin'
        ? 'https://other.synthetic.invalid'
        : typeof value === 'number'
          ? value + 1
          : value.length === 43
            ? mutateDigest(value)
            : value + '-other';
    (modified.header.binding as any)[key] = replacement;
    await assert.rejects(host.receive(modified), safeFailure, key);
  }
  assert.deepEqual((await host.receive(record)).plaintext, plaintext);
});

test('E2EE channel authenticates resource, direction, kind, suite, version, request id and sequence', async (t) => {
  const { client, host } = await pair(t);
  const record = await client.send(input());
  const changes: Array<(value: any) => void> = [
    (r) => {
      r.header.direction = 'host-to-client';
      r.header.kind = 'event';
    },
    (r) => {
      r.header.kind = 'response';
    },
    (r) => {
      r.header.suite = 'HPKE-Base-P256-HKDFSHA256-AES256GCM';
    },
    (r) => {
      r.header.version = 2;
    },
    (r) => {
      r.header.requestId = digest(10);
    },
    (r) => {
      r.header.sequence++;
    },
    (r) => {
      r.header.resource.kind = 'project';
      r.header.resource.sessionId = null;
    },
    (r) => {
      r.header.resource = {
        kind: 'catalog',
        workspaceId: null,
        projectId: null,
        sessionId: null,
        catalogWorkspaceId: null,
        replicaId: null,
      };
    },
    ...['workspaceId', 'projectId', 'sessionId', 'catalogWorkspaceId', 'replicaId'].map(
      (field) => (r: any) => {
        r.header.resource[field] += '-other';
      },
    ),
    (r) => {
      r.header.resource.catalogWorkspaceId = null;
      r.header.resource.replicaId = null;
    },
  ];
  for (const change of changes) {
    const modified = structuredClone(record);
    change(modified);
    await assert.rejects(host.receive(modified), safeFailure);
  }
  assert.deepEqual((await host.receive(record)).plaintext, plaintext);
  const reply = await host.send({ ...input(), kind: 'response' });
  const changedKind = structuredClone(reply);
  changedKind.header.kind = 'event';
  await assert.rejects(client.receive(changedKind), safeFailure);
  assert.deepEqual((await client.receive(reply)).plaintext, plaintext);
});

test('E2EE channel allows exactly one dispatcher result for simultaneous duplicate receives', async (t) => {
  const { client, host } = await pair(t);
  const record = await client.send(input());
  const hold = holdCrypto(t, 'decrypt');
  const first = host.receive(record);
  await hold.entered;
  await assert.rejects(host.receive(structuredClone(record)), safeFailure);
  hold.release();
  assert.deepEqual((await first).plaintext, plaintext);
  await assert.rejects(host.receive(record), safeFailure);
  assert.equal(hold.count(), 1, 'duplicates never start another decryption');
});

test('E2EE channel unauthenticated high sequences cannot advance the replay window or retain reservations', async (t) => {
  const { client, host } = await pair(t);
  const record = await client.send(input());
  const high = structuredClone(record);
  high.header.sequence = Number.MAX_SAFE_INTEGER;
  await assert.rejects(host.receive(high), safeFailure);
  await assert.rejects(host.receive(high), safeFailure);
  const corrupted = structuredClone(record);
  corrupted.ciphertext = mutateDigest(record.ciphertext);
  await assert.rejects(host.receive(corrupted), safeFailure);
  assert.deepEqual((await host.receive(record)).plaintext, plaintext);
});

test('E2EE channel accepts out-of-order authenticated records inside the exact 256-record window', async (t) => {
  const { client, host } = await pair(t);
  const sequence = [1, 2, 3, 256, 257, 258, 512];
  const records = new Map(
    await Promise.all(
      sequence.map(async (number) => [number, await recordAt(client, number)] as const),
    ),
  );
  await host.receive(records.get(257));
  await host.receive(records.get(2)); // max - 255: the oldest accepted record.
  await assert.rejects(host.receive(records.get(1)), safeFailure); // max - 256.
  await host.receive(records.get(256));
  await host.receive(records.get(3));
  await assert.rejects(host.receive(records.get(2)), safeFailure);
  await host.receive(records.get(512));
  await assert.rejects(host.receive(records.get(256)), safeFailure);
  await assert.rejects(host.receive(records.get(257)), safeFailure);
  await host.receive(records.get(258));
});

test('E2EE channel rechecks the replay floor after a delayed valid decryption completes', async (t) => {
  const { client, host } = await pair(t);
  const [low, high] = await Promise.all([recordAt(client, 1), recordAt(client, 257)]);
  const hold = holdCrypto(t, 'decrypt', 1, (args) => aadSequence(args) === 1);
  const pending = host.receive(low);
  const failed = assert.rejects(pending, safeFailure);
  await hold.entered;
  await host.receive(high);
  hold.release();
  await failed;
  await assert.rejects(host.receive(low), safeFailure);
});

test('E2EE channel bounds pending sends to 64 without reusing a sequence or automatically retrying', async (t) => {
  const { client, host } = await pair(t);
  const hold = holdCrypto(t, 'encrypt', 64);
  const pending = Promise.all(Array.from({ length: 64 }, () => client.send(input())));
  await assert.rejects(client.send(input()), safeFailure);
  await hold.entered;
  assert.equal(hold.count(), 64);
  hold.release();
  const records = await pending;
  assert.deepEqual(
    records.map((record) => record.header.sequence),
    Array.from({ length: 64 }, (_, index) => index + 1),
  );
  assert.equal(new Set(records.map((record) => record.enc)).size, 64);
  assert.equal((await client.send(input())).header.sequence, 65);
  for (const record of [records[63], records[0], records[31]])
    assert.deepEqual((await host.receive(record)).plaintext, plaintext);
});

test('E2EE channel bounds concurrent receives and releases rejected capacity for a later manual receive', async (t) => {
  const { client, host } = await pair(t);
  const records = await Promise.all(
    Array.from({ length: 65 }, (_, index) => recordAt(client, index + 1)),
  );
  const hold = holdCrypto(t, 'decrypt', 64);
  const pending = Promise.all(records.slice(0, 64).map((record) => host.receive(record)));
  await assert.rejects(host.receive(records[64]), safeFailure);
  await hold.entered;
  hold.release();
  assert.equal((await pending).length, 64);
  assert.deepEqual((await host.receive(records[64])).plaintext, plaintext);
});

test('E2EE channel snapshots caller resource, request id and binary view before its first await', async (t) => {
  const { client, host } = await pair(t);
  const value = input();
  const backing = new Uint8Array(plaintext.byteLength + 8);
  backing.set(plaintext, 4);
  value.plaintext = backing.subarray(4, backing.length - 4);
  const originalResource = structuredClone(value.resource);
  const pending = client.send(value);
  backing.fill(0);
  value.requestId = digest(19);
  (value.resource as any).workspaceId = 'substituted';
  (value.resource as any).sessionId = 'substituted';
  const record = await pending;
  assert.equal(record.header.requestId, digest(9));
  assert.deepEqual(record.header.resource, originalResource);
  assert.deepEqual((await host.receive(record)).plaintext, plaintext);
});

test('E2EE channel snapshots inbound records before decryption so caller mutations cannot alter delivered scope', async (t) => {
  const { client, host } = await pair(t);
  const record = await client.send(input());
  const originalHeader = structuredClone(record.header);
  const pending = host.receive(record);
  record.header.requestId = digest(20);
  (record.header.resource as any).sessionId = 'substituted';
  record.ciphertext = 'synthetic-secret';
  const received = await pending;
  assert.deepEqual(received.header, originalHeader);
  assert.deepEqual(received.plaintext, plaintext);
});

test('E2EE channel create rejects changed current trust after its awaited own-key check', async (t) => {
  const f = await pair(t);
  const pending = E2eeChannel.create(f.clientOptions);
  f.clientCurrent(nextTrust);
  await assert.rejects(pending, safeFailure);
});

test('E2EE channel rejects close, disconnect and signed trust changes after encryption or decryption starts', async (t) => {
  for (const phase of ['send', 'receive']) {
    for (const change of ['close', 'disconnect', 'trust']) {
      const f = await pair(t);
      const record = phase === 'receive' ? await f.client.send(input()) : undefined;
      const pending = phase === 'send' ? f.client.send(input()) : f.host.receive(record);
      if (change === 'close') (phase === 'send' ? f.client : f.host).close();
      else if (phase === 'send') f.clientCurrent(change === 'trust' ? nextTrust : undefined);
      else f.hostCurrent(change === 'trust' ? nextTrust : undefined);
      await assert.rejects(pending, safeFailure);
      assert.throws(() => (phase === 'send' ? f.client : f.host).assertCurrent(), safeFailure);
    }
  }
});

test('E2EE channel reconnect challenges bind old records to their original connection even with unchanged trusted keys', async (t) => {
  const old = await pair(t),
    freshHost = await pair(t, digest(3), digest(2)),
    freshClient = await pair(t, digest(1), digest(4));
  const record = await old.client.send(input());
  old.client.close();
  old.host.close();
  await assert.rejects(freshHost.host.receive(record), safeFailure);
  await assert.rejects(freshClient.host.receive(record), safeFailure);
  assert.deepEqual(
    (await freshHost.host.receive(await freshHost.client.send(input()))).plaintext,
    plaintext,
  );
  assert.equal((await freshClient.client.send(input())).header.sequence, 1);
  const challenge1 = newChannelChallenge(),
    challenge2 = newChannelChallenge();
  assert.equal(challenge1.length, 43);
  assert.equal(Buffer.from(challenge1, 'base64url').byteLength, 32);
  assert.equal(Buffer.from(challenge1, 'base64url').toString('base64url'), challenge1);
  assert.notEqual(challenge1, challenge2);
});

test('E2EE channel creation requires verified trust, the designated role and the exact endpoint private key', async (t) => {
  const f = await pair(t);
  const changes = [
    { trust: { manifest: trust.manifest, checkpoint: trust.checkpoint } },
    { side: 'relay' },
    { clientDeviceId: 'synthetic-host' },
    { hostDeviceId: 'synthetic-client' },
    { clientDeviceId: 'missing-client' },
    { privateKey: strangerKey.privateKey },
    { privateKey: hostKey.privateKey },
    { hostChallenge: 'synthetic-secret' },
    { clientChallenge: 'A'.repeat(42) + 'B' },
    { current: () => undefined },
    {
      current: () => {
        throw new Error('synthetic-secret');
      },
    },
  ];
  for (const change of changes)
    await assert.rejects(E2eeChannel.create({ ...f.clientOptions, ...change } as any), safeFailure);
  const mutable = { ...f.clientOptions };
  const pending = E2eeChannel.create(mutable);
  mutable.hostChallenge = digest(40);
  mutable.clientDeviceId = 'substituted';
  const channel = await pending;
  t.after(() => channel.close());
  assert.equal(channel.binding.hostChallenge, digest(1));
  assert.equal(channel.binding.clientDeviceId, 'synthetic-client');
});

test('E2EE channel enforces role and resource shape before encrypting and uses one safe parser error', async (t) => {
  const { client, host } = await pair(t);
  await assert.rejects(client.send({ ...input(), kind: 'event' }), safeFailure);
  await assert.rejects(host.send(input()), safeFailure);
  for (const invalid of [
    { ...resource, catalogWorkspaceId: null },
    { ...resource, replicaId: null },
    { ...resource, sessionId: null },
    { ...resource, unexpected: 'synthetic-secret' },
    {
      kind: 'catalog',
      workspaceId: 'unexpected',
      projectId: null,
      sessionId: null,
      catalogWorkspaceId: null,
      replicaId: null,
    },
  ])
    await assert.rejects(client.send({ ...input(), resource: invalid as any }), safeFailure);
  const record = await client.send(input());
  for (const value of [
    'synthetic-secret',
    '',
    '{}',
    '[]',
    JSON.stringify({ ...record, unknown: 'synthetic-secret' }),
    JSON.stringify({ ...record, ciphertext: 'AA==' }),
  ]) {
    assert.throws(() => parseEncryptedRecord(value), safeFailure);
  }
  const invalid = { ...record, header: { ...record.header, sequence: 0 } };
  assert.throws(() => serializeEncryptedRecord(invalid), safeFailure);
  await assert.rejects(host.receive(invalid), safeFailure);
  assert.deepEqual((await host.receive(record)).plaintext, plaintext);
});

test('E2EE channel declares the 48 MiB plaintext expansion rather than inheriting the smaller old wire cap', async (t) => {
  assert.equal(E2EE_CRYPTO_LIMITS.plaintextBytes, 48 * 1024 * 1024);
  assert.equal(E2EE_RECORD_LIMITS.ciphertextCharacters, 67108886);
  assert.equal(E2EE_RECORD_LIMITS.wireBytes, 67141654);
  assert.equal(E2EE_RECORD_LIMITS.replayWindow, 256);
  assert.equal(E2EE_RECORD_LIMITS.pending, 64);
  assert.equal(Object.isFrozen(E2EE_RECORD_LIMITS), true);
  assert.ok(E2EE_RECORD_LIMITS.wireBytes > E2EE_CRYPTO_LIMITS.plaintextBytes);
  const { client } = await pair(t);
  const record = await client.send({ ...input(), plaintext: new Uint8Array() });
  assert.equal(record.ciphertext.length, 22);
  assert.equal(
    encryptedRecordSchema.safeParse({ ...record, ciphertext: record.ciphertext.slice(1) }).success,
    false,
  );
  const overhead = Buffer.byteLength(serializeEncryptedRecord(record)) - record.ciphertext.length;
  assert.ok(overhead < E2EE_RECORD_LIMITS.wireBytes - E2EE_RECORD_LIMITS.ciphertextCharacters);
});
