// Schema change: `bin` is gone. The v2 caller no longer compiles: `bin` is not a field (TS2353) and `byBin` is not a
// method (TS2339).
import { defineRecord, field, type Db } from '../src/node.js';

export const Part = defineRecord({
  app: 'shop', collection: 'parts', version: 3,
  fields: { id: field.id().key(), name: field.string(), qty: field.u32().ordered() },
});

export async function caller(db: Db): Promise<void> {
  const parts = Part.of(db);
  const id = await parts.insert({ name: 'M3 screw', bin: 'A4', qty: 500 });
  await parts.update(id, (p) => { p.qty -= 1; });
  const inA4 = await parts.byBin('A4').fetch();
  void inA4;
}
