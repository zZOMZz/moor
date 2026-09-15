import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('rg', ['--files', '-g', '*.md'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
const missing = [];
for (const file of files) {
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {}
    if (!existsSync(resolve(dirname(file), decoded))) missing.push(`${file} -> ${target}`);
  }
}
if (missing.length) {
  console.error(missing.join('\n'));
  process.exit(1);
}
console.log(`Checked links in ${files.length} Markdown files.`);
