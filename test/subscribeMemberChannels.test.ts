/**
 * Tests for SLACK_SUBSCRIBE_MEMBER_CHANNELS.
 *
 * Run: node --import tsx --test test/subscribeMemberChannels.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackMcplServer } from '../src/server.js';

test('every delivered channel counts as subscribed when the switch is on', () => {
  delete process.env.SLACK_SUBSCRIPTIONS_FILE;
  const server = new SlackMcplServer({} as any) as any;
  delete process.env.SLACK_SUBSCRIBE_MEMBER_CHANNELS;
  assert.equal(server.isChannelSubscribed('C1'), false);
  process.env.SLACK_SUBSCRIBE_MEMBER_CHANNELS = 'true';
  try {
    assert.equal(server.isChannelSubscribed('C1'), true);
  } finally {
    delete process.env.SLACK_SUBSCRIBE_MEMBER_CHANNELS;
  }
});
