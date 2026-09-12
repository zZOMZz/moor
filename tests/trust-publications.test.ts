import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportJWK } from 'jose';
import { AppError } from '../src/protocol';
import { E2EE_CRYPTO_FAILED } from '../src/security/e2ee-crypto';
import {
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustCheckpoint,
  type TrustManifest,
} from '../src/security/e2ee-trust';
import {
  publicTrustEntrySchema,
  TRUST_PUBLICATION_LIMITS,
  trustPageSchema,
  trustPublishReceiptSchema,
  trustPublishSchema,
  trustReadSchema,
  verifyPublicTrustEntry,
  type PublicTrustEntry,
} from '../src/security/trust-publication';
import {
  RelayTrustPublications,
  TRUST_PUBLICATION_FAILED,
  type TrustPublicationAuthority,
} from '../src/relay/trust-publications';

const root = await generateTrustRoot();
const otherRoot = await generateTrustRoot();
const owner = 'synthetic-owner';
const origin = 'https://relay.example.test';
const pin = { accountId: owner, serverOrigin: origin, rootKeyId: root.keyId };
const context = (): TrustPublicationAuthority => ({ owner, origin, current() {} });
const copy = <T>(value: T): T => structuredClone(value);
async function entry(
  previous?: TrustCheckpoint,
  options: {
    owner?: string;
    origin?: string;
    root?: typeof root;
    devices?: TrustManifest['devices'];
  } = {},
): Promise<PublicTrustEntry> {
  const signer = options.root ?? root;
  const pin = {
    accountId: options.owner ?? owner,
    serverOrigin: options.origin ?? origin,
    rootKeyId: signer.keyId,
  };
  const manifest: TrustManifest = {
    ...pin,
    version: 1,
    epoch: (previous?.epoch ?? 0) + 1,
    previous: previous?.digest ?? null,
    devices: options.devices ?? [],
  };
  const signedManifest = await signTrustManifest({
    manifest,
    rootPublicKey: signer.publicKey,
    rootPrivateKey: signer.privateKey,
  });
  const verified = await VerifiedTrust.verify({
    signed: signedManifest,
    rootPublicKey: signer.publicKey,
    pin,
    previous,
  });
  return {
    pin,
    rootPublicKey: copy(signer.publicKey),
    checkpoint: copy(verified.checkpoint),
    signedManifest,
  };
}
const first = await entry();
const second = await entry(first.checkpoint);
const third = await entry(second.checkpoint);
const fourth = await entry(third.checkpoint);
const publish = (entries: PublicTrustEntry[]) => ({ publicationVersion: 1 as const, entries });
const read = (after: TrustCheckpoint | null = null, limit = 16, head?: TrustCheckpoint) => ({
  publicationVersion: 1 as const,
  pin: copy(pin),
  after,
  limit,
  ...(head ? { head } : {}),
});
function fixture(t: { after(fn: () => void): void }, persistent = false) {
  const directory = mkdtempSync(join(tmpdir(), 'moor-trust-publications-'));
  const file = persistent ? join(directory, 'accounts.sqlite') : ':memory:';
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE account(id TEXT PRIMARY KEY);');
  db.prepare('INSERT INTO account VALUES(?)').run(owner);
  const store = new RelayTrustPublications(db);
  t.after(() => {
    store.close();
    try {
      db.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, store, file };
}
function failure(status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.message, TRUST_PUBLICATION_FAILED);
    if (status !== undefined) assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    assert.notEqual((error as any).rejected, true);
    assert.ok(!String(error.stack).includes('synthetic-secret'));
    return true;
  };
}
const count = (db: DatabaseSync) =>
  db.prepare('SELECT count(*) AS n FROM trust_publication_entry').get()!.n;

