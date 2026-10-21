/**
 * isNearMiss, the rule an unknown argument's refusal uses to name what was
 * probably meant. These are agent-framework's own tests of the rule
 * (test/closest-names.test.ts), so the copy here keeps to it, with one more:
 * a name one edit past the limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNearMiss } from '../src/near-miss.js';

test('isNearMiss: the same ignoring case, or a few edits; past that, a different name', () => {
  for (const [slip, field] of [['keyby', 'keyBy'], ['pasthrough', 'passthrough'], ['polices', 'policies'], ['tagsAyn', 'tagsAny'],
    ['refilIntervalM', 'refillIntervalMs'], ['channels', 'channel']]) {
    assert.equal(isNearMiss(slip, field), true, `${slip} for ${field}`);
  }
  for (const [other, field] of [['comment', 'content'], ['type', 'text'], ['scope', 'match']]) {
    assert.equal(isNearMiss(other, field), false, `${other} is not ${field}`);
  }
  assert.equal(isNearMiss('workspace--read', 'workspace--write'), false,
    'a shared prefix is a namespace, so neighbours in it are counted by what follows it');
  // refilIntervalM, above, is two edits from refillIntervalMs, the most a slip
  // may be with 11 characters after the shared prefix. tyytConzains is three
  // edits from textContains, which also has 11 after its prefix: one past it.
  assert.equal(isNearMiss('tyytConzains', 'textContains'), false, 'three edits are past what a slip allows here');
});

test('isNearMiss: a part of a name, of three characters or more, is a slip for it; a name holding another, more edits from it than a slip allows, is not', () => {
  for (const [part, field] of [['interval', 'intervalSeconds'], ['mode', 'deliveryMode'], ['channel', 'targetChannelId'], ['EVERY', 'everySeconds'], ['key', 'keyBy']]) {
    assert.equal(isNearMiss(part, field), true, `${part} for ${field}`);
  }
  for (const [extra, field] of [['channel_note', 'channel'], ['pausedReason', 'paused']]) {
    assert.equal(isNearMiss(extra, field), false, `${extra} is an extra beside ${field}`);
  }
  assert.equal(isNearMiss('id', 'channelId'), false, 'two characters are no part of a name');
});
