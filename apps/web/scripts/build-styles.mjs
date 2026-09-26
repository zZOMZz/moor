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
      (
        await Promise.all(
          [
            'public/style.css',
            'src/features/sessions/workspace-navigation.css',
            'src/features/sessions/session-timeline.css',
            'src/features/sessions/composer-input.css',
            'src/styles/desktop-workspace.css',
            'src/features/files/project-content-ui.css',
          ].map((file) => readFile(resolve(appRoot, file), 'utf8')),
        )
      ).join('\n'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildWebStyles(resolve(appRoot, 'dist/style.css'));
