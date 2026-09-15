import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWebStyles(output) {
  const utilitiesPath = resolve(appRoot, 'src/styles/utilities.css');
  const utilities = await postcss([tailwind()]).process(await readFile(utilitiesPath, 'utf8'), {
    from: utilitiesPath,
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    utilities.css +
      '\n' +
      (await readFile(resolve(appRoot, 'public/style.css'), 'utf8')) +
      '\n' +
      (await readFile(resolve(appRoot, 'src/styles/secure.css'), 'utf8')),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildWebStyles(resolve(appRoot, 'dist/style.css'));
