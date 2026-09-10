import test from 'node:test';
import strict from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Exercise the real remote shell transaction with deterministic Docker/HTTPS
// responses. tar, checksum validation, private files, and traps run for real.
const docker = `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const root = process.env.FIXTURE;
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
fs.appendFileSync(root+'/events', JSON.stringify(args)+'\\n');
const active = fs.existsSync(root+'/active');
const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v));
if(args[0]==='compose') {
  if(args.includes('ps')) out(active ? 'new-container' : 'old-container');
  else if(args.includes('config') && args.includes('--format')) out({services:{relay:{volumes:[{target:'/data',type:'volume',source:'relay-data'}]}},volumes:{'relay-data':{name:scenario==='volume-mismatch'?'wrong-volume':'synthetic-data'}}});
  else if(args.includes('up')) {
    fs.writeFileSync(root+'/active','new');
    if(scenario==='up-failure') process.exit(1);
  }
} else if(args[0]==='inspect') {
  if(args.includes('-f')) {
    const template=args[args.indexOf('-f')+1];
    out(template.includes('Running')?'true':template.includes('Labels')?'moor':args.at(-1)==='new-container'?'sha256:new':'sha256:old');
  } else out([{Mounts:[{Destination:'/data',Type:'volume',Name:'synthetic-data'}],Config:{Env:['MOOR_ORIGIN=https://synthetic.invalid']}}]);
} else if(args[0]==='run') {
  if(scenario==='backup-failure') process.exit(1);
  const r=cp.spawnSync('tar',['-czf','-','-C',root+'/data','.']);
  process.stdout.write(r.stdout); process.exit(r.status);
} else if(args[0]==='build' && scenario==='build-failure') process.exit(1);
else if(args[0]==='exec' && scenario==='health-failure') process.exit(1);
else if(args[0]==='image') out('sha256:new');
`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }, scenario: string) {
  const root = await mkdtemp(join(tmpdir(), 'moor-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['bin', 'package/relay', 'data'])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'bin/docker'), docker, { mode: 0o700 });
  await writeFile(join(root, 'bin/curl'), '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n', {
    mode: 0o700,
  });
  await writeFile(join(root, 'bin/flock'), `#!/bin/sh\nexit ${scenario === 'locked' ? 1 : 0}\n`, {
    mode: 0o700,
  });
  await writeFile(join(root, 'compose.yaml'), 'synthetic compose; Docker is injected\n');
  await writeFile(join(root, 'package/relay/Dockerfile'), 'FROM scratch\n');
  await writeFile(join(root, 'data/accounts.sqlite'), 'synthetic database');
  const archive = join(root, 'relay.tar.gz');
  strict.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, 'package'), 'relay']).status, 0);
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const state = join(root, 'state');
  const run = (mode: string, checksum = digest) =>
    spawnSync(
      'bash',
      [
        resolve('scripts/deploy-relay-remote.sh'),
        mode,
        join(root, 'compose.yaml'),
        'moor',
        state,
        'no',
        archive,
        checksum,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: join(root, 'bin') + ':' + process.env.PATH,
          FIXTURE: root,
          SCENARIO: scenario,
        },
      },
    );
  const events = async (): Promise<string[][]> =>
    (await readFile(join(root, 'events'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { root, state, run, events };
}

test('deployment preflight is read-only and refuses mismatched volumes', async (t) => {
  const f = await fixture(t, 'success');
  const result = f.run('check');
  strict.equal(result.status, 0, result.stderr);
  await strict.rejects(readdir(f.state), { code: 'ENOENT' });
  strict.ok(
    (await f.events()).every((e) => e[0] === 'inspect' || e.includes('ps') || e.includes('config')),
  );
  const mismatch = await fixture(t, 'volume-mismatch');
  strict.notEqual(mismatch.run('deploy').status, 0);
  strict.ok(!(await mismatch.events()).some((e) => e.includes('stop') || e[0] === 'build'));
});

test('deployment builds before downtime, backs up data, and pins the new image', async (t) => {
  const f = await fixture(t, 'success');
  const result = f.run('deploy');
  strict.equal(result.status, 0, result.stderr);
  const events = await f.events();
  const build = events.findIndex((e) => e[0] === 'build');
  const stop = events.findIndex((e) => e.includes('stop'));
  const backup = events.findIndex((e) => e[0] === 'run');
  const up = events.findIndex((e) => e.includes('up'));
  strict.ok(build < stop && stop < backup && backup < up);
  strict.ok(events[backup].includes('type=volume,src=synthetic-data,dst=/data,readonly'));
  strict.ok(events[up].includes('--no-deps') && events[up].includes('--no-build'));
  const release = (await readdir(f.state)).find((n) => n.startsWith('release-'))!;
  const backupData = spawnSync(
    'tar',
    ['-xOzf', join(f.state, release, 'data.tar.gz'), './accounts.sqlite'],
    { encoding: 'utf8' },
  );
  strict.equal(backupData.stdout, 'synthetic database');
  strict.equal(await readFile(join(f.root, 'data/accounts.sqlite'), 'utf8'), 'synthetic database');
  strict.equal(
    JSON.parse(await readFile(join(f.state, release, 'previous.json'), 'utf8')).services.relay
      .image,
    'sha256:old',
  );
  strict.match(
    JSON.parse(await readFile(join(f.state, 'current.json'), 'utf8')).services.relay.image,
    /^moor-relay:deploy-/,
  );
  strict.deepEqual(await readdir(join(f.state, release, 'program')), ['relay']);
});

test('lock, checksum, and build failures never stop the existing relay', async (t) => {
  for (const scenario of ['locked', 'checksum', 'build-failure']) {
    const f = await fixture(t, scenario);
    const result = f.run('deploy', scenario === 'checksum' ? '0'.repeat(64) : undefined);
    strict.notEqual(result.status, 0);
    const events = await f.events().catch(() => []);
    strict.ok(!events.some((e) => e.includes('stop') || e.includes('up')));
  }
});

test('backup failure restarts the exact old container without activating new code', async (t) => {
  const f = await fixture(t, 'backup-failure');
  strict.notEqual(f.run('deploy').status, 0);
  const events = await f.events();
  strict.deepEqual(events.at(-1), ['start', 'old-container']);
  strict.ok(!events.some((e) => e.includes('up')));
  await strict.rejects(readFile(join(f.state, 'current.json')), { code: 'ENOENT' });
});

test('activation failure stops new code and preserves backup without unsafe data rollback', async (t) => {
  for (const scenario of ['up-failure', 'health-failure']) {
    const f = await fixture(t, scenario);
    const result = f.run('deploy');
    strict.notEqual(result.status, 0);
    strict.match(result.stderr, /Activation failed; relay stopped/);
    const events = await f.events();
    strict.ok(events.at(-1)?.includes('stop'));
    strict.ok(!events.some((e) => e[0] === 'start'));
    strict.equal(events.filter((e) => e[0] === 'run').length, 1);
    const release = (await readdir(f.state)).find((n) => n.startsWith('release-'))!;
    strict.ok((await readFile(join(f.state, release, 'data.tar.gz'))).length > 0);
    await strict.rejects(readFile(join(f.state, 'current.json')), { code: 'ENOENT' });
  }
});
