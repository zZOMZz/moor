import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Apple: https://developer.apple.com/library/archive/technotes/tn2206/_index.html
// https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
// Electron: https://www.electronjs.org/docs/latest/tutorial/code-signing
// Sign nested code inside out; --deep is only used to VERIFY, never to sign.
const templateRoot = fileURLToPath(new URL('./mac-entitlements/', import.meta.url));
const programRoot = 'Contents/Resources/app';
const desktopFiles = new Set([
  'package.json',
  'entry.cjs',
  'main.cjs',
  'preload.cjs',
  'web-preload.cjs',
  'preview-settings.cjs',
  'preview-renderer.cjs',
  'notifications.cjs',
  'github-settings.cjs',
  'attachment-save.cjs',
  'skills-settings.cjs',
  'recovery.cjs',
  'agent-settings.cjs',
  'page-loader.cjs',
  'settings.css',
  'settings.html',
  'settings.js',
  'icon-192.png',
  'moor-logo.png',
  'THIRD-PARTY.txt',
]);
const runtimeFiles = new Set(['bridge.mjs', 'cli.mjs', 'server.mjs', 'preview-renderer.cjs']);
const required = [
  'Contents/Info.plist',
  `${programRoot}/package.json`,
  `${programRoot}/entry.cjs`,
  `${programRoot}/runtime/bridge.mjs`,
  `${programRoot}/runtime/cli.mjs`,
  `${programRoot}/licenses/Moor-LICENSE`,
  `${programRoot}/licenses/Moor-NOTICE`,
  `${programRoot}/licenses/BUNDLED-NOTICES.txt`,
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validStatuses = new Set(['Accepted', 'Invalid', 'Rejected', 'In Progress']);

function ensure(value, message) {
  if (!value) throw new Error(message);
}
function within(root, path) {
  const part = relative(root, path);
  return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part));
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Release output already exists; choose a new directory');
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function options(input) {
  ensure(
    input &&
      Object.keys(input).every((key) =>
        ['app', 'output', 'identity', 'keychainProfile'].includes(key),
      ),
    'Unknown release option',
  );
  ensure(
    typeof input.app === 'string' &&
      input.app.length > 0 &&
      typeof input.output === 'string' &&
      input.output.length > 0,
    'Explicit app and new output paths are required',
  );
  ensure(
    typeof input.identity === 'string' &&
      /^Developer ID Application: [^\r\n\x00-\x1f]+ \([A-Z0-9]{10}\)$/.test(input.identity),
    'An explicit Developer ID Application identity is required; ad-hoc and development identities are refused',
  );
  ensure(
    typeof input.keychainProfile === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.keychainProfile),
    'An explicit notarytool Keychain profile name is required',
  );
  ensure(!/[\x00-\x1f]/.test(input.app + input.output), 'Invalid release path');
  return {
    ...input,
    app: resolve(input.app),
    output: resolve(input.output),
    teamId: input.identity.slice(-11, -1),
  };
}
function programPath(path, directory) {
  const segments = path.split('/');
  ensure(
    !segments.some((p) =>
      ['.git', '.codex', '.agents', '.data', '.cache', '.ssh', '.aws'].includes(p),
    ),
    'Non-program directory in app',
  );
  ensure(
    !segments.some((p) =>
      /^\.env(?:\.|$)|\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm))?$|\.(?:log|pem|p12|p8|keychain(?:-db)?)$|^(?:setup-token|auth\.json|credentials(?:\.json)?)$/i.test(
        p,
      ),
    ),
    'Operator data or credential file in app',
  );
  if (segments.length === 1) {
    ensure(path === 'Contents' && directory, 'Unexpected app root entry');
    return;
  }
  ensure(segments[0] === 'Contents', 'Unexpected app root entry');
  ensure(
    ['Info.plist', 'PkgInfo', '_CodeSignature', 'MacOS', 'Frameworks', 'Resources'].includes(
      segments[1],
    ),
    'Unexpected app Contents entry',
  );
  if (segments[1] === 'Resources' && segments.length >= 3) {
    ensure(
      ['app', 'electron.icns', 'moor.icns', 'default_app.asar'].includes(segments[2]) ||
        /^[a-zA-Z0-9_]+\.lproj$/.test(segments[2]),
      'Unexpected Electron resource',
    );
    if (segments[2] === 'app' && segments.length >= 4) {
      const entry = segments[3];
      ensure(
        desktopFiles.has(entry) || ['licenses', 'runtime'].includes(entry),
        'Unexpected Moor program entry',
      );
      if (desktopFiles.has(entry))
        ensure(segments.length === 4 && !directory, 'Unexpected desktop resource directory');
      if (entry === 'runtime' && segments.length >= 5) {
        ensure(
          runtimeFiles.has(segments[4]) || ['public', 'node_modules'].includes(segments[4]),
          'Unexpected runtime entry',
        );
        if (runtimeFiles.has(segments[4]))
          ensure(segments.length === 5 && !directory, 'Unexpected runtime directory');
      }
    }
  }
}
async function macho(path, size) {
  const file = await open(path, 'r');
  try {
    async function header(offset) {
      const bytes = Buffer.alloc(32);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      return bytes.subarray(0, bytesRead);
    }
    const bytes = await header(0);
    if (bytes.length < 4) return null;
    const magic = bytes.readUInt32BE(0);
    const thin = (h) => {
      ensure(h.length >= 28, 'Truncated Mach-O header');
      const m = h.readUInt32BE(0),
        little = m === 0xcefaedfe || m === 0xcffaedfe;
      ensure(little || m === 0xfeedface || m === 0xfeedfacf, 'Invalid universal Mach-O slice');
      const type = little ? h.readUInt32LE(12) : h.readUInt32BE(12);
      ensure([2, 6, 8].includes(type), 'Non-runtime Mach-O file in app');
      return type === 2 ? 'executable' : 'library';
    };
    if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) return thin(bytes);
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return null;
    const little = magic === 0xbebafeca || magic === 0xbfbafeca,
      wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    ensure(bytes.length >= 8, 'Truncated universal Mach-O header');
    const count = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
    ensure(count > 0 && count <= 32, 'Invalid universal Mach-O architecture count');
    const length = wide ? 32 : 20,
      table = Buffer.alloc(count * length);
    ensure(
      (await file.read(table, 0, table.length, 8)).bytesRead === table.length,
      'Truncated universal Mach-O table',
    );
    const kinds = new Set();
    for (let index = 0; index < count; index++) {
      const pos = index * length + 8;
      const offset = wide
        ? Number(little ? table.readBigUInt64LE(pos) : table.readBigUInt64BE(pos))
        : little
          ? table.readUInt32LE(pos)
          : table.readUInt32BE(pos);
      ensure(
        Number.isSafeInteger(offset) && offset >= 8 + table.length && offset <= size - 28,
        'Invalid universal Mach-O slice offset',
      );
      kinds.add(thin(await header(offset)));
    }
    ensure(kinds.size === 1, 'Mixed universal Mach-O file types');
    return [...kinds][0];
  } finally {
    await file.close();
  }
}

