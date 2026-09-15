import test from 'node:test';
import strict from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  copyCodexAdapter,
  isAgentRuntimePackagePath,
  packageDir,
  prepareElectronMacApp,
  workspaceManifestDirectories,
} from '../../scripts/release/package-dependencies.mjs';
import { archiveRelay, resetRelayProgramTrees } from '../../scripts/release/relay-package.mjs';

test('license discovery includes the root and every application and public package manifest', async () => {
  const directories = await workspaceManifestDirectories();
  const names = await Promise.all(
    directories.map(async (directory) => {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      return manifest.name;
    }),
  );
  strict.deepEqual(names.sort(), [
    '@moor/app-cli',
    '@moor/app-desktop',
    '@moor/app-host',
    '@moor/app-relay',
    '@moor/app-web',
    '@moor/client',
    '@moor/e2ee',
    '@moor/gateway',
    '@moor/host',
    '@moor/protocol',
    '@moor/session',
    'moor',
  ]);
});

test('relay rebuild resets only generated program trees and preserves operator data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-relay-reset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of [
    'public/stale.js',
    'node_modules/ws/stale.js',
    'licenses/stale.txt',
    'data/accounts.sqlite',
    'node_modules/operator/private.txt',
  ]) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), file);
  }
  await resetRelayProgramTrees(directory);
  for (const file of ['public/stale.js', 'node_modules/ws/stale.js', 'licenses/stale.txt'])
    await strict.rejects(readFile(join(directory, file)), { code: 'ENOENT' });
  for (const file of ['data/accounts.sqlite', 'node_modules/operator/private.txt'])
    strict.equal(await readFile(join(directory, file), 'utf8'), file);
});

test('pinned Electron uses its explicit installer instead of a lifecycle script', async () => {
  const manifest = JSON.parse(
    await readFile(join(await packageDir('electron'), 'package.json'), 'utf8'),
  );
  strict.equal(manifest.version, '44.3.0');
  strict.equal(manifest.scripts, undefined);
  strict.equal(manifest.bin?.['install-electron'], 'install.js');
});

test('macOS packaging prepares and validates Electron.app after a fresh install', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-electron-package-')),
    electron = join(directory, 'node_modules/electron'),
    captured = join(electron, 'installer-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(electron, { recursive: true });
  await writeFile(
    join(electron, 'package.json'),
    JSON.stringify({ name: 'electron', version: '44.3.0' }),
  );
  await writeFile(
    join(electron, 'install.js'),
    `const fs = require('node:fs');
const path = require('node:path');
const executable = path.join(__dirname, 'dist/Electron.app/Contents/MacOS/Electron');
const header = Buffer.alloc(32);
header.writeUInt32BE(0xcffaedfe, 0);
header.writeUInt32LE(process.env.ELECTRON_INSTALL_ARCH === 'arm64' ? 0x0100000c : 0x01000007, 4);
header.writeUInt32LE(2, 12);
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(executable, header);
fs.writeFileSync(path.join(__dirname, 'dist/version'), 'v44.3.0');
fs.writeFileSync(path.join(__dirname, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
fs.writeFileSync(path.join(__dirname, 'installer-environment.json'), JSON.stringify({
  platform: process.env.ELECTRON_INSTALL_PLATFORM,
  arch: process.env.ELECTRON_INSTALL_ARCH,
  npmArch: process.env.npm_config_arch,
  overrideDist: 'ELECTRON_OVERRIDE_DIST_PATH' in process.env,
  remoteChecksums: 'electron_use_remote_checksums' in process.env,
  npmRemoteChecksums: 'npm_config_electron_use_remote_checksums' in process.env,
}));
`,
  );

  const sanitized = [
      'ELECTRON_OVERRIDE_DIST_PATH',
      'electron_use_remote_checksums',
      'npm_config_electron_use_remote_checksums',
      'npm_config_arch',
    ],
    previous = sanitized.map((name) => [name, process.env[name]] as const);
  for (const name of sanitized) process.env[name] = '/synthetic/untrusted-override';
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const app = await prepareElectronMacApp(directory);
  strict.equal(app, join(await realpath(electron), 'dist/Electron.app'));
  strict.equal((await readFile(join(app, 'Contents/MacOS/Electron'))).length, 32);
  strict.deepEqual(JSON.parse(await readFile(captured, 'utf8')), {
    platform: 'darwin',
    arch: process.arch,
    npmArch: process.arch,
    overrideDist: false,
    remoteChecksums: false,
    npmRemoteChecksums: false,
  });
});

test('macOS packaging rejects an Electron installer that produces no app', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-electron-package-invalid-')),
    electron = join(directory, 'node_modules/electron');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(electron, { recursive: true });
  await writeFile(
    join(electron, 'package.json'),
    JSON.stringify({ name: 'electron', version: '44.3.0' }),
  );
  await writeFile(join(electron, 'install.js'), '// synthetic successful no-op');
  await strict.rejects(
    prepareElectronMacApp(directory),
    /Electron 44\.3\.0 installer did not produce a valid Electron\.app/,
  );
});

