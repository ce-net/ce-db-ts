// The caller code of every case here, on the schema it was written for: it compiles.
import { defineRecord, field, type Db } from '../src/node.js';

export const Part = defineRecord({
  app: 'shop', collection: 'parts', version: 2,
  fields: { id: field.id().key(), name: field.string(), bin: field.string().index(), qty: field.u32().ordered() },
});

export async function caller(db: Db): Promise<void> {
  const parts = Part.of(db);
  const id = await parts.insert({ name: 'M3 screw', bin: 'A4', qty: 500 });
  await parts.update(id, (p) => { p.qty -= 1; });
  const inA4 = await parts.byBin('A4').fetch();
  const low = await parts.byQty({ lt: 20 }).fetch();
  const n: number = inA4.length + low[0].qty;
  void n;
}
