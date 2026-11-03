import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions } from '../src/tools.js';
import { booleanFlag, startupSettings } from '../src/config.js';

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

const tokens = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' };

test('disabled tools parse exact comma-separated names, with empty entries ignored', () => {
  for (const [raw, expected] of [
    [undefined, []], ['', []], [' , \t, ', []],
    [' send_message, ,fetch_history,send_message ', ['send_message', 'fetch_history', 'send_message']],
    [toolDefinitions.map(t => t.name).join(','), toolDefinitions.map(t => t.name)],
  ] as const) {
    const result = startupSettings(['--stdio'], { ...tokens, SLACK_DISABLED_TOOLS: raw });
    assert.ok('settings' in result);
    assert.deepEqual(result.settings.disabledTools, expected);
  }
});

test('unknown disabled tool names return a clean refusal naming the bad value', () => {
  for (const bad of ['misspelled', 'SEND_MESSAGE', '*', 'fetch_history fetch_thread', 'bad\nname']) {
    assert.deepEqual(startupSettings(['--stdio'], { ...tokens, SLACK_DISABLED_TOOLS: `send_message,${bad}` }), {
      refusal: `SLACK_DISABLED_TOOLS names an unknown tool: ${JSON.stringify(bad)}`,
    });
  }
});
