import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { builtinModules } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import {
  architectureRole,
  inventoryMarkdown,
  moduleInventory,
  pureRoles,
} from './architecture-roles.mjs';

const root = process.cwd();
const allowedDependencies = new Map([
  ['@moor/protocol', new Set()],
  ['@moor/local-state', new Set(['@moor/protocol'])],
  ['@moor/session', new Set(['@moor/protocol'])],
  ['@moor/sync', new Set(['@moor/protocol', '@moor/session'])],
  ['@moor/client', new Set(['@moor/protocol', '@moor/session', '@moor/local-state'])],
  ['@moor/gateway', new Set(['@moor/protocol'])],
  ['@moor/host', new Set(['@moor/protocol', '@moor/session', '@moor/sync', '@moor/local-state'])],
  ['@moor/app-web', new Set(['@moor/protocol', '@moor/session', '@moor/client'])],
  ['@moor/app-desktop', new Set(['@moor/protocol', '@moor/client'])],
  [
    '@moor/app-cli',
    new Set(['@moor/protocol', '@moor/session', '@moor/client', '@moor/local-state']),
  ],
  [
    '@moor/app-host',
    new Set([
      '@moor/protocol',
      '@moor/session',
      '@moor/host',
      '@moor/gateway',
      '@moor/local-state',
    ]),
  ],
  ['@moor/app-relay', new Set(['@moor/protocol', '@moor/gateway', '@moor/local-state'])],
]);
const extensions = ['', '.ts', '.tsx', '.js', '.cjs', '.mjs'];
const sourceExtension = /\.(?:ts|tsx|js|cjs|mjs)$/;
const errors = [];
const nativeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
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
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const name of allowedDependencies.keys())
  if (!names.has(name)) errors.push(`missing workspace package ${name}`);
for (const workspace of workspaces) {
  if (workspace.manifest.private !== true || workspace.manifest.version !== rootManifest.version)
    errors.push(`${workspace.manifest.name} must use the private product version`);
  for (const [name, version] of Object.entries(workspace.manifest.dependencies ?? {}))
    if (name.startsWith('@moor/') && version !== 'workspace:*')
      errors.push(`${workspace.manifest.name} must declare ${name} with workspace:*`);
  for (const [entry, conditions] of Object.entries(workspace.manifest.exports ?? {})) {
    if (
      entry.includes('*') ||
      !conditions.types ||
      !conditions.import ||
      !conditions.types.startsWith('./src/') ||
      !conditions.import.startsWith('./dist/') ||
      conditions.types.includes('*') ||
      conditions.import.includes('*')
    )
      errors.push(
        `${workspace.manifest.name} must export exact canonical source/build modules: ${entry}`,
      );
    else if (!workspace.files.includes(resolve(workspace.directory, conditions.types)))
      errors.push(`${workspace.manifest.name} exports missing source module ${entry}`);
  }
}
if (Object.keys(rootManifest.dependencies ?? {}).length)
  errors.push('root package must not own production dependencies');

const workspaceFor = (path) =>
  workspaces.find(
    (workspace) => path === workspace.directory || path.startsWith(workspace.directory + '/'),
  );
