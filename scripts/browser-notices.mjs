import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Include notices for every package actually incorporated in the browser bundle,
// including transitive dependencies such as the interaction/positioning helpers.
export async function browserNotices(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = dirname(resolve(input));
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) {
          packages.set(`${manifest.name}@${manifest.version}`, { directory, manifest });
          break;
        }
      } catch {}
      directory = dirname(directory);
    }
  }
  const sections = [
    'Moor browser dependency notices\nDependencies are bundled locally; no runtime CDN is required.',
  ];
  for (const [name, { directory, manifest }] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const notices = [];
    for (const file of await readdir(directory)) {
      if (!/^(license|notice|copying)(\.|$)/i.test(file)) continue;
      const path = join(directory, file);
      if ((await stat(path)).isFile()) notices.push(await readFile(path, 'utf8'));
    }
    sections.push(
      `${name}\nLicense: ${manifest.license || 'See upstream license'}\n${notices.join('\n\n')}`,
    );
  }
  return sections.join('\n\n----------------------------------------\n\n') + '\n';
}
