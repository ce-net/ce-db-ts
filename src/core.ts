// ce-db core for TypeScript: the record meta the generator emits, the canonical value encoding (the same bytes
// ce-db-rs writes), ULIDs and the typed error. No transport here.
// Contract: repo:state-store-cell/docs/DB-SDK-DESIGN.md section 1.3.

export const MAX_VALUE = 2000;

export type FieldKind =
  | { kind: 'string' | 'bool' | 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'u64' | 'i64' | 'f64' | 'id' | 'millis' | 'hex' }
  | { kind: 'list' | 'option'; of: FieldKind };

export interface FieldMeta {
  name: string;
  ty: FieldKind;
  key: boolean;
  index: 'eq' | 'ordered' | null;
  max: number | null;
  since: number;
  default: unknown;
  secret: boolean;
  doc: string;
}

/** One collection's schema, as `#[derive(Record)]` made it (`ce-wire-gen --records` copies it into the generated file). */
export interface RecordMeta {
  type: string;
  app: string;
  collection: string;
  version: number;
  consistency: string;
  key: string;
  doc: string;
  hash_keys: boolean;
  per_person: boolean;
  replicas: string[];
  mirror_limit: number;
  max_value: number;
  fields: FieldMeta[];
}

// ---------------------------------------------------------------- errors

export type DbErrorInfo =
  | { kind: 'NotFound'; key: string }
  | { kind: 'Conflict'; heldVersion: bigint }
  | { kind: 'Invalid'; field: string; why: string }
  | { kind: 'Refused'; need: string }
  | { kind: 'TooLarge'; bytes: number; limit: number }
  | { kind: 'Throttled'; retryAfterMs: number }
  | { kind: 'SchemaMissing'; app: string; coll: string }
  | { kind: 'SchemaBehind'; app: string; coll: string; registered: number; compiled: number }
  | { kind: 'Unavailable'; tried: string[] }
  | { kind: 'NeedsServerIndex'; rows: number; limit: number }
  | { kind: 'Store'; message: string };

/** Every failure of every verb; switch on `info.kind`, never on the message. */
export class DbError extends Error {
  readonly info: DbErrorInfo;
  constructor(info: DbErrorInfo) {
    super(describe(info));
    this.info = info;
    this.name = 'DbError';
  }
  get kind(): DbErrorInfo['kind'] {
    return this.info.kind;
  }
}

function describe(i: DbErrorInfo): string {
  switch (i.kind) {
    case 'NotFound':
      return `not found: ${i.key}`;
    case 'Conflict':
      return `conflict: the store holds version ${i.heldVersion}`;
    case 'Invalid':
      return `invalid ${i.field}: ${i.why}`;
    case 'Refused':
      return `refused: the grant lacks ${i.need}`;
    case 'TooLarge':
      return `too large: ${i.bytes} bytes, the limit is ${i.limit}`;
    case 'Throttled':
      return `throttled: retry after ${i.retryAfterMs} ms`;
    case 'SchemaMissing':
      return `schema missing: ${i.app}/${i.coll} is not registered and this grant cannot register it (${right(i.app, null, 'admin')})`;
    case 'SchemaBehind':
      return `schema behind: ${i.app}/${i.coll} is registered at version ${i.registered}, this program has ${i.compiled}`;
    case 'Unavailable':
      return `unavailable: ${i.tried.join('; ')}`;
    case 'NeedsServerIndex':
      return `needs a server index: ${i.rows} rows, the mirror holds at most ${i.limit}`;
    case 'Store':
      return `store: ${i.message}`;
  }
}

/** The engine's right name: app and collection lowercased, everything but [a-z0-9] dropped. */
export function right(app: string, coll: string | null, verb: string): string {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return coll === null ? `state.${n(app)}.${verb}` : `state.${n(app)}.${n(coll)}.${verb}`;
}

