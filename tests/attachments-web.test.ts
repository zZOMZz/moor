import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ApiError } from '../src/web/api';
import {
  AttachmentDraftController,
  attachmentDraftKey,
  attachmentPreviewUrl,
  attachmentText,
  attachmentInputReason,
  readAttachment,
  type AttachmentTarget,
} from '../src/web/attachments';
import type { AttachmentAction } from '../src/attachment-protocol';
import type { AttachmentReference } from '../src/content-protocol';

const scope = {
  owner: 'synthetic-owner',
  deviceId: 'synthetic-device',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
};
const target: AttachmentTarget = { ...scope, catalogWorkspaceId: 'catalog', replicaId: 'replica' };
function file(name = 'synthetic.txt', text = 'synthetic', type = 'text/plain') {
  return new File([text], name, { type });
}
function fixture() {
  const cache = new Map<string, unknown>(),
    requests: { path: string; action: AttachmentAction }[] = [];
  let nextId = 0;
  const dependencies = {
    read: async (key: string) => structuredClone(cache.get(key)),
    write: async (key: string, value: unknown) => {
      cache.set(key, structuredClone(value));
    },
    request: async (path: string, action: AttachmentAction): Promise<unknown> => {
      const stored = cache.get(attachmentDraftKey(scope)) as any;
      assert.deepEqual(
        stored.items.find((item: any) => item.pending?.request.operationId === action.operationId)
          .pending.request,
        action,
        'persisted before network',
      );
      requests.push({ path, action: structuredClone(action) });
      return receipt(action);
    },
    uuid: () => `synthetic-${++nextId}`,
  };
  return {
    cache,
    requests,
    dependencies,
    controller: new AttachmentDraftController(scope, dependencies),
  };
}
function receipt(action: AttachmentAction) {
  const { contentVersion, operationId, workspaceId, localProjectId, sessionId } = action;
  return {
    contentVersion,
    operationId,
    workspaceId,
    localProjectId,
    sessionId,
    accepted: true,
    delivered: true,
    ...(action.action === 'upload' ? { attachment: action.attachment } : { removed: true }),
  };
}

test('attachment drafts persist bytes and remain local on reload; upload and removal require explicit host confirmation', async () => {
  const f = fixture();
  const [reference] = await f.controller.add([file()]);
  assert.equal(
    reference.content.version,
    'sha256:' + createHash('sha256').update('synthetic').digest('hex'),
  );
  assert.equal(f.requests.length, 0);
  const restored = new AttachmentDraftController(scope, f.dependencies);
  await restored.load();
  assert.deepEqual(restored.items, f.controller.items);
  assert.deepEqual(restored.references(), []);
  assert.equal(f.requests.length, 0);
  await restored.upload(reference.attachmentId, target);
  assert.deepEqual(restored.references(), [reference]);
  assert.equal(restored.items[0].pending, undefined);
  assert.equal(f.requests.length, 1);
  await restored.remove(reference.attachmentId, target);
  assert.equal(restored.items.length, 0);
  assert.equal(f.requests.length, 2);
});

test('unknown attachment delivery preserves exact payload and operation; loading and local changes never retry it', async () => {
  const f = fixture();
  const normal = f.dependencies.request;
  f.dependencies.request = async (path, action) => {
    await normal(path, action);
    throw new ApiError('synthetic response lost', 0);
  };
  const [reference] = await f.controller.add([file()]);
  await assert.rejects(f.controller.upload(reference.attachmentId, target), /response lost/);
  const original = structuredClone(f.controller.items[0].pending);
  assert.ok(original);
  const restored = new AttachmentDraftController(scope, f.dependencies);
  await restored.load();
  assert.deepEqual(restored.items[0].pending, original);
  assert.equal(f.requests.length, 1);
  await assert.rejects(restored.remove(reference.attachmentId, target), /先手动确认/);
  await assert.rejects(restored.upload(reference.attachmentId, target), /手动重试/);
  await assert.rejects(restored.forget([reference.attachmentId]), /不能从草稿清除/);
  assert.equal(f.requests.length, 1);
  f.dependencies.request = normal;
  await restored.retry(reference.attachmentId, {
    ...target,
    catalogWorkspaceId: 'moved',
    replicaId: 'moved-replica',
  });
  assert.deepEqual(f.requests[1].action, original.request);
  assert.equal(
    f.requests[1].path,
    '/api/workspaces/moved/replicas/moved-replica/attachment-actions',
  );
  assert.deepEqual(restored.references(), [reference]);
});