export async function inspectMacApp(inputPath) {
  const app = resolve(inputPath);
  ensure(
    basename(app) === 'Moor.app' &&
      (await lstat(app)).isDirectory() &&
      !(await lstat(app)).isSymbolicLink(),
    'Input must be a regular Moor.app directory',
  );
  ensure((await realpath(app)) === app, 'App path must not traverse symlinks');
  const entries = [],
    targets = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      ensure(!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name), 'Invalid app filename');
      const path = join(directory, name),
        rel = relative(app, path).split(sep).join('/'),
        info = await lstat(path);
      programPath(rel, info.isDirectory());
      if (info.isSymbolicLink()) {
        const link = await readlink(path);
        ensure(
          !isAbsolute(link) && within(app, resolve(dirname(path), link)),
          'External app symlink',
        );
        ensure(within(app, await realpath(path)), 'External or broken app symlink');
        entries.push({ path: rel, type: 'symlink', link });
      } else if (info.isDirectory()) {
        entries.push({ path: rel, type: 'directory' });
        await walk(path);
        if (
          /\.(?:app|framework|xpc|appex|bundle)$/.test(name) ||
          /\.framework\/Versions\/[^/]+$/.test(rel)
        ) {
          ensure(
            targets.some((target) => target.path.startsWith(rel + '/')),
            'Code bundle has no Mach-O target',
          );
          targets.push({
            path: rel,
            kind: 'bundle',
            entitlements: name.startsWith('Electron Helper') ? 'electron' : null,
          });
        }
      } else {
        ensure(info.isFile(), 'Non-program filesystem object in app');
        const kind = await macho(path, info.size);
        entries.push({
          path: rel,
          type: 'file',
          bytes: info.size,
          sha256: await sha256(path),
          mode: info.mode & 0o777,
        });
        if (kind) {
          // Preserve the reviewed runtime exceptions of the pinned native Agent binaries.
          // Templates are fixed policy, never copied from arbitrary input signatures.
          const electron =
            rel === 'Contents/MacOS/Electron' ||
            /\/Electron Helper[^/]*\.app\/Contents\/MacOS\//.test(rel);
          const claude = /\/@anthropic-ai\/claude-agent-sdk-darwin-(?:arm64|x64)\/claude$/.test(
            rel,
          );
          const codex =
            /\/@openai\/codex-darwin-(?:arm64|x64)\/vendor\/(?:aarch64|x86_64)-apple-darwin\/bin\/(?:codex|codex-code-mode-host)$/.test(
              rel,
            );
          targets.push({
            path: rel,
            kind,
            entitlements:
              kind === 'executable'
                ? electron
                  ? 'electron'
                  : claude
                    ? 'claude'
                    : codex
                      ? 'agent-v8'
                      : 'native'
                : null,
          });
        }
      }
    }
  }
  await walk(app);
  for (const path of required)
    ensure(
      entries.some((entry) => entry.path === path && entry.type === 'file'),
      'Required Moor program or license file missing',
    );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(app, programRoot, 'package.json'), 'utf8'));
  } catch {
    throw new Error('Invalid Moor package manifest');
  }
  ensure(
    manifest.name === 'moor' && manifest.main === 'entry.cjs',
    'Unexpected Moor package manifest',
  );
  const plist = await readFile(join(app, 'Contents/Info.plist'), 'utf8');
  ensure(
    /<key>CFBundleIdentifier<\/key>\s*<string>io\.github\.zzomzz\.moor<\/string>/.test(plist),
    'Unexpected Moor bundle identifier',
  );
  ensure(
    targets.some((target) => target.path === 'Contents/MacOS/Electron'),
    'Electron main executable missing',
  );
  targets.push({ path: '.', kind: 'bundle', entitlements: 'electron' });
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { entries, targets, digest };
}

