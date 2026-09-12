import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promptContent } from '../src/runtime/attachment-input';
import { CONTENT_VERSION } from '../src/content-protocol';
import type { AgentAttachment, PromptInputCapabilities } from '../src/attachment-protocol';

const allInputs: PromptInputCapabilities = { image: true, audio: true, embeddedContext: true };
function attachment(name: string, mediaType: string, bytes: Buffer): AgentAttachment {
  return {
    reference: {
      contentVersion: CONTENT_VERSION,
      attachmentId: name.replace(/\W/g, '-'),
      name,
      content: {
        version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
        mediaType,
      },
    },
    data: bytes.toString('base64'),
  };
}
function input(attachmentData: AgentAttachment[], prompt = 'Synthetic attachment request') {
  return { prompt, attachments: attachmentData.map((item) => item.reference), attachmentData };
}

test('host confirmed image, audio, text and binary attachments become exact ACP content blocks', () => {
  const items = [
    attachment('diagram.png', 'image/png', Buffer.from([137, 80, 78, 71])),
    attachment('voice.wav', 'audio/wav', Buffer.from('RIFF synthetic')),
    attachment('项目 notes.md', 'text/markdown', Buffer.from('# 合成说明\n')),
    attachment('data.json', 'application/json', Buffer.from('{"synthetic":true}')),
    attachment('archive.bin', 'application/octet-stream', Buffer.from([0, 255, 128])),
  ];
  const result = promptContent(input(items), allInputs);
  assert.deepEqual(result[0], { type: 'text', text: 'Synthetic attachment request' });
  for (const [index, type] of [
    [0, 'image'],
    [1, 'audio'],
  ] as const)
    assert.deepEqual(result[index + 1], {
      type,
      mimeType: items[index].reference.content.mediaType,
      data: items[index].data,
    });
  for (const index of [2, 3, 4]) {
    const item = items[index];
    assert.deepEqual(result[index + 1], {
      type: 'resource',
      resource: {
        uri:
          'moor-attachment://' +
          item.reference.attachmentId +
          '/' +
          encodeURIComponent(item.reference.name),
        mimeType: item.reference.content.mediaType,
        ...(index === 4
          ? { blob: item.data }
          : { text: Buffer.from(item.data, 'base64').toString('utf8') }),
      },
    });
  }
  assert.equal(promptContent(input([items[0]], ''), allInputs).length, 1);
  assert.deepEqual(promptContent({ prompt: 'text only' }, allInputs), [
    { type: 'text', text: 'text only' },
  ]);
  assert.throws(() => promptContent({ prompt: '' }, allInputs), /请填写指令或添加附件/);
});

test('launch-time capabilities reject every unsupported attachment instead of dropping its content', () => {
  for (const [flag, mime] of [
    ['image', 'image/png'],
    ['audio', 'audio/wav'],
    ['embeddedContext', 'text/plain'],
  ] as const) {
    const item = attachment('synthetic.bin', mime, Buffer.from('synthetic'));
    assert.throws(() => promptContent(input([item]), { ...allInputs, [flag]: false }), /未报告/);
  }
});

test('unconfirmed, reordered, substituted, corrupt and noncanonical attachment bytes cannot reach ACP', () => {
  const first = attachment('first.txt', 'text/plain', Buffer.from('first'));
  const second = attachment('second.txt', 'text/plain', Buffer.from('second'));
  assert.throws(
    () => promptContent({ ...input([first]), attachmentData: undefined }, allInputs),
    /尚未由主机确认/,
  );
  assert.throws(
    () => promptContent({ ...input([first]), attachmentData: [first, second] }, allInputs),
    /尚未由主机确认/,
  );
  assert.throws(
    () => promptContent({ ...input([first, second]), attachmentData: [second, first] }, allInputs),
    /与指令不匹配/,
  );
  assert.throws(
    () =>
      promptContent(
        {
          ...input([first]),
          attachmentData: [
            { ...first, reference: { ...first.reference, name: 'substituted.txt' } },
          ],
        },
        allInputs,
      ),
    /与指令不匹配/,
  );
  for (const data of [
    Buffer.from('other').toString('base64'),
    Buffer.from('longer').toString('base64'),
  ])
    assert.throws(
      () => promptContent({ ...input([first]), attachmentData: [{ ...first, data }] }, allInputs),
      /校验失败/,
    );
  for (const data of ['Zg=', 'Zh==', first.data + '\n'])
    assert.throws(() =>
      promptContent({ ...input([first]), attachmentData: [{ ...first, data }] }, allInputs),
    );
  assert.throws(() => promptContent(input([first, first]), allInputs), /附件不能重复/);
});

test('invalid UTF-8 labelled as text stays binary without replacing bytes or inventing text', () => {
  const item = attachment('invalid.txt', 'text/plain', Buffer.from([0xc0, 0xaf]));
  const block = promptContent(input([item], ''), allInputs)[0];
  assert.equal(block.type, 'resource');
  if (block.type !== 'resource') throw new Error('Expected a resource block');
  assert.equal('text' in block.resource, false);
  assert.equal('blob' in block.resource && block.resource.blob, item.data);
});
