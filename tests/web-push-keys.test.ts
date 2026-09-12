import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWebPushTransport } from '../src/relay/web-push';

test('operator key setup writes private valid configuration without printing secrets or overwriting data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-push-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.data', 'web-push.env');
  const command = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve('scripts/create-web-push-keys.mjs'),
        '--output',
        file,
        '--subject',
        'mailto:synthetic@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    );
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, 'utf8');
  const config = Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  assert.equal(createWebPushTransport(config).state.configured, true);
  assert(!result.stdout.includes(config.MOOR_WEB_PUSH_PRIVATE_KEY));
  assert.notEqual(command().status, 0);
  assert.equal(readFileSync(file, 'utf8'), text);
  rmSync(file);
  const protectedFile = join(dir, 'operator-config');
  writeFileSync(protectedFile, 'keep synthetic operator data');
  symlinkSync(protectedFile, file);
  assert.notEqual(command().status, 0);
  assert.equal(readFileSync(protectedFile, 'utf8'), 'keep synthetic operator data');
});