test('public trust entry verification snapshots strict public input and returns the exact signed checkpoint', async () => {
  assert.deepEqual((await verifyPublicTrustEntry(first)).checkpoint, first.checkpoint);
  assert.deepEqual((await verifyPublicTrustEntry(third)).checkpoint, third.checkpoint);
  const mutable = copy(third),
    pending = verifyPublicTrustEntry(mutable);
  mutable.pin.accountId = 'different-owner';
  mutable.rootPublicKey.x = otherRoot.publicKey.x;
  mutable.signedManifest = first.signedManifest;
  assert.deepEqual((await pending).checkpoint, third.checkpoint);
  for (const bad of [
    { ...first, privateKey: await exportJWK(root.privateKey) },
    { ...first, rootPublicKey: { ...first.rootPublicKey, d: 'synthetic-secret' } },
    { ...third, checkpoint: second.checkpoint },
    { ...first, checkpoint: { ...first.checkpoint, digest: second.checkpoint.digest } },
    { ...first, rootPublicKey: otherRoot.publicKey },
  ]) {
    await assert.rejects(
      verifyPublicTrustEntry(bad),
      (error: any) => error.message === E2EE_CRYPTO_FAILED && error.cause === undefined,
    );
  }
});

test('schemas reject private fields, mixed pins, duplicate order and false terminal pages', () => {
  assert.equal(
    publicTrustEntrySchema.safeParse({ ...first, cookie: 'synthetic-secret' }).success,
    false,
  );
  for (const value of [
    publish([]),
    publish([second, first]),
    publish([first, first]),
    { ...publish([first]), secret: 'synthetic-secret' },
  ])
    assert.equal(trustPublishSchema.safeParse(value).success, false);
  assert.equal(trustReadSchema.safeParse({ ...read(), limit: 17 }).success, false);
  assert.equal(
    trustReadSchema.safeParse({ ...read(), after: { ...first.checkpoint, accountId: 'other' } })
      .success,
    false,
  );
  assert.equal(
    trustReadSchema.safeParse(read(second.checkpoint, 1, first.checkpoint)).success,
    false,
  );
  assert.equal(
    trustPageSchema.safeParse({
      publicationVersion: 1,
      pin,
      rootPublicKey: root.publicKey,
      after: null,
      head: first.checkpoint,
      entries: [],
      complete: true,
    }).success,
    false,
  );
  assert.equal(
    trustPublishReceiptSchema.safeParse({
      publicationVersion: 1,
      pin,
      rootPublicKey: root.publicKey,
      stored: [second.checkpoint],
      head: first.checkpoint,
    }).success,
    false,
  );
});

test('genesis plus consecutive entries publish atomically and reopen as bounded public pages', async (t) => {
  const f = fixture(t, true);
  const receipt = await f.store.publish(publish([first, second, third]), context());
  assert.deepEqual(
    receipt.stored,
    [first, second, third].map((value) => value.checkpoint),
  );
  assert.deepEqual(receipt.head, third.checkpoint);
  assert.ok(
    Object.isFrozen(receipt) &&
      Object.isFrozen(receipt.stored) &&
      Object.isFrozen(receipt.stored[0]),
  );
  f.store.close();
  f.db.close();
  const reopenedDb = new DatabaseSync(f.file),
    reopened = new RelayTrustPublications(reopenedDb);
  t.after(() => {
    reopened.close();
    reopenedDb.close();
  });
  const page = await reopened.read(read(null, 2), context());
  assert.deepEqual(page.entries, [first, second]);
  assert.equal(page.complete, false);
  assert.deepEqual(page.head, third.checkpoint);
  assert.ok(Object.isFrozen(page.entries[0].rootPublicKey));
  const end = await reopened.read(read(second.checkpoint, 2, page.head), context());
  assert.deepEqual(end.entries, [third]);
  assert.equal(end.complete, true);
  const terminal = await reopened.read(read(third.checkpoint, 1, page.head), context());
  assert.deepEqual(terminal.entries, []);
  assert.equal(terminal.complete, true);
  const stored = JSON.stringify(reopenedDb.prepare('SELECT * FROM trust_publication_entry').all());
  assert.ok(!stored.includes((await exportJWK(root.privateKey)).d!));
  assert.deepEqual(
    reopenedDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name),
    ['account', 'trust_publication_entry', 'trust_publication_root'],
  );
});

