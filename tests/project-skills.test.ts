import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { AppError } from '../src/protocol';
import { SKILLS_LIMITS, skillSummarySchema, type SkillSource } from '../src/skills-protocol';
import { discoverSkills, type SkillDiscoveryOptions } from '../src/runtime/project-skills';
import { runDeviceSecurityCommand } from '../src/security/commands';

const version = 'sha256:' + '1'.repeat(64);
const source = (id = 'project_agents'): SkillSource => ({
  id,
  label: '项目 Skills',
  scope: 'project',
  convention: 'agents',
  version,
  status: 'available',
});
const skillBody = (description = '中文说明') =>
  `---\nname: example\ndescription: ${description}\n---\n\nFollow this instruction.\n`;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moor-skills-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root: string, path: string, body: string | Buffer = skillBody()) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}
const changed = (error: unknown) => error instanceof AppError && error.status === 409;

test('private vault, recovery code and capsule copies named SKILL.md never become readable Skills', async (t) => {
  const root = await fixture(t),
    dataFile = join(root, 'custom-vault.json'),
    recoveryCodeFile = join(root, 'custom-code.json'),
    outputFile = join(root, 'custom-backup.json'),
    skillsRoot = join(root, 'skills');
  await runDeviceSecurityCommand(
    {
      action: 'initialize',
      identity: {
        accountId: 'synthetic-owner',
        serverOrigin: 'https://relay.example.test',
        deviceId: 'synthetic-mbp',
        roles: ['host'],
      },
      recoveryCodeFile,
    },
    { dataFile },
  );
  await runDeviceSecurityCommand(
    { action: 'export-recovery', recoveryCodeFile, outputFile },
    { dataFile },
  );
  for (const [index, path] of [dataFile, recoveryCodeFile, outputFile].entries())
    await put(skillsRoot, `private-${index}/SKILL.md`, await readFile(path));
  await put(skillsRoot, 'safe/SKILL.md', 'Ordinary documentation of moor-private-endpoint-v1.');
  const result = await discoverSkills([{ source: source(), rootPath: skillsRoot }]);
  assert.deepEqual(
    result.skills.map((item) => item.path),
    ['safe/SKILL.md'],
  );
  assert.equal(result.documents.size, 1);
  assert.deepEqual(
    result.issues
      .filter((item) => item.reason === 'unreadable')
      .map((item) => item.path)
      .sort(),
    [0, 1, 2].map((index) => `private-${index}/SKILL.md`),
  );
});

test('Skills skip reserved security directories even when a source starts inside one', async (t) => {
  const root = await fixture(t);
  for (const name of ['.moor-security', '.MOOR-SECURITY'])
    await put(root, `${name}/nested/private/SKILL.md`, 'synthetic-private-body');
  const fromParent = await discoverSkills([{ source: source(), rootPath: root }]);
  assert.equal(fromParent.skills.length, 0);
  const inputs = ['.moor-security', '.MOOR-SECURITY'].flatMap((name, index) => [
    { source: source(`private-${index}`), rootPath: join(root, name) },
    { source: source(`nested-${index}`), rootPath: join(root, name, 'nested') },
  ]);
  const result = await discoverSkills(inputs);
  assert.equal(result.documents.size, 0);
  assert.ok(result.sources.every((item) => item.status === 'unavailable'));
  assert.ok(result.issues.every((item) => item.reason === 'unreadable'));
  assert.ok(!JSON.stringify(result).includes('synthetic-private-body'));
});

test('Skills preserve independent source identities, Unicode, and exact original bodies', async (t) => {
  const root = await fixture(t),
    a = join(root, 'project'),
    b = join(root, 'worktree');
  await put(a, '示例/SKILL.md');
  await put(b, '示例/SKILL.md', skillBody('worktree version'));
  const inputs = [
    { source: source('project'), rootPath: a },
    { source: source('worktree'), rootPath: b },
  ];
  const result = await discoverSkills(inputs);
  assert.equal(result.skills.length, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.skills[0]!.name, result.skills[1]!.name);
  assert.notEqual(result.skills[0]!.id, result.skills[1]!.id);
  assert.notEqual(result.skills[0]!.version, result.skills[1]!.version);
  for (const summary of result.skills) {
    skillSummarySchema.parse(summary);
    const text = result.documents.get(summary.id)!.text;
    assert.equal(summary.version, 'sha256:' + createHash('sha256').update(text).digest('hex'));
    assert.equal(summary.byteLength, Buffer.byteLength(text));
    assert.equal(summary.path, '示例/SKILL.md');
    assert.equal(JSON.stringify(summary).includes(root), false);
  }
  assert.deepEqual((await discoverSkills(inputs)).skills, result.skills);
});

