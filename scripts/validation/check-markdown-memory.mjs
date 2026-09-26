// Optional retained-memory regression: node scripts/validation/check-markdown-memory.mjs
// Runs the production parser with synthetic output and explicit GC in an isolated
// process. This measures live heap, not allocation rate or machine-dependent time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[2] === '--worker') {
  assert.equal(typeof global.gc, 'function');
  const { measureStreamingMarkdown: update } = await import(pathToFileURL(process.argv[3]).href);
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  const samples = [];
  let source = '\n```ts\n';
  let document;
  for (let sequence = 1; sequence <= 3000; sequence++) {
    const number = String(sequence).padStart(6, '0');
    const prefix = `// SEQ:${number}\nexport const item${number} = "`;
    const boundary = sequence > 1 && (sequence - 1) % 64 === 0 ? '\n```\n\n```ts\n' : '';
    source += boundary + prefix + 'x'.repeat(64 - prefix.length - 3) + '";\n';
    document = update(document, source);
    if (sequence % 1000 === 0) {
      // Keep only the current parsed document as an explicit strong root. Old
      // source versions may survive only through its persistent string parts.
      globalThis.__markdownMemoryDocument = document;
      global.gc();
      samples.push({
        chunks: sequence,
        sourceBytes: Buffer.byteLength(source),
        blocks: document.blocks.length,
        retainedBytes: Math.max(0, process.memoryUsage().heapUsed - baseline),
      });
    }
  }
  console.log(JSON.stringify({ baselineBytes: baseline, samples }, null, 2));
  for (const sample of samples)
    assert(
      sample.retainedBytes <= 16 * 1024 * 1024 + 32 * sample.sourceBytes,
      'Parsed parts retain old complete source versions instead of bounded text fragments',
    );
} else {
  const { build } = await import('esbuild');
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const sourceFile = path.join(repository, 'apps/web/src/features/sessions/streaming-markdown.tsx');
  const directory = mkdtempSync(path.join(tmpdir(), 'moor-markdown-memory-'));
  try {
    const outfile = path.join(directory, 'parser.mjs');
    await build({
      stdin: {
        contents:
          readFileSync(sourceFile, 'utf8') + '\nexport { update as measureStreamingMarkdown };',
        sourcefile: sourceFile,
        resolveDir: path.dirname(sourceFile),
        loader: 'tsx',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=768',
        fileURLToPath(import.meta.url),
        '--worker',
        outfile,
      ],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
