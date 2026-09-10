import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { AppError } from '../protocol';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

export async function serveStatic(req: IncomingMessage, res: ServerResponse, filename: string) {
  const bytes = await readFile(filename).catch(() => {
    throw new AppError(404, '未找到');
  });
  const etag = 'W/"' + createHash('sha256').update(bytes).digest('hex') + '"';
  res.setHeader('Content-Type', types[extname(filename)] ?? 'application/octet-stream');
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader(
    'Cache-Control',
    /\/assets\/[^/]+-[A-Z0-9]{8}\.(js|wasm)$/.test(filename)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  );
  const tags = req.headers['if-none-match']
    ?.split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''));
  if (tags?.includes('*') || tags?.includes(etag.slice(2))) {
    res.writeHead(304);
    res.end();
    return;
  }
  const encodings = (req.headers['accept-encoding'] ?? '').split(',').map((part) => {
    const [name, ...params] = part.trim().split(';');
    const quality = params.find((param) => param.trim().startsWith('q='));
    return { name: name.toLowerCase(), quality: quality ? Number(quality.trim().slice(2)) : 1 };
  });
  const gzip =
    encodings.find((encoding) => encoding.name === 'gzip') ??
    encodings.find((encoding) => encoding.name === '*');
  const compressed =
    gzip && gzip.quality > 0 && /\.(js|css|html|wasm)$/.test(filename)
      ? await readFile(filename + '.gz').catch(() => undefined)
      : undefined;
  if (compressed) res.setHeader('Content-Encoding', 'gzip');
  res.writeHead(200);
  res.end(compressed ?? bytes);
}
