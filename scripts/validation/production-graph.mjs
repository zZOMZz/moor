import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { repository } from '../build/workspace-sources.mjs';

export const productionGraphDirectory = join(repository, 'dist/validation/production-graphs');
export const requiredProductionGraphs = Object.freeze([
  'relay',
  'host',
  'client',
  'web',
  'web-worker',
  'desktop-main',
  'desktop-preload',
  'desktop-renderer',
]);
const outputRoots = {
  relay: 'dist',
  host: 'dist',
  client: 'dist',
  web: 'dist/public',
  'web-worker': 'dist/public',
  'desktop-main': 'dist/desktop',
  'desktop-preload': 'dist/desktop/preload',
  'desktop-renderer': 'dist/desktop/runtime/public',
};

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function sourcePath(value, root) {
  if (value.startsWith('\0')) return;
  value = value.split('?')[0];
  const file = relative(root, isAbsolute(value) ? value : resolve(root, value));
  if (/^(?:apps|packages)\//.test(file) && !file.includes('/node_modules/')) return file;
}
async function writeGraph(name, inputs, emitted, entries, artifacts, directory, root) {
  if (!requiredProductionGraphs.includes(name)) throw Error(`Unknown production graph: ${name}`);
  const sources = {};
  const local = (file) => sourcePath(file, root);
  for (const file of [...new Set(inputs.map(local).filter(Boolean))].sort())
    sources[file] = digest(await readFile(resolve(root, file)));
  const graph = {
    version: 1,
    name,
    entries: [...new Set(entries.map(local).filter(Boolean))].sort(),
    sources,
    emitted: [...new Set(emitted.map(local).filter(Boolean))].sort(),
    artifacts,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name + '.json'), JSON.stringify(graph, null, 2) + '\n');
  return graph;
}

/** Record the actual production bundler result, never package-build wildcard entries. */
export async function recordEsbuildGraph(
  name,
  metafile,
  { directory = productionGraphDirectory, copiedSources = {}, root = repository } = {},
) {
  const emitted = [],
    entries = [],
    artifacts = {};
  // Temp-output integration builds must not replace the canonical release graph.
  if (
    root === repository &&
    directory === productionGraphDirectory &&
    Object.keys(metafile.outputs).some((file) =>
      ['relay', 'host', 'client'].includes(name)
        ? dirname(resolve(root, file)) !== resolve(root, outputRoots[name])
        : !resolve(root, file).startsWith(resolve(root, outputRoots[name]) + '/'),
    )
  )
    return;
  for (const [file, output] of Object.entries(metafile.outputs)) {
    if (output.entryPoint) entries.push(output.entryPoint);
    for (const [input, detail] of Object.entries(output.inputs))
      if (detail.bytesInOutput > 0) emitted.push(input);
    artifacts[relative(root, resolve(root, file))] = {
      exports: output.exports,
      entry: output.entryPoint ?? null,
      sha256: digest(await readFile(resolve(root, file))),
    };
  }
  for (const [output, source] of Object.entries(copiedSources)) {
    const [actual, original] = await Promise.all([
      readFile(resolve(root, output)),
      readFile(resolve(root, source)),
    ]);
    if (!actual.equals(original)) throw Error(`Copied production source differs: ${source}`);
    artifacts[relative(root, resolve(root, output))] = {
      entry: source,
      exports: [],
      sha256: digest(actual),
    };
    emitted.push(source);
    entries.push(source);
  }
  return writeGraph(
    name,
    [...Object.keys(metafile.inputs), ...Object.values(copiedSources)],
    emitted,
    entries,
    artifacts,
    directory,
    root,
  );
}

/** Rollup's rendered modules distinguish emitted code from tree-shaken imports. */
export function productionGraphPlugin(
  name,
  { directory = productionGraphDirectory, copiedSources = {}, root = repository } = {},
) {
  return {
    name: 'moor-production-graph-' + name,
    apply: 'build',
    async writeBundle(options, bundle) {
      if (!options.dir) throw Error('Production graph requires a Rollup output directory');
      if (
        root === repository &&
        directory === productionGraphDirectory &&
        resolve(options.dir) !== resolve(root, outputRoots[name])
      )
        return;
      const emitted = [],
        entries = [],
        artifacts = {};
      for (const [file, output] of Object.entries(bundle)) {
        artifacts[relative(root, resolve(options.dir, file))] = {
          exports: output.type === 'chunk' ? output.exports : [],
          entry: output.type === 'chunk' ? output.facadeModuleId : null,
          sha256: digest(output.type === 'chunk' ? output.code : output.source),
        };
        if (output.type !== 'chunk') continue;
        if (output.isEntry && output.facadeModuleId) entries.push(output.facadeModuleId);
        for (const [input, detail] of Object.entries(output.modules))
          if (detail.renderedLength > 0) emitted.push(input);
      }
      for (const [fileName, source] of Object.entries(copiedSources)) {
        const output = bundle[fileName];
        const original = await readFile(resolve(root, source));
        if (output?.type !== 'asset' || !Buffer.from(output.source).equals(original))
          throw Error(`Copied production source missing or changed: ${source}`);
        emitted.push(source);
        entries.push(source);
      }
      await writeGraph(
        name,
        [...this.getModuleIds(), ...Object.values(copiedSources)],
        emitted,
        entries,
        artifacts,
        directory,
        root,
      );
    },
  };
}
