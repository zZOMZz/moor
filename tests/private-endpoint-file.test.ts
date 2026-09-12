import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  PRIVATE_ENDPOINT_FILE_FORMAT,
  PRIVATE_ENDPOINT_FILE_MAX_BYTES,
  PRIVATE_ENDPOINT_FILE_FAILED,
  PRIVATE_ENDPOINT_FILE_UNKNOWN,
  PrivateEndpointFile,
  PrivateEndpointFileError,
  type PrivateEndpointFileFs,
} from '../src/security/private-endpoint-file';

const secret = 'SYNTHETIC_PRIVATE_VALUE';
const safe =
  (outcome: 'unchanged' | 'unknown' = 'unchanged') =>
  (error: unknown) => {
    assert.ok(error instanceof PrivateEndpointFileError);
    assert.equal(error.outcome, outcome);
    assert.equal(
      error.message,
      outcome === 'unknown' ? PRIVATE_ENDPOINT_FILE_UNKNOWN : PRIVATE_ENDPOINT_FILE_FAILED,
    );
    assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes(secret), false);
    return true;
  };
const encode = (revision: number, value: unknown) =>
  JSON.stringify({ format: PRIVATE_ENDPOINT_FILE_FORMAT, revision, value }) + '\n';
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'moor-private-file-')));
  const directory = join(root, 'private'),
    file = join(directory, 'endpoint.json');
  fs.mkdirSync(directory, { mode: 0o700 });
  const stores: PrivateEndpointFile[] = [];
  const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
  t.after(async () => {
    stores.forEach((store) => store.close());
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = (io?: Partial<PrivateEndpointFileFs>, path = file) => {
    const store = PrivateEndpointFile.open(path, { fs: io });
    stores.push(store);
    return store;
  };
  return { root, directory, file, open, children };
}

test('explicit private-file CAS creates revision one, returns independent snapshots and persists across reopen', (t) => {
  const f = fixture(t),
    store = f.open();
  assert.equal(store.load(), undefined);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.statSync(f.file + '.lock').mode & 0o777, 0o600);
  const input = { device: { value: secret }, list: [1, null, true] };
  const result = store.save(null, input);
  input.device.value = 'changed';
  (result.value as typeof input).device.value = 'also changed';
  assert.deepEqual(store.load(), {
    revision: 1,
    value: { device: { value: secret }, list: [1, null, true] },
  });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), {
    format: PRIVATE_ENDPOINT_FILE_FORMAT,
    revision: 1,
    value: { device: { value: secret }, list: [1, null, true] },
  });
  const before = fs.readFileSync(f.file);
  for (const revision of [null, 0, 2, -1, NaN])
    assert.throws(() => store.save(revision, 'incorrect'), safe());
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(store.save(1, null), { revision: 2, value: null });
  store.close();
  store.close();
  assert.throws(() => store.load(), safe());
  assert.throws(() => store.save(2, secret), safe());
  assert.deepEqual(f.open().load(), { revision: 2, value: null });
});

test('file format, revision, UTF-8 and bounded JSON values are validated without replacing corrupt contents', (t) => {
  const f = fixture(t);
  for (const value of [
    '',
    '{',
    '[]',
    '{}',
    encode(0, secret),
    encode(1.5, secret),
    '{"format":"moor-private-endpoint-v1","revision":1,"value":1e400}',
    JSON.stringify({ format: 'foreign-format', revision: 1, value: secret }),
    JSON.stringify({ format: PRIVATE_ENDPOINT_FILE_FORMAT, revision: 1 }),
    JSON.stringify({
      format: PRIVATE_ENDPOINT_FILE_FORMAT,
      revision: 1,
      value: secret,
      extra: true,
    }),
    Buffer.from([0xff]),
    'x'.repeat(PRIVATE_ENDPOINT_FILE_MAX_BYTES + 1),
  ]) {
    fs.writeFileSync(f.file, value, { mode: 0o600 });
    const before = fs.readFileSync(f.file);
    assert.throws(() => f.open(), safe());
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
  fs.rmSync(f.file);
  const store = f.open();
  const cycle: { child?: unknown } = {};
  cycle.child = cycle;
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      throw Error(secret);
    },
  });
  const sparse: unknown[] = [];
  sparse.length = 2;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    Symbol('value'),
    { missing: undefined },
    cycle,
    getter,
    sparse,
    new Date(),
    { [Symbol('hidden')]: secret },
    '字'.repeat(PRIVATE_ENDPOINT_FILE_MAX_BYTES),
  ])
    assert.throws(() => store.save(null, value), safe());
  assert.equal(store.load(), undefined);
  assert.equal(fs.existsSync(f.file), false);
  fs.writeFileSync(f.file, encode(Number.MAX_SAFE_INTEGER, secret), { mode: 0o600 });
  store.close();
  const exhausted = f.open();
  assert.throws(() => exhausted.save(Number.MAX_SAFE_INTEGER, secret), safe());
  assert.equal(exhausted.load()!.revision, Number.MAX_SAFE_INTEGER);
});

