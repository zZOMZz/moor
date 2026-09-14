import { spawnSync } from 'node:child_process';
import { cp, open, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire as nodeCreateRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = nodeCreateRequire(import.meta.url);
const agentRuntimePackages = [
  '@openai/codex',
  '@anthropic-ai/claude-agent-sdk',
  '@agentclientprotocol/claude-agent-acp',
];

export function isAgentRuntimePackage(name) {
  return agentRuntimePackages.some((prefix) => name === prefix || name.startsWith(prefix + '-'));
}

export function isAgentRuntimePackagePath(path) {
  const normalized = path.replaceAll('\\', '/');
  return agentRuntimePackages.some((prefix) => {
    const value = '/' + normalized,
      marker = '/node_modules/' + prefix;
    let index = -1;
    while ((index = value.indexOf(marker, index + 1)) !== -1) {
      const suffix = value.slice(index + marker.length);
      if (suffix === '' || suffix.startsWith('/') || suffix.startsWith('-')) return true;
    }
    return false;
  });
}

export async function packageDir(name, from = process.cwd()) {
  let entry;
  try {
    // A resolved manifest is authoritative even for npm aliases.
    entry = require.resolve(name + '/package.json', { paths: [from] });
    return dirname(await realpath(entry));
  } catch {
    entry = require.resolve(name, { paths: [from] });
  }
  let directory = dirname(await realpath(entry));
  while (true) {
    try {
      if (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name === name)
        return directory;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate ' + name);
    directory = parent;
  }
}

export async function copyPackage(name, dest, from) {
  await cp(await packageDir(name, from), join(dest, 'node_modules', name), {
    recursive: true,
    dereference: true,
    filter: (path) => !path.includes('/node_modules/.cache/'),
  });
}

async function machOArchitectures(path) {
  const file = await open(path, 'r');
  try {
    async function bytes(length, position = 0) {
      const value = Buffer.alloc(length),
        result = await file.read(value, 0, length, position);
      if (result.bytesRead !== length) throw new Error('truncated Mach-O header');
      return value;
    }
    const header = await bytes(8),
      magic = header.readUInt32BE(0),
      names = new Map([
        [0x01000007, 'x64'],
        [0x0100000c, 'arm64'],
      ]),
      architecture = (cpu) => names.get(cpu) ?? `cpu-0x${cpu.toString(16)}`;
    if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) {
      const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
      return new Set([architecture(little ? header.readUInt32LE(4) : header.readUInt32BE(4))]);
    }
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
      throw new Error('not a Mach-O executable');
    const little = magic === 0xbebafeca || magic === 0xbfbafeca,
      wide = magic === 0xcafebabf || magic === 0xbfbafeca,
      count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
    if (count === 0 || count > 32) throw new Error('invalid universal Mach-O architecture count');
    const length = wide ? 32 : 20,
      table = await bytes(count * length, 8),
      result = new Set();
    for (let index = 0; index < count; index++) {
      const offset = index * length,
        cpu = little ? table.readUInt32LE(offset) : table.readUInt32BE(offset);
      result.add(architecture(cpu));
    }
    return result;
  } finally {
    await file.close();
  }
}

export async function prepareElectronMacApp(from = process.cwd()) {
  const directory = await packageDir('electron', from),
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')),
    installer = join(directory, 'install.js'),
    app = join(directory, 'dist/Electron.app'),
    executable = join(app, 'Contents/MacOS/Electron');
  // Electron 44 publishes install.js as the install-electron binary instead of a
  // lifecycle script. Run that pinned installer explicitly before copying its app.
  const environment = { ...process.env };
  for (const name of [
    'ELECTRON_INSTALL_PLATFORM',
    'ELECTRON_INSTALL_ARCH',
    'ELECTRON_OVERRIDE_DIST_PATH',
    'electron_use_remote_checksums',
    'npm_config_electron_use_remote_checksums',
  ])
    delete environment[name];
  const installed = spawnSync(process.execPath, [installer], {
    stdio: 'inherit',
    env: {
      ...environment,
      ELECTRON_INSTALL_PLATFORM: 'darwin',
      ELECTRON_INSTALL_ARCH: process.arch,
      // Electron's installer otherwise rewrites an x64 request to arm64 when
      // Node runs under Rosetta and npm_config_arch is absent.
      npm_config_arch: process.arch,
    },
  });
  if (installed.error)
    throw new Error('Electron installer could not start: ' + installed.error.message, {
      cause: installed.error,
    });
  if (installed.status !== 0)
    throw new Error('Electron installer failed with exit status ' + String(installed.status));

  try {
    const [appInfo, executableInfo, version, platformPath] = await Promise.all([
      stat(app),
      stat(executable),
      readFile(join(directory, 'dist/version'), 'utf8'),
      readFile(join(directory, 'path.txt'), 'utf8'),
    ]);
    if (!appInfo.isDirectory() || !executableInfo.isFile()) throw new Error('invalid app layout');
    if (version.trim().replace(/^v/, '') !== manifest.version)
      throw new Error('installed version does not match package');
    if (platformPath !== 'Electron.app/Contents/MacOS/Electron')
      throw new Error('installed platform does not match macOS');
  } catch (error) {
    throw new Error(`Electron ${manifest.version} installer did not produce a valid Electron.app`, {
      cause: error,
    });
  }
  let architectures;
  try {
    architectures = await machOArchitectures(executable);
  } catch (error) {
    throw new Error(`Electron ${manifest.version} main executable is not a valid Mach-O file`, {
      cause: error,
    });
  }
  if (!architectures.has(process.arch))
    throw new Error(
      `Electron ${manifest.version} main executable does not contain required ${process.arch} architecture (found ${[...architectures].join(', ')})`,
    );
  return app;
}

// Copy published runtime files and their production dependency resolution without
// pulling unrelated workspace packages into the application.
async function copyDependencyTree(
  name,
  dest,
  from = process.cwd(),
  ancestors = new Set(),
  omit = () => false,
) {
  if (omit(name)) return;
  const directory = await packageDir(name, from);
  if (ancestors.has(directory)) throw new Error('Dependency cycle while packaging ' + name);
  const target = join(dest, 'node_modules', name);
  await cp(directory, target, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      path === directory ||
      !path
        .slice(directory.length + 1)
        .split('/')
        .includes('node_modules'),
  });
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const next = new Set(ancestors).add(directory);
  for (const dependency of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    if (omit(dependency)) continue;
    try {
      await packageDir(dependency, directory);
    } catch (error) {
      if (dependency in (manifest.optionalDependencies ?? {})) continue;
      throw error;
    }
    await copyDependencyTree(dependency, target, directory, next, omit);
  }
}

// The adapter uses CODEX_PATH when Moor selects the user's local Codex. Its
// @openai/codex dependency is only a bundled fallback and must not enter Moor.app.
export async function copyCodexAdapter(dest, from = process.cwd()) {
  await copyDependencyTree(
    '@agentclientprotocol/codex-acp',
    dest,
    from,
    new Set(),
    isAgentRuntimePackage,
  );
}
