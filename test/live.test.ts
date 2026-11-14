// Against a dev store (ce-db-dev-store from ce-db-rs): $CE_DB_DEV_STORE names the binary, else it is looked up on PATH.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { open, DbError, type RecordMeta } from '../src/node.js';

const meta: RecordMeta = {
  type: 'Part', app: 't-parts', collection: 'parts', version: 1, consistency: 'lww', key: 'id', doc: '', hash_keys: false, per_person: false, replicas: [], mirror_limit: 5000, max_value: 2000,
  fields: [
    { name: 'id', ty: { kind: 'id' }, key: true, index: null, max: null, since: 1, default: null, secret: false, doc: '' },
    { name: 'name', ty: { kind: 'string' }, key: false, index: null, max: 120, since: 1, default: null, secret: false, doc: '' },
    { name: 'bin', ty: { kind: 'string' }, key: false, index: 'eq', max: null, since: 1, default: null, secret: false, doc: '' },
    { name: 'qty', ty: { kind: 'u32' }, key: false, index: 'ordered', max: null, since: 1, default: null, secret: false, doc: '' },
  ],
};
interface Part { id: string; name: string; bin: string; qty: number }

let child: ChildProcess | null = null;
async function devStore(): Promise<string> {
  const bin = process.env.CE_DB_DEV_STORE ?? 'ce-db-dev-store';
  child = spawn(bin, ['--listen', '127.0.0.1:0', '--grant', 'rw=state.tparts.*', '--grant', 'ro=state.tparts.parts.read'], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => {
    child!.on('error', rej);
    child!.stdout!.on('data', (b: Buffer) => {
      const m = /listening (\S+)/.exec(b.toString());
      if (m) res(m[1]);
    });
  });
}
after(() => child?.kill());

test('typed crud, index queries and a live watch against a dev store', async () => {
  const addr = await devStore();
  const db = await open('t-parts', { store: addr, cap: 'rw' });
  const p = db.collection<Part, Omit<Part, 'id'> & { id?: string }>(meta);
  const id = await p.insert({ name: 'M3x8 screw', bin: 'A4', qty: 500 });
  assert.deepEqual(await p.get(id), { id, name: 'M3x8 screw', bin: 'A4', qty: 500 });
  await assert.rejects(p.insert({ id, name: 'x', bin: 'A4', qty: 1 }), (e: DbError) => e.info.kind === 'Conflict');
  await p.insert({ name: 'nut', bin: 'A4', qty: 12 });
  await p.insert({ name: 'washer', bin: 'B1', qty: 3 });
  assert.equal((await p.indexEq('bin', 'A4').fetch()).length, 2);
  assert.deepEqual((await p.indexRange('qty', { lt: 20 }).fetch()).map((x) => x.name), ['washer', 'nut']);
  const w = await p.indexEq('bin', 'A4').watch();
  const seen: string[] = [];
  for (;;) {
    const c = await w.next(2000);
    assert.ok(c);
    seen.push(c.kind);
    if (c.kind === 'synced') break;
  }
  assert.deepEqual(seen, ['added', 'added', 'synced']);
  // another connection writes
  const other = (await open('t-parts', { store: addr, cap: 'rw' })).collection<Part>(meta);
  const t0 = Date.now();
  await other.update(id, (x) => {
    x.qty = 499;
  });
  const ch = await w.next(3000);
  assert.equal(ch?.kind, 'changed');
  assert.ok(Date.now() - t0 < 1000, `live within a second: ${Date.now() - t0} ms`);
  await other.update(id, (x) => {
    x.bin = 'C9';
  });
  assert.deepEqual(await w.next(3000), { kind: 'removed', key: id });
  w.close();
  const ro = (await open('t-parts', { store: addr, cap: 'ro' })).collection<Part, Omit<Part, 'id'>>(meta);
  await assert.rejects(ro.insert({ name: 'p', bin: 'A', qty: 1 }), (e: DbError) => e.info.kind === 'Refused' && (e.info as { need: string }).need === 'state.tparts.parts.write');
  db.close();
  other;
});

test('nothing listening: Unavailable within 2 s', async () => {
  const t0 = Date.now();
  await assert.rejects(open('t-parts', { store: '127.0.0.1:1', cap: 'rw' }), (e: DbError) => e.info.kind === 'Unavailable');
  assert.ok(Date.now() - t0 < 2500);
});
