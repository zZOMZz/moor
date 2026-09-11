import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

async function files(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('验收构建不能包含符号链接。');
    if (entry.isDirectory()) found.push(...(await files(root, name)));
    else if (entry.isFile()) found.push(name);
    else throw new Error('验收构建包含不支持的文件。');
  }
  return found.sort();
}
async function fingerprint(root: string, destination?: string) {
  const hash = createHash('sha256');
  const names = await files(root);
  if (!names.includes('index.html')) throw new Error('尚无可用构建，请先运行 pnpm build。');
  for (const name of names) {
    const bytes = await readFile(join(root, name));
    hash.update(JSON.stringify([name, bytes.length])).update(bytes);
    if (destination) {
      const target = join(destination, name);
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600 });
    }
  }
  return hash.digest('hex');
}

// An immutable copy of the exact browser build, including uncommitted UI builds.
// This is a build identity, never a claim about a Git commit or full source tree.
export async function snapshotBuild(source: string, destination: string) {
  const from = resolve(source),
    to = resolve(destination);
  const sourceStat = await lstat(from);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory())
    throw new Error('验收构建必须是实际目录，不能使用符号链接。');
  if (to === from || to.startsWith(from + sep)) throw new Error('验收副本必须与构建目录分开。');
  await mkdir(to, { mode: 0o700 });
  const copied = await fingerprint(from, to);
  if (copied !== (await fingerprint(from)))
    throw new Error('构建正在变化，请构建完成后手动重新准备。');
  return 'sha256:' + copied;
}
