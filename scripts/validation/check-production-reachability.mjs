import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { repository } from '../build/workspace-sources.mjs';
import { productionGraphDirectory, requiredProductionGraphs } from './production-graph.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const retired = [
  'packages/e2ee/',
  'packages/host/src/transport/encrypted-host.ts',
  'packages/host/src/commands/encrypted-host-command.ts',
  'packages/host/src/commands/product-catalog.ts',
  'packages/host/src/sessions/roles.ts',
  'packages/host/src/sessions/preview.ts',
  'packages/host/src/sessions/tasks.ts',
  'packages/host/src/integrations/preview/',
  'packages/host/src/integrations/task-mcp.ts',
  'packages/host/src/integrations/mcp-settings.ts',
  'packages/gateway/src/encrypted-bridge.ts',
  'packages/gateway/src/encrypted-ingress.ts',
  'packages/gateway/src/trust-publications.ts',
  'apps/cli/src/encrypted-client.ts',
  'apps/cli/src/security/',
  'apps/web/src/app/secure-app.tsx',
  'apps/desktop/src/main/desktop-client.ts',
  'apps/desktop/src/main/preview-renderer.cjs',
  'apps/desktop/src/main/mcp-settings.cjs',
];
async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sources(file)));
    else if (/\.(?:ts|tsx|js|cjs|mjs)$/.test(file) && !file.endsWith('.d.ts')) result.push(file);
  }
  return result;
}
function hasRuntime(source, file) {
  if (!/\.tsx?$/.test(file)) return true;
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
    },
  }).outputText;
  return output.replace(/export\s*\{\s*\}\s*;?/g, '').trim() !== '';
}
function onlyModuleLinks(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return ast.statements.every(
    (node) =>
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEmptyStatement(node),
  );
}
function typeImports(source, file, includeValues) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return ast.statements.flatMap((node) => {
    if (
      !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
      !node.moduleSpecifier ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      return [];
    const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
    const onlyTypes = ts.isImportDeclaration(node) ? clause?.isTypeOnly : node.isTypeOnly;
    const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : clause;
    const namedTypes =
      bindings &&
      'elements' in bindings &&
      bindings.elements.length > 0 &&
      bindings.elements.every((item) => item.isTypeOnly) &&
      !(ts.isImportDeclaration(node) && clause?.name);
    return includeValues || onlyTypes || namedTypes ? [node.moduleSpecifier.text] : [];
  });
}

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const errors = [],
  loaded = new Set(),
  emitted = new Set();
for (const name of requiredProductionGraphs) {
  let graph;
  try {
    graph = JSON.parse(await readFile(join(productionGraphDirectory, name + '.json'), 'utf8'));
  } catch {
    errors.push(`Missing production graph ${name}; run pnpm build first`);
    continue;
  }
  if (graph.version !== 1 || graph.name !== name || !graph.entries.length) {
    errors.push(`Invalid production graph ${name}`);
    continue;
  }
  for (const [file, expected] of Object.entries(graph.sources)) {
    const bytes = await readFile(resolve(repository, file)).catch(() => undefined);
    if (!bytes || digest(bytes) !== expected) errors.push(`Stale ${name} input: ${file}`);
    loaded.add(file);
  }
  for (const [file, artifact] of Object.entries(graph.artifacts)) {
    const bytes = await readFile(resolve(repository, file)).catch(() => undefined);
    if (!bytes || digest(bytes) !== artifact.sha256)
      errors.push(`Missing or changed ${name} artifact: ${file}`);
  }
  if (name === 'client') {
    const native = Object.values(graph.artifacts).find(
      (artifact) => artifact.entry === 'apps/desktop/src/main/workspace-client-entry.ts',
    );
    const expected = [
      'DesktopWorkspaceClient',
      'accountManagementPlan',
      'validateAccountManagementResult',
    ];
    if (JSON.stringify(native?.exports?.slice().sort()) !== JSON.stringify(expected))
      errors.push(
        'Native workspace bundle exports differ from the three reviewed dynamic entry points',
      );
  }
  for (const file of graph.emitted) emitted.add(file);
}
const candidates = [];
for (const group of ['apps', 'packages'])
  for (const entry of await readdir(join(repository, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    candidates.push(
      ...(await sources(join(repository, group, entry.name, 'src')).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })),
    );
  }
const configFile = ts.readConfigFile(join(repository, 'tsconfig.knip.json'), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repository).options;
const typeOnly = new Set(),
  visited = new Set();
async function followTypes(file, includeValues) {
  const key = file + ':' + includeValues;
  if (visited.has(key)) return;
  visited.add(key);
  const source = await readFile(resolve(repository, file), 'utf8');
  for (const specifier of typeImports(source, file, includeValues)) {
    const resolved = ts.resolveModuleName(specifier, resolve(repository, file), options, ts.sys)
      .resolvedModule?.resolvedFileName;
    if (!resolved || resolved.includes('/node_modules/')) continue;
    const target = relative(repository, resolved);
    if (!/^(?:apps|packages)\/.+\/src\//.test(target)) continue;
    typeOnly.add(target);
    await followTypes(target, true);
  }
}
for (const file of emitted) if (/\.tsx?$/.test(file)) await followTypes(file, false);

const unreferenced = [],
  linkage = [],
  erased = [];
for (const absolute of candidates) {
  const file = relative(repository, absolute);
  if (retired.some((name) => (name.endsWith('/') ? file.startsWith(name) : name === file)))
    errors.push(`Retired production source is present: ${file}`);
  if (emitted.has(file)) continue;
  const source = await readFile(absolute, 'utf8');
  if (!hasRuntime(source, file)) {
    erased.push(file);
    continue;
  }
  if (loaded.has(file) && onlyModuleLinks(source, file)) {
    linkage.push(file);
    continue;
  }
  // Type consumers cannot keep an unused runtime implementation alive. Such a
  // module must separate its necessary types from its unreferenced executable code.
  unreferenced.push(file);
}
for (const file of loaded)
  if (retired.some((name) => (name.endsWith('/') ? file.startsWith(name) : name === file)))
    errors.push(`Retired source entered a production build: ${file}`);

const result = {
  emitted: [...emitted].sort(),
  typeOnly: [...typeOnly].filter((file) => !emitted.has(file)).sort(),
  linkage: linkage.sort(),
  erased: erased.sort(),
  unreferenced: unreferenced.sort(),
  errors,
};
if (reportOnly) console.log(JSON.stringify(result, null, 2));
else {
  for (const error of errors) console.error(error);
  for (const file of unreferenced) console.error(`No production consumer: ${file}`);
  if (!errors.length && !unreferenced.length)
    console.log(
      `Verified ${emitted.size} production sources and ${result.typeOnly.length} type dependencies.`,
    );
}
process.exitCode = errors.length || unreferenced.length ? 1 : 0;