test('original signed bytes retry idempotently and may omit already stored intermediate epochs', async (t) => {
  const f = fixture(t);
  await f.store.publish(publish([first, second, third]), context());
  const receipt = await f.store.publish(publish([first, third, fourth]), context());
  assert.deepEqual(receipt.stored, [first.checkpoint, third.checkpoint, fourth.checkpoint]);
  assert.deepEqual(receipt.head, fourth.checkpoint);
  assert.equal(count(f.db), 4);
  assert.deepEqual((await f.store.publish(publish([second]), context())).head, fourth.checkpoint);
  assert.equal(count(f.db), 4);
  const differentBytes = await entry();
  assert.deepEqual(differentBytes.checkpoint, first.checkpoint);
  assert.notEqual(differentBytes.signedManifest, first.signedManifest);
  await assert.rejects(f.store.publish(publish([differentBytes]), context()), failure(409));
});

test('first publication needs genesis and append never skips an unstored version or changes roots', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.store.publish(publish([second]), context()), failure(409));
  await assert.rejects(f.store.publish(publish([first, third]), context()), failure(409));
  assert.equal(count(f.db), 0);
  await f.store.publish(publish([first]), context());
  await assert.rejects(f.store.publish(publish([third]), context()), failure(409));
  await assert.rejects(
    f.store.publish(publish([await entry(undefined, { root: otherRoot })]), context()),
    failure(409),
  );
  assert.equal(count(f.db), 1);
});

test('a signed fork or invalid signature anywhere rolls back the entire batch', async (t) => {
  const f = fixture(t);
  await f.store.publish(publish([first]), context());
  const fork = await entry({ ...second.checkpoint, digest: first.checkpoint.digest });
  await assert.rejects(f.store.publish(publish([second, fork]), context()), failure(409));
  const invalid = { ...third, signedManifest: third.signedManifest.slice(0, -2) + 'AA' };
  await assert.rejects(f.store.publish(publish([second, invalid]), context()), failure(409));
  assert.equal(count(f.db), 1);
  assert.deepEqual((await f.store.read(read(), context())).head, first.checkpoint);
});

test('owner and origin must match every entry and read pin before returning state', async (t) => {
  const f = fixture(t);
  const foreignOwner = await entry(undefined, { owner: 'foreign-owner' });
  const foreignOrigin = await entry(undefined, { origin: 'https://other.example.test' });
  for (const item of [foreignOwner, foreignOrigin])
    await assert.rejects(f.store.publish(publish([item]), context()), failure(403));
  await assert.rejects(
    f.store.publish(publish([first]), { ...context(), owner: 'foreign-owner' }),
    failure(403),
  );
  await f.store.publish(publish([first]), context());
  await assert.rejects(
    f.store.read(read(), { ...context(), origin: 'https://other.example.test' }),
    failure(403),
  );
  await assert.rejects(f.store.read({ ...read(), pin: foreignOwner.pin }, context()), failure(403));
  await assert.rejects(
    f.store.read({ ...read(), pin: { ...pin, rootKeyId: otherRoot.keyId } }, context()),
    failure(409),
  );
});

test('fixed snapshot pagination remains stable when later versions are published', async (t) => {
  const f = fixture(t);
  await f.store.publish(publish([first, second]), context());
  const page = await f.store.read(read(null, 1), context());
  await f.store.publish(publish([third, fourth]), context());
  const end = await f.store.read(read(page.entries[0].checkpoint, 16, page.head), context());
  assert.deepEqual(end.entries, [second]);
  assert.deepEqual(end.head, second.checkpoint);
  assert.equal(end.complete, true);
  assert.deepEqual((await f.store.read(read(second.checkpoint), context())).entries, [
    third,
    fourth,
  ]);
});

test('a full sixteen-entry page preserves continuous signed history and a final partial page', async (t) => {
  const f = fixture(t),
    history = [first, second, third, fourth];
  while (history.length < 20) history.push(await entry(history.at(-1)!.checkpoint));
  await f.store.publish(publish(history.slice(0, 16)), context());
  await f.store.publish(publish(history.slice(16)), context());
  const page = await f.store.read(read(), context());
  assert.equal(page.entries.length, TRUST_PUBLICATION_LIMITS.pageEntries);
  assert.deepEqual(page.entries, history.slice(0, 16));
  assert.equal(page.complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= TRUST_PUBLICATION_LIMITS.wireBytes);
  const rest = await f.store.read(read(page.entries.at(-1)!.checkpoint, 16, page.head), context());
  assert.deepEqual(rest.entries, history.slice(16));
  assert.equal(rest.complete, true);
});