test('Skills read only child SKILL.md entries, within four directory levels', async (t) => {
  const root = await fixture(t);
  await put(root, 'SKILL.md');
  await put(root, 'one/skill.md');
  await put(root, 'one/notes.md');
  await put(root, 'one/two/three/four/SKILL.md');
  await put(root, 'one/two/three/four/five/SKILL.md');
  const result = await discoverSkills([{ source: source(), rootPath: root }]);
  assert.deepEqual(
    result.skills.map((item) => item.path),
    ['one/two/three/four/SKILL.md'],
  );
  assert.equal(result.truncated, true);
  assert.ok(result.issues.some((issue) => issue.reason === 'limit'));
});

test('Skills missing roots are ordinary unavailable sources; symlink roots are never followed', async (t) => {
  const root = await fixture(t),
    actual = join(root, 'actual');
  await put(actual, 'x/SKILL.md');
  await symlink(actual, join(root, 'link'));
  const result = await discoverSkills([
    { source: source('missing'), rootPath: join(root, 'missing') },
    { source: source('link'), rootPath: join(root, 'link') },
    { source: source('link_child'), rootPath: join(root, 'link', 'x') },
  ]);
  assert.deepEqual(
    result.sources.map((item) => item.status),
    ['missing', 'unavailable', 'unavailable'],
  );
  assert.equal(result.skills.length, 0);
});

test('Skills skip symlink leaves, symlink directories, and FIFOs without reading them', async (t) => {
  const root = await fixture(t),
    sourceRoot = join(root, 'source'),
    outside = join(root, 'outside');
  await put(outside, 'foreign/SKILL.md', 'private content');
  await mkdir(join(sourceRoot, 'fifo'), { recursive: true });
  await mkdir(join(sourceRoot, 'leaf'), { recursive: true });
  await symlink(outside, join(sourceRoot, 'linked'));
  await symlink(join(outside, 'foreign/SKILL.md'), join(sourceRoot, 'leaf/SKILL.md'));
  execFileSync('/usr/bin/mkfifo', [join(sourceRoot, 'fifo/SKILL.md')]);
  const result = await discoverSkills([{ source: source(), rootPath: sourceRoot }]);
  assert.equal(result.skills.length, 0);
  assert.equal(result.issues.filter((issue) => issue.reason === 'unsupported-entry').length, 3);
  assert.equal(JSON.stringify(result).includes('private content'), false);
});

test('Skills reject invalid UTF-8/NUL and oversized files, preserve BOM and 64 KiB bytes', async (t) => {
  const root = await fixture(t);
  await put(root, 'invalid/SKILL.md', Buffer.from([0xc0, 0xaf]));
  await put(root, 'nul/SKILL.md', Buffer.from([97, 0, 98]));
  await put(root, 'large/SKILL.md', 'x'.repeat(SKILLS_LIMITS.fileBytes + 1));
  await put(root, 'maximum/SKILL.md', 'x'.repeat(SKILLS_LIMITS.fileBytes));
  await put(root, 'bom/SKILL.md', '\uFEFF' + skillBody());
  const result = await discoverSkills([{ source: source(), rootPath: root }]);
  assert.equal(result.skills.length, 2);
  assert.equal(result.issues.filter((issue) => issue.reason === 'invalid-text').length, 2);
  assert.equal(result.issues.filter((issue) => issue.reason === 'too-large').length, 1);
  const bom = result.skills.find((item) => item.path === 'bom/SKILL.md')!;
  assert.equal(bom.metadata, 'parsed');
  assert.equal(result.documents.get(bom.id)!.text.charCodeAt(0), 0xfeff);
});

test('Skills parse simple quoted and multiline metadata without evaluating dynamic syntax', async (t) => {
  const root = await fixture(t);
  const quoted =
    "---\nname: \"Quoted\"\ndescription: 'It''s plain text'\n---\n!`touch should-never-exist`\n[resource](https://invalid.example/secret)\n";
  await put(root, 'quoted/SKILL.md', quoted);
  await put(root, 'folded/SKILL.md', '---\ndescription: >-\n  First line\n  第二行\n---\n');
  await put(root, 'literal/SKILL.md', '---\ndescription: |\n  First line\n  Next line\n---\n');
  await put(root, 'alias/SKILL.md', '---\nname: *alias\ndescription: nope\n---\n');
  await put(root, 'tag/SKILL.md', '---\nname: !!js/function run()\n---\n');
  await put(root, 'duplicate/SKILL.md', '---\nname: first\nname: second\n---\n');
  await put(root, 'invalid/SKILL.md', '---\nname: "unterminated\n---\n');
  const result = await discoverSkills([{ source: source(), rootPath: root }]);
  const items = new Map(result.skills.map((item) => [item.path.split('/')[0], item]));
  assert.equal(items.get('quoted')!.description, "It's plain text");
  assert.equal(result.documents.get(items.get('quoted')!.id)!.text, quoted);
  assert.equal(items.get('folded')!.description, 'First line 第二行');
  assert.equal(items.get('literal')!.description, 'First line\nNext line');
  for (const name of ['alias', 'tag', 'duplicate', 'invalid']) {
    assert.equal(items.get(name)!.metadata, 'unparsed');
    assert.equal(items.get(name)!.name, name);
  }
});