/** The store answers in text; this is the one place that reads it (the same rules as ce-db-core `classify`). */
export function classify(msg: string, app: string, coll: string): DbError {
  const m = msg.trim();
  const na = m.indexOf('not authorized');
  if (na >= 0) {
    const parts = m.slice(na).split(': ');
    return new DbError({ kind: 'Refused', need: parts[parts.length - 1].trim().replace(/["')]+$/, '') });
  }
  const vc = m.indexOf('version conflict');
  if (vc >= 0) {
    const nums = m.slice(vc).match(/\d+/g);
    return new DbError({ kind: 'Conflict', heldVersion: BigInt(nums ? nums[nums.length - 1] : '0') });
  }
  if (m.includes('has no schema') || m.includes('is not in the schema')) return new DbError({ kind: 'SchemaMissing', app, coll });
  if (m.includes('value too large')) return new DbError({ kind: 'TooLarge', bytes: 0, limit: MAX_VALUE });
  if (m.startsWith('value is ')) return new DbError({ kind: 'TooLarge', bytes: Number(m.split(' ')[2]) || 0, limit: MAX_VALUE });
  if (m.startsWith('value.')) {
    const i = m.indexOf(': ');
    if (i > 0) return new DbError({ kind: 'Invalid', field: m.slice(6, i), why: m.slice(i + 2) });
  }
  if (m.startsWith('value: ') || m.startsWith('value is not JSON') || m.startsWith('bad key')) return new DbError({ kind: 'Invalid', field: 'value', why: m });
  if (m.startsWith('store unavailable: ') || m.includes('every replica unavailable')) return new DbError({ kind: 'Unavailable', tried: [m] });
  return new DbError({ kind: 'Store', message: m });
}

// ---------------------------------------------------------------- ULID

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48-bit unix ms + 80 random bits, Crockford base32; sorts by creation time. */
export function ulid(now: number = Date.now()): string {
  const r = new Uint8Array(10);
  globalThis.crypto.getRandomValues(r);
  let n = BigInt(now) & ((1n << 48n) - 1n);
  for (const b of r) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 26; i++) {
    s = CROCKFORD[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

export function isUlid(s: string): boolean {
  return s.length === 26 && s[0] <= '7' && [...s].every((c) => CROCKFORD.includes(c));
}

// ---------------------------------------------------------------- canonical JSON

function cmpCodePoints(a: string, b: string): number {
  // code point order is UTF-8 byte order, which is how Rust sorts the keys
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** The canonical JSON text: keys sorted, no whitespace, integral numbers without a fraction. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new DbError({ kind: 'Invalid', field: 'value', why: 'not a finite number' });
      return Object.is(v, -0) ? '0' : JSON.stringify(v).replace('e+', 'e');
    }
    if (typeof v === 'bigint') return v.toString();
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmpCodePoints);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ---------------------------------------------------------------- field codecs

const SMALL: Record<string, [number, number]> = {
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
};
const BIG: Record<string, [bigint, bigint]> = {
  u64: [0n, (1n << 64n) - 1n],
  i64: [-(1n << 63n), (1n << 63n) - 1n],
};

function bad(field: string, why: string): never {
  throw new DbError({ kind: 'Invalid', field, why });
}

/** A typed field to JSON; `undefined` = absent. */
export function encodeField(ty: FieldKind, v: unknown, field: string): unknown {
  if (ty.kind === 'option') return v === undefined || v === null ? undefined : encodeField(ty.of, v, field);
  if (v === undefined || v === null) bad(field, 'missing');
  switch (ty.kind) {
    case 'string':
      return typeof v === 'string' ? v : bad(field, 'expected a string');
    case 'bool':
      return typeof v === 'boolean' ? v : bad(field, 'expected a boolean');
    case 'f64':
      return typeof v === 'number' && Number.isFinite(v) ? v : bad(field, 'expected a finite number');
    case 'millis':
      return typeof v === 'number' && Number.isSafeInteger(v) ? v : bad(field, 'expected integer unix ms');
    case 'id':
      return typeof v === 'string' && isUlid(v) ? v : bad(field, `not a ULID: ${String(v)}`);
    case 'hex': {
      if (!(v instanceof Uint8Array)) bad(field, 'expected a Uint8Array');
      return [...(v as Uint8Array)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    case 'list':
      return Array.isArray(v) ? v.map((x, i) => encodeField(ty.of, x, `${field}[${i}]`) ?? null) : bad(field, 'expected a list');
    case 'u64':
    case 'i64': {
      const b = typeof v === 'bigint' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : bad(field, 'expected a bigint');
      const [lo, hi] = BIG[ty.kind];
      if (b < lo || b > hi) bad(field, `out of range of ${ty.kind}`);
      return b.toString();
    }
    default: {
      const [lo, hi] = SMALL[ty.kind];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) bad(field, `expected an integer in ${ty.kind}`);
      return v;
    }
  }
}

/** JSON to a typed field; `j` undefined = absent. */
export function decodeField(ty: FieldKind, j: unknown, field: string): unknown {
  if (ty.kind === 'option') return j === undefined || j === null ? undefined : decodeField(ty.of, j, field);
  if (j === undefined || j === null) bad(field, 'missing');
  switch (ty.kind) {
    case 'string':
      return typeof j === 'string' ? j : bad(field, 'expected a string');
    case 'bool':
      return typeof j === 'boolean' ? j : bad(field, 'expected a bool');
    case 'f64':
      return typeof j === 'number' ? j : bad(field, 'expected a number');
    case 'millis':
      return typeof j === 'number' && Number.isInteger(j) ? j : bad(field, 'expected integer unix ms');
    case 'id':
      return typeof j === 'string' && isUlid(j) ? j : bad(field, `not a ULID: ${String(j)}`);
    case 'hex': {
      if (typeof j !== 'string' || !/^([0-9a-f]{2})*$/.test(j)) bad(field, 'expected lowercase hex');
      const s = j as string;
      const out = new Uint8Array(s.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
      return out;
    }
    case 'list':
      return Array.isArray(j) ? j.map((x, i) => decodeField(ty.of, x, `${field}[${i}]`)) : bad(field, 'expected a list');
    case 'u64':
    case 'i64': {
      if (typeof j !== 'string' || !/^-?\d+$/.test(j)) bad(field, `expected a decimal string (${ty.kind} is a string on the wire)`);
      return BigInt(j as string);
    }
    default: {
      const [lo, hi] = SMALL[ty.kind];
      if (typeof j !== 'number' || !Number.isInteger(j) || j < lo || j > hi) bad(field, `expected an integer in ${ty.kind}`);
      return j;
    }
  }
}

function boundLen(v: unknown): number | null {
  if (typeof v === 'string') return utf8Len(v);
  if (Array.isArray(v) || v instanceof Uint8Array) return v.length;
  return null;
}

/** The fields of `rec` as JSON (no `_v`), checked against `max` bounds. */
export function encodeFields(meta: RecordMeta, rec: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of meta.fields) {
    const j = encodeField(f.ty, rec[f.name], f.name);
    if (f.max !== null) {
      const n = boundLen(rec[f.name]);
      if (n !== null && n > f.max) bad(f.name, `${n} long, the limit is ${f.max}`);
    }
    if (j !== undefined) o[f.name] = j;
  }
  return o;
}

/** The stored text of `rec` with `extra` (unknown fields read earlier): checked before any network call. */
export function encode(meta: RecordMeta, rec: object, extra: Record<string, unknown> = {}): string {
  const o: Record<string, unknown> = { ...extra, ...encodeFields(meta, rec as Record<string, unknown>), _v: meta.version };
  const s = canonical(o);
  const n = utf8Len(s);
  if (n > MAX_VALUE) throw new DbError({ kind: 'TooLarge', bytes: n, limit: MAX_VALUE });
  return s;
}

export interface Decoded<T> {
  value: T;
  extra: Record<string, unknown>;
  writerVersion: number;
}

export function decodeObj<T>(meta: RecordMeta, o: Record<string, unknown>): Decoded<T> {
  const value: Record<string, unknown> = {};
  for (const f of meta.fields) {
    const j = o[f.name];
    if ((j === undefined || j === null) && f.default !== null && f.default !== undefined) value[f.name] = decodeField(f.ty, f.default, f.name);
    else {
      const v = decodeField(f.ty, j, f.name);
      if (v !== undefined) value[f.name] = v;
    }
  }
  const known = new Set(meta.fields.map((f) => f.name));
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k !== '_v' && !known.has(k)) extra[k] = v;
  return { value: value as T, extra, writerVersion: typeof o._v === 'number' ? o._v : 1 };
}

export function decode<T>(meta: RecordMeta, text: string): Decoded<T> {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch (e) {
    bad('value', `not JSON: ${(e as Error).message}`);
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) bad('value', 'not an object');
  return decodeObj<T>(meta, o as Record<string, unknown>);
}

/** Top-level fields that differ: what `update` sends as a Patch; a cleared field is null. */
export function diff(old: Record<string, unknown>, now: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(now)) if (canonical(old[k] ?? null) !== canonical(v) || !(k in old)) d[k] = v;
  for (const k of Object.keys(old)) if (!(k in now)) d[k] = null;
  return d;
}

// ---------------------------------------------------------------- index values

/** An index key; null (an absent optional) sorts first. */
export type IndexVal = null | boolean | bigint | number | string;

function rank(v: IndexVal): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'string') return 3;
  return 2;
}

export function cmpIndex(a: IndexVal, b: IndexVal): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return Number(a) - Number(b);
  if (ra === 3) return cmpCodePoints(a as string, b as string);
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const x = Number(a);
  const y = Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The index key of a typed field value. */
export function indexOf(ty: FieldKind, v: unknown): IndexVal {
  if (v === undefined || v === null) return null;
  const k = ty.kind === 'option' ? ty.of.kind : ty.kind;
  if (k === 'u64' || k === 'i64') return typeof v === 'bigint' ? v : BigInt(v as number);
  if (k === 'hex') return encodeField({ kind: 'hex' }, v, 'index') as string;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'bigint') return v;
  return null;
}