export async function planMacRelease(input) {
  const config = options(input);
  await absent(config.output);
  ensure(
    (await realpath(dirname(config.output))) === dirname(config.output),
    'Output parent must exist and must not traverse symlinks',
  );
  ensure(
    !within(config.app, config.output) && !within(config.output, config.app),
    'App and output must be separate directories',
  );
  const inventory = await inspectMacApp(config.app);
  return {
    version: 1,
    mode: 'plan',
    executed: false,
    source: config.app,
    output: config.output,
    sourceDigest: inventory.digest,
    fileCount: inventory.entries.filter((entry) => entry.type === 'file').length,
    signingIdentity: 'explicit Developer ID Application reference (not inspected)',
    notarizationCredentials: 'explicit existing Keychain profile reference (not inspected)',
    targets: inventory.targets,
    steps: [
      'copy-and-recheck-source',
      'sign-inside-out-with-hardened-runtime-and-timestamp',
      'verify-every-target-and-Developer-ID-team',
      'verify-app-deep-strict',
      'create-submission-zip',
      'submit-notarytool-json',
      'require-Accepted',
      'staple-app',
      'validate-ticket-and-signatures',
      'assess-Gatekeeper',
      'create-final-zip',
      'sha256-final-zip',
    ],
    validationLimit:
      'A plan does not sign, upload, inspect Keychain, or prove real-device launch compatibility.',
  };
}

export function parseNotaryResult(text) {
  ensure(
    typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024,
    'Invalid notarization JSON',
  );
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid notarization JSON');
  }
  ensure(
    value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      uuid.test(value.id) &&
      typeof value.status === 'string' &&
      validStatuses.has(value.status),
    'Invalid notarization JSON',
  );
  // Only retain bounded machine-readable facts, never server messages or credential diagnostics.
  return { id: value.id, status: value.status };
}

