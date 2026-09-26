import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionItemJson, PERMISSION_REVIEW_MAX_BYTES } from '../src/permission-review';

test('permission contents remain current for mutable inputs and shallowly frozen objects or arrays', () => {
  const mutable = { input: { text: 'before' } };
  assert.equal(permissionItemJson(mutable), '{"input":{"text":"before"}}');
  mutable.input.text = 'after';
  assert.equal(permissionItemJson(mutable), '{"input":{"text":"after"}}');

  const child = { text: 'before' };
  const shallow = Object.freeze({ input: Object.freeze([child]) });
  assert.equal(permissionItemJson(shallow), '{"input":[{"text":"before"}]}');
  child.text = 'after';
  assert.equal(permissionItemJson(shallow), '{"input":[{"text":"after"}]}');

  const array = ['before'];
  const frozenParent = Object.freeze({ input: array });
  assert.equal(permissionItemJson(frozenParent), '{"input":["before"]}');
  array.push('after');
  assert.equal(permissionItemJson(frozenParent), '{"input":["before","after"]}');
});

test('frozen permission contents still reject accessors and unsupported prototypes without executing getters', () => {
  let accessed = 0;
  const accessor = () => {
    accessed++;
    return 'injected';
  };
  const object = Object.freeze(
    Object.defineProperty({}, 'input', { enumerable: true, get: accessor }),
  );
  const array = Object.freeze(Object.defineProperty([], '0', { enumerable: true, get: accessor }));
  const inherited = Object.freeze(
    Object.assign(Object.create({ inherited: true }), { input: 'value' }),
  );
  for (const value of [object, array, inherited]) {
    assert.throws(() => permissionItemJson(value), /格式不受支持/);
    assert.throws(() => permissionItemJson(value), /格式不受支持/);
  }
  assert.equal(accessed, 0);
});

test('immutable permission serialization preserves content and only caches after character, byte, depth and node checks', () => {
  const valid = Object.freeze({
    z: undefined,
    input: Object.freeze(['<script>', '\u001b[31m', '中文', Object.freeze({ z: 2, a: null })]),
  });
  assert.equal(
    permissionItemJson(valid),
    '{"input":["<script>","\\u001b[31m","中文",{"a":null,"z":2}]}',
  );
  assert.equal(permissionItemJson(valid), permissionItemJson(valid));
  let deep: unknown = null;
  for (let index = 0; index < 34; index++) deep = Object.freeze({ child: deep });
  const invalid = [
    Object.freeze({ input: 'x'.repeat(PERMISSION_REVIEW_MAX_BYTES) }),
    Object.freeze({ input: '中'.repeat(Math.ceil(PERMISSION_REVIEW_MAX_BYTES / 3)) }),
    Object.freeze(Array.from({ length: 10_000 }, () => null)),
    deep,
  ];
  for (const value of invalid) {
    assert.throws(() => permissionItemJson(value), /超出审阅限制/);
    assert.throws(() => permissionItemJson(value), /超出审阅限制/);
  }
  const recoverable = { input: 'x'.repeat(PERMISSION_REVIEW_MAX_BYTES) };
  assert.throws(() => permissionItemJson(recoverable), /超出审阅限制/);
  recoverable.input = 'repaired';
  assert.equal(permissionItemJson(recoverable), '{"input":"repaired"}');
  recoverable.input = 'changed again';
  assert.equal(permissionItemJson(recoverable), '{"input":"changed again"}');
});