test('exactly one MiB is accepted while one additional byte is rejected before replacing the original', (t) => {
  const f = fixture(t),
    store = f.open();
  const overhead = Buffer.byteLength(encode(1, ''));
  const value = 'a'.repeat(PRIVATE_ENDPOINT_FILE_MAX_BYTES - overhead);
  assert.equal(store.save(null, value).revision, 1);
  assert.equal(fs.statSync(f.file).size, PRIVATE_ENDPOINT_FILE_MAX_BYTES);
  assert.throws(() => store.save(1, value + 'a'), safe());
  assert.equal(store.load()!.value, value);
});

test('parent, data and lock identities reject symlinks, hardlinks, broad modes and non-regular entries', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.open(undefined, 'relative.json'), safe());
  assert.throws(() => f.open(undefined, join(f.root, 'missing', 'endpoint.json')), safe());
  fs.chmodSync(f.directory, 0o750);
  assert.throws(() => f.open(), safe());
  fs.chmodSync(f.directory, 0o700);
  const alias = join(f.root, 'alias');
  fs.symlinkSync(f.directory, alias);
  assert.throws(() => f.open(undefined, join(alias, basename(f.file))), safe());
  for (const suffix of ['', '.lock', '.lock-journal', '.lock-wal', '.lock-shm']) {
    for (const kind of ['symlink', 'hardlink', 'mode', 'directory', 'oversize'])
      await t.test(suffix + '/' + kind, (t) => {
        const f = fixture(t),
          target = join(f.root, 'operator-file'),
          path = f.file + suffix;
        fs.writeFileSync(target, secret, { mode: 0o600 });
        if (kind === 'symlink') fs.symlinkSync(target, path);
        else if (kind === 'hardlink') fs.linkSync(target, path);
        else if (kind === 'directory') fs.mkdirSync(path, { mode: 0o700 });
        else {
          fs.writeFileSync(path, '', { mode: kind === 'mode' ? 0o640 : 0o600 });
          if (kind === 'oversize') fs.truncateSync(path, PRIVATE_ENDPOINT_FILE_MAX_BYTES + 1);
        }
        assert.throws(() => f.open(), safe());
        assert.equal(fs.readFileSync(target, 'utf8'), secret);
      });
  }
});

test('replacement of parent, original file, lock or in-place contents permanently invalidates a loaded instance', async (t) => {
  for (const kind of ['parent', 'file', 'lock', 'in-place', 'mode'])
    await t.test(kind, (t) => {
      const f = fixture(t),
        store = f.open();
      store.save(null, secret);
      const before = fs.readFileSync(f.file);
      if (kind === 'parent') {
        fs.renameSync(f.directory, f.directory + '-old');
        fs.mkdirSync(f.directory, { mode: 0o700 });
        fs.copyFileSync(join(f.directory + '-old', basename(f.file)), f.file);
      } else if (kind === 'file' || kind === 'lock') {
        const path = f.file + (kind === 'lock' ? '.lock' : '');
        fs.renameSync(path, path + '-old');
        fs.copyFileSync(path + '-old', path);
      } else if (kind === 'in-place') fs.writeFileSync(f.file, encode(2, 'operator-change'));
      else fs.chmodSync(f.directory, 0o755);
      assert.throws(() => store.load(), safe());
      if (kind === 'mode') fs.chmodSync(f.directory, 0o700);
      assert.throws(() => store.save(1, 'unwanted-overwrite'), safe());
      if (!['in-place', 'mode'].includes(kind)) assert.deepEqual(fs.readFileSync(f.file), before);
    });
});

