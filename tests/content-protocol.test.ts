import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CONTENT_LIMITS,
  CONTENT_VERSION,
  attachmentReferenceSchema,
  contentDescriptorSchema,
  fileDiffReferenceSchema,
  projectFilePathSchema,
  projectFileReadSchema,
  projectFileResultSchema,
} from '../src/content-protocol';

const scope = {
  workspaceId: 'synthetic-runtime',
  localProjectId: 'synthetic-project',
  sessionId: 'synthetic-session',
};
const request = { ...scope, contentVersion: CONTENT_VERSION, path: 'src/example.ts' };
function descriptor(bytes: Uint8Array = Buffer.from('synthetic')) {
  return {
    version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    mediaType: 'application/octet-stream',
  };
}
function response(bytes: Uint8Array = Buffer.from('synthetic')) {
  return {
    ...request,
    status: 'content',
    confirmed: true,
    encoding: 'base64',
    content: descriptor(bytes),
    data: Buffer.from(bytes).toString('base64'),
  };
}
const content = descriptor();
function diff(files: unknown[]) {
  return {
    contentVersion: CONTENT_VERSION,
    turnId: 'synthetic-turn',
    basis: 'project-snapshot',
    files,
  };
}

test('project paths reject traversal and platform aliases without decoding literal percent names', () => {
  for (const path of [
    'src/main.ts',
    '中文/文件 名.md',
    '.env.example',
    '%2e%2e/synthetic.txt',
    'literal%2Fsegment.txt',
    '%00.txt',
  ])
    assert.equal(projectFilePathSchema.parse(path), path);
  for (const path of [
    '',
    '.',
    '..',
    '../private.txt',
    'src/../../private.txt',
    '/private.txt',
    '//server/share.txt',
    'C:/private.txt',
    'C:private.txt',
    'src\\private.txt',
    '\\\\server\\share.txt',
    'src/./main.ts',
    'src//main.ts',
    'src/',
    'src/..',
    'nul\0.txt',
    'line\n.txt',
    'delete\x7f.txt',
    'a'.repeat(CONTENT_LIMITS.pathLength + 1),
  ])
    assert.equal(projectFilePathSchema.safeParse(path).success, false, JSON.stringify(path));
});

test('file requests cannot omit scope, select unknown versions or smuggle filesystem and identity fields', () => {
  assert.deepEqual(projectFileReadSchema.parse(request), request);
  assert.equal(
    projectFileReadSchema.safeParse({ ...request, knownVersion: content.version }).success,
    true,
  );
  for (const field of ['workspaceId', 'localProjectId', 'sessionId']) {
    assert.equal(
      projectFileReadSchema.safeParse({ ...request, [field]: undefined }).success,
      false,
    );
    assert.equal(
      projectFileReadSchema.safeParse({ ...request, [field]: '../other' }).success,
      false,
    );
  }
  for (const addition of [
    { contentVersion: CONTENT_VERSION + 1 },
    { knownVersion: 'mtime:123' },
    { rootPath: '/outside-project' },
    { owner: 'other-owner' },
    { deviceId: 'other-device' },
    { encoding: 'utf8' },
  ])
    assert.equal(projectFileReadSchema.safeParse({ ...request, ...addition }).success, false);
});

test('file envelopes accept bounded canonical bytes and keep conditional responses body-free', () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('f'),
    Buffer.from('fo'),
    Buffer.from('foo'),
    Buffer.from([0, 255, 128]),
    Buffer.alloc(CONTENT_LIMITS.fileBytes, 128),
  ])
    assert.deepEqual(projectFileResultSchema.parse(response(bytes)), response(bytes));
  const unchanged = {
    ...request,
    status: 'not-modified',
    confirmed: true,
    content,
  };
  assert.deepEqual(projectFileResultSchema.parse(unchanged), unchanged);
  for (const extra of [{ data: '' }, { encoding: 'base64' }, { confirmed: false }])
    assert.equal(projectFileResultSchema.safeParse({ ...unchanged, ...extra }).success, false);
  assert.equal(
    projectFileResultSchema.safeParse(response(Buffer.alloc(CONTENT_LIMITS.fileBytes + 1))).success,
    false,
  );
});

