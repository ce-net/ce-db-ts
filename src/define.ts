// Define a record in TypeScript: the same RecordMeta `#[derive(Record)]` and `ce-wire-gen --records` make, written by
// hand for an app that has no Rust schema crate. The TypeScript type of a row is inferred from the fields, and the
// collection gets one `by<Field>` per declared index, as the generated code has:
//
//   const Task = defineRecord({ app: 'todo', collection: 'tasks', version: 1, fields: {
//     id: field.id().key(), title: field.string().max(200), done: field.bool().index() } });
//   type Task = RowOf<typeof Task>;                       // { id: string; title: string; done: boolean }
//   const tasks = Task.of(db);                             // tasks.byDone(false).fetch()
//
// When an app has a Rust schema crate, generate from it instead (`ce-wire-gen --records`): one source for every
// language. A record defined here registers the same schema entry a Rust struct with the same fields would.
import type { FieldKind, FieldMeta, RecordMeta } from './core.js';
import { MAX_VALUE } from './core.js';
import type { Collection, Db, Query, Range } from './db.js';

type Index = 'eq' | 'ordered' | null;

/** One field: its TypeScript type `T`, whether it is optional `O`, its index `I`, whether it is the key `K`. */
export class Field<T, O extends boolean = false, I extends Index = null, K extends boolean = false, A extends boolean = false> {
  /** @internal */ declare readonly _t: T;
  /** @internal */ declare readonly _o: O;
  /** @internal */ declare readonly _i: I;
  /** @internal */ declare readonly _k: K;
  /** @internal */ declare readonly _auto: A;
  constructor(
    /** @internal */ readonly spec: Omit<FieldMeta, 'name'>,
  ) {}
  private with<T2 = T, O2 extends boolean = O, I2 extends Index = I, K2 extends boolean = K>(p: Partial<Omit<FieldMeta, 'name'>>): Field<T2, O2, I2, K2, A> {
    return new Field<T2, O2, I2, K2, A>({ ...this.spec, ...p });
  }
  /** The row's key (exactly one field). An `id` key is made (a ULID) when an insert leaves it out. */
  key(): Field<T, O, I, true, A> {
    return this.with({ key: true });
  }
  /** An equality index: `by<Field>(v)`. */
  index(): Field<T, O, 'eq', K, A> {
    return this.with({ index: 'eq' });
  }
  /** A range index: `by<Field>({ gte, lt, ... })`, ascending or `.desc()`. */
  ordered(): Field<T, O, 'ordered', K, A> {
    return this.with({ index: 'ordered' });
  }
  /** At most `n` characters (strings) or items (lists). */
  max(n: number): Field<T, O, I, K, A> {
    return this.with({ max: n });
  }
  /** The schema version that added the field (default 1). */
  since(v: number): Field<T, O, I, K, A> {
    return this.with({ since: v });
  }
  doc(text: string): Field<T, O, I, K, A> {
    return this.with({ doc: text });
  }
  /** Never indexed; kept out of logs. */
  secret(): Field<T, O, I, K, A> {
    return this.with({ secret: true });
  }
  /** May be absent: `T | undefined`, written as no key. */
  optional(): Field<T, true, I, K, A> {
    return this.with<T, true, I, K>({ ty: { kind: 'option', of: this.spec.ty } });
  }
}

const mk = <T, A extends boolean = false>(ty: FieldKind) => new Field<T, false, null, false, A>({ ty, key: false, index: null, max: null, since: 1, default: null, secret: false, doc: '' });

