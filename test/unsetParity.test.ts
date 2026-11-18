/** Differential compatibility oracle captured from #65, not handwritten wording. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('unset tool text, manifest, notices and subscription results equal #65 (44e95bd3)', () => {
  const actual = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx',
    'test/fixtures/unset-parity-worker.mjs', root], { cwd: root, encoding: 'utf8' }));
  const expected = JSON.parse(readFileSync(new URL('./fixtures/unset-parity-44e95bd3.json', import.meta.url), 'utf8'));
  assert.deepEqual(actual, expected);
});