test('read rejects nonexistent or conflicting after/head checkpoints and missing history', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.store.read(read(), context()), failure(404));
  await f.store.publish(publish([first, second, third]), context());
  for (const input of [
    read(fourth.checkpoint),
    read({ ...first.checkpoint, digest: second.checkpoint.digest }),
    read(null, 2, fourth.checkpoint),
    read(null, 2, { ...second.checkpoint, digest: first.checkpoint.digest }),
  ])
    await assert.rejects(f.store.read(input, context()), failure(409));
  f.db.prepare('DELETE FROM trust_publication_entry WHERE epoch=2').run();
  await assert.rejects(f.store.read(read(), context()), failure(409));
});

test('concurrent publications compare the original durable head; failed contenders retry manually', async (t) => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    f.store.publish(publish([first]), context()),
    f.store.publish(publish([first, second]), context()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  await f.store.publish(publish([first, second]), context());
  assert.equal(count(f.db), 2);
  const contenders = await Promise.allSettled([
    f.store.publish(publish([third]), context()),
    f.store.publish(publish([third, fourth]), context()),
  ]);
  assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
  await f.store.publish(publish([third, fourth]), context());
  assert.equal(count(f.db), 4);
});

test('concurrent owners append independently within the same accounts database', async (t) => {
  const f = fixture(t);
  const other = await entry(undefined, { owner: 'other-owner' });
  const receipts = await Promise.all([
    f.store.publish(publish([first]), context()),
    f.store.publish(publish([other]), { ...context(), owner: 'other-owner' }),
  ]);
  assert.deepEqual(
    receipts.map((value) => value.head.accountId),
    [owner, 'other-owner'],
  );
  assert.equal(count(f.db), 2);
});

