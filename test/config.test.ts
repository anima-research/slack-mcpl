import test from 'node:test';
import assert from 'node:assert/strict';
import { booleanFlag, startupSettings } from '../src/config.js';

test('bot message policy defaults off and accepts all or bot/user IDs', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' };
  for (const [raw, expected] of [[undefined, undefined], [' all ', 'all'], ['B1, U2,W3', ['B1', 'U2', 'W3']]] as const) {
    const started = startupSettings(['--stdio'], { ...env, SLACK_BOT_MESSAGES: raw });
    assert.ok('settings' in started);
    assert.deepEqual(started.settings.botMessages, expected);
  }
  for (const raw of ['', ' ', 'true', 'false', 'ALL', 'B1,,U2', 'all,B1', 'C1', 'name']) {
    const started = startupSettings(['--stdio'], { ...env, SLACK_BOT_MESSAGES: raw });
    assert.ok('refusal' in started, raw);
    assert.match(started.refusal, /SLACK_BOT_MESSAGES must be all or a comma-separated list of bot\/user IDs/);
  }
});

test('operator switches default off only when absent and accept explicit yes/no values', () => {
  assert.equal(booleanFlag('SWITCH', undefined), false);
  for (const raw of ['true', '1', 'yes', ' TRUE ', ' Yes ']) {
    assert.equal(booleanFlag('SWITCH', raw), true, raw);
  }
  for (const raw of ['false', '0', 'no', ' FALSE ', ' No ']) {
    assert.equal(booleanFlag('SWITCH', raw), false, raw);
  }
});

test('operator switches refuse present empty, whitespace, and unrecognized values', () => {
  for (const name of ['SLACK_DISABLE_DMS', 'SLACK_SUBSCRIBE_MEMBER_CHANNELS']) {
    for (const raw of ['', '   ', '\t\n', 'maybe', 'enabled', '2']) {
      assert.throws(() => booleanFlag(name, raw), {
        message: `${name} must be true or false, got ${JSON.stringify(raw)}`,
      });
    }
  }
});

test('bot policy refusal identifies the invalid entry and its position safely', () => {
  const result = startupSettings(['--stdio'], {
    SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test',
    SLACK_BOT_MESSAGES: 'B123,U456,wrong\nentry,B789',
  });
  assert.ok('refusal' in result);
  assert.ok(result.refusal.includes('entry 3'));
  assert.ok(result.refusal.includes(JSON.stringify('wrong\nentry')));
  assert.equal(result.refusal.split('\n').length, 1);
});
