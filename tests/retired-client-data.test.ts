import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRetiredClientData } from '../src/desktop/retired-client-data.cjs';

test('retired client cleanup deletes both old partitions and preserves current client and host data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moor-retired-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['personal-local', 'personal-remote', 'moor-secure-client-v1']) {
    const directory = join(root, 'Partitions', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'synthetic-cache'), name);
  }
  for (const name of ['settings.json', 'runtime-v1.sqlite', 'bridge-v3.json'])
    writeFileSync(join(root, name), 'synthetic current data');
  removeRetiredClientData(root);
  removeRetiredClientData(root);
  for (const name of ['personal-local', 'personal-remote'])
    assert.equal(existsSync(join(root, 'Partitions', name)), false);
  assert.equal(
    readFileSync(join(root, 'Partitions', 'moor-secure-client-v1', 'synthetic-cache'), 'utf8'),
    'moor-secure-client-v1',
  );
  for (const name of ['settings.json', 'runtime-v1.sqlite', 'bridge-v3.json'])
    assert.equal(readFileSync(join(root, name), 'utf8'), 'synthetic current data');
});

test('retired cleanup never follows a partition link and rejects a redirected Partitions directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moor-retired-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'),
    other = join(root, 'other');
  mkdirSync(data);
  mkdirSync(other);
  writeFileSync(join(other, 'keep'), 'synthetic current data');
  removeRetiredClientData(data);
  mkdirSync(join(data, 'Partitions'));
  symlinkSync(other, join(data, 'Partitions', 'personal-local'));
  removeRetiredClientData(data);
  assert.equal(readFileSync(join(other, 'keep'), 'utf8'), 'synthetic current data');
  rmSync(join(data, 'Partitions'), { recursive: true });
  symlinkSync(other, join(data, 'Partitions'));
  assert.throws(() => removeRetiredClientData(data), /独立目录/);
  assert.equal(readFileSync(join(other, 'keep'), 'utf8'), 'synthetic current data');
});
