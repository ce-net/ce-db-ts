// Schema change: `qty` became a string. The v2 caller no longer compiles: 500 is not a string (TS2322), and
// arithmetic on it is a type error (TS2362/TS2363 or TS2322).
import { defineRecord, field, type Db } from '../src/node.js';

export const Part = defineRecord({
  app: 'shop', collection: 'parts', version: 3,
  fields: { id: field.id().key(), name: field.string(), bin: field.string().index(), qty: field.string().ordered() },
});

export async function caller(db: Db): Promise<void> {
  const parts = Part.of(db);
  const id = await parts.insert({ name: 'M3 screw', bin: 'A4', qty: 500 });
  await parts.update(id, (p) => { p.qty -= 1; });
  const low = await parts.byQty({ lt: 20 }).fetch();
  void low;
}