test('NOFOLLOW reads detect a replaced path and mid-read changes before returning private values', async (t) => {
  for (const kind of ['inode', 'mode', 'size', 'contents'])
    await t.test(kind, (t) => {
      const f = fixture(t);
      const initial = f.open();
      initial.save(null, secret);
      initial.close();
      let armed = false;
      const store = f.open({
        readSync: ((
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const result = fs.readSync(fd, buffer, offset, length, position);
          if (armed) {
            armed = false;
            if (kind === 'inode') {
              fs.renameSync(f.file, f.file + '-original');
              fs.copyFileSync(f.file + '-original', f.file);
            } else if (kind === 'mode') fs.chmodSync(f.file, 0o644);
            else if (kind === 'size') fs.appendFileSync(f.file, ' ');
            else fs.writeFileSync(f.file, encode(1, secret.replace('VALUE', 'OTHER')));
          }
          return result;
        }) as typeof fs.readSync,
      });
      armed = true;
      assert.throws(() => store.load(), safe());
      assert.throws(() => store.load(), safe());
    });
});

test('short writes are completed, synced before rename and followed by syncing the containing directory', (t) => {
  const f = fixture(t),
    calls: string[] = [];
  const store = f.open({
    writeSync: ((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      calls.push('write');
      return fs.writeSync(fd, buffer, offset, Math.min(length, 7), position);
    }) as typeof fs.writeSync,
    fsyncSync(fd) {
      calls.push(fs.fstatSync(fd).isDirectory() ? 'sync-directory' : 'sync-file');
      fs.fsyncSync(fd);
    },
    renameSync(from, to) {
      calls.push('rename');
      fs.renameSync(from, to);
    },
  });
  assert.deepEqual(store.save(null, secret), { revision: 1, value: secret });
  assert.ok(calls.filter((value) => value === 'write').length > 1);
  assert.deepEqual(calls.slice(-3), ['sync-file', 'rename', 'sync-directory']);
  assert.deepEqual(
    fs
      .readdirSync(f.directory)
      .filter((name) => name !== 'endpoint.json.lock-journal')
      .sort(),
    ['endpoint.json', 'endpoint.json.lock'],
  );
});

test('pre-rename write, fsync and rename faults preserve the old revision and clean only the owned temporary inode', async (t) => {
  for (const point of ['write', 'fsync', 'rename'])
    await t.test(point, (t) => {
      const f = fixture(t),
        initial = f.open();
      initial.save(null, secret);
      initial.close();
      const before = fs.readFileSync(f.file);
      const io: Partial<PrivateEndpointFileFs> =
        point === 'write'
          ? {
              writeSync() {
                throw Error(secret);
              },
            }
          : point === 'fsync'
            ? {
                fsyncSync() {
                  throw Error(secret);
                },
              }
            : {
                renameSync() {
                  throw Error(secret);
                },
              };
      const store = f.open(io);
      assert.throws(() => store.save(1, 'next'), safe());
      assert.deepEqual(fs.readFileSync(f.file), before);
      assert.deepEqual(store.load(), { revision: 1, value: secret });
      assert.deepEqual(
        fs
          .readdirSync(f.directory)
          .filter((name) => name !== 'endpoint.json.lock-journal')
          .sort(),
        ['endpoint.json', 'endpoint.json.lock'],
      );
    });
});

