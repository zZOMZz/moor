import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentPayload,
  createAttachmentSaver,
  writeChosenFile,
} from '../src/desktop/attachment-save.cjs';
const bytes = Buffer.from('Synthetic attachment bytes');
const payload = {
  scope: {
    owner: 'owner',
    deviceId: 'device',
    workspaceId: 'runtime:1',
    localProjectId: 'project',
    sessionId: 'session',
  },
  reference: {
    contentVersion: 1,
    attachmentId: 'attachment',
    name: 'result.txt',
    content: {
      version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mediaType: 'text/plain',
    },
  },
  data: bytes.toString('base64'),
};
function fixture() {
  const frame = { url: 'https://moor.invalid/', origin: 'https://moor.invalid' },
    sender = { mainFrame: frame, isDestroyed: () => false },
    window = { isDestroyed: () => false };
  const registry = new Map<any, any>([[sender, { window, origin: 'https://moor.invalid' }]]),
    event = { sender, senderFrame: frame };
  const dialogs: any[] = [],
    writes: any[] = [];
  let release: (value: any) => void = () => {};
  const saver = createAttachmentSaver({
    registry,
    showSaveDialog: async (w: any, options: any) => {
      dialogs.push({ window: w, options });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    writeFile: async (path: string, data: Buffer) => {
      writes.push({ path, data: Buffer.from(data) });
    },
    downloads: () => '/synthetic/Downloads',
  });
  return {
    saver,
    registry,
    event,
    sender,
    frame,
    window,
    dialogs,
    writes,
    release: (value: any) => release(value),
  };
}
test('attachment save validates complete payload before the native dialog, writes only the chosen path and returns no filesystem path', async () => {
  const f = fixture(),
    operation = f.saver.save(f.event, payload);
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].options.defaultPath, '/synthetic/Downloads/result.txt');
  assert.equal(f.writes.length, 0);
  f.release({ canceled: false, filePath: '/synthetic/chosen/result.txt' });
  assert.deepEqual(await operation, { status: 'saved' });
  assert.deepEqual(f.writes, [{ path: '/synthetic/chosen/result.txt', data: bytes }]);
  const cancelled = f.saver.save(f.event, payload);
  f.release({ canceled: true });
  assert.deepEqual(await cancelled, { status: 'cancelled' });
  assert.equal(f.writes.length, 1);
});
test('foreign senders, subframes, changed origins, changed target and concurrent dialogs cannot save', async () => {
  const f = fixture();
  for (const event of [
    { ...f.event, sender: {} },
    { ...f.event, senderFrame: { ...f.frame } },
    { ...f.event, senderFrame: undefined },
  ])
    await assert.rejects(f.saver.save(event, payload));
  f.frame.url = 'https://other.invalid/';
  await assert.rejects(f.saver.save(f.event, payload));
  f.frame.url = 'https://moor.invalid/';
  f.frame.origin = 'null';
  await assert.rejects(f.saver.save(f.event, payload));
  f.frame.origin = 'https://moor.invalid';
  const first = f.saver.save(f.event, payload);
  await assert.rejects(f.saver.save(f.event, payload), /当前附件保存对话框/);
  f.saver.cancel(f.event);
  f.release({ canceled: false, filePath: '/synthetic/result.txt' });
  await assert.rejects(first, /会话目标或页面已改变/);
  assert.equal(f.writes.length, 0);
  const next = f.saver.save(f.event, payload);
  f.registry.delete(f.sender);
  f.release({ canceled: false, filePath: '/synthetic/result.txt' });
  await assert.rejects(next, /保存来源/);
  assert.equal(f.writes.length, 0);
});
test('scope, canonical base64, size, digest, filename and unexpected URL/path properties are bounded before any dialog', async () => {
  const f = fixture();
  const invalid = [
    { ...payload, path: '/private/file' },
    { ...payload, scope: { ...payload.scope, sessionId: undefined } },
    { ...payload, data: payload.data + '\n' },
    { ...payload, reference: { ...payload.reference, name: '../result.txt' } },
    { ...payload, reference: { ...payload.reference, name: '..' } },
    { ...payload, reference: { ...payload.reference, url: 'https://external.invalid' } },
    {
      ...payload,
      reference: {
        ...payload.reference,
        content: { ...payload.reference.content, byteLength: 8 * 1024 * 1024 + 1 },
      },
    },
    {
      ...payload,
      reference: {
        ...payload.reference,
        content: { ...payload.reference.content, version: 'sha256:' + '0'.repeat(64) },
      },
    },
  ];
  for (const value of invalid) {
    assert.throws(() => attachmentPayload(value));
    await assert.rejects(f.saver.save(f.event, value));
  }
  assert.equal(f.dialogs.length, 0);
});
test('native selected-file writer atomically replaces ordinary synthetic files and never follows a symlink', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-save-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'output.txt'),
    original = join(directory, 'original.txt'),
    link = join(directory, 'link.txt');
  await writeFile(destination, 'old synthetic');
  await writeChosenFile(destination, bytes);
  assert.deepEqual(await readFile(destination), bytes);
  await writeFile(original, 'preserved synthetic');
  await symlink(original, link);
  await assert.rejects(writeChosenFile(link, bytes), /链接或非普通文件/);
  assert.equal(await readFile(original, 'utf8'), 'preserved synthetic');
  await assert.rejects(writeChosenFile(directory, bytes));
});

function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, waiting };
}

test('navigation during temporary attachment writing aborts before atomic replacement and cleans temporary bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-save-navigation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'chosen.txt');
  await writeFile(destination, 'original synthetic content');
  const f = fixture(),
    writing = gate();
  const saver = createAttachmentSaver({
    registry: f.registry,
    downloads: () => directory,
    showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    writeFile: (path, data, options) =>
      writeChosenFile(path, data, {
        ...options,
        fileSystem: {
          ...fileSystem,
          open: async (...args: Parameters<typeof fileSystem.open>) => {
            const handle = await fileSystem.open(...args);
            return {
              writeFile: (data: Buffer) => handle.writeFile(data),
              close: () => handle.close(),
              sync: async () => {
                writing.enter();
                await writing.waiting;
                await handle.sync();
              },
            };
          },
        } as any,
      }),
  });
  const result = saver.save(f.event, payload);
  const rejected = assert.rejects(result, /会话目标或页面已改变/);
  await writing.entered;
  saver.invalidate(f.sender);
  writing.release();
  await rejected;
  assert.equal(await readFile(destination, 'utf8'), 'original synthetic content');
  assert.deepEqual(await readdir(directory), ['chosen.txt']);
});

test('navigation after a successful attachment rename preserves the actual saved result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-save-committed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'chosen.txt'),
    f = fixture(),
    renamed = gate();
  const saver = createAttachmentSaver({
    registry: f.registry,
    downloads: () => directory,
    showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    writeFile: (path, data, options) =>
      writeChosenFile(path, data, {
        ...options,
        fileSystem: {
          ...fileSystem,
          rename: async (source, destination) => {
            await fileSystem.rename(source, destination);
            renamed.enter();
            await renamed.waiting;
          },
        },
      }),
  });
  const result = saver.save(f.event, payload);
  await renamed.entered;
  saver.invalidate(f.sender);
  renamed.release();
  assert.deepEqual(await result, { status: 'saved' });
  assert.deepEqual(await readFile(destination), bytes);
  assert.deepEqual(await readdir(directory), ['chosen.txt']);
});
