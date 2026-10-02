import test from 'node:test';
import assert from 'node:assert/strict';
import { booleanFlag } from '../src/config.js';

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
        message: `${name} must be true or false, got "${raw}"`,
      });
    }
  }
});