test('file envelopes reject noncanonical base64 and size metadata that disagrees with the bytes', () => {
  const oneByte = response(Buffer.from('f'));
  for (const data of ['Zh==', 'Zg', 'Zg===', 'Zg==\n', 'Zg==Zg==', 'Zg--'])
    assert.equal(projectFileResultSchema.safeParse({ ...oneByte, data }).success, false, data);
  const twoBytes = response(Buffer.from('fo'));
  assert.equal(projectFileResultSchema.safeParse({ ...twoBytes, data: 'Zm9=' }).success, false);
  for (const byteLength of [0, 2, 1.5, -1, CONTENT_LIMITS.fileBytes + 1])
    assert.equal(
      projectFileResultSchema.safeParse({
        ...oneByte,
        content: { ...oneByte.content, byteLength },
      }).success,
      false,
      String(byteLength),
    );
  assert.equal(projectFileResultSchema.safeParse({ ...oneByte, data: '' }).success, false);
  for (const mediaType of ['image/png', 'text/html', 'text/plain; charset=utf-8'])
    assert.equal(
      projectFileResultSchema.safeParse({
        ...oneByte,
        content: { ...oneByte.content, mediaType },
      }).success,
      false,
    );
});

test('content references bound attachment bytes and reject ambiguous MIME and unsafe display names', () => {
  const attachment = {
    contentVersion: CONTENT_VERSION,
    attachmentId: 'synthetic-attachment',
    name: '合成材料.bin',
    content: { ...content, byteLength: CONTENT_LIMITS.attachmentBytes },
  };
  assert.deepEqual(attachmentReferenceSchema.parse(attachment), attachment);
  assert.equal(
    attachmentReferenceSchema.safeParse({
      ...attachment,
      content: { ...attachment.content, byteLength: CONTENT_LIMITS.attachmentBytes + 1 },
    }).success,
    false,
  );
  for (const name of ['', '../secret', 'subdir/file', 'subdir\\file', 'name\0.txt', 'line\r.txt'])
    assert.equal(attachmentReferenceSchema.safeParse({ ...attachment, name }).success, false);
  for (const mediaType of [
    '',
    'text',
    'text/plain; charset=utf-8',
    'text/plain\r\nX-Header: value',
    'text/plain extra',
    'TEXT/PLAIN',
  ])
    assert.equal(contentDescriptorSchema.safeParse({ ...content, mediaType }).success, false);
  for (const version of ['sha256:abc', 'sha256:' + 'A'.repeat(64), 'sha1:' + 'a'.repeat(64)])
    assert.equal(contentDescriptorSchema.safeParse({ ...content, version }).success, false);
  assert.equal(
    attachmentReferenceSchema.safeParse({ ...attachment, rootPath: '/synthetic' }).success,
    false,
  );
  assert.equal(
    contentDescriptorSchema.safeParse({ ...content, data: 'hidden body' }).success,
    false,
  );
});

test('saved diff contracts bound file counts and preserve meaningful add, delete and rename states', () => {
  const files = [
    { path: 'added.txt', before: null, after: content },
    { path: 'deleted.txt', before: content, after: null },
    {
      path: 'changed.txt',
      before: content,
      after: { ...content, version: 'sha256:' + 'a'.repeat(64) },
    },
    { path: 'renamed.txt', previousPath: 'original.txt', before: content, after: content },
  ];
  assert.deepEqual(fileDiffReferenceSchema.parse(diff(files)), diff(files));
  for (const file of [
    { path: 'empty.txt', before: null, after: null },
    { path: 'new.txt', previousPath: 'old.txt', before: null, after: content },
    { path: 'new.txt', previousPath: 'old.txt', before: content, after: null },
    { path: 'same.txt', previousPath: 'same.txt', before: content, after: content },
  ])
    assert.equal(fileDiffReferenceSchema.safeParse(diff([file])).success, false);
  const many = Array.from({ length: CONTENT_LIMITS.diffFiles }, (_, i) => ({
    path: `synthetic-${i}.txt`,
    before: null,
    after: content,
  }));
  assert.equal(fileDiffReferenceSchema.safeParse(diff(many)).success, true);
  assert.equal(fileDiffReferenceSchema.safeParse(diff([...many, files[0]])).success, false);
  assert.equal(
    fileDiffReferenceSchema.safeParse({ ...diff(files), contentVersion: CONTENT_VERSION + 1 })
      .success,
    false,
  );
});

test('saved diff references reject duplicate source or destination paths while allowing a rename swap', () => {
  const rename = { path: 'new.txt', previousPath: 'old.txt', before: content, after: content };
  for (const files of [
    [rename, { path: 'new.txt', before: null, after: content }],
    [rename, { path: 'another.txt', previousPath: 'old.txt', before: content, after: content }],
    [rename, { path: 'old.txt', before: content, after: null }],
    [
      { path: 'deleted.txt', before: content, after: null },
      { path: 'deleted.txt', before: content, after: null },
    ],
  ])
    assert.equal(fileDiffReferenceSchema.safeParse(diff(files)).success, false);
  const swap = [
    { path: 'b.txt', previousPath: 'a.txt', before: content, after: content },
    { path: 'a.txt', previousPath: 'b.txt', before: content, after: content },
  ];
  assert.deepEqual(fileDiffReferenceSchema.parse(diff(swap)), diff(swap));
});
