import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  executeMacRelease,
  inspectMacApp,
  parseMacReleaseArgs,
  parseNotaryResult,
  planMacRelease,
  verifySigningFacts,
  writeReleaseReport,
} from '../scripts/mac-release.mjs';

const identity = 'Developer ID Application: Synthetic Private Name (AAAAAAAAAA)';
const profile = 'synthetic-private-profile';
const submissionId = '00000000-0000-4000-8000-000000000001';
const metadata = `Authority=${identity}\nTeamIdentifier=AAAAAAAAAA\nCodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+0 location=embedded\nTimestamp=Sep 12, 2026 at 10:00:00 AM\n`;
const appRoot = 'Contents/Resources/app';
const native = `${appRoot}/runtime/node_modules/synthetic/bin/tool`;
const addon = `${appRoot}/runtime/node_modules/synthetic/addon.node`;
const framework = 'Contents/Frameworks/Synthetic.framework';
const helper = 'Contents/Frameworks/Electron Helper.app';
const claude = `${appRoot}/runtime/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
const codex = `${appRoot}/runtime/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host`;
function thin(type = 2) {
  const result = Buffer.alloc(32);
  result.writeUInt32BE(0xcffaedfe);
  result.writeUInt32LE(type, 12);
  return result;
}
function fat() {
  const result = Buffer.alloc(112);
  result.writeUInt32BE(0xcafebabe);
  result.writeUInt32BE(2, 4);
  result.writeUInt32BE(48, 16);
  result.writeUInt32BE(32, 20);
  result.writeUInt32BE(80, 36);
  result.writeUInt32BE(32, 40);
  thin().copy(result, 48);
  thin().copy(result, 80);
  return result;
}
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moor-mac-release-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, 'Moor.app'),
    output = join(directory, 'output');
  async function put(path: string, contents: string | Buffer) {
    await mkdir(dirname(join(app, path)), { recursive: true });
    await writeFile(join(app, path), contents);
  }
  const files = {
    'Contents/Info.plist':
      '<plist><dict><key>CFBundleIdentifier</key><string>io.github.zzomzz.moor</string></dict></plist>',
    [`${appRoot}/package.json`]: '{"name":"moor","main":"entry.cjs"}',
    [`${appRoot}/entry.cjs`]: '// synthetic entry',
    [`${appRoot}/mcp-settings.cjs`]: '// synthetic private MCP IPC controller',
    [`${appRoot}/google-auth.cjs`]: '// synthetic Google desktop sign-in controller',
    [`${appRoot}/runtime/bridge.mjs`]: '// synthetic host',
    [`${appRoot}/runtime/cli.mjs`]: '// synthetic cli',
    [`${appRoot}/runtime/security.mjs`]: '// synthetic local device security CLI',
    [`${appRoot}/runtime/public/index.html`]: '<title>Synthetic</title>',
    [`${appRoot}/licenses/Moor-LICENSE`]: 'synthetic Moor license',
    [`${appRoot}/licenses/Moor-NOTICE`]: 'synthetic attribution',
    [`${appRoot}/licenses/BUNDLED-NOTICES.txt`]: 'synthetic third-party notices',
    [`${appRoot}/runtime/node_modules/synthetic/LICENSE`]: 'synthetic bundled license',
    'Contents/MacOS/Electron': thin(),
    [native]: fat(),
    [addon]: thin(8),
    [claude]: thin(),
    [codex]: thin(),
    [`${framework}/Versions/A/Synthetic`]: thin(6),
    [`${framework}/Versions/B/Synthetic`]: thin(6),
    [`${framework}/Versions/A/Resources/Info.plist`]: '<plist/>',
    [`${framework}/Versions/B/Resources/Info.plist`]: '<plist/>',
    [`${helper}/Contents/MacOS/Electron Helper`]: thin(),
    [`${helper}/Contents/Info.plist`]: '<plist/>',
  };
  for (const [path, contents] of Object.entries(files)) await put(path, contents);
  await symlink('A', join(app, framework, 'Versions/Current'));
  await symlink('Versions/Current/Synthetic', join(app, framework, 'Synthetic'));
  return {
    directory,
    app,
    output,
    put,
    files,
    config: { app, output, identity, keychainProfile: profile },
  };
}
type Call = { command: string; args: string[] };
function executor(
  calls: Call[],
  response?: (call: Call) => { status: number; stdout: string; stderr: string } | undefined,
) {
  return async (command: string, args: string[]) => {
    const call = { command, args: [...args] };
    calls.push(call);
    const override = response?.(call);
    if (override) return override;
    if (command.endsWith('/ditto')) await writeFile(args.at(-1)!, 'synthetic archive');
    return {
      status: 0,
      stdout:
        args[0] === 'notarytool'
          ? JSON.stringify({
              id: submissionId,
              status: 'Accepted',
              message: 'do not retain server text',
            })
          : '',
      stderr: args[0] === '--display' ? metadata : '',
    };
  };
}
const injected = {
  platform: 'darwin' as const,
  entitlementsDirectory: resolve('scripts/mac-entitlements'),
};

test('macOS release plan is read-only, credential-free and inventories native code inside out', async (t) => {
  const f = await fixture(t),
    before = await inspectMacApp(f.app);
  const plan = await planMacRelease(f.config),
    paths = plan.targets.map((target) => target.path);
  assert.equal(plan.executed, false);
  assert.equal(plan.sourceDigest, before.digest);
  assert.equal(paths.at(-1), '.');
  for (const path of [
    native,
    addon,
    claude,
    codex,
    framework,
    `${framework}/Versions/A`,
    `${framework}/Versions/B`,
    helper,
  ])
    assert.ok(paths.includes(path), path);
  assert.ok(
    paths.indexOf(`${framework}/Versions/A/Synthetic`) < paths.indexOf(`${framework}/Versions/A`),
  );
  assert.ok(paths.indexOf(`${framework}/Versions/B`) < paths.indexOf(framework));
  assert.ok(paths.indexOf(`${helper}/Contents/MacOS/Electron Helper`) < paths.indexOf(helper));
  assert.equal(plan.targets.find((target) => target.path === addon)?.entitlements, null);
  assert.equal(plan.targets.find((target) => target.path === claude)?.entitlements, 'claude');
  assert.equal(plan.targets.find((target) => target.path === codex)?.entitlements, 'agent-v8');
  assert.ok(!JSON.stringify(plan).includes(identity));
  assert.ok(!JSON.stringify(plan).includes(profile));
  assert.deepEqual(await readdir(f.directory), ['Moor.app']);
  assert.equal((await inspectMacApp(f.app)).digest, before.digest);
});

test('release CLI defaults to plan and refuses ad-hoc identities, secret parameters and incomplete options', () => {
  const args = [
    '--app',
    '/synthetic/Moor.app',
    '--output',
    '/synthetic/new',
    '--identity',
    identity,
    '--keychain-profile',
    profile,
  ];
  assert.equal(parseMacReleaseArgs([...args]).mode, 'plan');
  assert.equal(parseMacReleaseArgs(['execute', ...args]).mode, 'execute');
  for (const invalid of [
    '-',
    'Apple Development: Synthetic (AAAAAAAAAA)',
    'Developer ID Installer: Synthetic (AAAAAAAAAA)',
    'a'.repeat(40),
  ]) {
    const changed = [...args];
    changed[5] = invalid;
    assert.throws(() => parseMacReleaseArgs(changed), /Developer ID Application/);
  }
  for (const extra of [
    ['--password', 'synthetic-secret'],
    ['--apple-id', 'synthetic@example.test'],
    ['--identity', identity],
    ['--app'],
  ])
    assert.throws(() => parseMacReleaseArgs([...args, ...extra]));
});

test('release rejects operator data, unexpected files, external links and invalid Mach-O without creating output', async (t) => {
  for (const path of [
    'Contents/Resources/app/data/session.json',
    `${appRoot}/runtime/accounts.sqlite-wal`,
    `${appRoot}/runtime/node_modules/synthetic/.env`,
    `${appRoot}/runtime/node_modules/synthetic/local.keychain-db`,
    'Contents/Resources/arbitrary.txt',
  ]) {
    await t.test(path, async (child) => {
      const f = await fixture(child);
      await f.put(path, 'synthetic operator data');
      await assert.rejects(planMacRelease(f.config), /Operator data|Unexpected/);
      assert.deepEqual(await readdir(f.directory), ['Moor.app']);
      assert.equal(await readFile(join(f.app, path), 'utf8'), 'synthetic operator data');
    });
  }
  await t.test('external symlink', async (child) => {
    const f = await fixture(child);
    await writeFile(join(f.directory, 'private.txt'), 'synthetic private content');
    await symlink(f.directory, join(f.app, appRoot, 'runtime/node_modules/external'));
    await assert.rejects(planMacRelease(f.config), /External app symlink/);
  });
  await t.test('broken symlink', async (child) => {
    const f = await fixture(child);
    await symlink('missing', join(f.app, appRoot, 'runtime/node_modules/broken'));
    await assert.rejects(planMacRelease(f.config));
  });
  await t.test('malformed universal header', async (child) => {
    const f = await fixture(child),
      malformed = fat();
    malformed.writeUInt32BE(0xffffffff, 16);
    await f.put(native, malformed);
    await assert.rejects(planMacRelease(f.config), /slice offset/);
  });
  await t.test('control characters in names', async (child) => {
    const f = await fixture(child);
    await f.put(`${appRoot}/runtime/node_modules/synthetic/bad\nname`, 'synthetic data');
    await assert.rejects(planMacRelease(f.config), /Invalid app filename/);
  });
});

test('explicit execution signs a separate copy, verifies before upload, staples then verifies before final archive', async (t) => {
  const f = await fixture(t),
    before = await inspectMacApp(f.app),
    calls: Call[] = [];
  const report = await executeMacRelease(f.config, { ...injected, run: executor(calls) });
  assert.equal(report.state, 'complete');
  assert.equal((await inspectMacApp(f.app)).digest, before.digest);
  const signing = calls.filter((call) => call.args.includes('--sign'));
  assert.deepEqual(
    signing.map((call) => call.args.at(-1)),
    before.targets.map((target) => join(f.output, 'Moor.app', target.path)),
  );
  for (const call of signing) {
    assert.ok(!call.args.includes('--deep'));
    assert.ok(call.args.includes('--timestamp'));
    assert.ok(call.args.includes('runtime'));
  }
  const find = (first: string, second?: string) =>
    calls.findIndex((call) => call.args[0] === first && (!second || call.args[1] === second));
  const notary = find('notarytool'),
    staple = find('stapler', 'staple'),
    ticket = find('stapler', 'validate'),
    gatekeeper = find('--assess');
  assert.ok(notary > find('--verify'));
  assert.ok(staple > notary && ticket > staple && gatekeeper > ticket);
  assert.ok(calls.slice(ticket + 1, gatekeeper).some((call) => call.args.includes('--deep')));
  assert.equal(calls.at(-1)?.command, '/usr/bin/ditto');
  assert.equal(calls.at(-1)?.args.at(-1), join(f.output, 'Moor-notarized.zip'));
  for (const call of calls.filter((call) => call.args.includes('-R'))) {
    assert.match(
      call.args[call.args.indexOf('-R') + 1]!,
      /anchor apple generic.*100\.6\.1\.13.*AAAAAAAAAA/,
    );
  }
  for (const [path, value] of Object.entries(f.files).filter(
    ([path]) => path.includes('LICENSE') || path.includes('NOTICES'),
  ))
    assert.equal(await readFile(join(f.output, 'Moor.app', path), 'utf8'), value);
  const persisted = await readFile(join(f.output, 'release-report.json'), 'utf8');
  assert.ok(
    !persisted.includes(identity) &&
      !persisted.includes(profile) &&
      !persisted.includes('do not retain server text'),
  );
  assert.deepEqual(report.notarization, { id: submissionId, status: 'Accepted' });
  assert.match(report.archive!.sha256, /^[0-9a-f]{64}$/);
});

test('failed verification never uploads and retained output cannot be overwritten', async (t) => {
  const f = await fixture(t),
    calls: Call[] = [];
  await assert.rejects(
    executeMacRelease(f.config, {
      ...injected,
      run: executor(calls, (call) =>
        call.args[0] === '--verify' ? { status: 1, stdout: profile, stderr: identity } : undefined,
      ),
    }),
    /stopped at verify-signature/,
  );
  assert.ok(!calls.some((call) => call.args[0] === 'notarytool'));
  const persisted = await readFile(join(f.output, 'release-report.json'), 'utf8');
  assert.equal(JSON.parse(persisted).state, 'failed');
  assert.ok(!persisted.includes(profile) && !persisted.includes(identity));
  const count = calls.length;
  await assert.rejects(
    executeMacRelease(f.config, { ...injected, run: executor(calls) }),
    /already exists/,
  );
  assert.equal(calls.length, count);
  assert.equal(await readFile(join(f.output, 'release-report.json'), 'utf8'), persisted);
  await assert.rejects(readFile(join(f.output, 'Moor-notarized.zip')));
});

test('wrong team, absent hardened runtime and absent secure timestamp stop before notarization', async (t) => {
  for (const [name, text] of [
    ['team', metadata.replace('TeamIdentifier=AAAAAAAAAA', 'TeamIdentifier=BBBBBBBBBB')],
    ['runtime', metadata.replace('0x10000(runtime)', '0x0(none)')],
    ['timestamp', metadata.replace(/Timestamp=.*\n/, '')],
  ] as const) {
    await t.test(name, async (child) => {
      const f = await fixture(child),
        calls: Call[] = [];
      await assert.rejects(
        executeMacRelease(f.config, {
          ...injected,
          run: executor(calls, (call) =>
            call.args[0] === '--display' ? { status: 0, stdout: '', stderr: text } : undefined,
          ),
        }),
        /stopped/,
      );
      assert.ok(!calls.some((call) => call.args[0] === 'notarytool'));
    });
  }
  assert.throws(
    () => verifySigningFacts(metadata + 'Signature=adhoc\n', identity, 'AAAAAAAAAA'),
    /Ad-hoc/,
  );
});

test('notarization requires successful exit and exact Accepted JSON; no retries or stapling after unknown and rejected results', async (t) => {
  const results = [
    { status: 0, stdout: 'Accepted', stderr: '' },
    { status: 0, stdout: JSON.stringify({ id: submissionId, status: 'In Progress' }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ id: submissionId, status: 'Invalid' }), stderr: '' },
    {
      status: 1,
      stdout: JSON.stringify({ id: submissionId, status: 'Accepted' }),
      stderr: profile,
    },
    { status: 1, stdout: JSON.stringify({ id: submissionId, message: profile }), stderr: identity },
  ];
  for (const [index, result] of results.entries()) {
    await t.test(String(index), async (child) => {
      const f = await fixture(child),
        calls: Call[] = [];
      await assert.rejects(
        executeMacRelease(f.config, {
          ...injected,
          run: executor(calls, (call) => (call.args[0] === 'notarytool' ? result : undefined)),
        }),
        /require-Accepted/,
      );
      assert.equal(calls.filter((call) => call.args[0] === 'notarytool').length, 1);
      assert.ok(!calls.some((call) => call.args[0] === 'stapler'));
      const report = JSON.parse(await readFile(join(f.output, 'release-report.json'), 'utf8'));
      assert.equal(
        report.notarySubmission,
        index === 0 ? 'possibly-submitted' : 'confirmed-submitted',
      );
      if (index > 0) assert.equal(report.notarization.id, submissionId);
      if (result.status !== 0) assert.ok(!report.completed.includes('notarize'));
      assert.ok(
        !JSON.stringify(report).includes(profile) && !JSON.stringify(report).includes(identity),
      );
      await assert.rejects(readFile(join(f.output, 'Moor-notarized.zip')));
    });
  }
  for (const value of [
    null,
    [],
    { id: [submissionId], status: 'Accepted' },
    { id: submissionId, status: 'accepted' },
    { id: submissionId, status: true },
  ])
    assert.throws(() => parseNotaryResult(JSON.stringify(value)), /Invalid notarization JSON/);
});

test('an interrupted submit remains possibly submitted without leaking executor diagnostics', async (t) => {
  const f = await fixture(t),
    calls: Call[] = [];
  const run = executor(calls);
  await assert.rejects(
    executeMacRelease(f.config, {
      ...injected,
      run: async (command, args) => {
        if (args[0] === 'notarytool') throw new Error(profile + identity);
        return run(command, args);
      },
    }),
    /stopped at notarize/,
  );
  const report = JSON.parse(await readFile(join(f.output, 'release-report.json'), 'utf8'));
  assert.equal(report.notarySubmission, 'possibly-submitted');
  assert.equal(report.notarization, null);
  assert.ok(!report.completed.includes('notarize'));
  assert.ok(
    !JSON.stringify(report).includes(profile) && !JSON.stringify(report).includes(identity),
  );
  assert.ok(!calls.some((call) => call.args[0] === 'stapler'));
});

function failingReportIo(phase: 'write' | 'rename') {
  return {
    openFile: async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[1] === 'wx' && phase === 'write') {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          await write('{"incomplete":');
          throw new Error('synthetic interrupted write');
        };
      }
      return handle;
    },
    renameFile: async (...args: Parameters<typeof rename>) => {
      if (phase === 'rename') throw new Error('synthetic failed rename');
      await rename(...args);
    },
  };
}

test('release reports atomically replace a synced private temp and sync the directory', async (t) => {
  const f = await fixture(t),
    reportPath = join(f.directory, 'release-report.json');
  const events: string[] = [];
  const receipt = { notarization: { id: submissionId, status: 'Accepted' } };
  await writeReleaseReport(reportPath, receipt, {
    openFile: async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle),
        close = handle.close.bind(handle);
      const kind = args[1] === 'wx' ? 'file' : 'directory';
      events.push('open-' + kind);
      if (kind === 'file') {
        assert.equal(dirname(String(args[0])), f.directory);
        assert.equal((await stat(args[0])).mode & 0o777, 0o600);
      }
      handle.sync = async () => {
        events.push('sync-' + kind);
        await sync();
      };
      handle.close = async () => {
        events.push('close-' + kind);
        await close();
      };
      return handle;
    },
    renameFile: async (from, to) => {
      events.push('rename');
      assert.equal(await readFile(from, 'utf8'), JSON.stringify(receipt, null, 2) + '\n');
      await rename(from, to);
    },
  });
  assert.deepEqual(events, [
    'open-file',
    'sync-file',
    'close-file',
    'rename',
    'open-directory',
    'sync-directory',
    'close-directory',
  ]);
  const before = await readFile(reportPath, 'utf8');
  for (const phase of ['write', 'rename'] as const) {
    await assert.rejects(
      writeReleaseReport(reportPath, { replacement: true }, failingReportIo(phase)),
    );
    assert.equal(await readFile(reportPath, 'utf8'), before);
    assert.equal(JSON.parse(before).notarization.id, submissionId);
    assert.deepEqual(await readdir(f.directory), ['Moor.app', 'release-report.json']);
  }
});

test('report write or rename failure after notarization preserves the original id and never resubmits', async (t) => {
  for (const phase of ['write', 'rename'] as const) {
    await t.test(phase, async (child) => {
      const f = await fixture(child),
        calls: Call[] = [];
      const run = executor(calls);
      await assert.rejects(
        executeMacRelease(f.config, {
          ...injected,
          run,
          writeReport: (path, report) =>
            writeReleaseReport(
              path,
              report,
              report.notarization && report.completed.includes('require-Accepted')
                ? failingReportIo(phase)
                : undefined,
            ),
        }),
        /stopped at staple/,
      );
      const report = JSON.parse(await readFile(join(f.output, 'release-report.json'), 'utf8'));
      assert.equal(report.notarization.id, submissionId);
      assert.equal(report.notarySubmission, 'confirmed-submitted');
      assert.equal(calls.filter((call) => call.args[0] === 'notarytool').length, 1);
      assert.ok(!calls.some((call) => call.args[0] === 'stapler'));
      assert.ok(!(await readdir(f.output)).some((name) => name.endsWith('.tmp')));
      await assert.rejects(executeMacRelease(f.config, { ...injected, run }), /already exists/);
      assert.equal(calls.filter((call) => call.args[0] === 'notarytool').length, 1);
    });
  }
});

test('notary submission is never dispatched until the possibly-submitted report is durable', async (t) => {
  const f = await fixture(t),
    calls: Call[] = [];
  await assert.rejects(
    executeMacRelease(f.config, {
      ...injected,
      run: executor(calls),
      writeReport: (path, report) =>
        writeReleaseReport(
          path,
          report,
          report.notarySubmission === 'possibly-submitted' ? failingReportIo('rename') : undefined,
        ),
    }),
    /stopped at notarize/,
  );
  assert.ok(!calls.some((call) => call.args[0] === 'notarytool'));
  const report = JSON.parse(await readFile(join(f.output, 'release-report.json'), 'utf8'));
  assert.equal(report.notarySubmission, 'not-started');
  assert.ok(!(await readdir(f.output)).some((name) => name.endsWith('.tmp')));
});

test('staple or post-staple verification failure does not produce a final distributable', async (t) => {
  for (const phase of ['staple', 'verify', 'gatekeeper']) {
    await t.test(phase, async (child) => {
      const f = await fixture(child),
        calls: Call[] = [];
      let stapled = false;
      await assert.rejects(
        executeMacRelease(f.config, {
          ...injected,
          run: executor(calls, (call) => {
            if (call.args[0] === 'stapler' && call.args[1] === 'staple') {
              stapled = true;
              if (phase === 'staple') return { status: 1, stdout: '', stderr: '' };
            }
            if (
              (phase === 'verify' && stapled && call.args[0] === '--verify') ||
              (phase === 'gatekeeper' && call.args[0] === '--assess')
            )
              return { status: 1, stdout: '', stderr: '' };
            return undefined;
          }),
        }),
        /stopped/,
      );
      await assert.rejects(readFile(join(f.output, 'Moor-notarized.zip')));
      assert.equal((await readdir(f.output)).includes('Moor.app'), true);
    });
  }
});
