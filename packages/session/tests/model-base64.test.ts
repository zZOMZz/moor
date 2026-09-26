import test from 'node:test';
import assert from 'node:assert/strict';
// Initialize WASM dependencies before emulating a browser without Node Buffer.
import 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { Mirror } from 'loro-mirror';

test('browser Base64 preserves byte views and atob acceptance with or without native codecs', async () => {
  assert.equal(typeof Flock, 'function');
  assert.equal(typeof Mirror, 'function');
  const buffer = globalThis.Buffer;
  let codec: typeof import('../src/model');
  try {
    Reflect.set(globalThis, 'Buffer', undefined);
    codec = await import('../src/model');
  } finally {
    globalThis.Buffer = buffer;
  }
  const from = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  const to = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
  const fallback = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const inputs = [
    '',
    'Zg',
    'Zg==',
    'Zm8',
    'Zm9',
    'Zh==',
    'Z m\t9\nv\r\f',
    'Z',
    'Zg=',
    'Zg===',
    'Zg==A',
    '====',
    'Zm9v_',
    'Zm9v-',
    'Zg==\v',
    'Zg==\u00a0',
    'Zg==\0',
  ];
  let nativeReads = 0;
  let nativeWrites = 0;
  try {
    for (const native of [false, true]) {
      Object.defineProperty(Uint8Array, 'fromBase64', {
        configurable: true,
        value: native
          ? function (this: unknown, value: string) {
              assert.equal(this, Uint8Array);
              nativeReads++;
              return fallback(value);
            }
          : undefined,
      });
      Object.defineProperty(Uint8Array.prototype, 'toBase64', {
        configurable: true,
        value: native
          ? function (this: Uint8Array) {
              nativeWrites++;
              return buffer.from(this).toString('base64');
            }
          : undefined,
      });
      for (const input of inputs) {
        let expected: Uint8Array;
        try {
          expected = fallback(input);
        } catch {
          assert.throws(() => codec.decode(input), JSON.stringify(input));
          continue;
        }
        assert.deepEqual(codec.decode(input), expected, JSON.stringify(input));
      }
      // The visible view, not its entire backing buffer, is the encoded payload.
      const backing = Uint8Array.from({ length: 17_000 }, (_, index) => index % 256);
      for (const bytes of [
        new Uint8Array(),
        backing.subarray(3, 4),
        backing.subarray(17, 16_501),
      ]) {
        const encoded = codec.encode(bytes);
        assert.equal(encoded, buffer.from(bytes).toString('base64'));
        const decoded = codec.decode(encoded);
        assert.deepEqual(decoded, bytes);
        decoded.fill(0);
        assert.equal(codec.encode(bytes), encoded, 'decoded output does not alias the source');
      }
    }
    assert.ok(nativeReads > inputs.length);
    assert.equal(nativeWrites, 6);
  } finally {
    if (from) Object.defineProperty(Uint8Array, 'fromBase64', from);
    else Reflect.deleteProperty(Uint8Array, 'fromBase64');
    if (to) Object.defineProperty(Uint8Array.prototype, 'toBase64', to);
    else Reflect.deleteProperty(Uint8Array.prototype, 'toBase64');
  }
});
