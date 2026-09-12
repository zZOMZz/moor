import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ApiError } from '../src/web/api';
import {
  fileContentCacheKey,
  readProjectFile,
  type FileContentTarget,
} from '../src/web/file-content';
import { type ProjectFileRead, type ProjectFileResult } from '../src/content-protocol';

const target: FileContentTarget = {
  owner: 'synthetic-owner',
  deviceId: 'device-a',
  catalogWorkspaceId: 'product-a',
  replicaId: 'replica-a',
};
const request: ProjectFileRead = {
  contentVersion: 1,
  workspaceId: 'runtime-a',
  localProjectId: 'project-a',
  sessionId: 'session-a',
  path: 'src/example.txt',
};
function content(
  value: string | Uint8Array,
  mediaType: 'text/plain' | 'application/octet-stream' = 'text/plain',
) {
  const bytes = Buffer.from(value);
  return {
    ...request,
    confirmed: true,
    status: 'content',
    encoding: 'base64',
    data: bytes.toString('base64'),
    content: {
      version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mediaType,
    },
  } satisfies ProjectFileResult;
}
function fixture(response: unknown = content('synthetic file')) {
  const cache = new Map<string, unknown>(),
    calls: { path: string; input: ProjectFileRead }[] = [];
  let responder: (input: ProjectFileRead) => Promise<unknown> = async () => response;
  const dependencies = {
    read: async (key: string) => cache.get(key),
    write: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    request: async (path: string, input: ProjectFileRead) => {
      calls.push({ path, input });
      return responder(input);
    },
  };
  return {
    cache,
    calls,
    dependencies,
    respond: (next: typeof responder) => {
      responder = next;
    },
  };
}

test('host content is verified, cached by version, and revalidated only by an explicit scoped read', async () => {
  const body = content('合成文件内容'),
    f = fixture(body);
  const first = await readProjectFile(target, request, true, f.dependencies);
  assert.equal(first.source, 'host');
  assert.equal(first.stale, false);
  assert.equal(first.text, '合成文件内容');
  assert.equal(first.cacheSaved, true);
  assert.deepEqual(f.calls, [
    { path: '/api/workspaces/product-a/replicas/replica-a/file-content', input: request },
  ]);
  const { data: _data, encoding: _encoding, ...unchanged } = body;
  f.respond(async () => ({ ...unchanged, status: 'not-modified' }));
  const conditional = { ...request, knownVersion: body.content.version };
  const second = await readProjectFile(target, conditional, true, f.dependencies);
  assert.equal(second.source, 'host');
  assert.equal(second.stale, false);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(f.calls.at(-1)?.input.knownVersion, body.content.version);
  const offline = await readProjectFile(target, conditional, false, f.dependencies);
  assert.equal(offline.source, 'cache');
  assert.equal(offline.stale, true);
  assert.equal(f.calls.length, 2, 'offline reads do not start a request or queue work');
  assert.equal(f.cache.size, 1, 'not-modified responses never replace the stored bytes');
});

test('file caches isolate owner, device, runtime, project, session, path and exact content version', async () => {
  const body = content('synthetic file'),
    f = fixture(body);
  await readProjectFile(target, request, true, f.dependencies);
  const known = { ...request, knownVersion: body.content.version };
  for (const route of [
    { ...target, owner: 'other' },
    { ...target, deviceId: 'device-b' },
  ])
    await assert.rejects(readProjectFile(route, known, false, f.dependencies), /没有这个版本/);
  for (const input of [
    { ...known, workspaceId: 'runtime-b' },
    { ...known, localProjectId: 'project-b' },
    { ...known, sessionId: 'session-b' },
    { ...known, path: 'other.txt' },
    { ...known, knownVersion: content('different').content.version },
    request,
  ])
    await assert.rejects(readProjectFile(target, input, false, f.dependencies), /没有这个版本/);
  const moved = { ...target, catalogWorkspaceId: 'product-b', replicaId: 'replica-b' };
  assert.equal(
    fileContentCacheKey(moved, known, known.knownVersion),
    fileContentCacheKey(target, known, known.knownVersion),
  );
  const stillLocal = await readProjectFile(moved, known, false, f.dependencies);
  assert.equal(
    stillLocal.source,
    'cache',
    'catalog organization does not change execution identity',
  );
  assert.equal(f.calls.length, 1);
});

