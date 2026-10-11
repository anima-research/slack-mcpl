/**
 * MCPL RFC-011 targeted publish on Slack: every conversation declares
 * `capabilities.publish.target: 'exact'`, and a publish carrying `threadId`
 * lands exactly there (a thread's parent ts, or top level for null) or fails
 * with nothing posted. A publish without the field keeps the legacy
 * latest-incoming-thread placement.
 *
 * Platform boundary: every Slack call here is a stub at the web client. What
 * real Slack does with a stale or non-parent `thread_ts` on chat.postMessage
 * is not established by these tests; the server does not rely on it, because
 * every thread target — even one seen arriving — is checked with
 * conversations.replies just before posting. Only a deletion in the moment
 * between that check and the post is left to the platform.
 *
 * Run: node --import tsx --test test/publishTarget.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { FULL_GRANT, harness, initialize, until, type Harness, type HarnessOptions, type WebOverrides } from './harness.js';

type Post = { channel: string; text: string; thread_ts?: string };

/** A platform stub for chat.postMessage that answers like Slack: the posted
 *  message, with thread_ts when it was a reply. */
const echoingPost = async (args: Record<string, unknown>) => ({
  ts: '200.1',
  message: { ts: '200.1', ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}) },
});

async function ready(opts: HarnessOptions = {}) {
  const h = harness({ ...opts, web: { postMessage: echoingPost, ...opts.web } });
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
  return h;
}

const publish = (h: Awaited<ReturnType<typeof ready>>, extra: Record<string, unknown>) =>
  h.host.sendRequest(method.CHANNELS_PUBLISH, {
    conversationId: 'conv', channelId: 'slack:C1', content: [{ type: 'text', text: 'answer' }], ...extra,
  }) as Promise<Record<string, unknown>>;

/** A mention inside thread `parent` (a reply), as Socket Mode delivers it. */
const threadReply = (parent: string, ts: string) => ({
  type: 'message', channel: 'C1', user: 'U2', text: '<@UBOT> in the thread', ts, thread_ts: parent,
});

/** Deliver a Socket Mode event and wait until the host has it, so the
 *  latest-incoming state a test races against is known to exist. */
async function arrive(h: Harness, event: { ts: string } & Record<string, unknown>) {
  await h.socket.emitMessage(event);
  await until(() => h.hostSaw.some((r) => {
    const p = r.params as { origin?: { messageId?: string }; messages?: Array<{ messageId?: string }> } | undefined;
    return p?.origin?.messageId === event.ts || (p?.messages ?? []).some((m) => m.messageId === event.ts);
  }), `the host receiving ${event.ts}`);
}

/** Slack's ok:false answer, as @slack/web-api throws it. */
const platform = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), {
  code: 'slack_webapi_platform_error', data: { ok: false, error },
});

test('every conversation declares an exact publish target', async () => {
  const h = await ready();
  const reg = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!;
  const channels = (reg.params as { channels: Array<{ id: string; capabilities?: Record<string, unknown> }> }).channels;
  assert.ok(channels.length > 0);
  for (const c of channels) assert.deepEqual(c.capabilities?.publish, { target: 'exact' }, c.id);
  await h.close();
});

test('a legacy publish (no threadId) keeps the latest-incoming-thread placement and result shape', async () => {
  const h = await ready();
  await arrive(h, threadReply('50.1', '51.1'));
  const res = await publish(h, {});
  assert.deepEqual(Object.keys(res).sort(), ['delivered', 'messageId']);
  assert.equal((h.posts.at(-1) as Post).thread_ts, '50.1');
  await h.close();
});

test('threadId null posts at the top level even after a threaded arrival (the root race)', async () => {
  const h = await ready();
  await arrive(h, threadReply('50.1', '51.1'));
  const res = await publish(h, { threadId: null });
  assert.equal(res.delivered, true);
  assert.ok('threadId' in res && res.threadId === null, 'echoed from the posted message: top level');
  assert.equal((h.posts.at(-1) as Post).thread_ts, undefined);
  await h.close();
});

test('a thread seen arriving is still confirmed before posting, targeted exactly, and echoed', async () => {
  const asked: unknown[] = [];
  const h = await ready({ web: { replies: async (args) => { asked.push(args); return { messages: [{ ts: '50.1', thread_ts: '50.1' }] }; } } });
  await arrive(h, threadReply('50.1', '51.1'));
  await arrive(h, { type: 'message', channel: 'C1', user: 'U3', text: '<@UBOT> elsewhere', ts: '61.1', thread_ts: '60.1' });
  const res = await publish(h, { threadId: '50.1' });
  assert.equal(res.delivered, true);
  assert.equal(res.threadId, '50.1');
  assert.equal((h.posts.at(-1) as Post).thread_ts, '50.1', 'its own thread, not the newer one');
  assert.deepEqual(asked, [{ channel: 'C1', ts: '50.1', limit: 1 }], 'confirmed even though it was seen arriving');
  await h.close();
});

