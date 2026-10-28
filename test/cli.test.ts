import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startupSettings } from '../src/config.js';

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
  const run = startWith({ SLACK_DISABLE_DMS: 'maybe' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'SLACK_DISABLE_DMS must be true or false, got "maybe"\n');
});

test('startup refuses a missing mode, missing tokens and an empty SLACK_SEND_CHANNELS, each with its own line', () => {
  const tokens = { SLACK_BOT_TOKEN: 'xoxb-0-test', SLACK_APP_TOKEN: 'xapp-0-test' };
  assert.deepEqual(startupSettings([], tokens), { refusal: 'Usage: slack-mcpl --stdio | --tcp <port>' });
  for (const missing of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const) {
    const rest = Object.fromEntries(Object.entries(tokens).filter(([name]) => name !== missing));
    assert.deepEqual(startupSettings(['--stdio'], rest), {
      refusal: 'SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables are required',
    }, missing);
  }
  assert.deepEqual(startupSettings(['--stdio'], { ...tokens, SLACK_SEND_CHANNELS: ' , ' }), {
    refusal: 'SLACK_SEND_CHANNELS is set but names no conversation; unset it to allow writing anywhere',
  });
});

test('startup reads every setting from the command line and the environment', () => {
  const env = {
    SLACK_BOT_TOKEN: 'xoxb-1',
    SLACK_APP_TOKEN: 'xapp-1',
    SLACK_DM_USERS: 'U1, U2',
    SLACK_SEND_CHANNELS: 'C1,,C2',
    SLACK_DISABLE_DMS: 'yes',
    SLACK_SUBSCRIBE_MEMBER_CHANNELS: '1',
    SLACK_ACK_REACTION: ':eyes:',
  };
  assert.deepEqual(startupSettings(['--tcp', '4100'], env), {
    settings: {
      useStdio: false,
      tcpPort: 4100,
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      dmUsers: ['U1', 'U2'],
      sendChannels: ['C1', 'C2'],
      disableDms: true,
      subscribeMemberChannels: true,
      ackReaction: 'eyes',
    },
  });
});

test('each bad switch is refused with one line naming it and its value', () => {
  for (const [name, raw] of [
    ['SLACK_DISABLE_DMS', 'maybe'],
    ['SLACK_DISABLE_DMS', ''],
    ['SLACK_SUBSCRIBE_MEMBER_CHANNELS', ' '],
    ['SLACK_DISABLE_DMS', '\t\n'],
  ]) {
    const started = startupSettings(['--stdio'], { SLACK_BOT_TOKEN: 'xoxb-0-test', SLACK_APP_TOKEN: 'xapp-0-test', [name]: raw });
    assert.deepEqual(started, { refusal: `${name} must be true or false, got ${JSON.stringify(raw)}` }, `${name}=${JSON.stringify(raw)}`);
  }
});
