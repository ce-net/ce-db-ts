// A schema change is a compile error in TypeScript too: tsc passes the v2 caller on the v2 schema and fails it, with
// the expected error codes, on each changed schema (test-types/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

// tsc does not take -p and files together: the options of tsconfig.json, by hand
function tscFile(file: string): { code: number | null; out: string } {
  const args = [tsc, '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', '--types', 'node', '--skipLibCheck', `test-types/${file}`];
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
test('the v2 caller compiles on the v2 schema', () => {
  const r = tscFile('v2-compiles.ts');
  assert.equal(r.code, 0, r.out);
});

for (const [file, codes] of [
  ['field-removed.ts', ['TS2353', 'TS2339']],
  ['type-changed.ts', ['TS2322']],
  ['generated-field-removed.ts', ['TS2353', 'TS2339']],
] as const) {
  test(`a schema change breaks the caller at compile time: ${file}`, () => {
    const r = tscFile(file);
    assert.notEqual(r.code, 0, `expected tsc to fail:\n${r.out}`);
    for (const c of codes) assert.ok(r.out.includes(c), `expected ${c} in:\n${r.out}`);
    console.log(r.out.trim());
  });
}