test('a parent seen arriving and deleted since is refused, never posted with a stale thread_ts', async () => {
  const h = await ready({ web: { replies: async () => { throw platform('thread_not_found'); } } });
  await arrive(h, threadReply('50.1', '51.1'));
  const res = await publish(h, { threadId: '50.1' });
  assert.equal(res.delivered, false);
  assert.equal('messageId' in res, false);
  assert.match(String(res.reason), /no message 50\.1/);
  assert.equal(h.posts.length, 0);
  await h.close();
});

test('an unseen thread parent is confirmed with Slack, then posted into, every time', async () => {
  const asked: unknown[] = [];
  const h = await ready({ web: { replies: async (args) => { asked.push(args); return { messages: [{ ts: '70.1', thread_ts: '70.1' }] }; } } });
  const res = await publish(h, { threadId: '70.1' });
  assert.equal(res.delivered, true);
  assert.equal(res.threadId, '70.1');
  assert.deepEqual(asked, [{ channel: 'C1', ts: '70.1', limit: 1 }]);
  assert.equal((h.posts.at(-1) as Post).thread_ts, '70.1');
  // No cache: the next publish to it is confirmed again.
  await publish(h, { threadId: '70.1' });
  assert.equal(asked.length, 2);
  await h.close();
});

test('a top-level message with no replies yet can be replied under', async () => {
  const h = await ready({ web: { replies: async () => ({ messages: [{ ts: '80.1' }] }) } });
  const res = await publish(h, { threadId: '80.1' });
  assert.equal(res.delivered, true);
  assert.equal(res.threadId, '80.1');
  await h.close();
});

