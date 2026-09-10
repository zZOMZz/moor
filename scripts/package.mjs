import { cp, mkdir, readFile, writeFile, realpath, readdir, stat, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { archiveRelay } from './relay-package.mjs';
const require = createRequire(import.meta.url),
  lody = resolve(process.env.LODY_SOURCE ?? '.runtime/lody');
const mode = process.argv[2] ?? 'relay';
async function packageDir(name, from = process.cwd()) {
  let entry;
  try {
    entry = require.resolve(name + '/package.json', { paths: [from] });
  } catch {
    entry = require.resolve(name, { paths: [from] });
  }
  let dir = dirname(await realpath(entry));
  while (true) {
    try {
      if (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate ' + name);
    dir = parent;
  }
}
async function copyPackage(name, dest, from) {
  await cp(await packageDir(name, from), join(dest, 'node_modules', name), {
    recursive: true,
    dereference: true,
    filter: (path) => !path.includes('/node_modules/.cache/'),
  });
}
async function copyRuntime(dest) {
  await mkdir(dest, { recursive: true });
  for (const file of ['bridge.mjs', 'server.mjs']) await cp('dist/' + file, join(dest, file));
  await cp('dist/public', join(dest, 'public'), { recursive: true });
  for (const pkg of ['ws', 'loro-crdt']) await copyPackage(pkg, dest);
}
async function licenses(dest) {
  await mkdir(join(dest, 'licenses'), { recursive: true });
  await cp(join(lody, 'LICENSE'), join(dest, 'licenses', 'Lody-LICENSE'));
  await cp('LICENSE', join(dest, 'licenses', 'Moor-LICENSE'));
  await cp('NOTICE', join(dest, 'licenses', 'Moor-NOTICE'));
  const manifests = [process.cwd(), join(lody, 'apps/cli')];
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
  const dest = resolve('release/macos-' + process.arch),
    app = join(dest, 'Moor.app');
  await mkdir(dest, { recursive: true });
  const electron = join(lody, 'apps/electron/node_modules/electron/dist/Electron.app');
  await rm(app, { recursive: true, force: true });
  await cp(electron, app, { recursive: true, verbatimSymlinks: true });
  const resources = join(app, 'Contents', 'Resources'),
    root = join(resources, 'app');
  await mkdir(root, { recursive: true });
  await cp('src/desktop', root, { recursive: true });
  await cp('src/web/public/icon-192.png', join(root, 'icon-192.png'));
  await cp('assets/brand/moor.icns', join(resources, 'moor.icns'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'moor', version: '0.2.0', private: true, main: 'main.cjs' }) + '\n',
  );
  await licenses(root);
  const runtime = join(root, 'runtime');
  await copyRuntime(runtime);
  await cp(join(lody, 'apps/electron/resources/cli'), join(runtime, 'cli'), {
    recursive: true,
    dereference: true,
  });
  // Preserve licenses for the unmodified OSS execution bundle and Electron runtime.
  await cp(join(lody, 'LICENSE'), join(root, 'LODY-LICENSE'));
  await cp(join(lody, 'NOTICE'), join(root, 'LODY-NOTICE')).catch(() => {});
  await writeFile(
    join(root, 'THIRD-PARTY.txt'),
    'Moor uses Lody (Apache-2.0), Electron and the dependencies shipped in runtime/node_modules and runtime/cli/node_modules. See licenses/ and the license files supplied alongside those packages.\n',
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