test('Skills cap all sources together at 200 documents and 2000 streamed entries', async (t) => {
  const root = await fixture(t),
    items = join(root, 'items'),
    entries = join(root, 'entries');
  await Promise.all(Array.from({ length: 205 }, (_, index) => put(items, `s${index}/SKILL.md`)));
  const first = await discoverSkills([{ source: source(), rootPath: items }]);
  assert.equal(first.skills.length, 200);
  assert.equal(first.truncated, true);
  await mkdir(entries);
  await Promise.all(
    Array.from({ length: 2010 }, (_, index) => writeFile(join(entries, `file-${index}.txt`), '')),
  );
  let seen = 0;
  const second = await discoverSkills(
    [
      { source: source('one'), rootPath: entries },
      { source: source('two'), rootPath: items },
    ],
    {
      checkpoint(stage) {
        if (stage === 'entry-read') seen++;
      },
    },
  );
  assert.equal(seen, 2000);
  assert.equal(second.skills.length, 0);
  assert.equal(second.truncated, true);
});

test('Skills cap issues and do not expose invalid path characters', async (t) => {
  const root = await fixture(t);
  await Promise.all(
    Array.from({ length: 110 }, (_, index) => symlink('missing', join(root, `link-${index}`))),
  );
  await writeFile(join(root, 'secret:invalid'), '');
  const result = await discoverSkills([{ source: source(), rootPath: root }]);
  assert.equal(result.issues.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result.issues).includes('secret:invalid'), false);
});

for (const stage of [
  'source-checked',
  'directory-opened',
  'entry-read',
  'file-opened',
  'before-file-read',
  'after-file-read',
] as const) {
  test(`Skills refuse observable directory replacement at ${stage}`, async (t) => {
    const root = await fixture(t),
      current = join(root, 'source'),
      replacement = join(root, 'replacement');
    await put(current, 'example/SKILL.md', 'original');
    await put(replacement, 'example/SKILL.md', 'replacement');
    let swapped = false;
    await assert.rejects(
      discoverSkills([{ source: source(), rootPath: current }], {
        async checkpoint(at) {
          if (at !== stage || swapped) return;
          swapped = true;
          await rename(current, join(root, 'old'));
          await rename(replacement, current);
        },
      }),
      changed,
    );
    assert.equal(swapped, true);
  });
}

test('Skills refuse leaf replacement and byte mutation during reading', async (t) => {
  const root = await fixture(t);
  await put(root, 'example/SKILL.md', 'first');
  await assert.rejects(
    discoverSkills([{ source: source(), rootPath: root }], {
      async checkpoint(stage) {
        if (stage === 'file-opened') {
          await rename(join(root, 'example/SKILL.md'), join(root, 'example/old'));
          await put(root, 'example/SKILL.md', 'other');
        }
      },
    }),
    changed,
  );
  await assert.rejects(
    discoverSkills([{ source: source(), rootPath: root }], {
      async checkpoint(stage) {
        if (stage === 'after-file-read') await put(root, 'example/SKILL.md', 'edited');
      },
    }),
    changed,
  );
});

test('Skills propagate scope revocation after asynchronous checkpoints without returning bodies', async (t) => {
  const root = await fixture(t);
  await put(root, 'example/SKILL.md');
  for (const stage of ['source-checked', 'file-opened', 'after-file-read']) {
    let current = true;
    const options: SkillDiscoveryOptions = {
      assertCurrent() {
        if (!current) throw new AppError(403, '测试权限已撤销');
      },
      async checkpoint(at) {
        if (at === stage) current = false;
      },
    };
    await assert.rejects(
      discoverSkills([{ source: source(), rootPath: root }], options),
      /测试权限已撤销/,
    );
  }
});

test('Skills recheck earlier documents after later files finish reading', async (t) => {
  const root = await fixture(t);
  await put(root, 'one/nested/SKILL.md', 'first');
  await put(root, 'two/nested/SKILL.md', 'second');
  let earlier: string | undefined;
  await assert.rejects(
    discoverSkills([{ source: source(), rootPath: root }], {
      async checkpoint(stage, entry) {
        if (stage !== 'after-file-read') return;
        if (!earlier) earlier = entry.path;
        else await writeFile(join(root, earlier), 'changed earlier content');
      },
    }),
    changed,
  );
});