test('targets that cannot be honored fail with nothing posted', async () => {
  const cases: Array<{ threadId: unknown; replies?: WebOverrides['replies']; reason: RegExp }> = [
    // Slack's own code is named: the reason says what Slack said.
    { threadId: '90.1', replies: async () => { throw platform('thread_not_found'); }, reason: /no message 90\.1 .*\(thread_not_found\)/ },
    { threadId: '94.1', replies: async () => { throw platform('message_not_found'); }, reason: /no message 94\.1 .*\(message_not_found\)/ },
    // A reply's ts: Slack answers with the thread's parent first…
    { threadId: '91.2', replies: async () => ({ messages: [{ ts: '91.1', thread_ts: '91.1' }] }), reason: /reply inside a thread/ },
    // …or with the reply itself, which names its parent's thread.
    { threadId: '93.2', replies: async () => ({ messages: [{ ts: '93.2', thread_ts: '93.1' }] }), reason: /reply inside a thread/ },
    { threadId: '92.1', replies: async () => { throw new Error('socket hang up'); }, reason: /could not confirm thread 92\.1/ },
    { threadId: 'not-a-ts', reason: /invalid threadId "not-a-ts"/ },
    { threadId: 7, reason: /invalid threadId 7:/ },
    { threadId: '', reason: /invalid threadId "":/ },
    // A refused value is named bounded, whatever the host sent.
    { threadId: 'x'.repeat(5000), reason: /invalid threadId "x{39}… \(5002 characters\):/ },
  ];
  for (const c of cases) {
    const h = await ready({ web: c.replies ? { replies: c.replies } : {} });
    const res = await publish(h, { threadId: c.threadId });
    assert.equal(res.delivered, false, JSON.stringify(c.threadId));
    assert.equal('messageId' in res, false, 'no message id: definitely not posted');
    assert.equal('threadId' in res, false, 'nothing landed, so nothing is echoed');
    assert.match(String(res.reason), c.reason);
    assert.ok(String(res.reason).length < 200, 'the reason is bounded');
    assert.equal(h.posts.length, 0, 'nothing reached chat.postMessage');
    await h.close();
  }
});

test("Slack's own refusal is a definite failure; an uncertain error stays an error", async () => {
  const refused = await ready({ web: { postMessage: async () => { throw platform('restricted_action_thread_only_channel'); } } });
  const res = await publish(refused, { threadId: null });
  assert.equal(res.delivered, false);
  assert.equal('messageId' in res, false);
  assert.match(String(res.reason), /restricted_action_thread_only_channel/);
  await refused.close();

  // Into a thread too: Slack refusing the reply is a definite failure.
  const threadRefused = await ready({
    web: { replies: async () => ({ messages: [{ ts: '95.1' }] }), postMessage: async () => { throw platform('cannot_reply_to_message'); } },
  });
  const inThread = await publish(threadRefused, { threadId: '95.1' });
  assert.equal(inThread.delivered, false);
  assert.equal('messageId' in inThread, false);
  assert.equal('threadId' in inThread, false);
  assert.match(String(inThread.reason), /cannot_reply_to_message/);
  await threadRefused.close();

  // internal_error and fatal_error may have partly succeeded, and a lost
  // connection can't tell: each stays an error, which the host counts
  // unconfirmed.
  for (const thrown of [platform('internal_error'), platform('fatal_error'), new Error('socket hang up')]) {
    const uncertain = await ready({ web: { postMessage: async () => { throw thrown; } } });
    await assert.rejects(publish(uncertain, { threadId: null }), new RegExp(thrown.message.split(': ').at(-1)!));
    await uncertain.close();
  }
});

test('the echo is where Slack says the post landed, not what was asked', async () => {
  const replies: WebOverrides['replies'] = async () => ({ messages: [{ ts: '96.1' }] });
  const elsewhere = await ready({ web: { replies, postMessage: async () => ({ ts: '201.1', message: { ts: '201.1', thread_ts: '97.1' } }) } });
  const moved = await publish(elsewhere, { threadId: '96.1' });
  assert.equal(moved.delivered, true);
  assert.equal(moved.threadId, '97.1', "Slack's answer, which the host sees differ from its request");
  await elsewhere.close();

  const top = await ready({ web: { replies, postMessage: async () => ({ ts: '202.1', message: { ts: '202.1' } }) } });
  const atTop = await publish(top, { threadId: '96.1' });
  assert.equal(atTop.threadId, null);
  await top.close();

  // A message whose thread_ts is its own ts is a thread's parent, at the top level.
  const own = await ready({ web: { postMessage: async () => ({ ts: '203.1', message: { ts: '203.1', thread_ts: '203.1' } }) } });
  const parent = await publish(own, { threadId: null });
  assert.equal(parent.threadId, null);
  await own.close();
});

test('every failure before the send is a refusal, the target named first', async () => {
  const h = await ready();
  const send = (params: Record<string, unknown>) =>
    h.host.sendRequest(method.CHANNELS_PUBLISH, { conversationId: 'conv', ...params }) as Promise<Record<string, unknown>>;
  const empty = await send({ channelId: 'slack:C1', threadId: null, content: [] });
  assert.equal(empty.delivered, false);
  assert.match(String(empty.reason), /no text content/);
  // An invalid target is named even when the text is missing too.
  const both = await send({ channelId: 'slack:C1', threadId: 'not-a-ts', content: [] });
  assert.match(String(both.reason), /invalid threadId "not-a-ts"/);
  // An unparseable channel ID is a refusal, not a JSON-RPC error.
  const badChannel = await send({ channelId: 'C1', threadId: null, content: [{ type: 'text', text: 'answer' }] });
  assert.equal(badChannel.delivered, false);
  assert.equal('messageId' in badChannel, false);
  assert.match(String(badChannel.reason), /invalid channelId "C1"/);
  assert.equal(h.posts.length, 0);
  // The legacy path keeps its own answers.
  assert.deepEqual(await send({ channelId: 'slack:C1', content: [] }), { delivered: false });
  await assert.rejects(send({ channelId: 'C1', content: [{ type: 'text', text: 'answer' }] }), /Invalid channel ID/);
  await h.close();
});

test('a targeted publish sent as a Notification is dropped, never posted, and logged', async (t) => {
  const h = await ready();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  h.host.sendNotification(method.CHANNELS_PUBLISH, {
    conversationId: 'conv', channelId: 'slack:C1', threadId: null, content: [{ type: 'text', text: 'answer' }],
  });
  await until(() => logged.some((l) => /Notification carrying threadId/.test(l)), 'the drop logged');
  assert.match(logged.find((l) => /Notification carrying threadId/.test(l))!, /"slack:C1"/);
  assert.equal(h.posts.length, 0);
  await h.close();
});

test('a post whose response names no message carries no echo (the host cannot confirm it)', async () => {
  const h = await ready({ web: { postMessage: async () => ({ ts: '300.1' }) } });
  const res = await publish(h, { threadId: null });
  assert.equal(res.delivered, true);
  assert.equal('threadId' in res, false);
  await h.close();
});

test('a targeted publish this server would block is refused before Slack, not left uncertain', async () => {
  // A thread target too: refused before Slack is asked about the thread.
  for (const threadId of [null, '50.1']) {
    const asked: unknown[] = [];
    const replies: WebOverrides['replies'] = async (args) => { asked.push(args); return { messages: [{ ts: '50.1' }] }; };
    const excluded = await ready({ sendChannels: ['COTHER'], web: { replies } });
    const res = await publish(excluded, { threadId });
    assert.equal(res.delivered, false, String(threadId));
    assert.equal('messageId' in res, false);
    assert.match(String(res.reason), /SLACK_SEND_CHANNELS/);
    assert.equal(excluded.posts.length, 0);
    assert.deepEqual(asked, []);
    await excluded.close();

    // SLACK_DISABLE_DMS: a DM is a certain no-post too.
    const noDms = await ready({ disableDms: true, web: { replies } });
    const dm = (await noDms.host.sendRequest(method.CHANNELS_PUBLISH, {
      conversationId: 'conv', channelId: 'slack:D1', threadId, content: [{ type: 'text', text: 'hi' }],
    })) as Record<string, unknown>;
    assert.equal(dm.delivered, false, String(threadId));
    assert.equal('messageId' in dm, false);
    assert.match(String(dm.reason), /SLACK_DISABLE_DMS/);
    assert.equal(noDms.posts.length, 0);
    assert.deepEqual(asked, []);
    await noDms.close();
  }
});
