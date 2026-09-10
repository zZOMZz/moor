import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRuntimeLock } from '../src/runtime/lock';
test('exclusive ownership prevents a second host and releases without deleting operator data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.lock');
  const release = acquireRuntimeLock(file);
  assert.throws(() => acquireRuntimeLock(file));
  release();
  release();
  const next = acquireRuntimeLock(file);
  assert.throws(() => acquireRuntimeLock(file));
  next();
});
