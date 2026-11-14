// A StoreConn over a generated state.store client (node or web; both have the same shape). One connection, opened
// on first use and again after it breaks. A read that fails on a broken connection is tried once more on a fresh
// one; a write is never resent once it may have reached the store.
import { classify, DbError } from './core.js';
import type { Doc, StoreConn } from './db.js';

interface Coll {
  app: string;
  coll: string;
}

/** The generated StateStoreClient, as far as ce-db uses it. */
export interface WireClient {
  get(r: { at: Coll; key: string; cap: string }): Promise<Doc | null>;
  put(r: { at: Coll; key: string; value: string; if_version: bigint | null; insert_only: boolean; cap: string }): Promise<Doc>;
  patch(r: { at: Coll; key: string; fields: string; cap: string }): Promise<Doc>;
  delete(r: { at: Coll; key: string; cap: string }): Promise<null>;
  list(r: { at: Coll; prefix: string; since: bigint; limit: number; include_deleted: boolean; cap: string }): Promise<{ docs: Doc[]; next: bigint | null }>;
  schema(r: { app: string; cap: string }): Promise<string | null>;
  schemaPut(r: { app: string; schema: string; cap: string }): Promise<null>;
  watch(r: { at: Coll; since: bigint; cap: string }): { next(timeoutMs?: number): Promise<Doc | undefined>; close(): void };
  close(): void;
}

/** The generated module's error classes (each generated file has its own). */
export interface WireErrors {
  Refused: abstract new (...a: never[]) => Error & { kind: string; detail: unknown };
  WireError: abstract new (...a: never[]) => Error;
}

export function wireConn(connect: () => Promise<WireClient>, cap: string, errs: WireErrors, label: string): StoreConn {
  let cur: Promise<WireClient> | null = null;
  const client = (): Promise<WireClient> => {
    if (!cur) {
      cur = connect();
      cur.catch(() => (cur = null));
    }
    return cur;
  };
  const drop = (c: Promise<WireClient> | null) => {
    if (c && cur === c) {
      cur = null;
      void c.then((x) => x.close()).catch(() => {});
    }
  };
  const map = (e: unknown, app: string, coll: string): DbError => {
    if (e instanceof DbError) return e;
    if (e instanceof errs.Refused) {
      if (e.kind === 'Remote') return classify(String(e.detail), app, coll);
      if (e.kind === 'Right') return new DbError({ kind: 'Refused', need: String(e.detail) });
      return new DbError({ kind: 'Unavailable', tried: [`${label}: ${e.message}`] });
    }
    return new DbError({ kind: 'Unavailable', tried: [`${label}: ${(e as Error)?.message ?? String(e)}`] });
  };
  const run = async <R>(write: boolean, app: string, coll: string, f: (c: WireClient) => Promise<R>): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      const p = client();
      let c: WireClient;
      try {
        c = await p;
      } catch (e) {
        throw map(e, app, coll);
      }
      try {
        return await f(c);
      } catch (e) {
        const broken = !(e instanceof errs.Refused) && !(e instanceof DbError);
        if (broken) drop(p);
        if (broken && !write && attempt === 0) continue;
        const d = map(e, app, coll);
        if (broken && write && d.info.kind === 'Unavailable') d.info.tried.push('not resent: the write may have landed');
        throw d;
      }
    }
  };
  const at = (app: string, coll: string): Coll => ({ app, coll });
  return {
    get: (app, coll, key) => run(false, app, coll, (c) => c.get({ at: at(app, coll), key, cap })),
    put: (app, coll, key, value, ifVersion) => run(true, app, coll, (c) => c.put({ at: at(app, coll), key, value, if_version: ifVersion, insert_only: false, cap })),
    patch: (app, coll, key, fields) => run(true, app, coll, (c) => c.patch({ at: at(app, coll), key, fields, cap })),
    delete: async (app, coll, key) => {
      await run(true, app, coll, (c) => c.delete({ at: at(app, coll), key, cap }));
    },
    list: (app, coll, prefix, since, limit, includeDeleted) => run(false, app, coll, (c) => c.list({ at: at(app, coll), prefix, since, limit, include_deleted: includeDeleted, cap })),
    schema: (app) => run(false, app, '', (c) => c.schema({ app, cap })),
    schemaPut: async (app, schema) => {
      await run(true, app, '', (c) => c.schemaPut({ app, schema, cap }));
    },
    watch(app, coll, since) {
      let sub: { next(): Promise<Doc | undefined>; close(): void } | null = null;
      let closed = false;
      return {
        close() {
          closed = true;
          sub?.close();
        },
        async *[Symbol.asyncIterator]() {
          const p = client();
          let c: WireClient;
          try {
            c = await p;
          } catch (e) {
            throw map(e, app, coll);
          }
          sub = c.watch({ at: at(app, coll), since, cap });
          try {
            for (;;) {
              if (closed) return;
              const d = await sub.next();
              if (d === undefined) return;
              yield d;
            }
          } catch (e) {
            if (!(e instanceof errs.Refused)) drop(p);
            throw map(e, app, coll);
          }
        },
      };
    },
    close() {
      drop(cur);
    },
  };
}
