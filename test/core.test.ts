import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, classify, decode, encode, isUlid, ulid, type RecordMeta } from '../src/node.js';

const meta: RecordMeta = {
  type: 'T', app: 'a', collection: 'c', version: 2, consistency: 'lww', key: 'id', doc: '', hash_keys: false, per_person: false, replicas: [], mirror_limit: 5000, max_value: 2000,
  fields: [
    { name: 'id', ty: { kind: 'id' }, key: true, index: null, max: null, since: 1, default: null, secret: false, doc: '' },
    { name: 'n', ty: { kind: 'u64' }, key: false, index: null, max: null, since: 1, default: null, secret: false, doc: '' },
    { name: 'b', ty: { kind: 'hex' }, key: false, index: null, max: null, since: 1, default: null, secret: false, doc: '' },
    { name: 'o', ty: { kind: 'option', of: { kind: 'string' } }, key: false, index: null, max: 3, since: 2, default: null, secret: false, doc: '' },
  ],
};

test('canonical matches the Rust writer', () => {
  assert.equal(canonical({ b: [1, { z: 1, a: '\n\u0001é' }], a: null }), '{"a":null,"b":[1,{"a":"\\n\\u0001é","z":1}]}');
  assert.equal(canonical([100.0, -0, 1.5, 1e20, -3]), '[100,0,1.5,100000000000000000000,-3]');
});

test('encode: u64 as a decimal string, bytes as hex, None absent, _v', () => {
  const id = ulid();
  const s = encode(meta, { id, n: 18446744073709551615n, b: new Uint8Array([0, 255]) });
  assert.equal(s, `{"_v":2,"b":"00ff","id":"${id}","n":"18446744073709551615"}`);
  const d = decode<{ n: bigint; o?: string }>(meta, s.replace('}', ',"zz":1}'));
  assert.equal(d.value.n, 18446744073709551615n);
  assert.equal(d.value.o, undefined);
  assert.deepEqual(d.extra, { zz: 1 });
  assert.throws(() => encode(meta, { id, n: 1n, b: new Uint8Array(), o: 'long' }), /invalid o/);
  assert.throws(() => encode(meta, { id, n: 1n, b: new Uint8Array(2000) }), /too large/);
});

test('ulids and errors', () => {
  const a = ulid(1000);
  const b = ulid(2000);
  assert.ok(isUlid(a) && a < b);
  assert.deepEqual(classify('not authorized: state.partsdemo.parts.write', 'parts-demo', 'parts').info, { kind: 'Refused', need: 'state.partsdemo.parts.write' });
  assert.deepEqual(classify('version conflict: have 3', 'a', 'b').info, { kind: 'Conflict', heldVersion: 3n });
  assert.equal(classify("app 'a' has no schema; register one", 'a', 'b').info.kind, 'SchemaMissing');
});
