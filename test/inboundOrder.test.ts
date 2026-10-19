/**
 * Incoming Slack events reach the host in arrival order within a conversation,
 * however long the lookups before delivery take for each.
 *
 * Run: node --import tsx --test test/inboundOrder.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackAdapter, type SlackMessageData, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';
import { FULL_GRANT, harness, initialize, until } from './harness.js';

/** A lookup's answer, which the test gives when it chooses. */
function held() {
  let release!: () => void;
  const answered = new Promise<void>((resolve) => { release = resolve; });
  return { answered, release };
}

/** Every microtask the events can run without a held answer has run. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** An adapter whose users.info for each user in `holds` waits for that
 *  promise; the others answer at once. */
function adapter(holds: Record<string, Promise<void>> = {}) {
  let handler: Parameters<SlackSocketLike['on']>[1] | undefined;
  const web = {
    users: {
      async info({ user }: { user: string }) {
        await holds[user];
        return { user: { name: user, real_name: user, profile: { display_name: user }, is_bot: false } };
      },
    },
  } as unknown as SlackWebLike;
  const socket: SlackSocketLike = { on(_event, cb) { handler = cb; }, async start() {}, async disconnect() {} };
  const slack = new SlackAdapter(web, socket, 'UBOT', 'acme');
  const seen: string[] = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  slack.onMessage((m: SlackMessageData) => {
    seen.push(`${m.channelId}:${m.id}`);
    for (const w of waiting) if (seen.length >= w.count) w.resolve();
  });
  let acks = 0;
  const emit = (channel: string, ts: string, user: string) =>
    handler!({ event: { type: 'message', channel, channel_type: 'channel', user, ts, text: 'hi' }, ack: async () => { acks++; } });
  /** Settles once `count` messages have been delivered. */
  const delivered = (count: number) => new Promise<void>((resolve) => {
    if (seen.length >= count) resolve();
    else waiting.push({ count, resolve });
  });
  return { slack, seen, emit, delivered, acks: () => acks };
}

test('a later message whose lookup finishes first still follows the earlier one, and each is acked on arrival', { timeout: 5000 }, async () => {
  const u1 = held();
  const { slack, seen, emit, delivered, acks } = adapter({ U1: u1.answered });
  emit('C1', '1.0', 'U1');
  emit('C1', '2.0', 'U2');
  await settled();
  assert.deepEqual(seen, [], "the later message waits for the earlier one's lookup");
  assert.equal(acks(), 2, 'each envelope is acked on arrival, whatever its conversation waits for');
  u1.release();
  await delivered(2);
  assert.deepEqual(seen, ['C1:1.0', 'C1:2.0']);
  await settled();
  // White-box: the map is private, and an idle conversation keeps no entry.
  assert.equal((slack as unknown as { inbound: Map<string, unknown> }).inbound.size, 0);
});

test('conversations stay independent: a lookup held in one holds nothing in another', { timeout: 5000 }, async () => {
  const u1 = held();
  const { seen, emit, delivered } = adapter({ U1: u1.answered });
  emit('C1', '1.0', 'U1');
  emit('C2', '2.0', 'U2');
  await delivered(1);
  assert.deepEqual(seen, ['C2:2.0']);
  u1.release();
  await delivered(2);
  assert.deepEqual(seen, ['C2:2.0', 'C1:1.0']);
});

test('a handler that throws on one message does not hold the next in its conversation', { timeout: 5000 }, async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { slack, seen, emit, delivered } = adapter();
  slack.onMessage((m) => { if (m.id === '1.0') throw new Error('a handler failed on 1.0'); });
  emit('C1', '1.0', 'U1');
  emit('C1', '2.0', 'U2');
  await delivered(2);
  assert.deepEqual(seen, ['C1:1.0', 'C1:2.0']);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0]!.arguments[1]), /a handler failed on 1\.0/);
});

test('through the server, the host sees a conversation in arrival order, and a publish without a threadId follows the newest message', { timeout: 10_000 }, async () => {
  const h = harness();
  const u1 = held();
  const web = (h.server as unknown as { slack: { web: { users: { info(args: { user: string }): Promise<unknown> } } } }).slack.web;
  const info = web.users.info.bind(web.users);
  web.users.info = async (args) => {
    if (args.user === 'U1') await u1.answered;
    return info(args);
  };
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
  // The earlier message is a reply in thread 50.0; the later one is top-level.
  await h.socket.emitMessage({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@UBOT> first', ts: '300.1', thread_ts: '50.0' });
  await h.socket.emitMessage({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U2', text: '<@UBOT> second', ts: '300.2' });
  u1.release();
  const pushed = () => h.hostSaw.filter((r) => r.method === method.PUSH_EVENT);
  await until(() => pushed().length === 2, 'both messages at the host');
  assert.deepEqual(pushed().map((r) => JSON.stringify(r.params).match(/300\.[12]/)?.[0]), ['300.1', '300.2']);
  await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'reply' }] });
  assert.equal((h.posts.at(-1) as { thread_ts?: string }).thread_ts, undefined, 'the reply goes where the newest message is, top-level');
  await h.close();
});
