import test from 'node:test';
import assert from 'node:assert/strict';
import { leftOutNote } from '../src/slack-adapter.js';

test('fallback exception requires an explicit configured-fallback flag', () => {
  const legacy = leftOutNote(['public_channel']);
  assert.doesNotMatch(legacy, /fallback/);
  assert.equal(leftOutNote(['public_channel'], false, false), legacy);
  assert.match(leftOutNote(['public_channel'], false, true), /Some public conversations can be checked separately/);
});
