import test from 'node:test';
import assert from 'node:assert/strict';
import { booleanFlag, startupSettings } from '../src/config.js';
import { parseAccessPolicy } from '../src/access-policy.js';

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

// The startup parser is the same strict snapshot used by embedded callers.
const fallbackPolicy = { readJoinedChannels: true, writeChannels: ['C1'], dmUsers: [], historyMembershipFallbackChannels: ['C1'] };
const startupPolicy = (policy: unknown) => startupSettings(['--stdio'], {
  SLACK_BOT_TOKEN: 'synthetic', SLACK_APP_TOKEN: 'synthetic', SLACK_ACCESS_POLICY: JSON.stringify(policy),
});
test('history fallback uses strict startup policy parsing and immutable snapshots', () => {
  const config = structuredClone(fallbackPolicy);
  const parsed = parseAccessPolicy(config);
  config.historyMembershipFallbackChannels.push('C2');
  assert.deepEqual(parsed.historyMembershipFallbackChannels, ['C1']);
  assert.ok(Object.isFrozen(parsed.historyMembershipFallbackChannels));
  const start = startupPolicy(fallbackPolicy);
  assert.ok('settings' in start);
  assert.deepEqual(start.settings.accessPolicy, fallbackPolicy);
  const absent = parseAccessPolicy({ readJoinedChannels: true, writeChannels: [], dmUsers: [] });
  assert.equal(Object.hasOwn(absent, 'historyMembershipFallbackChannels'), false);
});
test('history fallback refuses malformed, non-public, unpinned and overlapping group DM entries', () => {
  for (const value of [null, undefined, false, 'C1', ['C2'], ['G1'], ['D1'], ['c1'], [1], Array(1)]) {
    assert.throws(() => parseAccessPolicy({ ...fallbackPolicy, historyMembershipFallbackChannels: value }));
  }
  for (const policy of [
    { ...fallbackPolicy, groupDms: ['C1'] },
    { ...fallbackPolicy, writeChannels: ['G1'], groupDms: ['G1'], historyMembershipFallbackChannels: ['G1'] },
    { ...fallbackPolicy, readJoinedChannels: false },
  ]) {
    assert.throws(() => parseAccessPolicy(policy));
    const start = startupPolicy(policy);
    assert.ok('refusal' in start);
    assert.match(start.refusal, /SLACK_ACCESS_POLICY/);
  }
  assert.doesNotThrow(() => parseAccessPolicy({ ...fallbackPolicy, groupDms: ['G1'] }));
});

test('group DM overlap has an explicit refusal, without broadening G-only group IDs', () => {
  assert.throws(() => parseAccessPolicy({ ...fallbackPolicy, groupDms: ['C1'] }), /must not overlap/);
  assert.throws(() => parseAccessPolicy({ ...fallbackPolicy, groupDms: ['COTHER'] }), /Invalid Slack access policy/);
});
