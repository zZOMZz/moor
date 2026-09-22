import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  repository,
  workspaceSourceAliases,
  workspaceSources,
} from '../../scripts/build/workspace-sources.mjs';

test('workspace source resolution bundles sync source instead of its generated distribution', async () => {
  const result = await build({
    absWorkingDir: repository,
    stdin: {
      contents: "export { CollaborationStore } from '@moor/sync/store';",
      resolveDir: repository,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    external: ['loro-crdt'],
    plugins: [workspaceSources],
  });
  const inputs = Object.keys(result.metafile!.inputs);
  assert.ok(inputs.includes('packages/sync/src/store.ts'));
  assert.equal(
    inputs.some((path) => /^packages\/[^/]+\/dist\//.test(path)),
    false,
  );
});

test('new packages use their declared source exports without a second package-name list', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moor-source-aliases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'packages', 'synthetic');
  mkdirSync(directory, { recursive: true });
  // A removed package can leave ignored program outputs or operator-owned files.
  // Source discovery ignores it rather than requiring destructive directory cleanup.
  mkdirSync(join(root, 'packages', 'retired', 'dist'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@moor/synthetic',
      exports: {
        '.': { types: './src/api.ts', import: './dist/api.js' },
        './*': { types: './src/*.ts', import: './dist/*.js' },
      },
    }),
  );
  const aliases = workspaceSourceAliases(root);
  const resolve = (specifier: string) => {
    const alias = aliases.find((entry) => entry.find.test(specifier));
    return alias && specifier.replace(alias.find, alias.replacement);
  };
  assert.equal(resolve('@moor/synthetic'), join(directory, 'src/api.ts'));
  assert.equal(resolve('@moor/synthetic/node/worker'), join(directory, 'src/node/worker.ts'));
  assert.equal(resolve('@moor/synthetic-other'), undefined);
});