test('separate SQLite connections cannot silently overwrite a head published during verification', async (t) => {
  const f = fixture(t, true),
    anotherDb = new DatabaseSync(f.file),
    another = new RelayTrustPublications(anotherDb);
  t.after(() => {
    another.close();
    anotherDb.close();
  });
  const results = await Promise.allSettled([
    f.store.publish(publish([first, second]), context()),
    another.publish(publish([first]), context()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  await another.publish(publish([first, second]), context());
  assert.deepEqual((await f.store.read(read(), context())).entries, [first, second]);
});

test('request and authority parameters are snapshotted before asynchronous verification', async (t) => {
  const f = fixture(t),
    input = copy(publish([first, second])),
    authority = context();
  const pending = f.store.publish(input, authority);
  input.entries.length = 0;
  authority.owner = 'other-owner';
  authority.origin = 'https://different.example.test';
  authority.current = () => {
    throw new Error('synthetic-secret');
  };
  assert.deepEqual((await pending).head, second.checkpoint);
  const request = read(null, 1),
    pagePromise = f.store.read(request, context());
  request.pin.rootKeyId = otherRoot.keyId;
  request.after = second.checkpoint;
  request.limit = 16;
  const page = await pagePromise;
  assert.deepEqual(page.entries, [first]);
  assert.equal(page.after, null);
});

test('authorization loss across verification stops publish/read without raw error or automatic retry', async (t) => {
  const f = fixture(t);
  let authorized = true;
  const authority = {
    ...context(),
    current() {
      if (!authorized) throw new AppError(401, 'synthetic-secret');
    },
  };
  const pending = f.store.publish(publish([first, second]), authority);
  authorized = false;
  await assert.rejects(pending, failure(401));
  assert.equal(count(f.db), 0);
  authorized = true;
  await f.store.publish(publish([first]), authority);
  const page = f.store.read(read(), authority);
  authorized = false;
  await assert.rejects(page, failure(401));
  assert.equal(count(f.db), 1);
});

test('authorization invalidated during the final transaction rolls back all public rows', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.store.publish(publish([first, second]), {
      ...context(),
      current() {
        if (count(f.db)) throw new AppError(503, 'synthetic-secret');
      },
    }),
    failure(503),
  );
  assert.equal(count(f.db), 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM trust_publication_root').get()!.n, 0);
});

test('close invalidates in-flight operations and leaves the shared account database open', async (t) => {
  const f = fixture(t);
  const pending = f.store.publish(publish([first]), context());
  f.store.close();
  await assert.rejects(pending, failure(409));
  assert.equal(count(f.db), 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM account').get()!.n, 1);
  const replacement = new RelayTrustPublications(f.db);
  await replacement.publish(publish([first]), context());
  const page = replacement.read(read(), context());
  replacement.close();
  await assert.rejects(page, failure(409));
  f.db.close();
  const closedDb = new DatabaseSync(':memory:'),
    closed = new RelayTrustPublications(closedDb);
  closed.close();
  await assert.rejects(closed.read(read(), context()), failure(409));
  closedDb.close();
});

test('SQL failures roll back partial inserts and never expose diagnostics', async (t) => {
  const f = fixture(t);
  f.db.exec(
    "CREATE TRIGGER fail_second BEFORE INSERT ON trust_publication_entry WHEN NEW.epoch=2 BEGIN SELECT RAISE(ABORT,'synthetic-secret SQL diagnostic'); END;",
  );
  await assert.rejects(f.store.publish(publish([first, second]), context()), failure(409));
  assert.equal(count(f.db), 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM trust_publication_root').get()!.n, 0);
  f.db.exec('DROP TRIGGER fail_second');
  await f.store.publish(publish([first, second]), context());
});

test('stored byte quota bounds additions while exact old retries remain available at capacity', async (t) => {
  const f = fixture(t);
  await f.store.publish(publish([first]), context());
  // A deterministic capacity fixture avoids allocating 128 MiB of unrelated public history.
  f.db
    .prepare('UPDATE trust_publication_root SET stored_bytes=?')
    .run(TRUST_PUBLICATION_LIMITS.storedBytes);
  await assert.rejects(f.store.publish(publish([second]), context()), failure(413));
  assert.deepEqual((await f.store.publish(publish([first]), context())).stored, [first.checkpoint]);
  assert.equal(count(f.db), 1);
  const nextBytes = Buffer.byteLength(JSON.stringify(second));
  f.db
    .prepare('UPDATE trust_publication_root SET stored_bytes=?')
    .run(TRUST_PUBLICATION_LIMITS.storedBytes - nextBytes);
  await f.store.publish(publish([second]), context());
  assert.equal(
    f.db.prepare('SELECT stored_bytes FROM trust_publication_root').get()!.stored_bytes,
    TRUST_PUBLICATION_LIMITS.storedBytes,
  );
});

test('version quota rejects only new epochs and preserves the final stored version', async (t) => {
  const f = fixture(t);
  await f.store.publish(publish([first]), context());
  const final = await entry({ ...first.checkpoint, epoch: TRUST_PUBLICATION_LIMITS.versions - 1 });
  // Seed the public capacity boundary with a valid signed final snapshot; no private key enters SQLite.
  const encoded = JSON.stringify(final),
    bytes = Buffer.byteLength(encoded);
  f.db
    .prepare('INSERT INTO trust_publication_entry(owner,epoch,entry,bytes) VALUES(?,?,?,?)')
    .run(owner, final.checkpoint.epoch, encoded, bytes);
  f.db
    .prepare('UPDATE trust_publication_root SET head=?,stored_bytes=stored_bytes+?')
    .run(JSON.stringify(final.checkpoint), bytes);
  await assert.rejects(
    f.store.publish(publish([await entry(final.checkpoint)]), context()),
    failure(413),
  );
  assert.deepEqual((await f.store.publish(publish([final]), context())).head, final.checkpoint);
  assert.equal(count(f.db), 2);
});

test('wire and item limits reject bounded malformed batches before SQLite writes', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.store.publish(publish(Array.from({ length: 17 }, () => first)), context()),
    failure(400),
  );
  const oversized = Array.from({ length: 16 }, (_, index) => ({
    ...copy(first),
    checkpoint: { ...first.checkpoint, epoch: index + 1 },
    signedManifest: 'x'.repeat(64 * 1024),
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify(publish(oversized))) > TRUST_PUBLICATION_LIMITS.wireBytes,
  );
  await assert.rejects(f.store.publish(publish(oversized), context()), failure(400));
  assert.equal(count(f.db), 0);
});