test('a concurrent original replacement before rename is never overwritten and invalidates the writer', (t) => {
  const f = fixture(t),
    initial = f.open();
  initial.save(null, secret);
  initial.close();
  let replaced = false;
  const store = f.open({
    fsyncSync(fd) {
      fs.fsyncSync(fd);
      if (!replaced && fs.fstatSync(fd).isFile()) {
        replaced = true;
        fs.renameSync(f.file, f.file + '-operator-backup');
        fs.writeFileSync(f.file, encode(7, 'operator-replacement'), { mode: 0o600 });
      }
    },
  });
  assert.throws(() => store.save(1, 'unwanted'), safe());
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).value, 'operator-replacement');
  assert.throws(() => store.load(), safe());
});

test('post-rename fsync failure or an ambiguous rename result reports unknown and requires reopening', async (t) => {
  for (const point of ['directory-sync', 'rename-return'])
    await t.test(point, (t) => {
      const f = fixture(t);
      const store = f.open(
        point === 'directory-sync'
          ? {
              fsyncSync(fd) {
                if (fs.fstatSync(fd).isDirectory()) throw Error(secret);
                fs.fsyncSync(fd);
              },
            }
          : {
              renameSync(from, to) {
                fs.renameSync(from, to);
                throw Error(secret);
              },
            },
      );
      assert.throws(() => store.save(null, secret), safe('unknown'));
      assert.throws(() => store.load(), safe());
      assert.throws(() => store.save(null, 'automatic-retry'), safe());
      store.close();
      assert.deepEqual(f.open().load(), { revision: 1, value: secret });
    });
});

test('cleanup preserves a replacement at the temporary pathname and never removes the operator lock', (t) => {
  const f = fixture(t);
  let temporary = '';
  const store = f.open({
    openSync: ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      const fd = fs.openSync(path, flags, mode);
      if (String(path).endsWith('.tmp')) temporary = String(path);
      return fd;
    }) as typeof fs.openSync,
    fsyncSync() {
      fs.renameSync(temporary, temporary + '-owned-original');
      fs.writeFileSync(temporary, 'operator-owned-replacement', { mode: 0o600 });
      throw Error(secret);
    },
  });
  const lock = fs.statSync(f.file + '.lock');
  assert.throws(() => store.save(null, secret), safe());
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'operator-owned-replacement');
  assert.equal(fs.statSync(f.file + '.lock').ino, lock.ino);
  assert.equal(store.load(), undefined);
});

