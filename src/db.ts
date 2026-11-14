// ce-db for TypeScript, transport-free: Db, Collection, Query, the live mirror and watch. node.ts and web.ts give it a
// StoreConn over the generated ce-wire state.store client. Same surface and rules as ce-db-rs (DB-SDK-DESIGN.md).
import {
  canonical,
  cmpIndex,
  DbError,
  decode,
  decodeObj,
  diff,
  encode,
  encodeFields,
  indexOf,
  type IndexVal,
  type RecordMeta,
  ulid,
} from './core.js';

/** The stored record as the state.store wire carries it (u64 as bigint). */
export interface Doc {
  key: string;
  value: string;
  seq: bigint;
  version: bigint;
  deleted: boolean;
}

/** What ce-db needs from a state.store connection. Errors are DbError. */
export interface StoreConn {
  get(app: string, coll: string, key: string): Promise<Doc | null>;
  put(app: string, coll: string, key: string, value: string, ifVersion: bigint | null): Promise<Doc>;
  patch(app: string, coll: string, key: string, fields: string): Promise<Doc>;
  delete(app: string, coll: string, key: string): Promise<void>;
  list(app: string, coll: string, prefix: string, since: bigint, limit: number, includeDeleted: boolean): Promise<{ docs: Doc[]; next: bigint | null }>;
  schema(app: string): Promise<string | null>;
  schemaPut(app: string, schema: string): Promise<void>;
  /** Every change after `since`, then each new one; `close()` ends it. Errors end the iteration with a throw. */
  watch(app: string, coll: string, since: bigint): AsyncIterable<Doc> & { close(): void };
  close(): void;
}

export const MAX_PAGE = 500;
export const PAGE = 500;

export type Change<T> =
  | { kind: 'added'; doc: T }
  | { kind: 'changed'; old: T; doc: T }
  | { kind: 'removed'; key: string }
  | { kind: 'synced' };

export type Link = 'connecting' | 'live' | 'resyncing' | 'offline';

export interface Range<V> {
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
}

export interface Stored<T> {
  key: string;
  value: T;
  version: bigint;
  seq: bigint;
  extra: Record<string, unknown>;
  writerVersion: number;
}

