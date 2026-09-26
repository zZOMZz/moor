import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import {
  recordEsbuildGraph,
  productionGraphPlugin,
  requiredProductionGraphs,
} from '../../scripts/validation/production-graph.mjs';

test('Knip follows source paths with a built dist present and still reports a genuinely unused export', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moor-knip-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file: string, value: unknown) => {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put('package.json', {
    name: 'synthetic-root',
    private: true,
    workspaces: ['packages/*'],
    dependencies: { '@synthetic/library': 'workspace:*' },
  });
  await put('packages/library/package.json', {
    name: '@synthetic/library',
    private: true,
    exports: { '.': { types: './src/index.ts', import: './dist/index.js' } },
  });
  await put('main.ts', "import { usedValue } from '@synthetic/library'; console.log(usedValue);");
  await put(
    'packages/library/src/index.ts',
    'export const usedValue = 1; export const unusedValue = 2;',
  );
  await put('packages/library/dist/index.js', 'export const usedValue = 1;');
  await put('.gitignore', 'node_modules/\ndist/\n');
  await put('tsconfig.knip.json', {
    compilerOptions: {
      baseUrl: '.',
      paths: { '@synthetic/library': ['./packages/library/src/index.ts'] },
    },
    include: [],
  });
  await put('knip.json', {
    includeEntryExports: true,
    workspaces: {
      '.': { entry: ['main.ts'], project: ['main.ts'] },
      'packages/library': { entry: [], project: ['src/**/*.ts'] },
    },
  });
  await mkdir(join(root, 'node_modules/@synthetic'), { recursive: true });
  await symlink(join(root, 'packages/library'), join(root, 'node_modules/@synthetic/library'));
  const analyze = () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/knip/bin/knip.js'),
        '--config',
        'knip.json',
        '--tsConfig',
        'tsconfig.knip.json',
        '--reporter',
        'json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 1, result.stderr);
    return JSON.parse(result.stdout)
      .issues.flatMap((issue: any) => (issue.exports ?? []).map((value: any) => value.name))
      .sort();
  };
  assert.deepEqual(analyze(), ['unusedValue']);
  await rm(join(root, 'packages/library/dist'), { recursive: true });
  assert.deepEqual(analyze(), ['unusedValue']);
});

test('development performance classification requires its exact runtime chain and forbids production emission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moor-development-reachability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file: string, value: string | object) => {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put('package.json', { private: true, type: 'module' });
  await put('tsconfig.knip.json', { compilerOptions: {} });
  await mkdir(join(root, 'packages'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'));
  await put(
    'scripts/build/workspace-sources.mjs',
    `export const repository = ${JSON.stringify(root)};`,
  );
  for (const file of ['check-production-reachability.mjs', 'production-graph.mjs'])
    await put('scripts/validation/' + file, await readFile('scripts/validation/' + file, 'utf8'));

  const bootstrap = 'apps/web/src/app/desktop-entry.ts';
  const panel = 'apps/web/src/features/performance/performance-panel.ts';
  const metrics = 'apps/web/src/features/performance/performance-metrics.ts';
  const native = 'apps/desktop/src/main/workspace-client-entry.ts';
  const bootstrapSource = `
    import './main';
    declare const __MOOR_DEV_PERFORMANCE__: boolean;
    if (typeof __MOOR_DEV_PERFORMANCE__ !== 'undefined' && __MOOR_DEV_PERFORMANCE__) {
      void import('../features/performance/performance-panel').then(({ installPerformancePanel }) => installPerformancePanel());
    }
  `;
  const panelSource = `import { score } from './performance-metrics';
    export function installPerformancePanel() { console.log(score); }`;
  await put(bootstrap, bootstrapSource);
  await put('apps/web/src/app/main.ts', 'console.log("synthetic production entry");');
  await put(panel, panelSource);
  await put(metrics, 'export const score = 42; export type Score = number;');
  await put(
    native,
    'export const DesktopWorkspaceClient = 1, accountManagementPlan = 2, validateAccountManagementResult = 3;',
  );
  const directory = join(root, 'dist/validation/production-graphs');
  const nativeResult = await build({
    absWorkingDir: root,
    entryPoints: [native],
    outfile: 'dist/native.mjs',
    bundle: true,
    format: 'esm',
    metafile: true,
  });
  const nativeGraph = await recordEsbuildGraph('client', nativeResult.metafile!, {
    directory,
    root,
  });
  assert(nativeGraph);
  for (const name of requiredProductionGraphs)
    if (name !== 'desktop-renderer')
      await put('dist/validation/production-graphs/' + name + '.json', { ...nativeGraph, name });
  const compile = async (development = false, entry = bootstrap) => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: 'dist/renderer.mjs',
      bundle: true,
      format: 'esm',
      minifySyntax: true,
      metafile: true,
      define: { __MOOR_DEV_PERFORMANCE__: JSON.stringify(development) },
    });
    await recordEsbuildGraph('desktop-renderer', result.metafile!, { directory, root });
  };
  const analyze = (status: number) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/validation/check-production-reachability.mjs', '--report'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, status, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };

  await compile();
  const production = analyze(0);
  assert.deepEqual(production.developmentOnly, [metrics, panel]);
  assert(production.linkage.includes(bootstrap));

  await t.test(
    'test-only references cannot exempt another file in the development directory',
    async () => {
      const unused = 'apps/web/src/features/performance/unreviewed.ts';
      await put(unused, 'export const unused = 1;');
      await put(
        'tests/unreviewed.test.ts',
        `import { unused } from '../${unused}'; console.log(unused);`,
      );
      assert.deepEqual(analyze(1).unreferenced, [unused]);
      await rm(join(root, unused));
    },
  );

  await t.test('a type import cannot replace the development runtime consumer', async () => {
    await put(
      panel,
      `import type { Score } from './performance-metrics'; export const score: Score = 42;`,
    );
    assert.deepEqual(analyze(1).unreferenced, [metrics]);
    await put(panel, panelSource);
  });

  await t.test(
    'an incorrect production compile flag exposes and rejects both implementations',
    async () => {
      await compile(true);
      const leaked = analyze(1);
      for (const file of [metrics, panel])
        assert(
          leaked.errors.includes(
            'Development-only implementation entered a production build: ' + file,
          ),
        );
    },
  );

  await t.test(
    'removing the guarded import or actual bootstrap consumer removes the exception',
    async () => {
      await put(bootstrap, "import './main';");
      await compile();
      assert.deepEqual(analyze(1).unreferenced, [metrics, panel]);
      await put(bootstrap, bootstrapSource);
      await compile(false, 'apps/web/src/app/main.ts');
      assert.deepEqual(analyze(1).unreferenced, [bootstrap, metrics, panel]);
    },
  );
});

