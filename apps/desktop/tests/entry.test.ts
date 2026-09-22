import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function select(env: Record<string, string | undefined>) {
  const loaded: string[] = [],
    errors: string[] = [];
  let exitCode: number | undefined;
  const exited = {};
  try {
    runInNewContext(await readFile('apps/desktop/src/entry.cjs', 'utf8'), {
      require(name: string) {
        loaded.push(name);
        return {};
      },
      process: {
        env,
        stderr: { write: (message: string) => errors.push(message) },
        exit(code: number) {
          exitCode = code;
          throw exited;
        },
      },
    });
  } catch (error) {
    if (error !== exited) throw error;
  }
  return { loaded, errors, exitCode };
}

test('desktop entry opens the ordinary app without loading a retired worker', async () => {
  assert.deepEqual(await select({}), {
    loaded: ['./main/main.cjs'],
    errors: [],
    exitCode: undefined,
  });
});

test('all retired preview invocations fail before loading the app or reading operator data', async () => {
  for (const env of [
    { MOOR_PREVIEW_NONCE: '' },
    { MOOR_PREVIEW_DATA: '' },
    { MOOR_PREVIEW_DATA: '/synthetic/private-data', MOOR_PREVIEW_NONCE: 'valid-looking-old-value' },
  ]) {
    const result = await select(env);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.loaded, []);
    assert.match(result.errors.join(''), /retired/);
    assert.doesNotMatch(result.errors.join(''), /synthetic|valid-looking/);
  }
});