test('macOS packaging rejects an Electron cache for another architecture', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-electron-package-wrong-arch-')),
    electron = join(directory, 'node_modules/electron'),
    executable = join(electron, 'dist/Electron.app/Contents/MacOS/Electron'),
    otherArchitecture = process.arch === 'arm64' ? 'x64' : 'arm64',
    header = Buffer.alloc(32);
  t.after(() => rm(directory, { recursive: true, force: true }));
  header.writeUInt32BE(0xcffaedfe, 0);
  header.writeUInt32LE(otherArchitecture === 'arm64' ? 0x0100000c : 0x01000007, 4);
  header.writeUInt32LE(2, 12);
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(
    join(electron, 'package.json'),
    JSON.stringify({ name: 'electron', version: '44.3.0' }),
  );
  await writeFile(join(electron, 'install.js'), '// synthetic cache hit');
  await writeFile(executable, header);
  await writeFile(join(electron, 'dist/version'), 'v44.3.0');
  await writeFile(join(electron, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');

  await strict.rejects(
    prepareElectronMacApp(directory),
    new RegExp(
      `does not contain required ${process.arch} architecture \\(found ${otherArchitecture}\\)`,
    ),
  );
});

test('desktop dependencies keep the Codex adapter without a bundled Agent runtime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-desktop-dependencies-')),
    runtime = join(directory, 'runtime');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(runtime);
  await copyCodexAdapter(runtime);

  const adapter = join(runtime, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'),
    manifest = JSON.parse(
      await readFile(
        join(runtime, 'node_modules/@agentclientprotocol/codex-acp/package.json'),
        'utf8',
      ),
    ),
    entries = await readdir(runtime, { recursive: true });
  strict.equal(manifest.name, '@agentclientprotocol/codex-acp');
  strict.equal(
    entries.some((path) => isAgentRuntimePackagePath(path)),
    false,
  );
  strict.equal(
    entries.some((path) => path.includes('claude-agent-acp')),
    false,
  );

  const loaded = spawnSync(process.execPath, [adapter, '--version'], { encoding: 'utf8' });
  strict.equal(loaded.status, 0, loaded.stderr);
  strict.match(loaded.stdout, /@agentclientprotocol\/codex-acp 1\.11\.0/);

  const localRuntime = spawnSync(process.execPath, [adapter, 'cli', '-v'], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_PATH: process.execPath },
  });
  strict.equal(localRuntime.status, 0, localRuntime.stderr);
  strict.match(localRuntime.stdout, new RegExp(process.version.replaceAll('.', '\\.')));
});

test('repackaging includes program files and preserves operator data without distributing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-package-')),
    relay = join(directory, 'relay'),
    archive = join(directory, 'relay.tar.gz'),
    extracted = join(directory, 'extracted');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = {
    'server.mjs': 'console.log("synthetic program")',
    'package.json': '{"name":"synthetic-relay"}',
    'public/index.html': '<title>Synthetic app</title>',
    'public/icon-192.png': 'synthetic icon',
    'node_modules/ws/package.json': '{"name":"ws"}',
    'node_modules/ws/lib/websocket.js': '// synthetic runtime',
    'licenses/Moor-LICENSE': 'synthetic notice',
    'README.txt': 'synthetic instructions',
    Dockerfile: 'FROM scratch',
    '.dockerignore': '**',
  };
  const operatorFiles = [
    '.env',
    '.data/accounts.sqlite',
    'data/accounts.sqlite',
    'accounts.sqlite-wal',
    'setup-token',
    'host.log',
    'node_modules/unrelated/local-config',
  ];
  for (const [file, contents] of Object.entries(program)) {
    await mkdir(dirname(join(relay, file)), { recursive: true });
    await writeFile(join(relay, file), contents);
  }
  for (const file of operatorFiles) {
    await mkdir(dirname(join(relay, file)), { recursive: true });
    await writeFile(join(relay, file), 'synthetic operator data');
  }
  archiveRelay(relay, archive);
  await mkdir(extracted);
  const result = spawnSync('tar', ['-xzf', archive, '-C', extracted]);
  strict.equal(result.status, 0, result.stderr?.toString());
  for (const [file, contents] of Object.entries(program))
    strict.equal(await readFile(join(extracted, 'relay', file), 'utf8'), contents);
  for (const file of operatorFiles) {
    strict.equal(await readFile(join(relay, file), 'utf8'), 'synthetic operator data');
    await strict.rejects(readFile(join(extracted, 'relay', file)), { code: 'ENOENT' });
  }
});