test('explicit rejection alone permits removing or replacing an attachment operation', async () => {
  for (const rejected of [true, false]) {
    const f = fixture();
    const [reference] = await f.controller.add([file()]);
    f.dependencies.request = async () => {
      throw new ApiError('synthetic rejection', 409, rejected);
    };
    await assert.rejects(
      f.controller.upload(reference.attachmentId, target),
      /synthetic rejection/,
    );
    assert.equal(!!f.controller.items[0].pending, !rejected);
    if (rejected) {
      await f.controller.remove(reference.attachmentId);
      assert.equal(f.controller.items.length, 0);
    }
  }
});

test('attachment transmission waits for durable storage and receipt cleanup failures preserve retry state', async () => {
  for (const mode of ['pending', 'confirmed']) {
    const f = fixture();
    const [reference] = await f.controller.add([file()]);
    const normal = f.dependencies.write;
    f.dependencies.write = async (key, value) => {
      if (mode === 'pending' || (value as any).items[0]?.uploaded)
        throw new Error('synthetic storage failure');
      await normal(key, value);
    };
    await assert.rejects(f.controller.upload(reference.attachmentId, target), /storage failure/);
    assert.equal(f.requests.length, mode === 'pending' ? 0 : 1);
    assert.equal(!!f.controller.items[0].pending, mode === 'confirmed');
  }
});

test('attachment receipts are bound to every session scope field, operation and complete content reference', async () => {
  for (const field of [
    'workspaceId',
    'localProjectId',
    'sessionId',
    'operationId',
    'hash',
    'attachmentId',
    'name',
    'byteLength',
    'mediaType',
  ]) {
    const f = fixture();
    const [reference] = await f.controller.add([file()]);
    f.dependencies.request = async (_path, action) => {
      const result = receipt(action) as any;
      if (['hash', 'byteLength', 'mediaType'].includes(field))
        result.attachment = {
          ...reference,
          content: {
            ...reference.content,
            [field === 'hash' ? 'version' : field]:
              field === 'hash'
                ? 'sha256:' + '0'.repeat(64)
                : field === 'byteLength'
                  ? 0
                  : 'text/markdown',
          },
        };
      else if (['attachmentId', 'name'].includes(field))
        result.attachment = { ...reference, [field]: 'different' };
      else result[field] = 'different';
      return result;
    };
    await assert.rejects(
      f.controller.upload(reference.attachmentId, target),
      /有效的主机确认/,
      field,
    );
    assert.ok(f.controller.items[0].pending, field);
    assert.deepEqual(f.controller.references(), []);
  }
});

test('attachment scopes isolate drafts and prohibit retries to a different account, host, project or session', async () => {
  const f = fixture();
  const [reference] = await f.controller.add([file()]);
  for (const field of [
    'owner',
    'deviceId',
    'workspaceId',
    'localProjectId',
    'sessionId',
  ] as const) {
    const altered = { ...target, [field]: 'other' };
    const { catalogWorkspaceId: _catalog, replicaId: _replica, ...alteredScope } = altered;
    assert.notEqual(attachmentDraftKey(scope), attachmentDraftKey(alteredScope));
    await assert.rejects(f.controller.upload(reference.attachmentId, altered), /执行目标已改变/);
  }
  assert.equal(f.requests.length, 0);
  const corrupt = structuredClone(f.cache.get(attachmentDraftKey(scope))) as any;
  corrupt.items[0].data = Buffer.from('different').toString('base64');
  f.cache.set(attachmentDraftKey(scope), corrupt);
  await assert.rejects(new AttachmentDraftController(scope, f.dependencies).load(), /内容校验失败/);
});