test('lifetime lock excludes another process and is released by process exit without deleting the lock', async (t) => {
  const f = fixture(t);
  const script = `
    import { PrivateEndpointFile } from ${JSON.stringify(resolve('src/security/private-endpoint-file.ts'))};
    const store = PrivateEndpointFile.open(process.argv[1]);
    store.save(null, {synthetic:true});
    process.send({ready:true});
    process.on('message', () => process.exit(0));
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, f.file],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  const closed = once(child, 'close');
  f.children.push({ child, closed });
  const message = await Promise.race([
    once(child, 'message').then(([message]) => message),
    closed.then(() => {
      throw Error('Synthetic lock owner exited before readiness');
    }),
  ]);
  assert.deepEqual(message, { ready: true });
  assert.throws(() => f.open(), safe());
  const before = fs.statSync(f.file + '.lock').ino;
  child.send({ stop: true });
  assert.equal((await closed)[0], 0);
  const store = f.open();
  assert.deepEqual(store.load(), { revision: 1, value: { synthetic: true } });
  assert.equal(fs.statSync(f.file + '.lock').ino, before);
  assert.throws(() => f.open(), safe());
});

test('an existing foreign SQLite database is refused before opening it as a Moor lifetime lock', (t) => {
  const f = fixture(t),
    lock = f.file + '.lock';
  const database = new DatabaseSync(lock);
  database.exec('CREATE TABLE operator_rows(value TEXT)');
  database.prepare('INSERT INTO operator_rows VALUES (?)').run(secret);
  database.close();
  fs.chmodSync(lock, 0o600);
  const before = fs.readFileSync(lock),
    inode = fs.statSync(lock).ino;
  assert.ok(before.length > 0);
  assert.throws(() => f.open(), safe());
  assert.deepEqual(fs.readFileSync(lock), before);
  assert.equal(fs.statSync(lock).ino, inode);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(fs.readdirSync(f.directory), ['endpoint.json.lock']);
});

test('foreign hot journals and databases remain byte-for-byte untouched instead of being rolled back by SQLite', async (t) => {
  const f = fixture(t),
    lock = f.file + '.lock',
    journal = lock + '-journal';
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { chmodSync, readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const path = process.argv[1], database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; CREATE TABLE operator_rows(id INTEGER PRIMARY KEY, value BLOB)');
    const insert = database.prepare('INSERT INTO operator_rows(value) VALUES (?)');
    for (let index = 0; index < 40; index++) insert.run(Buffer.alloc(3000, 65));
    const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
    const initial = hash();
    database.exec('BEGIN EXCLUSIVE');
    const update = database.prepare('UPDATE operator_rows SET value=? WHERE id=?');
    for (let index = 1; index <= 40; index++) update.run(Buffer.alloc(3000, 66), index);
    process.send({ready:true, initial, dirty:hash()});
    process.on('message', () => process.exit(0));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const closed = once(child, 'close');
  f.children.push({ child, closed });
  const message = await Promise.race([
    once(child, 'message').then(
      ([value]) => value as { ready: boolean; initial: string; dirty: string },
    ),
    closed.then(() => {
      throw Error('Synthetic foreign writer exited before readiness');
    }),
  ]);
  assert.equal(message.ready, true);
  assert.notEqual(message.initial, message.dirty);
  child.kill('SIGKILL');
  assert.equal((await closed)[1], 'SIGKILL');
  const before = fs.readFileSync(lock),
    journalBefore = fs.readFileSync(journal);
  assert.ok(journalBefore.length > 512 && journalBefore.length < PRIVATE_ENDPOINT_FILE_MAX_BYTES);
  assert.equal(journalBefore.subarray(0, 8).toString('hex'), 'd9d505f920a163d7');
  assert.throws(() => f.open(), safe());
  assert.deepEqual(fs.readFileSync(lock), before);
  assert.deepEqual(fs.readFileSync(journal), journalBefore);
  assert.equal(fs.existsSync(f.file), false);
  // A zero-byte target does not make another database's hot journal safe to replay.
  const empty = join(f.directory, 'empty.json');
  fs.writeFileSync(empty + '.lock', '', { mode: 0o600 });
  fs.writeFileSync(empty + '.lock-journal', journalBefore, { mode: 0o600 });
  assert.throws(() => f.open(undefined, empty), safe());
  assert.equal(fs.statSync(empty + '.lock').size, 0);
  assert.deepEqual(fs.readFileSync(empty + '.lock-journal'), journalBefore);
});

test('only the complete empty-database cold journal is accepted, including all fields and zero padding', async (t) => {
  const source = fixture(t),
    original = source.open();
  const valid = fs.readFileSync(source.file + '.lock-journal');
  original.close();
  assert.equal(valid.length, 512);
  assert.ok(valid.subarray(0, 12).every((byte) => byte === 0));
  assert.equal(valid.readUInt32BE(16), 0);
  assert.equal(valid.readUInt32BE(20), 512);
  assert.equal(valid.readUInt32BE(24), 4096);
  assert.ok(valid.subarray(28).every((byte) => byte === 0));
  const invalid = [
    Buffer.alloc(0),
    Buffer.alloc(512),
    valid.subarray(0, 511),
    Buffer.concat([valid, Buffer.from([0])]),
  ];
  for (const offset of [0, 7, 8, 11, 16, 19, 20, 23, 24, 27, 28, 100, 511]) {
    const changed = Buffer.from(valid);
    changed[offset] ^= 1;
    invalid.push(changed);
  }
  for (const [index, bytes] of invalid.entries())
    await t.test(`unknown journal structure ${index}`, (t) => {
      const f = fixture(t),
        journal = f.file + '.lock-journal';
      fs.writeFileSync(f.file + '.lock', '', { mode: 0o600 });
      fs.writeFileSync(journal, bytes, { mode: 0o600 });
      assert.throws(() => f.open(), safe());
      assert.equal(fs.statSync(f.file + '.lock').size, 0);
      assert.deepEqual(fs.readFileSync(journal), bytes);
      assert.equal(fs.existsSync(f.file), false);
    });
  const f = fixture(t),
    journal = Buffer.from(valid);
  // The checksum nonce is the only unconstrained field in this empty journal.
  journal.writeUInt32BE(0xfedcba98, 12);
  fs.writeFileSync(f.file + '.lock', '', { mode: 0o600 });
  fs.writeFileSync(f.file + '.lock-journal', journal, { mode: 0o600 });
  assert.equal(f.open().load(), undefined);
});

test('WAL and shared-memory sidecars are refused even when empty and are never removed', async (t) => {
  for (const suffix of ['-wal', '-shm'])
    for (const bytes of [Buffer.alloc(0), Buffer.from(secret)])
      await t.test(`${suffix}/${bytes.length}`, (t) => {
        const f = fixture(t),
          sidecar = f.file + '.lock' + suffix;
        fs.writeFileSync(f.file + '.lock', '', { mode: 0o600 });
        fs.writeFileSync(sidecar, bytes, { mode: 0o600 });
        assert.throws(() => f.open(), safe());
        assert.deepEqual(fs.readFileSync(sidecar), bytes);
        assert.equal(fs.statSync(f.file + '.lock').size, 0);
      });
});

test('SIGKILL leaves only a recognized empty cold journal and a new process can reopen the durable vault', async (t) => {
  const f = fixture(t);
  const script = `
    import { PrivateEndpointFile } from ${JSON.stringify(resolve('src/security/private-endpoint-file.ts'))};
    const store = PrivateEndpointFile.open(process.argv[1]);
    store.save(null, {synthetic:'durable-before-crash'});
    process.send({ready:true});
    process.on('message', () => process.exit(0));
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, f.file],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  const closed = once(child, 'close');
  f.children.push({ child, closed });
  assert.deepEqual(
    await Promise.race([
      once(child, 'message').then(([message]) => message),
      closed.then(() => {
        throw Error('Synthetic Moor lock owner exited before readiness');
      }),
    ]),
    { ready: true },
  );
  assert.throws(() => f.open(), safe());
  const before = fs.readFileSync(f.file),
    lockInode = fs.statSync(f.file + '.lock').ino;
  child.kill('SIGKILL');
  assert.equal((await closed)[1], 'SIGKILL');
  assert.equal(fs.statSync(f.file + '.lock').size, 0);
  assert.equal(fs.statSync(f.file + '.lock-journal').size, 512);
  const reopened = f.open();
  assert.deepEqual(reopened.load(), { revision: 1, value: { synthetic: 'durable-before-crash' } });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.statSync(f.file + '.lock').ino, lockInode);
  assert.deepEqual(reopened.save(1, { synthetic: 'manual-after-crash' }), {
    revision: 2,
    value: { synthetic: 'manual-after-crash' },
  });
});

test('journal replacement during its bounded NOFOLLOW read is rejected before SQLite receives the lock path', (t) => {
  const source = fixture(t),
    original = source.open();
  const journalBytes = fs.readFileSync(source.file + '.lock-journal');
  original.close();
  const f = fixture(t),
    journal = f.file + '.lock-journal';
  fs.writeFileSync(f.file + '.lock', '', { mode: 0o600 });
  fs.writeFileSync(journal, journalBytes, { mode: 0o600 });
  let changed = false;
  assert.throws(
    () =>
      f.open({
        readSync: ((
          fd: number,
          bytes: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const count = fs.readSync(fd, bytes, offset, length, position);
          if (!changed) {
            changed = true;
            fs.renameSync(journal, journal + '-original');
            fs.writeFileSync(journal, secret, { mode: 0o600 });
          }
          return count;
        }) as typeof fs.readSync,
      }),
    safe(),
  );
  assert.equal(fs.readFileSync(journal, 'utf8'), secret);
  assert.deepEqual(fs.readFileSync(journal + '-original'), journalBytes);
  assert.equal(fs.statSync(f.file + '.lock').size, 0);
});
