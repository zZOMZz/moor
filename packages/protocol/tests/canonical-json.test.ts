import test from 'node:test';
import assert from 'node:assert/strict';
import { productCanonicalJson } from '../src/canonical-json';

test('canonical JSON preserves historical persisted bytes, omissions and array order', () => {
  const inherited = Object.assign(Object.create({ inherited: 'never persisted' }), {
    z: undefined,
    b: [3, undefined, { z: '末尾', a: 1 }],
    a: '\n"',
  });
  assert.equal(productCanonicalJson(inherited), '{"a":"\\n\\\"","b":[3,null,{"a":1,"z":"末尾"}]}');
  const scope = {
    target: { workspaceId: 'workspace', owner: 'owner', deviceId: 'device' },
    source: 'local',
  };
  assert.equal(
    productCanonicalJson(['moor-desktop-ledger-v1', scope]),
    '["moor-desktop-ledger-v1",{"source":"local","target":{"deviceId":"device","owner":"owner","workspaceId":"workspace"}}]',
  );
  assert.equal(
    productCanonicalJson(JSON.parse('{"__proto__":{"b":2,"a":1},"constructor":"own"}')),
    '{"__proto__":{"a":1,"b":2},"constructor":"own"}',
  );
});
