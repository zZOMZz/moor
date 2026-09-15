import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const root = process.cwd();
const allowedDependencies = new Map([
  ['@moor/protocol', new Set()],
  ['@moor/session', new Set(['@moor/protocol'])],
  ['@moor/e2ee', new Set(['@moor/protocol'])],
  ['@moor/client', new Set(['@moor/protocol', '@moor/session', '@moor/e2ee'])],
  ['@moor/gateway', new Set(['@moor/protocol', '@moor/e2ee'])],
  ['@moor/host', new Set(['@moor/protocol', '@moor/session', '@moor/e2ee'])],
  ['@moor/app-web', new Set(['@moor/protocol', '@moor/session', '@moor/client'])],
  ['@moor/app-desktop', new Set(['@moor/protocol', '@moor/client', '@moor/e2ee'])],
  ['@moor/app-cli', new Set(['@moor/protocol', '@moor/session', '@moor/client', '@moor/e2ee'])],
  [
    '@moor/app-host',
    new Set(['@moor/protocol', '@moor/session', '@moor/host', '@moor/gateway', '@moor/e2ee']),
  ],
  ['@moor/app-relay', new Set(['@moor/protocol', '@moor/gateway', '@moor/e2ee'])],
]);
const extensions = ['', '.ts', '.tsx', '.js', '.cjs', '.mjs'];
const sourceExtension = /\.(?:ts|tsx|js|cjs|mjs)$/;
const errors = [];
try {
  await readdir(join(root, 'src'));
  errors.push('legacy root src directory must be removed');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

async function directories(parent) {
  try {
    return (await readdir(join(root, parent), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, parent, entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (sourceExtension.test(entry.name)) result.push(path);
  }
  return result;
}

const workspaces = [];
for (const directory of [...(await directories('packages')), ...(await directories('apps'))]) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (!allowedDependencies.has(manifest.name))
    errors.push(
      `${relative(root, directory)} has unexpected package name ${String(manifest.name)}`,
    );
  workspaces.push({ directory, manifest, files: await files(directory) });
}
const names = new Set(workspaces.map((workspace) => workspace.manifest.name));
for (const name of allowedDependencies.keys())
  if (!names.has(name)) errors.push(`missing workspace package ${name}`);
for (const workspace of workspaces) {
  if (workspace.manifest.private !== true || workspace.manifest.version !== '0.2.0')
    errors.push(`${workspace.manifest.name} must use the private product version`);
  for (const [name, version] of Object.entries(workspace.manifest.dependencies ?? {}))
    if (name.startsWith('@moor/') && version !== 'workspace:*')
      errors.push(`${workspace.manifest.name} must declare ${name} with workspace:*`);
}
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (Object.keys(rootManifest.dependencies ?? {}).length)
  errors.push('root package must not own production dependencies');

const workspaceFor = (path) =>
  workspaces.find(
    (workspace) => path === workspace.directory || path.startsWith(workspace.directory + '/'),
  );
const imports = (body) =>
  [...body.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])([^'"]+)\1/g)].map(
    (match) => match[2],
  );

for (const workspace of workspaces) {
  const declared = {
    ...workspace.manifest.dependencies,
    ...workspace.manifest.optionalDependencies,
    ...workspace.manifest.peerDependencies,
    ...workspace.manifest.devDependencies,
  };
  const allowed = allowedDependencies.get(workspace.manifest.name) ?? new Set();
  for (const file of workspace.files) {
    for (const specifier of imports(await readFile(file, 'utf8'))) {
      if (!specifier.startsWith('.') && (specifier.includes('/src/') || specifier.endsWith('/src')))
        errors.push(`${relative(root, file)} imports private source path ${specifier}`);
      if (specifier.startsWith('@moor/')) {
        const targetName = [...allowedDependencies.keys()]
          .sort((a, b) => b.length - a.length)
          .find((name) => specifier === name || specifier.startsWith(name + '/'));
        if (!targetName) {
          errors.push(`${relative(root, file)} imports unknown Moor package ${specifier}`);
          continue;
        }
        if (targetName !== workspace.manifest.name && !(targetName in declared))
          errors.push(`${relative(root, file)} does not declare ${targetName}`);
        if (targetName !== workspace.manifest.name && !allowed.has(targetName))
          errors.push(
            `${workspace.manifest.name} cannot depend on ${targetName} (${relative(root, file)})`,
          );
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier);
      let target;
      for (const suffix of extensions) {
        const candidate = normalize(base + suffix);
        const owner = workspaceFor(candidate);
        if (owner?.files.includes(candidate)) {
          target = owner;
          break;
        }
        for (const index of ['index.ts', 'index.tsx', 'index.js']) {
          const indexed = join(candidate, index);
          const indexedOwner = workspaceFor(indexed);
          if (indexedOwner?.files.includes(indexed)) {
            target = indexedOwner;
            break;
          }
        }
        if (target) break;
      }
      if (target && target !== workspace)
        errors.push(
          `${relative(root, file)} crosses into ${target.manifest.name} with ${specifier}`,
        );
      if (!target && !base.startsWith(workspace.directory + '/'))
        errors.push(`${relative(root, file)} imports outside its workspace with ${specifier}`);
    }
  }
}

const packageGraph = new Map(
  workspaces
    .filter((workspace) => workspace.manifest.name?.startsWith('@moor/'))
    .map((workspace) => [
      workspace.manifest.name,
      Object.keys(workspace.manifest.dependencies ?? {}).filter((name) =>
        name.startsWith('@moor/'),
      ),
    ]),
);
function visit(name, path = []) {
  const index = path.indexOf(name);
  if (index >= 0) {
    errors.push(`Moor package dependency cycle: ${[...path.slice(index), name].join(' -> ')}`);
    return;
  }
  for (const dependency of packageGraph.get(name) ?? []) visit(dependency, [...path, name]);
}
for (const name of packageGraph.keys()) visit(name);

if (errors.length) {
  console.error(errors.sort().join('\n'));
  process.exit(1);
}
console.log(`Checked ${workspaces.length} workspace package boundary.`);
