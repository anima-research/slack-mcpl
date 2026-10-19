/**
 * Incoming Slack events reach the host in arrival order within a conversation,
 * however long the lookups before delivery take for each.
 *
 * Run: node --import tsx --test test/inboundOrder.test.ts
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackAdapter, type SlackMessageData, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';
import { FULL_GRANT, harness, initialize, until } from './harness.js';

/** Something the test answers when it chooses: a lookup, or an ack.
 *  `entered` settles once the code under test has started waiting on it. */
function held() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  let enter!: () => void;
  const answered = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  return { answered, release, fail, entered, enter };
}
type Held = ReturnType<typeof held>;

/** Every microtask the events can run without a held answer has run. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Rejections nothing handled while the test ran. */
function unhandledRejections(t: TestContext): unknown[] {
  const seen: unknown[] = [];
  const listen = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', listen);
  t.after(() => { process.off('unhandledRejection', listen); });
  return seen;
}

/** An adapter whose users.info for each user in `holds` waits until the test
 *  releases it; the others answer at once. */
function adapter(holds: Record<string, Held> = {}) {
  let handler: Parameters<SlackSocketLike['on']>[1] | undefined;
  const looked: string[] = [];
  const web = {
    users: {
      async info({ user }: { user: string }) {
        looked.push(user);
        holds[user]?.enter();
        await holds[user]?.answered;
        const name = `${user}'s name`;
        return { user: { name, real_name: name, profile: { display_name: name }, is_bot: false } };
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
  const emit = (channel: string, ts: string, user: string,
    opts: { ack?: () => Promise<void>; event?: Record<string, unknown> } = {}) =>
    handler!({
      event: { type: 'message', channel, channel_type: 'channel', user, ts, text: 'hi', ...opts.event } as never,
      ack: opts.ack ?? (async () => { acks++; }),
    });
  /** Settles once `count` messages have been delivered. */
  const delivered = (count: number) => new Promise<void>((resolve) => {
    if (seen.length >= count) resolve();
    else waiting.push({ count, resolve });
  });
  return { slack, seen, looked, emit, delivered, acks: () => acks };
}

test('a later message whose lookup finishes first is delivered after the earlier one, its lookup started on arrival', { timeout: 5000 }, async () => {
  const u1 = held();
  const { slack, seen, looked, emit, delivered, acks } = adapter({ U1: u1 });
  emit('C1', '1.0', 'U1');
  emit('C1', '2.0', 'U2');
  await settled();
  assert.deepEqual(seen, [], "the later message waits for the earlier one's delivery");
  assert.deepEqual(looked, ['U1', 'U2'], "each event's lookups start as it arrives, not when its turn comes");
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
  const { seen, emit, delivered } = adapter({ U1: u1 });
  emit('C1', '1.0', 'U1');
  emit('C2', '2.0', 'U2');
  await delivered(1);
  assert.deepEqual(seen, ['C2:2.0']);
  u1.release();
  await delivered(2);
  assert.deepEqual(seen, ['C2:2.0', 'C1:1.0']);
});

test('a message that arrives once an earlier turn has finished still waits for the one still pending', { timeout: 5000 }, async () => {
  const u1 = held();
  const u2 = held();
  const { seen, emit, delivered } = adapter({ U1: u1, U2: u2 });
  emit('C1', '1.0', 'U1');
  emit('C1', '2.0', 'U2');
  u1.release();
  await delivered(1);
  await settled();
  // 1.0's turn has finished, and 2.0's is still waiting for its lookup.
  emit('C1', '3.0', 'U3');
  await settled();
  assert.deepEqual(seen, ['C1:1.0'], 'the third waits for the second');
  u2.release();
  await delivered(3);
  assert.deepEqual(seen, ['C1:1.0', 'C1:2.0', 'C1:3.0']);
});

test("an ack still pending holds no delivery, and one that rejects isn't left unhandled", { timeout: 5000 }, async (t) => {
  const unhandled = unhandledRejections(t);
  const ack = held();
  let rejected = 0;
  const { seen, emit, delivered } = adapter();
  emit('C1', '1.0', 'U1', { ack: () => { ack.enter(); return ack.answered; } });
  emit('C1', '2.0', 'U2', { ack: async () => { rejected++; throw new Error('the ack failed'); } });
  await ack.entered;
  await delivered(2);
  assert.deepEqual(seen, ['C1:1.0', 'C1:2.0']);
  assert.equal(rejected, 1, "2.0's ack was called, and rejected");
  await settled();
  assert.deepEqual(unhandled, []);
  ack.release();
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

test("a preparation that fails before its turn isn't left unhandled, and is logged when its turn comes", { timeout: 5000 }, async (t) => {
  const unhandled = unhandledRejections(t);
  const errors = t.mock.method(console, 'error', () => {});
  const u1 = held();
  const { seen, looked, emit, delivered } = adapter({ U1: u1 });
  emit('C1', '1.0', 'U1');
  // A file entry that isn't an object fails 2.0's preparation, after its
  // lookups and while 1.0 still waits for its own.
  emit('C1', '2.0', 'U2', { event: { files: [null] } });
  emit('C1', '3.0', 'U3');
  await settled();
  assert.ok(looked.includes('U2'), "2.0's preparation ran, and failed, before its turn");
  assert.deepEqual(unhandled, []);
  assert.equal(errors.mock.callCount(), 0, '2.0 waits for its turn to be logged');
  u1.release();
  await delivered(2);
  assert.deepEqual(seen, ['C1:1.0', 'C1:3.0']);
  assert.equal(errors.mock.callCount(), 1);
});

test("a lookup that fails still delivers its message in its turn, with the user's id", { timeout: 5000 }, async () => {
  const u1 = held();
  const { slack, seen, emit, delivered } = adapter({ U1: u1 });
  const authors: string[] = [];
  slack.onMessage((m) => authors.push(m.authorName));
  emit('C1', '1.0', 'U1');
  emit('C1', '2.0', 'U2');
  await u1.entered;
  u1.fail(new Error('users.info failed'));
  await delivered(2);
  assert.deepEqual(seen, ['C1:1.0', 'C1:2.0']);
  assert.deepEqual(authors, ['U1', "U2's name"]);
});

// main's rule, which #6 asks to change to the thread of the message being
// answered: a publish without a threadId follows the last message the host took.
test('through the server, the host sees a conversation in arrival order, so a publish without a threadId follows the last message the host took, the top-level one', { timeout: 10_000 }, async () => {
  const h = harness();
  const u1 = held();
  // White-box: the server's adapter and the adapter's client are private.
  const slack = (h.server as unknown as { slack: SlackAdapter }).slack;
  const web = (slack as unknown as { web: { users: { info(args: { user: string }): Promise<unknown> } } }).web;
  const info = web.users.info.bind(web.users);
  web.users.info = async (args) => {
    if (args.user === 'U1') {
      u1.enter();
      await u1.answered;
    }
    return info(args);
  };
  const deliveredHere: string[] = [];
  slack.onMessage((m) => deliveredHere.push(m.id));
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
  // The earlier message is a reply in thread 50.0; the later one is top-level.
  await h.socket.emitMessage({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@UBOT> first', ts: '300.1', thread_ts: '50.0' });
  await h.socket.emitMessage({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U2', text: '<@UBOT> second', ts: '300.2' });
  await u1.entered;
  await settled();
  assert.deepEqual(deliveredHere, [], "the later message waits for the earlier one's lookup");
  u1.release();
  const pushed = () => h.hostSaw.filter((r) => r.method === method.PUSH_EVENT);
  await until(() => pushed().length === 2, 'both messages at the host');
  assert.deepEqual(pushed().map((r) => JSON.stringify(r.params).match(/300\.[12]/)?.[0]), ['300.1', '300.2']);
  await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'reply' }] });
  assert.equal((h.posts.at(-1) as { thread_ts?: string }).thread_ts, undefined,
    'the last message the host took is the top-level one, so the publish goes top-level');
  await h.close();
});
