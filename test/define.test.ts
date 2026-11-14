// defineRecord writes the same meta (and so registers the same schema entry) as #[derive(Record)] on the equal Rust
// struct: the reference is parts-demo's Part, as ce-wire-gen --records generated it from crates/parts-schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineRecord, field, schemaEntry, type RecordMeta, type RowOf } from '../src/node.js';

const generated: RecordMeta = {"app":"parts-demo","collection":"parts","consistency":"lww","doc":"A part on a shelf: one row of the parts-demo inventory.","fields":[{"default":null,"doc":"","index":null,"key":true,"max":null,"name":"id","secret":false,"since":1,"ty":{"kind":"id"}},{"default":null,"doc":"What it is.","index":null,"key":false,"max":120,"name":"name","secret":false,"since":1,"ty":{"kind":"string"}},{"default":null,"doc":"The shelf bin it lives in.","index":"eq","key":false,"max":16,"name":"bin","secret":false,"since":1,"ty":{"kind":"string"}},{"default":null,"doc":"How many are in the bin.","index":"ordered","key":false,"max":null,"name":"qty","secret":false,"since":1,"ty":{"kind":"u32"}},{"default":null,"doc":"Who sells it.","index":null,"key":false,"max":80,"name":"supplier","secret":false,"since":2,"ty":{"kind":"option","of":{"kind":"string"}}},{"default":null,"doc":"Which face changed it last: `cli` or `web`.","index":null,"key":false,"max":16,"name":"by","secret":false,"since":2,"ty":{"kind":"option","of":{"kind":"string"}}},{"default":null,"doc":"When it last changed.","index":null,"key":false,"max":null,"name":"at","secret":false,"since":2,"ty":{"kind":"option","of":{"kind":"millis"}}}],"hash_keys":false,"key":"id","max_value":2000,"mirror_limit":5000,"per_person":false,"replicas":[],"type":"Part","version":2};

const Part = defineRecord({
  app: 'parts-demo', collection: 'parts', version: 2, type: 'Part', doc: 'A part on a shelf: one row of the parts-demo inventory.',
  fields: {
    id: field.id().key(),
    name: field.string().max(120).doc('What it is.'),
    bin: field.string().index().max(16).doc('The shelf bin it lives in.'),
    qty: field.u32().ordered().doc('How many are in the bin.'),
    supplier: field.string().optional().since(2).max(80).doc('Who sells it.'),
    by: field.string().optional().since(2).max(16).doc('Which face changed it last: `cli` or `web`.'),
    at: field.millis().optional().since(2).doc('When it last changed.'),
  },
});

test('defineRecord equals the generated meta of the same Rust struct', () => {
  assert.deepEqual(Part.meta, generated);
  assert.deepEqual(schemaEntry(Part.meta), schemaEntry(generated));
  const row: RowOf<typeof Part> = { id: '01J', name: 'screw', bin: 'A4', qty: 1 }; // optional fields may be absent
  assert.equal(row.supplier, undefined);
});

test('defineRecord refuses a record without exactly one key', () => {
  assert.throws(() => defineRecord({ app: 'a', collection: 'c', version: 1, fields: { x: field.string() } }), /exactly one field is .key\(\)/);
  assert.throws(() => defineRecord({ app: 'a b', collection: 'c', version: 1, fields: { x: field.id().key() } }), /not a name/);
});
