/**
 * push/event names the MCPL channel it came from (#5), so a host can route
 * and show typing for a conversation it has not opened, such as a DM.
 *
 * Run: node --import tsx --test test/pushOrigin.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until } from './harness.js';

test('push/event origin carries mcplChannelId next to the raw Slack ID', async () => {
  const h = harness();
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');

  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push/event');
  const origin = (h.hostSaw.find((r) => r.method === method.PUSH_EVENT)!.params as {
    origin: Record<string, unknown>;
  }).origin;
  assert.equal(origin.channelId, 'C1');
  assert.equal(origin.mcplChannelId, 'slack:C1');
  await h.close();
});