function imports(body, file) {
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
  const specifiers = new Set();
  const role = architectureRole(root, file);
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      specifiers.add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      specifiers.add(node.arguments[0].text);
    if (pureRoles.has(role)) {
      if (ts.isCallExpression(node)) {
        const called = node.expression.getText(source);
        if (
          ['setTimeout', 'setInterval', 'fetch', 'Date.now', 'crypto.randomUUID'].includes(called)
        )
          errors.push(`${relative(root, file)} chooses a runtime capability in ${role}: ${called}`);
        if (
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
          !ts.isStringLiteralLike(node.arguments[0])
        )
          errors.push(`${relative(root, file)} has an unresolved dynamic business dependency`);
      }
      if (
        ts.isNewExpression(node) &&
        ['Date', 'WebSocket', 'IndexedStorage', 'DatabaseSync'].includes(
          node.expression.getText(source),
        ) &&
        (node.expression.getText(source) !== 'Date' || !node.arguments?.length)
      )
        errors.push(`${relative(root, file)} creates a runtime implementation in ${role}`);
    }
    if (
      (role === 'core' || role === 'ui') &&
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      /^moor[A-Z]/.test(node.argumentExpression.text)
    )
      errors.push(`${relative(root, file)} reads a platform bridge outside its adapter`);
    if ((role === 'core' || role === 'ui') && ts.isPropertyAccessExpression(node)) {
      if (
        /^moor[A-Z]/.test(node.name.text) &&
        ['window', 'globalThis'].includes(node.expression.getText(source))
      )
        errors.push(`${relative(root, file)} reads a platform bridge outside its adapter`);
      if (
        [
          'window.localStorage',
          'window.indexedDB',
          'navigator.clipboard',
          'location.protocol',
          'window.location.protocol',
        ].includes(node.getText(source))
      )
        errors.push(
          `${relative(root, file)} chooses a platform implementation outside its adapter`,
        );
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    )
      specifiers.add(node.argument.literal.text);
    if (
      file.includes('/packages/client/src/features/') ||
      file.includes('/packages/client/src/operations/')
    ) {
      if (ts.isStringLiteralLike(node) && node.text.startsWith('/api/'))
        errors.push(`${relative(root, file)} contains a physical API route in client business`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...specifiers];
}

for (const workspace of workspaces) {
  const declared = {
    ...workspace.manifest.dependencies,
    ...workspace.manifest.optionalDependencies,
    ...workspace.manifest.peerDependencies,
    ...workspace.manifest.devDependencies,
  };
  const allowed = allowedDependencies.get(workspace.manifest.name) ?? new Set();
  for (const file of workspace.files) {
    const productionSource = file.startsWith(join(workspace.directory, 'src') + '/');
    const role = architectureRole(root, file);
    if (productionSource && !role) errors.push(`${relative(root, file)} has no architecture role`);
    for (const specifier of imports(await readFile(file, 'utf8'), file)) {
      if (
        productionSource &&
        workspace.manifest.name === '@moor/protocol' &&
        (specifier.startsWith('node:') ||
          ['electron', 'react', 'react-dom'].some(
            (name) => specifier === name || specifier.startsWith(name + '/'),
          ))
      )
        errors.push(
          `${relative(root, file)} imports a runtime implementation into protocol: ${specifier}`,
        );
      if (
        productionSource &&
        ((['@moor/client', '@moor/host', '@moor/gateway'].includes(workspace.manifest.name) &&
          (file.includes('/src/operations/') || file.includes('/src/features/'))) ||
          (workspace.manifest.name === '@moor/sync' && file.includes('/src/document/'))) &&
        (specifier.startsWith('node:') ||
          specifier.includes('/adapters/') ||
          ['electron', 'react', 'react-dom', '@moor/local-state'].some(
            (name) => specifier === name || specifier.startsWith(name + '/'),
          ))
      )
        errors.push(
          `${relative(root, file)} imports a runtime adapter into business: ${specifier}`,
        );
      if (
        pureRoles.has(role) &&
        (nativeModules.has(specifier.replace(/^node:/, '')) ||
          ['ws', 'electron', 'react', 'react-dom', '@moor/local-state'].some(
            (name) => specifier === name || specifier.startsWith(name + '/'),
          ))
      )
        errors.push(
          `${relative(root, file)} imports an external runtime into ${role}: ${specifier}`,
        );
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
        const targetWorkspace = workspaces.find((value) => value.manifest.name === targetName);
        const entry = specifier === targetName ? '.' : '.' + specifier.slice(targetName.length);
        const conditions = targetWorkspace?.manifest.exports?.[entry];
        if (!conditions)
          errors.push(`${relative(root, file)} imports a non-public module ${specifier}`);
        else if (
          pureRoles.has(role) &&
          !pureRoles.has(
            architectureRole(root, resolve(targetWorkspace.directory, conditions.types)),
          )
        )
          errors.push(`${relative(root, file)} depends on an outer module via ${specifier}`);
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
      const sourceBase = /\.(?:js|jsx|mjs|cjs)$/.test(base)
        ? base.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
        : base;
      let target;
      let targetFile;
      for (const candidate of [
        base,
        ...extensions.map((suffix) => normalize(sourceBase + suffix)),
      ]) {
        const owner = workspaceFor(candidate);
        if (owner?.files.includes(candidate)) {
          target = owner;
          targetFile = candidate;
          break;
        }
        for (const index of ['index.ts', 'index.tsx', 'index.js']) {
          const indexed = join(candidate, index);
          const indexedOwner = workspaceFor(indexed);
          if (indexedOwner?.files.includes(indexed)) {
            target = indexedOwner;
            targetFile = indexed;
            break;
          }
        }
        if (target) break;
      }
      if (pureRoles.has(role) && targetFile && !pureRoles.has(architectureRole(root, targetFile)))
        errors.push(`${relative(root, file)} depends on an outer module via ${specifier}`);
      if (pureRoles.has(role) && !targetFile)
        errors.push(
          `${relative(root, file)} has an unresolved relative business dependency: ${specifier}`,
        );
      if (target && target !== workspace)
        errors.push(
          `${relative(root, file)} crosses into ${target.manifest.name} with ${specifier}`,
        );
      if (!target && !base.startsWith(workspace.directory + '/'))
        errors.push(`${relative(root, file)} imports outside its workspace with ${specifier}`);
    }
  }
}

const inventoryFile = join(root, 'docs/architecture-modules.md');
const inventory = await format(
  inventoryMarkdown(
    moduleInventory(
      root,
      workspaces.flatMap((workspace) => workspace.files),
    ),
  ),
  { ...(await resolveConfig(inventoryFile)), parser: 'markdown' },
);
if (process.argv.includes('--write-inventory')) await writeFile(inventoryFile, inventory);
else if ((await readFile(inventoryFile, 'utf8').catch(() => '')) !== inventory)
  errors.push('Architecture module inventory is stale; run pnpm architecture:inventory');

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