test('production graph records emitted code separately from tree-shaken imports and verifies copied native assets', async (t) => {
  assert.equal(
    await recordEsbuildGraph('host', {
      inputs: {},
      outputs: { '/synthetic-temporary-build/bridge.mjs': {} },
    }),
    undefined,
    'temporary builds cannot publish the canonical production graph',
  );
  const root = await mkdtemp(join(tmpdir(), 'moor-production-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'graphs'),
    source = 'apps/fixture/src';
  await mkdir(join(root, source), { recursive: true });
  await writeFile(
    join(root, source, 'main.ts'),
    "import { used } from './barrel'; console.log(used);",
  );
  await writeFile(
    join(root, source, 'barrel.ts'),
    "export { used } from './used'; export { unused } from './unused';",
  );
  await writeFile(join(root, source, 'used.ts'), 'export const used = 1;');
  await writeFile(join(root, source, 'unused.ts'), 'export const unused = 2;');
  const result = await build({
    absWorkingDir: root,
    entryPoints: [source + '/main.ts'],
    outfile: 'out.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    metafile: true,
  });
  const graph = await recordEsbuildGraph('host', result.metafile!, { directory, root });
  assert(graph);
  assert(Object.hasOwn(graph.sources, source + '/unused.ts'));
  assert(!graph.emitted.includes(source + '/unused.ts'));
  assert(graph.emitted.includes(source + '/main.ts'));
  assert.deepEqual(graph.entries, [source + '/main.ts']);
  const plugin = productionGraphPlugin('desktop-main', {
    root,
    directory,
    copiedSources: { 'entry.cjs': source + '/used.ts' },
  });
  const context = { getModuleIds: () => [join(root, source, 'main.ts')] };
  const bundle: any = {
    'main.cjs': {
      type: 'chunk',
      isEntry: true,
      facadeModuleId: join(root, source, 'main.ts'),
      exports: [],
      code: 'synthetic production code',
      modules: { [join(root, source, 'main.ts')]: { renderedLength: 50 } },
    },
    'entry.cjs': { type: 'asset', source: 'incorrect bytes' },
  };
  await assert.rejects(
    plugin.writeBundle.call(context, { dir: root }, bundle),
    /missing or changed/,
  );
  bundle['entry.cjs'].source = await readFile(join(root, source, 'used.ts'));
  await plugin.writeBundle.call(context, { dir: root }, bundle);
  const copied = JSON.parse(await readFile(join(directory, 'desktop-main.json'), 'utf8'));
  assert(copied.emitted.includes(source + '/used.ts'));
});
