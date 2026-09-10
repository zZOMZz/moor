import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

// release/relay may also contain an operator's live database. Never archive its
// whole directory, and never delete that data while rebuilding the application.
const files = [
  'server.mjs',
  'package.json',
  'public',
  'node_modules/ws',
  'licenses',
  'README.txt',
  'Dockerfile',
  '.dockerignore',
];
export function archiveRelay(directory, archive) {
  const source = resolve(directory);
  const result = spawnSync(
    'tar',
    [
      '-czf',
      resolve(archive),
      '-C',
      dirname(source),
      ...files.map((file) => basename(source) + '/' + file),
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Relay archive failed');
}