/** The field types, the same set as ce-db-core's `Field` codecs. */
export const field = {
  string: () => mk<string>({ kind: 'string' }),
  bool: () => mk<boolean>({ kind: 'bool' }),
  u8: () => mk<number>({ kind: 'u8' }),
  u16: () => mk<number>({ kind: 'u16' }),
  u32: () => mk<number>({ kind: 'u32' }),
  i8: () => mk<number>({ kind: 'i8' }),
  i16: () => mk<number>({ kind: 'i16' }),
  i32: () => mk<number>({ kind: 'i32' }),
  /** Decimal string on the wire, `bigint` here. */
  u64: () => mk<bigint>({ kind: 'u64' }),
  i64: () => mk<bigint>({ kind: 'i64' }),
  f64: () => mk<number>({ kind: 'f64' }),
  /** A 26-character ULID. */
  id: () => mk<string, true>({ kind: 'id' }),
  /** Milliseconds since the epoch. */
  millis: () => mk<number>({ kind: 'millis' }),
  /** Bytes, lowercase hex on the wire. */
  hex: () => mk<Uint8Array>({ kind: 'hex' }),
  list: <T>(of: Field<T, boolean, Index, boolean, boolean>) => mk<T[]>({ kind: 'list', of: of.spec.ty }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyField = Field<any, boolean, Index, boolean, boolean>;
type Fields = Record<string, AnyField>;
type TypeOf<F> = F extends Field<infer T, boolean, Index, boolean, boolean> ? T : never;
type OptKeys<FS extends Fields> = { [P in keyof FS]: FS[P] extends Field<unknown, true, Index, boolean, boolean> ? P : never }[keyof FS];
type KeyOf<FS extends Fields> = { [P in keyof FS]: FS[P] extends Field<unknown, boolean, Index, true, boolean> ? P : never }[keyof FS];
type Simplify<X> = { [P in keyof X]: X[P] } & {};

/** A stored row of the record. */
export type Row<FS extends Fields> = Simplify<{ [P in Exclude<keyof FS, OptKeys<FS>>]: TypeOf<FS[P]> } & { [P in OptKeys<FS>]?: TypeOf<FS[P]> }>;
/** What `insert` takes: the row, with an `id` key optional (made when left out). */
export type NewRow<FS extends Fields> = Simplify<
  FS[KeyOf<FS>] extends Field<string, boolean, Index, true, true> ? Omit<Row<FS>, KeyOf<FS>> & { [P in KeyOf<FS>]?: string } : Row<FS>
>;

type IndexedKeys<FS extends Fields> = { [P in keyof FS & string]: FS[P] extends Field<unknown, boolean, 'eq' | 'ordered', boolean, boolean> ? P : never }[keyof FS & string];
type ByOne<F, T> = F extends Field<infer V, boolean, 'ordered', boolean, boolean> ? (r: Range<V>) => Query<T> : (v: TypeOf<F>) => Query<T>;
type ByMethods<FS extends Fields, T> = { [P in IndexedKeys<FS> as `by${Capitalize<P>}`]: ByOne<FS[P], T> };

/** A collection of a defined record: the six verbs, queries, watch, and one `by<Field>` per declared index. */
export type TypedCollection<FS extends Fields> = Collection<Row<FS>, NewRow<FS>> & ByMethods<FS, Row<FS>>;

export interface Defined<FS extends Fields> {
  readonly meta: RecordMeta;
  /** The typed collection of `db` (opened with `open(app)`). */
  of(db: Db): TypedCollection<FS>;
}

export interface Definition<FS extends Fields> {
  app: string;
  collection: string;
  /** The schema version: raise it when a field is added (`field.x().since(n)`). */
  version: number;
  fields: FS;
  /** The type name in the registered schema (default: the collection name, capitalized). */
  type?: string;
  doc?: string;
  /** Rows a live mirror holds before index queries answer NeedsServerIndex (default 5,000). */
  mirrorLimit?: number;
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Define a record; checked at once (names, exactly one key, no secret index). */
export function defineRecord<const FS extends Fields>(d: Definition<FS>): Defined<FS> {
  for (const n of [d.app, d.collection]) if (!NAME.test(n)) throw new Error(`defineRecord: '${n}' is not a name ([A-Za-z0-9._-]{1,64})`);
  const fields: FieldMeta[] = Object.entries(d.fields).map(([name, f]) => ({ name, ...f.spec }));
  const keys = fields.filter((f) => f.key);
  if (keys.length !== 1) throw new Error(`defineRecord ${d.app}/${d.collection}: exactly one field is .key(), found ${keys.length}`);
  for (const f of fields) if (f.secret && f.index) throw new Error(`defineRecord: a secret field is never indexed (${f.name})`);
  const meta: RecordMeta = {
    type: d.type ?? d.collection.charAt(0).toUpperCase() + d.collection.slice(1),
    app: d.app,
    collection: d.collection,
    version: d.version,
    consistency: 'lww',
    key: keys[0].name,
    doc: d.doc ?? '',
    hash_keys: false,
    per_person: false,
    replicas: [],
    mirror_limit: d.mirrorLimit ?? 5000,
    max_value: MAX_VALUE,
    fields,
  };
  return {
    meta,
    of(db: Db) {
      const c = db.collection<Row<FS>, NewRow<FS>>(meta);
      const by: Record<string, (x: unknown) => Query<Row<FS>>> = {};
      for (const f of fields) {
        if (!f.index) continue;
        const m = `by${f.name.charAt(0).toUpperCase()}${f.name.slice(1)}`;
        by[m] = f.index === 'ordered' ? (r) => c.indexRange(f.name, r as Range<unknown>) : (v) => c.indexEq(f.name, v);
      }
      return Object.assign(c, by) as TypedCollection<FS>;
    },
  };
}

/** The row type of a defined record: `type Task = RowOf<typeof Task>`. */
export type RowOf<D> = D extends Defined<infer FS> ? Row<FS> : never;
