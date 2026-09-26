import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAttachmentDraftItem,
  attachmentPreviewUrl,
  attachmentText,
  attachmentInputReason,
} from '../../apps/web/src/features/attachments/attachments';

test('preview selection never embeds SVG, HTML, unsafe data or file paths; input capabilities gate media types', async () => {
  const { reference, data } = await createAttachmentDraftItem(
    new File(['<svg onload="alert(1)"/>'], 'synthetic.svg', { type: 'image/svg+xml' }),
    'synthetic-svg',
  );
  assert.equal(attachmentPreviewUrl(reference, data), undefined);
  assert.equal(attachmentText(reference, data), undefined);
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