test('attachment selection validates batch count, size, filenames and leaves earlier drafts intact on failure', async () => {
  const f = fixture();
  await f.controller.add([file()]);
  await assert.rejects(f.controller.add(Array.from({ length: 8 }, () => file())), /最多添加 8/);
  await assert.rejects(
    f.controller.add([new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'huge.bin')]),
    /最多 8 MiB/,
  );
  await assert.rejects(f.controller.add([file('bad/path.txt')]));
  assert.equal(f.controller.items.length, 1);
  assert.equal(f.requests.length, 0);
});

test('queued independent additions retain both files and forgetting confirmed prompt attachments preserves newer drafts', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.controller.add([file('a.txt')]),
    f.controller.add([file('b.txt')]),
  ]);
  assert.equal(f.controller.items.length, 2);
  await f.controller.upload(a[0].attachmentId, target);
  await f.controller.forget([a[0].attachmentId]);
  assert.equal(f.requests.length, 1, 'forget does not delete history attachments');
  assert.deepEqual(
    f.controller.items.map((item) => item.reference),
    b,
  );
});

test('preview selection never embeds SVG, HTML, unsafe data or file paths; input capabilities gate media types', async () => {
  const f = fixture();
  const [reference] = await f.controller.add([
    file('synthetic.svg', '<svg onload="alert(1)"/>', 'image/svg+xml'),
  ]);
  assert.equal(attachmentPreviewUrl(reference, f.controller.items[0].data), undefined);
  assert.equal(attachmentText(reference, f.controller.items[0].data), undefined);
  assert.match(attachmentInputReason(reference)!, /等待 Agent/);
  assert.match(
    attachmentInputReason(reference, { image: false, audio: true, embeddedContext: true })!,
    /不支持图片/,
  );
  assert.equal(
    attachmentInputReason(reference, { image: true, audio: false, embeddedContext: false }),
    undefined,
  );
  const png = { ...reference, content: { ...reference.content, mediaType: 'image/png' } };
  assert.equal(attachmentPreviewUrl(png, 'javascript:alert(1)'), undefined);
  assert.equal(attachmentPreviewUrl(png, 'AA=='), 'data:image/png;base64,AA==');
});

test('attachment reads validate host scope and hash, persist versioned bytes and never contact host for offline cache', async () => {
  const f = fixture();
  const [reference] = await f.controller.add([file()]);
  const result = {
    contentVersion: 1 as const,
    confirmed: true as const,
    workspaceId: scope.workspaceId,
    localProjectId: scope.localProjectId,
    sessionId: scope.sessionId,
    attachment: reference,
    data: f.controller.items[0].data,
  };
  let reads = 0;
  const dependencies = {
    read: f.dependencies.read,
    write: f.dependencies.write,
    request: async () => {
      reads++;
      return structuredClone(result);
    },
  };
  const first = await readAttachment(target, reference, true, dependencies);
  assert.equal(first.source, 'host');
  assert.equal(new TextDecoder().decode(first.bytes), 'synthetic');
  const cached = await readAttachment(target, reference, false, dependencies);
  assert.equal(cached.source, 'cache');
  assert.equal(reads, 1);
  await assert.rejects(
    readAttachment({ ...target, deviceId: 'other' }, reference, false, dependencies),
    /没有这个附件版本/,
  );
  await assert.rejects(
    readAttachment(target, reference, true, {
      ...dependencies,
      request: async () => ({ ...result, sessionId: 'different' }),
    }),
    /会话或版本不匹配/,
  );
  await assert.rejects(
    readAttachment(target, reference, true, {
      ...dependencies,
      request: async () => ({ ...result, data: Buffer.from('different').toString('base64') }),
    }),
    /内容校验失败/,
  );
});
