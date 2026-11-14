// @ce-net/db/web: the same typed collections in a browser, ce-wire over a WebSocket (wire.ws-door, or a cell's own
// dev pipe). The grant comes from the page's link fragment as generated web clients take it: `#g=<seed>.<chain>&w=<wss
// url>`; `cap=<hex>` in the fragment is the state.store cap. Nothing secret is ever in the query string.
import { DbError } from './core.js';
import { wireConn, type WireClient } from './conn.js';
import { Db } from './db.js';
import { everyoneGrant, grantFromLink, Refused, StateStoreClient, WireError, type Grant } from './wire/web/StateStore.js';

export * from './core.js';
export * from './db.js';
export * from './define.js';

export interface OpenOptions {
  /** WebSocket URL of the door. Default: `w=` in the fragment, else this page's origin + `/wire`. */
  url?: string;
  /** The page's grant. Default: `g=` in the fragment; without one, an unsigned Hello (only a dev store takes it). */
  grant?: Grant;
  /** The state.store cap. Default: `cap=` in the fragment. */
  cap?: string;
}

function frag(): URLSearchParams {
  return new URLSearchParams(typeof location === 'undefined' ? '' : location.hash.slice(1));
}

export async function open(app: string, o: OpenOptions = {}): Promise<Db> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(app)) throw new DbError({ kind: 'Invalid', field: 'app', why: '1..=64 of [A-Za-z0-9._-]' });
  const f = frag();
  const cap = (o.cap ?? f.get('cap') ?? '').trim();
  if (!cap) throw new DbError({ kind: 'Refused', need: `a grant for ${app}: cap= in the link` });
  const url = o.url ?? f.get('w') ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wire`;
  const g = o.grant ?? (o.url ? null : grantFromLink()) ?? everyoneGrant(url, '');
  const conn = wireConn(async () => (await StateStoreClient.connect({ ...g, url: g.url || url }, 2000)) as unknown as WireClient, cap, { Refused, WireError }, url);
  try {
    await conn.schema(app);
  } catch (e) {
    if (e instanceof DbError && e.info.kind === 'Unavailable') throw e;
  }
  return new Db(app, conn);
}