test('untrusted scope, bytes, descriptor and protocol responses cannot enter file cache', async () => {
  const body = content('synthetic file');
  for (const response of [
    { ...body, workspaceId: 'other' },
    { ...body, localProjectId: 'other' },
    { ...body, sessionId: 'other' },
    { ...body, path: 'other.txt' },
    { ...body, confirmed: false },
    { ...body, contentVersion: 2 },
    { ...body, data: content('tampered bytes').data },
    { ...body, content: { ...body.content, version: content('other').content.version } },
    { ...body, content: { ...body.content, mediaType: 'text/html' } },
    content(Uint8Array.of(255)),
    content(Uint8Array.of(0)),
  ]) {
    const f = fixture(response);
    await assert.rejects(readProjectFile(target, request, true, f.dependencies));
    assert.equal(f.cache.size, 0);
  }
  const binary = content(Uint8Array.of(255, 0, 1), 'application/octet-stream'),
    f = fixture(binary);
  const result = await readProjectFile(target, request, true, f.dependencies);
  assert.equal(result.text, undefined, 'binary bytes are not decoded with replacement characters');
  assert.deepEqual([...result.bytes], [255, 0, 1]);
});

test('invalid local cache forces a full read and cannot satisfy a body-free confirmation', async () => {
  const body = content('synthetic file'),
    f = fixture(body);
  const known = { ...request, knownVersion: body.content.version },
    key = fileContentCacheKey(target, request, known.knownVersion);
  for (const poisoned of [
    { cacheVersion: 2, owner: target.owner, deviceId: target.deviceId, result: body },
    { cacheVersion: 1, owner: 'other', deviceId: target.deviceId, result: body },
    { cacheVersion: 1, owner: target.owner, deviceId: 'other', result: body },
    {
      cacheVersion: 1,
      owner: target.owner,
      deviceId: target.deviceId,
      result: { ...body, sessionId: 'other' },
    },
    {
      cacheVersion: 1,
      owner: target.owner,
      deviceId: target.deviceId,
      result: { ...body, data: content('bad file value').data },
    },
  ]) {
    f.cache.set(key, poisoned);
    await assert.rejects(readProjectFile(target, known, false, f.dependencies), /没有这个版本/);
    await readProjectFile(target, known, true, f.dependencies);
    assert.equal(f.calls.at(-1)?.input.knownVersion, undefined);
  }
  const { data: _data, encoding: _encoding, ...unchanged } = body;
  f.respond(async () => ({ ...unchanged, status: 'not-modified' }));
  f.cache.clear();
  await assert.rejects(readProjectFile(target, known, true, f.dependencies), /没有对应缓存/);
  assert.equal(f.cache.size, 0);
});

test('online rejection never falls back to stale bytes; cache storage failure keeps a confirmed read usable', async () => {
  const body = content('synthetic file'),
    f = fixture(body);
  await readProjectFile(target, request, true, f.dependencies);
  const known = { ...request, knownVersion: body.content.version };
  for (const status of [0, 401, 403, 404, 409]) {
    f.respond(async () => {
      throw new ApiError('synthetic unavailable', status);
    });
    await assert.rejects(
      readProjectFile(target, known, true, f.dependencies),
      (error: unknown) => error instanceof ApiError && error.status === status,
    );
  }
  f.respond(async () => body);
  const result = await readProjectFile(target, known, true, {
    ...f.dependencies,
    read: async () => {
      throw new Error('storage blocked');
    },
    write: async () => {
      throw new Error('storage full');
    },
  });
  assert.equal(result.source, 'host');
  assert.equal(result.cacheSaved, false);
  assert.equal(f.calls.at(-1)?.input.knownVersion, undefined);
  assert.equal(result.text, 'synthetic file');
});

test('late reads preserve distinct immutable versions instead of overwriting a latest cache pointer', async () => {
  const older = content('older contents'),
    newer = content('newer contents'),
    f = fixture();
  let finishOlder!: (value: unknown) => void,
    first = true;
  f.respond(async () => {
    if (first) {
      first = false;
      return new Promise((resolve) => {
        finishOlder = resolve;
      });
    }
    return newer;
  });
  const pending = readProjectFile(target, request, true, f.dependencies);
  const current = await readProjectFile(target, request, true, f.dependencies);
  finishOlder(older);
  await pending;
  assert.equal(f.cache.size, 2);
  const offline = await readProjectFile(
    target,
    { ...request, knownVersion: current.result.content.version },
    false,
    f.dependencies,
  );
  assert.equal(offline.text, 'newer contents');
});