function notaryReceipt(text) {
  // A submit timeout can still return the original submission id. Retain that
  // bounded fact for manual info/log checks without treating it as acceptance.
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) return null;
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value.id !== 'string' || !uuid.test(value.id))
      return null;
    return {
      id: value.id,
      ...(typeof value.status === 'string' && validStatuses.has(value.status)
        ? { status: value.status }
        : {}),
    };
  } catch {
    return null;
  }
}

export function verifySigningFacts(text, identity, teamId) {
  ensure(
    typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024,
    'Invalid signing metadata',
  );
  const lines = text.split(/\r?\n/);
  ensure(
    lines.includes('Authority=' + identity) && lines.includes('TeamIdentifier=' + teamId),
    'Unexpected signing identity',
  );
  ensure(!lines.includes('Signature=adhoc'), 'Ad-hoc signature cannot be released');
  ensure(
    lines.some((line) => /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/i.test(line)),
    'Hardened runtime missing',
  );
  ensure(
    lines.some((line) => /^Timestamp=\S/.test(line) && !/^Timestamp=(?:none|not set)$/i.test(line)),
    'Secure signature timestamp missing',
  );
}

function runCommand(command, args) {
  return new Promise((fulfill) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '',
      overflow = false;
    const collect = (name, chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 1024 * 1024) {
        overflow = true;
        child.kill();
        return;
      }
      if (name === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', () => fulfill({ status: null, stdout: '', stderr: '' }));
    child.on('close', (status) => fulfill({ status: overflow ? null : status, stdout, stderr }));
  });
}