export interface Stats {
  rows: number;
  rejects: [string, string][];
  headSeq: bigint;
  watchers: number;
  link: Link;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the mirror

interface Row<T> {
  seq: bigint;
  version: bigint;
  value: T;
  raw: Record<string, unknown>;
}

type Filter<T> = (key: string, v: T) => boolean;

class Sub<T> {
  q: (Change<T> | Error)[] = [];
  wake: (() => void) | null = null;
  closed = false;
  constructor(
    readonly filter: Filter<T>,
    readonly m: Mirror<T>,
  ) {}
  push(c: Change<T> | Error): void {
    if (this.closed) return;
    this.q.push(c);
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

/** A live watch: `for await (const ch of w)`; `close()` stops it. The shared stream stays for other watchers. */
export class Watch<T> implements AsyncIterable<Change<T>> {
  constructor(private s: Sub<T>) {}
  /** The next change, or undefined after `timeoutMs` with none. */
  async next(timeoutMs?: number): Promise<Change<T> | undefined> {
    for (;;) {
      if (this.s.q.length) {
        const c = this.s.q.shift()!;
        if (c instanceof Error) throw c;
        return c;
      }
      if (this.s.closed) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await new Promise<boolean>((res) => {
        this.s.wake = () => res(false);
        if (timeoutMs !== undefined) timer = setTimeout(() => res(true), timeoutMs);
      });
      if (timer) clearTimeout(timer);
      if (timedOut) {
        this.s.wake = null;
        return undefined;
      }
    }
  }
  close(): void {
    this.s.closed = true;
    this.s.m.subs.delete(this.s);
    const w = this.s.wake;
    this.s.wake = null;
    w?.();
  }
  get link(): Link {
    return this.s.m.link;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Change<T>> {
    try {
      for (;;) {
        const c = await this.next();
        if (c === undefined) return;
        yield c;
      }
    } finally {
      this.close();
    }
  }
}

class Mirror<T> {
  rows = new Map<string, Row<T>>();
  rejects = new Map<string, string>();
  head = 0n;
  synced = false;
  link: Link = 'connecting';
  error: DbError | null = null;
  subs = new Set<Sub<T>>();
  private waiters: (() => void)[] = [];
  private linkCbs = new Set<(l: Link) => void>();
  private stream: { close(): void } | null = null;
  private stopped = false;

  constructor(
    readonly meta: RecordMeta,
    readonly conn: StoreConn,
    readonly app: string,
  ) {
    void this.run();
  }

  onLink(cb: (l: Link) => void): () => void {
    this.linkCbs.add(cb);
    return () => this.linkCbs.delete(cb);
  }

  private setLink(l: Link): void {
    if (this.link === l) return;
    this.link = l;
    for (const cb of this.linkCbs) cb(l);
  }

  private notify(key: string, old: T | undefined, now: T | undefined): void {
    for (const s of this.subs) {
      const was = old !== undefined && s.filter(key, old);
      const is = now !== undefined && s.filter(key, now);
      if (!was && is) s.push({ kind: 'added', doc: now! });
      else if (was && is) s.push({ kind: 'changed', old: old!, doc: now! });
      else if (was && !is) s.push({ kind: 'removed', key });
    }
  }

  apply(d: Doc): void {
    if (d.seq > this.head) this.head = d.seq;
    const held = this.rows.get(d.key);
    if (held && held.seq >= d.seq) return;
    if (d.deleted) {
      this.rejects.delete(d.key);
      if (held) {
        this.rows.delete(d.key);
        this.notify(d.key, held.value, undefined);
      }
      return;
    }
    let raw: Record<string, unknown>;
    let value: T;
    try {
      raw = JSON.parse(d.value);
      value = decodeObj<T>(this.meta, raw).value;
    } catch (e) {
      // never dropped silently: counted, and its old typed value leaves the result
      if (held) {
        this.rows.delete(d.key);
        this.notify(d.key, held.value, undefined);
      }
      this.rejects.set(d.key, (e as Error).message);
      return;
    }
    this.rejects.delete(d.key);
    this.rows.set(d.key, { seq: d.seq, version: d.version, value, raw });
    this.notify(d.key, held?.value, value);
  }

  removeLocal(key: string): void {
    const held = this.rows.get(key);
    if (!held) return;
    this.rows.delete(key);
    this.notify(key, held.value, undefined);
  }

  async ready(timeoutMs = 10000): Promise<void> {
    if (!this.synced) {
      await Promise.race([
        new Promise<void>((r) => this.waiters.push(r)),
        sleep(timeoutMs).then(() => {
          if (!this.synced)
            throw new DbError({ kind: 'Unavailable', tried: [`the mirror of ${this.meta.collection} did not load within ${timeoutMs / 1000} s (${this.link})`] });
        }),
      ]);
    }
    if (this.error) throw this.error;
  }

  subscribe(filter: Filter<T>, order: (a: [string, T], b: [string, T]) => number): Watch<T> {
    const s = new Sub<T>(filter, this);
    const now = [...this.rows.entries()].map(([k, r]) => [k, r.value] as [string, T]).filter(([k, v]) => filter(k, v));
    now.sort(order);
    for (const [, v] of now) s.q.push({ kind: 'added', doc: v });
    s.q.push({ kind: 'synced' });
    this.subs.add(s);
    return new Watch(s);
  }

  /** Walk the collection (tombstones included) and make the mirror equal to it, telling watchers the difference. */
  private async resync(): Promise<void> {
    const docs = new Map<string, Doc>();
    let since = 0n;
    let head = 0n;
    for (;;) {
      const p = await this.conn.list(this.app, this.meta.collection, '', since, MAX_PAGE, true);
      for (const d of p.docs) {
        if (d.seq > head) head = d.seq;
        if (d.deleted) docs.delete(d.key);
        else docs.set(d.key, d);
      }
      if (docs.size > this.meta.mirror_limit) throw new DbError({ kind: 'NeedsServerIndex', rows: docs.size, limit: this.meta.mirror_limit });
      if (p.next !== null && p.next > since) since = p.next;
      else break;
    }
    for (const k of [...this.rows.keys()]) if (!docs.has(k)) this.removeLocal(k);
    for (const d of docs.values()) {
      const r = this.rows.get(d.key);
      if (r) {
        let same = false;
        try {
          same = canonical(JSON.parse(d.value)) === canonical(r.raw);
        } catch {
          same = false;
        }
        if (same) {
          r.seq = d.seq;
          r.version = d.version;
          continue;
        }
        r.seq = 0n;
      }
      this.apply(d);
    }
    this.head = head;
    this.synced = true;
    this.error = null;
    for (const w of this.waiters.splice(0)) w();
  }

  private async run(): Promise<void> {
    let backoff = 200;
    let needList = true;
    while (!this.stopped) {
      if (needList) {
        try {
          await this.resync();
          needList = false;
        } catch (e) {
          if (e instanceof DbError && e.info.kind === 'NeedsServerIndex') {
            this.error = e;
            this.synced = true;
            this.setLink('offline');
            for (const w of this.waiters.splice(0)) w();
            return;
          }
          this.setLink('offline');
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30000);
          continue;
        }
      }
      const t0 = Date.now();
      try {
        const w = this.conn.watch(this.app, this.meta.collection, this.head);
        this.stream = w;
        this.setLink('live');
        for await (const d of w) {
          this.apply(d);
          backoff = 200;
        }
      } catch {
        // falls through to the reconnect below
      }
      this.stream = null;
      if (this.stopped) return;
      this.setLink('offline');
      if (Date.now() - t0 > 10000) backoff = 200;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
      this.setLink('resyncing');
      // the same connection factory reaches the same replica in slice 1: resume from the head (DB-SDK-DESIGN.md 4.1)
    }
  }

  stop(): void {
    this.stopped = true;
    this.stream?.close();
  }
}

// ---------------------------------------------------------------- collection and query

type Kind = { t: 'prefix'; p: string } | { t: 'eq'; f: string; v: IndexVal } | { t: 'range'; f: string; r: Range<IndexVal> };

function inRange(v: IndexVal, r: Range<IndexVal>): boolean {
  if (v === null) return false;
  if (r.gt !== undefined && !(cmpIndex(v, r.gt) > 0)) return false;
  if (r.gte !== undefined && !(cmpIndex(v, r.gte) >= 0)) return false;
  if (r.lt !== undefined && !(cmpIndex(v, r.lt) < 0)) return false;
  if (r.lte !== undefined && !(cmpIndex(v, r.lte) <= 0)) return false;
  return true;
}

function hexOf(s: string): string {
  return [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s: string): string {
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return new TextDecoder().decode(b);
}
function ivJson(v: IndexVal): unknown {
  return typeof v === 'bigint' ? { b: v.toString() } : typeof v === 'string' ? { s: v } : v;
}
function ivFrom(j: unknown): IndexVal {
  if (j !== null && typeof j === 'object') {
    const o = j as { b?: string; s?: string };
    return o.b !== undefined ? BigInt(o.b) : (o.s ?? null);
  }
  return j as IndexVal;
}

/** One index or one prefix. Immutable: each modifier returns a new query. */
export class Query<T> {
  constructor(
    private c: Collection<T, unknown>,
    private kind: Kind,
    private lim: number | null = null,
    private cursor: string | null = null,
    private descending = false,
  ) {}
  limit(n: number): Query<T> {
    return new Query(this.c, this.kind, n, this.cursor, this.descending);
  }
  after(cursor: string): Query<T> {
    return new Query(this.c, this.kind, this.lim, cursor, this.descending);
  }
  desc(): Query<T> {
    return new Query(this.c, this.kind, this.lim, this.cursor, true);
  }

  /** @internal */
  filter(): Filter<T> {
    const k = this.kind;
    const meta = this.c.meta;
    if (k.t === 'prefix') return (key) => key.startsWith(k.p);
    const f = meta.fields.find((x) => x.name === k.f)!;
    if (k.t === 'eq') return (_, v) => cmpIndex(indexOf(f.ty, (v as Record<string, unknown>)[k.f]), k.v) === 0;
    return (_, v) => inRange(indexOf(f.ty, (v as Record<string, unknown>)[k.f]), k.r);
  }

  private ivOf(v: T): IndexVal {
    if (this.kind.t === 'prefix') return null;
    const name = this.kind.f;
    const f = this.c.meta.fields.find((x) => x.name === name)!;
    return indexOf(f.ty, (v as Record<string, unknown>)[name]);
  }

  /** @internal (index value, key) order, or key order for a prefix. */
  order(): (a: [string, T], b: [string, T]) => number {
    const sign = this.descending ? -1 : 1;
    return (a, b) => sign * (cmpIndex(this.ivOf(a[1]), this.ivOf(b[1])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  private get serverSide(): boolean {
    return this.kind.t === 'prefix' && !this.descending;
  }

  /** One page and the cursor of the next (null at the end). */
  async fetchPage(): Promise<{ rows: T[]; next: string | null }> {
    const p = await this.page(this.lim ?? PAGE, this.cursor);
    return { rows: p.rows, next: p.next };
  }

  /** Every matching row up to `limit` (all of them without one). */
  async fetch(): Promise<T[]> {
    return (await this.fetchWithRejects()).rows;
  }

  /** `fetch`, and rows that matched but do not decode into T: never dropped silently. */
  async fetchWithRejects(): Promise<{ rows: T[]; rejects: [string, string][] }> {
    const want = this.lim ?? Infinity;
    const rows: T[] = [];
    const rejects: [string, string][] = [];
    let after = this.cursor;
    for (;;) {
      const p = await this.page(Math.min(want - rows.length, PAGE), after);
      rows.push(...p.rows);
      rejects.push(...p.rejects);
      if (p.next === null || rows.length >= want) return { rows, rejects };
      after = p.next;
    }
  }

  async count(): Promise<number> {
    if (this.serverSide) return (await this.fetch()).length;
    const m = await this.c.mirror();
    const f = this.filter();
    let n = 0;
    for (const [k, r] of m.rows) if (f(k, r.value)) n++;
    return n;
  }

  /** Rows entering, changing inside and leaving the result, after the rows in it now and a 'synced'. */
  async watch(): Promise<Watch<T>> {
    const m = await this.c.mirror();
    return m.subscribe(this.filter(), this.order());
  }

  /** For UI frameworks: React `useSyncExternalStore(s.subscribe, s.getSnapshot)`, Svelte `{ subscribe }`-style. */
  store(): LiveQuery<T> {
    return new LiveQuery(this);
  }

  private async page(n: number, after: string | null): Promise<{ rows: T[]; rejects: [string, string][]; next: string | null }> {
    n = Math.max(1, n);
    if (this.serverSide) {
      const k = this.kind as { t: 'prefix'; p: string };
      let since = 0n;
      if (after !== null) {
        if (!/^s\d+$/.test(after)) throw new DbError({ kind: 'Invalid', field: 'cursor', why: 'not a cursor of this query' });
        since = BigInt(after.slice(1));
      }
      await this.c.prep();
      const p = await this.c.conn.list(this.c.app, this.c.meta.collection, k.p, since, Math.min(n, MAX_PAGE), false);
      const rows: T[] = [];
      const rejects: [string, string][] = [];
      for (const d of p.docs) {
        try {
          rows.push(decode<T>(this.c.meta, d.value).value);
        } catch (e) {
          rejects.push([d.key, (e as Error).message]);
        }
      }
      return { rows, rejects, next: p.next === null ? null : `s${p.next}` };
    }
    const m = await this.c.mirror();
    const f = this.filter();
    const hits = [...m.rows.entries()].map(([k, r]) => [k, r.value] as [string, T]).filter(([k, v]) => f(k, v));
    const ord = this.order();
    hits.sort(ord);
    let start = 0;
    if (after !== null) {
      let pos: [IndexVal, string];
      try {
        if (!after.startsWith('m')) throw new Error();
        const j = JSON.parse(unhex(after.slice(1)));
        pos = [ivFrom(j[0]), String(j[1])];
      } catch {
        throw new DbError({ kind: 'Invalid', field: 'cursor', why: 'not a cursor of this query' });
      }
      const sign = this.descending ? -1 : 1;
      start = hits.findIndex(([k, v]) => sign * (cmpIndex(this.ivOf(v), pos[0]) || (k < pos[1] ? -1 : k > pos[1] ? 1 : 0)) > 0);
      if (start < 0) start = hits.length;
    }
    const page = hits.slice(start, start + n);
    const last = page[page.length - 1];
    const next = start + page.length < hits.length && last ? `m${hexOf(canonical([ivJson(this.ivOf(last[1])), last[0]]))}` : null;
    return { rows: page.map(([, v]) => v), rejects: [...m.rejects.entries()], next };
  }
}

/** A query's current rows, kept live: subscribe for changes, read with getSnapshot (a stable array between changes). */
export class LiveQuery<T> {
  private rows = new Map<string, T>();
  private snap: T[] = [];
  private cbs = new Set<() => void>();
  private w: Watch<T> | null = null;
  private starting: Promise<void> | null = null;
  constructor(private q: Query<T>) {}
  private key(v: T): string {
    return String((v as Record<string, unknown>)[(this.q as unknown as { c: Collection<T, unknown> }).c.meta.key]);
  }
  private rebuild(): void {
    const ord = this.q.order();
    this.snap = [...this.rows.entries()].sort(ord).map(([, v]) => v);
    for (const cb of this.cbs) cb();
  }
  private start(): void {
    if (this.starting) return;
    this.starting = (async () => {
      this.w = await this.q.watch();
      for await (const ch of this.w) {
        if (ch.kind === 'added' || ch.kind === 'changed') this.rows.set(this.key(ch.doc), ch.doc);
        else if (ch.kind === 'removed') this.rows.delete(ch.key);
        if (ch.kind !== 'added' || this.synced) this.rebuild();
        if (ch.kind === 'synced') this.synced = true;
      }
    })();
  }
  private synced = false;
  subscribe = (cb: () => void): (() => void) => {
    this.cbs.add(cb);
    this.start();
    return () => {
      this.cbs.delete(cb);
      if (this.cbs.size === 0) {
        this.w?.close();
        this.w = null;
        this.starting = null;
        this.synced = false;
        this.rows.clear();
      }
    };
  };
  getSnapshot = (): T[] => this.snap;
}

/** A typed collection. `N` is what `insert` takes (the key may be left out when it is a ULID). */
export class Collection<T, N = T> {
  /** @internal */ readonly conn: StoreConn;
  /** @internal */ readonly app: string;
  constructor(
    private db: Db,
    readonly meta: RecordMeta,
  ) {
    this.conn = db.conn;
    this.app = db.app;
  }

  /** @internal The first use checks (or registers) the schema; later calls reuse that answer. */
  prep(): Promise<void> {
    return this.db.ensureSchema(this.meta, schemaEntry(this.meta));
  }

  /** @internal */
  async mirror(): Promise<Mirror<T>> {
    await this.prep();
    return this.db.mirrorOf<T>(this.meta);
  }

  private keyOf(v: unknown): string {
    const k = (v as Record<string, unknown>)[this.meta.key];
    if (typeof k !== 'string' || k === '') throw new DbError({ kind: 'Invalid', field: this.meta.key, why: 'the key is missing' });
    return k;
  }

  private own(d: Doc): void {
    this.db.openMirror<T>(this.meta)?.apply(d);
  }

  /** Create the row; `Conflict` when the key exists. Returns the key (made here when it is a ULID and left out). */
  async insert(rec: N): Promise<string> {
    await this.prep();
    const keyField = this.meta.fields.find((f) => f.key)!;
    const r = { ...(rec as object) } as Record<string, unknown>;
    if ((r[this.meta.key] === undefined || r[this.meta.key] === '') && keyField.ty.kind === 'id') r[this.meta.key] = ulid();
    const key = this.keyOf(r);
    const value = encode(this.meta, r);
    this.own(await this.conn.put(this.app, this.meta.collection, key, value, 0n));
    return key;
  }

  async get(key: string): Promise<T | undefined> {
    return (await this.getStored(key))?.value;
  }

  async getStored(key: string): Promise<Stored<T> | undefined> {
    await this.prep();
    const d = await this.conn.get(this.app, this.meta.collection, key);
    if (!d) return undefined;
    const dec = decode<T>(this.meta, d.value);
    return { key: d.key, value: dec.value, version: d.version, seq: d.seq, extra: dec.extra, writerVersion: dec.writerVersion };
  }

  /** Change fields: `f` edits a copy of the current value (or returns a new one); only changed fields go to the
   *  store (Patch), so a field this program does not know is never erased. `NotFound` when there is no such row. */
  async update(key: string, f: (v: T) => T | void): Promise<T> {
    const cur = await this.getStored(key);
    if (!cur) throw new DbError({ kind: 'NotFound', key });
    const copy = structuredClone(cur.value) as T;
    const next = (f(copy) ?? copy) as T;
    if (this.keyOf(next) !== key) throw new DbError({ kind: 'Invalid', field: this.meta.key, why: 'update cannot change the key' });
    encode(this.meta, next as object, cur.extra);
    const fields = diff(encodeFields(this.meta, cur.value as Record<string, unknown>), encodeFields(this.meta, next as Record<string, unknown>));
    if (Object.keys(fields).length === 0) return next;
    fields._v = this.meta.version;
    const d = await this.conn.patch(this.app, this.meta.collection, key, canonical(fields));
    this.own(d);
    return decode<T>(this.meta, d.value).value;
  }

  /** Write the whole value (unknown fields of the stored row are lost; prefer update). Returns the new version. */
  async replace(rec: T): Promise<bigint> {
    await this.prep();
    const d = await this.conn.put(this.app, this.meta.collection, this.keyOf(rec), encode(this.meta, rec as object), null);
    this.own(d);
    return d.version;
  }

  /** Compare-and-set over `s.version`, unknown fields kept; else `Conflict`. */
  async replaceStored(s: Stored<T>): Promise<bigint> {
    await this.prep();
    const d = await this.conn.put(this.app, this.meta.collection, s.key, encode(this.meta, s.value as object, s.extra), s.version);
    this.own(d);
    return d.version;
  }

  async remove(key: string): Promise<void> {
    await this.prep();
    await this.conn.delete(this.app, this.meta.collection, key);
    this.db.openMirror<T>(this.meta)?.removeLocal(key);
  }

  prefix(p: string): Query<T> {
    return new Query<T>(this as Collection<T, unknown>, { t: 'prefix', p });
  }
  all(): Query<T> {
    return this.prefix('');
  }
  indexEq(field: string, v: unknown): Query<T> {
    const f = this.meta.fields.find((x) => x.name === field && x.index !== null);
    if (!f) throw new DbError({ kind: 'Invalid', field, why: 'not an indexed field' });
    return new Query<T>(this as Collection<T, unknown>, { t: 'eq', f: field, v: indexOf(f.ty, v) });
  }
  indexRange(field: string, r: Range<unknown>): Query<T> {
    const f = this.meta.fields.find((x) => x.name === field && x.index === 'ordered');
    if (!f) throw new DbError({ kind: 'Invalid', field, why: 'not an ordered index' });
    const m = (v: unknown) => (v === undefined ? undefined : indexOf(f.ty, v));
    return new Query<T>(this as Collection<T, unknown>, { t: 'range', f: field, r: { gt: m(r.gt), gte: m(r.gte), lt: m(r.lt), lte: m(r.lte) } });
  }
  watch(): Promise<Watch<T>> {
    return this.all().watch();
  }
  async watchKey(key: string): Promise<Watch<T>> {
    const m = await this.mirror();
    return m.subscribe((k) => k === key, () => 0);
  }
  /** The live link of this collection, and changes of it. */
  async onLink(cb: (l: Link) => void): Promise<() => void> {
    const m = await this.mirror();
    cb(m.link);
    return m.onLink(cb);
  }
  stats(): Stats {
    const m = this.db.openMirror<T>(this.meta);
    if (!m) return { rows: 0, rejects: [], headSeq: 0n, watchers: 0, link: 'connecting' };
    return { rows: m.rows.size, rejects: [...m.rejects.entries()], headSeq: m.head, watchers: m.subs.size, link: m.link };
  }
}

/** One app's view of state.store. */
export class Db {
  private mirrors = new Map<string, Mirror<unknown>>();
  private checked = new Map<string, Promise<void>>();
  constructor(
    readonly app: string,
    readonly conn: StoreConn,
  ) {}

  /** The typed collection for a generated meta; generated code calls this (`parts(db)`). */
  collection<T, N = T>(meta: RecordMeta): Collection<T, N> {
    if (meta.app !== this.app) throw new DbError({ kind: 'Invalid', field: 'app', why: `${meta.type} belongs to app ${meta.app}, this Db is ${this.app}` });
    return new Collection<T, N>(this, meta);
  }

  /** Read the registered schema; register this program's when it is missing or older (needs state.<app>.admin). */
  ensureSchema(meta: RecordMeta, entry: unknown): Promise<void> {
    let p = this.checked.get(meta.collection);
    if (!p) {
      p = this.checkSchema(meta, entry);
      this.checked.set(meta.collection, p);
      p.catch(() => this.checked.delete(meta.collection));
    }
    return p;
  }

  private async checkSchema(meta: RecordMeta, entry: unknown): Promise<void> {
    const text = await this.conn.schema(this.app);
    const doc = (text ? JSON.parse(text) : { app: this.app, collections: {} }) as { collections?: Record<string, unknown>; replicas?: string[] };
    const have = doc.collections?.[meta.collection] as { version?: number } | undefined;
    const registered = have ? (have.version ?? 1) : null;
    if (have && (canonical(have) === canonical(entry) || (registered ?? 1) > meta.version)) return;
    doc.collections = { ...(doc.collections ?? {}), [meta.collection]: entry };
    if (meta.replicas.length) doc.replicas = meta.replicas;
    try {
      await this.conn.schemaPut(this.app, JSON.stringify(doc));
    } catch (e) {
      if (e instanceof DbError && e.info.kind === 'Refused')
        throw registered === null
          ? new DbError({ kind: 'SchemaMissing', app: this.app, coll: meta.collection })
          : new DbError({ kind: 'SchemaBehind', app: this.app, coll: meta.collection, registered, compiled: meta.version });
      throw e;
    }
  }

  /** @internal */
  async mirrorOf<T>(meta: RecordMeta): Promise<Mirror<T>> {
    let m = this.mirrors.get(meta.collection) as Mirror<T> | undefined;
    if (!m) {
      m = new Mirror<T>(meta, this.conn, this.app);
      this.mirrors.set(meta.collection, m as Mirror<unknown>);
    }
    await m.ready();
    return m;
  }

  /** @internal */
  openMirror<T>(meta: RecordMeta): Mirror<T> | undefined {
    return this.mirrors.get(meta.collection) as Mirror<T> | undefined;
  }

  close(): void {
    for (const m of this.mirrors.values()) m.stop();
    this.conn.close();
  }
}

/** The schema entry of a collection, as ce-db-core `Meta::schema_entry` writes it (the generated `json` has the same). */
export function schemaEntry(meta: RecordMeta): unknown {
  const props: Record<string, unknown> = {};
  const required = ['_v'];
  const js = (t: RecordMeta['fields'][number]['ty']): Record<string, unknown> => {
    switch (t.kind) {
      case 'string':
      case 'u64':
      case 'i64':
      case 'id':
      case 'hex':
        return { type: 'string' };
      case 'bool':
        return { type: 'boolean' };
      case 'f64':
        return { type: 'number' };
      case 'list':
        return { type: 'array', items: js(t.of) };
      case 'option': {
        const s = js(t.of);
        return typeof s.type === 'string' ? { ...s, type: [s.type, 'null'] } : s;
      }
      default:
        return { type: 'integer' };
    }
  };
  for (const f of meta.fields) {
    props[f.name] = js(f.ty);
    if (f.ty.kind !== 'option' && (f.default === null || f.default === undefined)) required.push(f.name);
  }
  props._v = { type: 'integer' };
  return {
    value: { type: 'object', properties: props, required },
    hash_keys: meta.hash_keys,
    per_person: meta.per_person,
    version: meta.version,
    consistency: meta.consistency,
    key: meta.key,
    indexes: meta.fields.filter((f) => f.index !== null).map((f) => ({ field: f.name, ordered: f.index === 'ordered' })),
    limits: { max_value: meta.max_value, mirror_limit: meta.mirror_limit },
  };
}
