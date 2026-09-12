import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { PreviewFrame, PreviewViewport } from '../../src/preview-protocol';

export const previewVersion = 'sha256:' + 'a'.repeat(64);
export const previewViewport = { width: 390, height: 844 };
export function previewPng(viewport = previewViewport) {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(viewport.width);
  header.writeUInt32BE(viewport.height, 4);
  header[8] = 8;
  header[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0SYNTHETIC_PRIVATE_PREVIEW_PAGE')),
    chunk('IDAT', deflateSync(Buffer.alloc((viewport.width * 4 + 1) * viewport.height))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return {
    mediaType: 'image/png' as const,
    byteLength: bytes.length,
    version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  };
}
export function previewFrame(
  previewId = 'preview',
  frameId = 'frame',
  viewport: PreviewViewport = previewViewport,
): PreviewFrame {
  return {
    previewId,
    frameId,
    documentId: 'document',
    revision: 1,
    viewport,
    path: '/',
    title: 'SYNTHETIC_PRIVATE_PREVIEW_PAGE',
    capturedAt: '2026-09-12T00:00:00Z',
    image: previewPng(viewport),
  };
}
export function previewSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
