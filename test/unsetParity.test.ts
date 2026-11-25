/** Differential compatibility oracle captured from #65, not handwritten wording. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('unset tool text, manifest, notices and subscription results match the pre-bot-delivery baseline', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-unset-parity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'subscriptions.json');
  writeFileSync(file, '["C9"]');
  const actual = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx',
    'test/fixtures/unset-parity-worker.mjs', root], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SLACK_SUBSCRIPTIONS_FILE: file },
  }));
  const expected = JSON.parse(readFileSync(new URL('./fixtures/unset-parity.json', import.meta.url), 'utf8'));
  assert.deepEqual(actual, expected);
  assert.equal(readFileSync(file, 'utf8'), '["C9"]');
});
