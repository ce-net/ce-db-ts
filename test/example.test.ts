// The quickstart example, run as a stranger would: a dev store, CE_DB_STORE and CE_DB_CAP, then the compiled example.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let child: ChildProcess | null = null;
after(() => child?.kill());

test('examples/quickstart.ts: define, insert, query, watch', async () => {
  const bin = process.env.CE_DB_DEV_STORE ?? 'ce-db-dev-store';
  child = spawn(bin, ['--listen', '127.0.0.1:0', '--grant', 'dev=state.quickstart.*'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const addr = await new Promise<string>((res, rej) => {
    child!.on('error', rej);
    child!.stdout!.on('data', (b: Buffer) => {
      const m = /listening (\S+)/.exec(b.toString());
      if (m) res(m[1]);
    });
  });
  const run = () => spawnSync(process.execPath, ['examples/dist/quickstart.js'], { cwd: root, encoding: 'utf8', env: { ...process.env, CE_DB_STORE: addr, CE_DB_CAP: 'dev' } });
  const a = run();
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.stdout, /open tasks: 1/);
  assert.match(a.stdout, /kind: 'synced'/);
  assert.match(a.stdout, /kind: 'added'[\s\S]*buy milk/);
  const b = run();
  assert.match(b.stdout, /open tasks: 2/, b.stdout + b.stderr);
  console.log(b.stdout.trim());
});