export async function writeReleaseReport(
  path,
  report,
  { openFile = open, renameFile = rename } = {},
) {
  const directory = dirname(path);
  const temporary = join(directory, '.' + basename(path) + '.' + randomUUID() + '.tmp');
  let handle;
  let created = false;
  try {
    // Never truncate the last durable receipt. A killed writer leaves either the
    // previous report or the complete replacement, plus at most its own temp.
    handle = await openFile(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(report, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameFile(temporary, path);
    const parent = await openFile(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    // O_EXCL failures must not remove a temporary file owned by another writer.
    if (created) await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function executeMacRelease(
  input,
  {
    run = runCommand,
    platform = process.platform,
    entitlementsDirectory = templateRoot,
    writeReport = writeReleaseReport,
  } = {},
) {
  ensure(platform === 'darwin', 'Developer ID release execution requires macOS');
  const config = options(input),
    plan = await planMacRelease(input);
  await mkdir(config.output, { mode: 0o700 });
  const app = join(config.output, 'Moor.app'),
    reportPath = join(config.output, 'release-report.json');
  /** @type {{version: number, state: string, sourceDigest: string, completed: string[], failedStep: string | null, notarySubmission: string, notarization: {id: string, status?: string} | null, archive: {file: string, sha256: string} | null, validationLimit: string}} */
  const report = {
    version: 1,
    state: 'running',
    sourceDigest: plan.sourceDigest,
    completed: [],
    failedStep: null,
    notarySubmission: 'not-started',
    notarization: null,
    archive: null,
    validationLimit:
      'Signing and Gatekeeper checks do not prove fresh-machine launch or native Agent compatibility.',
  };
  let current = 'copy-and-recheck-source';
  const save = () => writeReport(reportPath, report);
  async function command(step, executable, args, allowFailure = false) {
    current = step;
    await save();
    let result;
    try {
      result = await run(executable, args);
    } catch {
      throw new Error('Release command failed');
    }
    ensure(result && (allowFailure || result.status === 0), 'Release command failed');
    if (result.status === 0) report.completed.push(step);
    return result;
  }
  try {
    await save();
    await cp(config.app, app, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    const copied = await inspectMacApp(app);
    ensure(copied.digest === plan.sourceDigest, 'Source changed during release copy');
    report.completed.push(current);
    const entitlements = join(config.output, 'entitlements');
    await mkdir(entitlements);
    for (const name of ['electron', 'native', 'claude', 'agent-v8'])
      await cp(join(entitlementsDirectory, name + '.plist'), join(entitlements, name + '.plist'), {
        errorOnExist: true,
        force: false,
      });
    const requirement = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${config.teamId}"`;
    for (const target of plan.targets) {
      const args = ['--force', '--sign', config.identity, '--timestamp', '--options', 'runtime'];
      if (target.entitlements)
        args.push('--entitlements', join(entitlements, target.entitlements + '.plist'));
      args.push(join(app, target.path));
      await command('sign:' + target.path, '/usr/bin/codesign', args);
    }
    async function verify(prefix) {
      for (const target of plan.targets) {
        await command(prefix + ':' + target.path, '/usr/bin/codesign', [
          '--verify',
          '--strict',
          '--verbose=2',
          '-R',
          requirement,
          join(app, target.path),
        ]);
        const metadata = await command(prefix + ':metadata:' + target.path, '/usr/bin/codesign', [
          '--display',
          '--verbose=4',
          join(app, target.path),
        ]);
        verifySigningFacts(
          metadata.stdout + '\n' + metadata.stderr,
          config.identity,
          config.teamId,
        );
      }
      await command(prefix + ':deep', '/usr/bin/codesign', [
        '--verify',
        '--deep',
        '--strict',
        '--verbose=2',
        app,
      ]);
    }
    await verify('verify-signature');
    const submission = join(config.output, 'submission.zip');
    await command('archive-submission', '/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      app,
      submission,
    ]);
    report.notarySubmission = 'possibly-submitted';
    const notary = await command(
      'notarize',
      '/usr/bin/xcrun',
      [
        'notarytool',
        'submit',
        submission,
        '--keychain-profile',
        config.keychainProfile,
        '--wait',
        '--timeout',
        '30m',
        '--output-format',
        'json',
      ],
      true,
    );
    current = 'require-Accepted';
    report.notarization = notaryReceipt(notary.stdout);
    if (report.notarization) report.notarySubmission = 'confirmed-submitted';
    await save();
    const result = parseNotaryResult(notary.stdout);
    ensure(
      notary.status === 0 && result.status === 'Accepted',
      'Apple did not accept the notarization submission',
    );
    report.completed.push(current);
    await command('staple', '/usr/bin/xcrun', ['stapler', 'staple', app]);
    await command('validate-ticket', '/usr/bin/xcrun', ['stapler', 'validate', app]);
    await verify('verify-stapled-signature');
    await command('assess-Gatekeeper', '/usr/sbin/spctl', [
      '--assess',
      '--type',
      'execute',
      '--verbose=2',
      app,
    ]);
    const archive = join(config.output, 'Moor-notarized.zip');
    await command('archive-final', '/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      app,
      archive,
    ]);
    current = 'sha256-final-zip';
    report.archive = { file: basename(archive), sha256: await sha256(archive) };
    report.completed.push(current);
    report.state = 'complete';
    await save();
    return report;
  } catch {
    report.state = 'failed';
    report.failedStep = current;
    await save().catch(() => {});
    throw new Error(
      `macOS release stopped at ${current}; working copy and sanitized report retained in output`,
    );
  }
}

export function parseMacReleaseArgs(args) {
  let mode = 'plan';
  if (args[0] && !args[0].startsWith('--')) mode = args.shift();
  ensure(['plan', 'execute'].includes(mode), 'Choose plan or execute');
  const parsed = {};
  const keys = {
    '--app': 'app',
    '--output': 'output',
    '--identity': 'identity',
    '--keychain-profile': 'keychainProfile',
  };
  while (args.length) {
    const key = keys[args.shift()],
      value = args.shift();
    ensure(
      key && value && !value.startsWith('--') && !(key in parsed),
      'Unknown, duplicate, or incomplete release option',
    );
    parsed[key] = value;
  }
  options(parsed);
  return { mode, options: parsed };
}
if (
  process.argv[1] &&
  basename(process.argv[1]) === 'mac-release.mjs' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const parsed = parseMacReleaseArgs(process.argv.slice(2));
    const result =
      parsed.mode === 'execute'
        ? await executeMacRelease(parsed.options)
        : await planMacRelease(parsed.options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
