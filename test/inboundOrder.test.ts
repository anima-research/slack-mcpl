/**
 * Incoming Slack events reach the host in arrival order within a conversation,
 * however long the lookups before delivery take for each.
 *
 * Run: node --import tsx --test test/inboundOrder.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, type SlackMessageData, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';

function adapter(lookupMs: Record<string, number>) {
  let handler: Parameters<SlackSocketLike['on']>[1] | undefined;
  const web = {
    users: {
      async info({ user }: { user: string }) {
        await new Promise((r) => setTimeout(r, lookupMs[user] ?? 0));
        return { user: { name: user, real_name: user, profile: { display_name: user }, is_bot: false } };
      },
    },
  } as unknown as SlackWebLike;
  const socket: SlackSocketLike = { on(_event, cb) { handler = cb; }, async start() {}, async disconnect() {} };
  const slack = new SlackAdapter(web, socket, 'UBOT', 'acme');
  const seen: string[] = [];
  slack.onMessage((m: SlackMessageData) => seen.push(`${m.channelId}:${m.id}`));
  const emit = (channel: string, ts: string, user: string) =>
    handler!({ event: { type: 'message', channel, channel_type: 'channel', user, ts, text: 'hi' }, ack: async () => {} });
  return { seen, emit };
}

test('a later message whose lookup finishes first still follows the earlier one', async () => {
  const { seen, emit } = adapter({ U1: 40 });
  emit('C1', '1.0', 'U1');
  emit('C1', '2.0', 'U2');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(seen, ['C1:1.0', 'C1:2.0']);
});

test('conversations stay independent: a slow lookup in one holds nothing in another', async () => {
  const { seen, emit } = adapter({ U1: 40 });
  emit('C1', '1.0', 'U1');
  emit('C2', '2.0', 'U2');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['C2:2.0']);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, ['C2:2.0', 'C1:1.0']);
});

test('an event that fails to handle does not hold the next in its conversation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { seen, emit } = adapter({});
  emit('C1', '1.0', 'U1');
  // No ts: dropped before any lookup. A malformed one is handled, not thrown
  // on, and either way the next event must still arrive.
  emit('C1', '', 'U1');
  emit('C1', '3.0', 'U2');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['C1:1.0', 'C1:3.0']);
});
