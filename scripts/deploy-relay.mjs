import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  host: 'moor-vps',
  compose: '/opt/moor/compose.yaml',
  project: 'moor',
  state: '/opt/moor/.moor-deploy',
  sudo: 'yes',
};
const [mode, ...args] = process.argv.slice(2);
const help = `Usage: node scripts/deploy-relay.mjs <check|deploy> [options]
  --host HOST       SSH alias (default: moor-vps)
  --compose PATH    Existing VPS Compose file (default: /opt/moor/compose.yaml)
  --project NAME    Existing Compose project (default: moor)
  --state PATH      Private VPS releases/backups (default: /opt/moor/.moor-deploy)
  --sudo yes|no     Use sudo -n for Docker (default: yes)

check is read-only. deploy checks and packages the current working tree, then
updates only relay. It preserves the existing configuration and named data volume.
SSH host keys must already be trusted. No credentials are copied from this repo.`;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function run(command, argv, input, capture = false) {
  const result = spawnSync(command, argv, {
    cwd: root,
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result.stdout?.trim();
}

try {
  if (mode === '--help' || args.includes('--help')) {
    console.log(help);
    process.exit(0);
  }
  if (!['check', 'deploy'].includes(mode)) throw new Error(help);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !Object.hasOwn(options, key) || !args[i + 1])
      throw new Error(help);
    options[key] = args[i + 1];
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(options.host)) throw new Error('Invalid SSH host');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(options.project)) throw new Error('Invalid Compose project');
  for (const key of ['compose', 'state'])
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(options[key]) || options[key].split('/').includes('..'))
      throw new Error(`Invalid absolute ${key} path`);
  if (!['yes', 'no'].includes(options.sudo)) throw new Error('--sudo must be yes or no');
  const sshOptions = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];
  const script = await readFile(join(root, 'scripts/deploy-relay-remote.sh'), 'utf8');
  const remote = (action, extra = []) =>
    run(
      'ssh',
      [
        ...sshOptions,
        options.host,
        [
          'bash',
          '-s',
          '--',
          action,
          options.compose,
          options.project,
          options.state,
          options.sudo,
          ...extra,
        ]
          .map(quote)
          .join(' '),
      ],
      script,
    );
  remote('check');
  if (mode === 'deploy') {
    console.log('Validating and packaging the current working tree.');
    for (const task of ['check', 'test', 'build', 'format:check']) run('pnpm', [task]);
    run(process.execPath, ['scripts/package.mjs', 'relay']);
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    const staging = await mkdtemp(join(tmpdir(), 'moor-upload-'));
    let upload;
    try {
      // Snapshot the package so a concurrent local build cannot change the upload.
      const archive = join(staging, 'relay.tar.gz');
      await copyFile(join(root, `release/moor-relay-${version}.tar.gz`), archive);
      const digest = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex');
      upload = run(
        'ssh',
        [...sshOptions, options.host, 'umask 077; mktemp -d /tmp/moor-upload.XXXXXXXXXX'],
        undefined,
        true,
      );
      if (!/^\/tmp\/moor-upload\.[a-zA-Z0-9]+$/.test(upload))
        throw new Error('Invalid upload directory');
      run('scp', [...sshOptions, archive, `${options.host}:${upload}/relay.tar.gz`]);
      remote('deploy', [upload + '/relay.tar.gz', digest]);
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (/^\/tmp\/moor-upload\.[a-zA-Z0-9]+$/.test(upload ?? '')) {
        // Remove only our known upload file and empty directory, never operator data.
        try {
          run('ssh', [
            ...sshOptions,
            options.host,
            `rm -f -- ${quote(upload + '/relay.tar.gz')} && rmdir -- ${quote(upload)}`,
          ]);
        } catch {
          console.error(`Upload cleanup required on VPS: ${upload}`);
        }
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
