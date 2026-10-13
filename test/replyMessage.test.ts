/**
 * reply_message posts into the thread its messageId names, as README's
 * "Reply to a specific thread" says, whatever has arrived since: unlike
 * channels/publish's automatic route, the newest message plays no part.
 *
 * Run: node --import tsx --test test/replyMessage.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { FULL_GRANT, harness, initialize, until } from './harness.js';

test('reply_message posts into the thread its messageId names, whatever arrived since', async () => {
  const h = harness();
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');

  // A newer message in another thread, which the automatic route would follow.
  await h.socket.emitMessage({
    type: 'message', channel: 'C1', user: 'U3', text: '<@UBOT> elsewhere',
    ts: '1718000000.000300', thread_ts: '1718000000.000250',
  });
  await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'the newer message reaching the host');

  // README's example.
  const res = (await h.host.sendRequest('tools/call', {
    name: 'reply_message',
    arguments: { channelId: 'C1', messageId: '1718000000.000100', content: 'Here is what I found.' },
  })) as { isError?: boolean };
  assert.notEqual(res.isError, true);
  const post = h.posts.at(-1) as { channel: string; text: string; thread_ts?: string };
  assert.equal(post.channel, 'C1');
  assert.equal(post.thread_ts, '1718000000.000100');
  assert.equal(post.text, 'Here is what I found.');
  await h.close();
});
