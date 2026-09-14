import { cp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { archiveRelay } from './relay-package.mjs';
import {
  copyCodexAdapter,
  copyPackage,
  packageDir,
  prepareElectronMacApp,
} from './package-dependencies.mjs';
const mode = process.argv[2] ?? 'relay';
const desktopFiles = [
  'entry.cjs',
  'main.cjs',
  'preload.cjs',
  'web-preload.cjs',
  'secure-preload.cjs',
  'secure-client.cjs',
  'workspace-bridge.cjs',
  'project-registration.cjs',
  'retired-client-data.cjs',
  'secure-account.cjs',
  'client-window.cjs',
  'secure-input.cjs',
  'content-authority.cjs',
  'client-assets.cjs',
  'preview-settings.cjs',
  'preview-renderer.cjs',
  'notifications.cjs',
  'github-settings.cjs',
  'attachment-save.cjs',
  'skills-settings.cjs',
  'recovery.cjs',
  'agent-settings.cjs',
  'device-metadata.cjs',
  'mcp-settings.cjs',
  'google-auth.cjs',
  'page-loader.cjs',
  'settings.css',
  'settings.html',
  'settings.js',
];
async function copyRuntime(dest) {
  await mkdir(dest, { recursive: true });
  for (const file of [
    'bridge.mjs',
    'cli.mjs',
    'security.mjs',
    'desktop-client.mjs',
    'workspace-client.mjs',
    'server.mjs',
    'preview-renderer.cjs',
  ])
    await cp('dist/' + file, join(dest, file));
  await cp('dist/public', join(dest, 'public'), { recursive: true });
  for (const pkg of ['ws', 'loro-crdt']) await copyPackage(pkg, dest);
}
async function licenses(dest) {
  await mkdir(join(dest, 'licenses'), { recursive: true });
  await cp('LICENSE', join(dest, 'licenses', 'Moor-LICENSE'));
  await cp('NOTICE', join(dest, 'licenses', 'Moor-NOTICE'));
  await cp('dist/THIRD_PARTY_NOTICES.txt', join(dest, 'licenses', 'BUNDLED-NOTICES.txt'));
  const manifests = [process.cwd()];
  for (const from of manifests) {
    const manifest = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      let dir;
      try {
        dir = await packageDir(name, from);
      } catch {
        continue;
      }
      for (const file of await readdir(dir)) {
        if (!/^(license|notice|copying)(\.|$)/i.test(file)) continue;
        const source = join(dir, file);
        if ((await stat(source)).isFile())
          await cp(source, join(dest, 'licenses', name.replaceAll('/', '-') + '-' + file));
      }
    }
  }
}
if (mode === 'relay') {
  const dest = resolve('release/relay');
  await mkdir(dest, { recursive: true });
  await cp('dist/server.mjs', join(dest, 'server.mjs'));
  await cp('dist/public', join(dest, 'public'), { recursive: true });
  await copyPackage('ws', dest);
  await writeFile(
    join(dest, 'package.json'),
    JSON.stringify(
      {
        name: 'moor-relay',
        version: '0.2.0',
        private: true,
        type: 'module',
        engines: { node: '>=24' },
        scripts: { start: 'node server.mjs' },
      },
      null,
      2,
    ) + '\n',
  );
  await licenses(dest);
  await cp('deploy/Dockerfile', join(dest, 'Dockerfile'));
  await cp('deploy/.dockerignore', join(dest, '.dockerignore'));
  await writeFile(
    join(dest, 'README.txt'),
    'Run with Node 24+: MOOR_PUBLIC_DIR=./public MOOR_DATA_DIR=./data node server.mjs\nSee https://github.com/zZOMZz/moor#readme for HTTPS, initial setup and migration.\n',
  );
  archiveRelay(dest, 'release/moor-relay-0.2.0.tar.gz');
  console.log(dest);
} else if (mode === 'mac') {
  if (process.platform !== 'darwin') throw new Error('macOS packaging must run on macOS');
  const dest = resolve(process.env.MOOR_RELEASE_DIR ?? 'release', 'macos-' + process.arch),
    app = join(dest, 'Moor.app');
  await mkdir(dest, { recursive: true });
  const electron = await prepareElectronMacApp();
  await rm(app, { recursive: true, force: true });
  await cp(electron, app, { recursive: true, verbatimSymlinks: true });
  const resources = join(app, 'Contents', 'Resources'),
    root = join(resources, 'app');
  await mkdir(root, { recursive: true });
  for (const file of desktopFiles) await cp(join('src/desktop', file), join(root, file));
  await cp('src/web/public/icon-192.png', join(root, 'icon-192.png'));
  await cp('src/web/public/moor-logo.png', join(root, 'moor-logo.png'));
  await cp('assets/brand/moor.icns', join(resources, 'moor.icns'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'moor', version: '0.2.0', private: true, main: 'entry.cjs' }) + '\n',
  );
  await licenses(root);
  const runtime = join(root, 'runtime');
  await copyRuntime(runtime);
  await copyCodexAdapter(runtime);
  await writeFile(
    join(root, 'THIRD-PARTY.txt'),
    "Moor includes Electron and the pinned Codex ACP adapter. Codex itself is supplied by the user's local installation. See licenses/ and the license files alongside runtime/node_modules packages.\n",
  );
  const plist = join(app, 'Contents', 'Info.plist');
  let xml = await readFile(plist, 'utf8');
  for (const [key, value] of Object.entries({
    CFBundleIconFile: 'moor.icns',
    CFBundleDisplayName: 'Moor',
    CFBundleName: 'Moor',
    CFBundleIdentifier: 'io.github.zzomzz.moor',
    CFBundleShortVersionString: '0.2.0',
    CFBundleVersion: '2',
  })) {
    const re = new RegExp('(<key>' + key + '</key>\\s*<string>)[^<]*(</string>)');
    xml = xml.replace(re, (_, start, end) => start + value + end);
  }
  await writeFile(plist, xml);
  const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], {
    stdio: 'inherit',
  });
  if (signed.status !== 0) throw new Error('Ad-hoc signing failed');
  const zipped = spawnSync(
    'ditto',
    ['-c', '-k', '--keepParent', app, join(dest, 'Moor-0.2.0-' + process.arch + '.zip')],
    { stdio: 'inherit' },
  );
  if (zipped.status !== 0) throw new Error('Packaging failed');
  console.log(app);
} else throw new Error('Choose relay or mac');
