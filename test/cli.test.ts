import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cliInvocation } from './cliHarness.js';
import { startupSettings } from '../src/config.js';

/** Start the CLI with no inherited SLACK_* settings or real Slack traffic. */
function startWith(vars: Record<string, string>, allowSlackStartup = false) {
  const { args, options } = cliInvocation(vars, allowSlackStartup);
  return spawnSync(process.execPath, args, { ...options, input: '', encoding: 'utf8' });
}

test('a bad switch stops startup with one line, before Slack is contacted', () => {
  const run = startWith({ SLACK_DISABLE_DMS: 'maybe' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'SLACK_DISABLE_DMS must be true or false, got "maybe"\n');
});

test('index refuses a bad disabled tool on one line before contacting Slack', () => {
  const run = startWith({ SLACK_DISABLED_TOOLS: 'send_message,bad\nname' });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'SLACK_DISABLED_TOOLS names an unknown tool: "bad\\nname"\n');
});

test('startup logs that no tools are disabled by default', () => {
  const run = startWith({}, true);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /writes: anywhere; DMs: on; tools off: none\n/);
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
      disabledTools: [],
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
