import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppearance } from '../src/desktop/appearance.cjs';

test('appearance persists independently, defaults to Auto and does not announce failed saves', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'moor-appearance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'appearance.json'),
    nativeTheme = { themeSource: '' },
    changes: string[] = [];
  let failing = false;
  const options = {
    file,
    nativeTheme,
    changed: (value: string) => changes.push(value),
    write: (path: string, value: string) => {
      if (failing) throw Error('Synthetic disk failure');
      writeFileSync(path, JSON.stringify(value));
    },
  };
  const appearance = createAppearance(options);
  assert.equal(appearance.read(), 'system');
  assert.equal(nativeTheme.themeSource, 'system');
  for (const mode of ['dark', 'light', 'system']) {
    assert.equal(appearance.set(mode), mode);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')), mode);
    assert.equal(nativeTheme.themeSource, mode);
    assert.equal(createAppearance(options).read(), mode);
  }
  failing = true;
  assert.throws(() => appearance.set('dark'), /disk failure/);
  assert.equal(appearance.read(), 'system');
  assert.equal(nativeTheme.themeSource, 'system');
  assert.deepEqual(changes, ['dark', 'light', 'system']);
  for (const value of ['blue', {}, null, false, 1])
    assert.throws(() => appearance.set(value), /外观/);
  writeFileSync(file, '{corrupt');
  assert.equal(createAppearance(options).read(), 'system');
});
