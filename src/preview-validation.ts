import { createHash } from 'node:crypto';
import { assert } from './protocol';
import { previewFrameSchema } from './preview-protocol';

/** Decode only bounded PNG headers; the renderer owns full image decoding. */
export function validatePreviewFrame(value: unknown) {
  const frame = previewFrameSchema.parse(value),
    bytes = Buffer.from(frame.image.data, 'base64');
  assert(
    bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) === frame.viewport.width &&
      bytes.readUInt32BE(20) === frame.viewport.height &&
      'sha256:' + createHash('sha256').update(bytes).digest('hex') === frame.image.version,
    502,
    '预览图片内容或尺寸不可验证',
  );
  return frame;
}
