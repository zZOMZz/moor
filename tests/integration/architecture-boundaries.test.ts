import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { repository } from '../../scripts/build/workspace-sources.mjs';

test('architecture gate resolves types, side effects, reexports and dynamic imports and rejects unclassified modules', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moor-architecture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name: string, body: string) => {
    const file = join(root, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
  };
  write('package.json', JSON.stringify({ version: '0.2.0', private: true }));
  mkdirSync(join(root, 'docs'));
  for (const [group, name, module] of [
    ['packages', 'protocol', 'probe.ts'],
    ['packages', 'session', 'probe.ts'],
    ['packages', 'local-state', 'probe.ts'],
    ['packages', 'client', 'features/probe.ts'],
    ['packages', 'host', 'features/probe.ts'],
    ['packages', 'gateway', 'features/probe.ts'],
    ['packages', 'sync', 'document/probe.ts'],
    ['apps', 'web', 'app/probe.ts'],
    ['apps', 'desktop', 'main/main.cjs'],
    ['apps', 'cli', 'main.ts'],
    ['apps', 'host', 'main.ts'],
    ['apps', 'relay', 'main.ts'],
  ]) {
    write(`${group}/${name}/src/${module}`, 'export {};');
    const entry = './' + module!.replace(/\.(ts|cjs)$/, '');
    write(
      `${group}/${name}/package.json`,
      JSON.stringify({
        name: '@moor/' + (group === 'apps' ? 'app-' : '') + name,
        version: '0.2.0',
        private: true,
        exports: {
          [entry]: {
            types: './src/' + module,
            import: './dist/' + module!.replace(/\.ts$/, '.js'),
          },
        },
      }),
    );
  }
  write('packages/client/src/adapters/io.ts', 'export interface Transport {}');
  const run = () =>
    spawnSync(
      process.execPath,
      [join(repository, 'scripts/validation/check-package-boundaries.mjs'), '--write-inventory'],
      { cwd: root, encoding: 'utf8' },
    );
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stderr);
  for (const body of [
    "import type { Transport } from '../adapters/io';",
    "import '../adapters/io';",
    "export type { Transport } from '../adapters/io';",
    "type Port = import('../adapters/io').Transport;",
    "import type { Transport } from '../adapters/io.js';",
    "void import('../adapters/io');",
    "require('../adapters/io');",
  ]) {
    write('packages/client/src/features/probe.ts', body);
    const rejected = run();
    assert.notEqual(rejected.status, 0, body);
    assert.match(rejected.stderr, /outer module|runtime adapter/);
  }
  write('packages/client/src/features/probe.ts', 'export {};');
  write('packages/client/src/unclassified.ts', 'export {};');
  assert.match(run().stderr, /has no architecture role/);
  rmSync(join(root, 'packages/client/src/unclassified.ts'));
  write('apps/web/src/features/probe.ts', 'void window.moorDesktop;');
  assert.match(run().stderr, /platform bridge outside its adapter/);
  rmSync(join(root, 'apps/web/src/features/probe.ts'));
  write('packages/client/src/features/probe.ts', 'void crypto.randomUUID();');
  assert.match(run().stderr, /chooses a runtime capability/);
});
