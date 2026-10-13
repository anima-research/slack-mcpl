import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Start the CLI as an operator would, with tokens Slack would reject, so
 *  whatever it reports instead of an API error was checked before connecting.
 *  The test's own SLACK_* variables are left out. */
function startWith(vars: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('SLACK_')) env[key] = value;
  }
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--stdio'], {
    cwd: root,
    env: { ...env, SLACK_BOT_TOKEN: 'xoxb-0-test', SLACK_APP_TOKEN: 'xapp-0-test', ...vars },
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('a bad switch stops startup with one line, before Slack is contacted', () => {
  for (const [name, raw] of [
    ['SLACK_DISABLE_DMS', 'maybe'],
    ['SLACK_DISABLE_DMS', ''],
    ['SLACK_SUBSCRIBE_MEMBER_CHANNELS', ' '],
    ['SLACK_DISABLE_DMS', '\t\n'],
  ]) {
    const run = startWith({ [name]: raw });
    assert.equal(run.status, 1, `${name}=${JSON.stringify(raw)}`);
    assert.equal(run.stderr, `${name} must be true or false, got ${JSON.stringify(raw)}\n`);
  }
});
