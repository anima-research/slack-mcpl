/**
 * Tests for SLACK_DISABLE_DMS.
 *
 * Run: node --import tsx --test test/disableDms.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebClient } from '@slack/web-api';
import { SLACK_CLIENT_OPTIONS, SlackAdapter, type SlackMessageData, type SlackWebLike } from '../src/slack-adapter.js';
import { fakeSlackApi, unreachableSlackApiUrl } from './slackApi.js';

/** What a refusal says when DMs are off, after what didn't happen. */
const offHere =
  'and this bot works only in channels here, since direct messages are turned off. list_channels shows the ones it ' +
  'can use.';

function makeAdapter(disableDms: boolean) {
  let handler: ((args: { event: any; ack: () => Promise<void> }) => void) | undefined;
  const calls: string[] = [];
  const socket = { on(_e: string, h: any) { handler = h; }, async start() {}, async disconnect() {} } as any;
  const web = {
    users: { info: async ({ user }: { user: string }) => ({ user: { name: user.toLowerCase() } }) },
    chat: { postMessage: async () => { calls.push('post'); return { ts: '1.0' }; } },
    conversations: {
      open: async () => { calls.push('open'); return { channel: { id: 'D9' } }; },
      history: async () => { calls.push('history'); return { messages: [] }; },
      replies: async () => { calls.push('replies'); return { messages: [] }; },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, disableDms);
  const received: SlackMessageData[] = [];
  adapter.onMessage((msg) => received.push(msg));
  const emit = async (event: any) => {
    handler!({ event, ack: async () => {} });
    await new Promise((r) => setTimeout(r, 0));
  };
  return { adapter, emit, received, calls };
}

test('incoming DMs and group DMs are dropped, channel messages still arrive', async () => {
  const { emit, received } = makeAdapter(true);
  await emit({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '1718000000.000100', text: 'psst' });
  await emit({ type: 'message', channel: 'G1', channel_type: 'mpim', user: 'U1', ts: '1718000000.000200', text: 'psst' });
  await emit({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '1718000000.000300', text: 'hi' });
  assert.deepEqual(received.map((m) => m.channelId), ['C1']);
});

test('DM sends and DM history reads are refused before reaching Slack', async () => {
  const { adapter, calls } = makeAdapter(true);
  await assert.rejects(adapter.sendDM('U1', 'hi'), {
    message:
      "Nothing was sent: direct messages are turned off on this host, so send_dm can't reach anyone. Calling again " +
      "won't change that; whoever runs this host decides whether this bot may send DMs. To reach people, post in a " +
      'channel with send_message; list_channels marks where this bot may write with writable: true.',
  });
  await assert.rejects(adapter.fetchHistory('D1'), { message: `Nothing was read: D1 is a direct message or group DM, ${offHere}` });
  await assert.rejects(adapter.readThread('D1', '1.0', { channelId: 'D1', threadTs: '1.0' }), {
    message: `No messages were returned: D1 is a direct message or group DM, ${offHere}`,
  });
  assert.deepEqual(calls, []);
});

test('DMs work when the switch is off', async () => {
  const { emit, received } = makeAdapter(false);
  await emit({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '1718000000.000100', text: 'psst' });
  assert.equal(received.length, 1);
});

function makeStrictAdapter() {
  const calls: string[] = [];
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const rec = (name: string) => async ({ channel }: any) => { calls.push(`${name}:${channel}`); return { ts: '1.0' }; };
  const listTypes: string[] = [];
  const web = {
    chat: { postMessage: rec('post'), update: rec('update'), delete: rec('delete') },
    reactions: { add: rec('react') },
    conversations: {
      list: async ({ types }: any) => { listTypes.push(types); return { channels: [] }; },
      info: async ({ channel }: any) => {
        calls.push(`info:${channel}`);
        if (channel === 'G1') return { channel: { id: 'G1', name: 'mpdm-a--b-1', is_mpim: true } };
        if (channel === 'G2') return { channel: { id: 'G2', name: 'secret', is_private: true, is_member: true, is_im: false, is_mpim: false } };
        // Hostile or odd answers: another conversation's ID, or a group without is_mpim.
        if (channel === 'U7') return { channel: { id: 'C777', name: 'other', is_im: false, is_mpim: false } };
        if (channel === 'G55') return { channel: { id: 'G55', name: 'grp', is_group: true, is_private: true } };
        throw new Error('channel_not_found');
      },
      history: async ({ channel }: any) => { calls.push(`history:${channel}`); return { messages: [] }; },
      replies: async ({ channel }: any) => { calls.push(`replies:${channel}`); return { messages: [] }; },
    },
  } as any;
  return { adapter: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, true), calls, listTypes };
}

test('every write path and both history reads refuse a DM, before any Slack write', async () => {
  const { adapter, calls } = makeStrictAdapter();
  const dm = `D1 is a direct message or group DM, ${offHere}`;
  await assert.rejects(adapter.sendMessage('D1', 'hi'), { message: `Nothing was posted: ${dm}` });
  await assert.rejects(adapter.editMessage('D1', '1.0', 'hi'), { message: `The message wasn't changed: ${dm}` });
  await assert.rejects(adapter.deleteMessage('D1', '1.0'), { message: `Nothing was deleted: ${dm}` });
  await assert.rejects(adapter.addReaction('D1', '1.0', 'eyes'), { message: `No reaction was added: ${dm}` });
  await assert.rejects(adapter.fetchHistory('D1'), { message: `Nothing was read: ${dm}` });
  assert.deepEqual(calls, []);
});

test('a group DM is told from a private channel by asking Slack, and unknown means refused', async () => {
  const { adapter, calls } = makeStrictAdapter();
  await assert.rejects(adapter.fetchHistory('G1'), /direct messages are turned off/);
  await assert.rejects(adapter.readThread('G1', '1.0', { channelId: 'G1', threadTs: '1.0' }), /direct messages are turned off/);
  await assert.rejects(adapter.sendMessage('G1', 'hi'), /direct messages are turned off/);
  assert.ok(!calls.some((c) => /^(history|replies|post):G1/.test(c)));

  await adapter.fetchHistory('G2'); // an old-style private channel is fine
  await adapter.sendMessage('G2', 'hi');
  assert.ok(calls.includes('history:G2'));
  assert.equal(calls.filter((c) => c === 'info:G2').length, 1, 'asked about once');

  await assert.rejects(adapter.fetchHistory('GUNKNOWN'), /direct messages turned off/, 'fail closed when Slack cannot say');
});

test('with DMs disabled, conversations.list is not asked for DMs or group DMs', async () => {
  const { adapter, listTypes } = makeStrictAdapter();
  await adapter.listConversations();
  assert.deepEqual(listTypes, ['public_channel,private_channel']);
});

test('a user ID is refused: posting to it would land in that user\'s DM', async () => {
  const { adapter, calls } = makeStrictAdapter();
  await assert.rejects(adapter.sendMessage('U123', 'hi'), /direct messages turned off/);
  await assert.rejects(adapter.fetchHistory('CUNKNOWN'), /direct messages turned off/);
  assert.ok(!calls.some((c) => /^(post|history):/.test(c)));
});

test('only Slack\'s explicit "not a DM" for the very ID asked about lets a write through', async () => {
  const { adapter, calls } = makeStrictAdapter();
  await assert.rejects(adapter.sendMessage('U7', 'hi'), { message: `Nothing was posted: U7 isn't a channel, ${offHere}` }, 'answer names another conversation');
  await assert.rejects(adapter.sendMessage('G55', 'hi'), { message: `Nothing was posted: G55 isn't a channel, ${offHere}` }, 'is_mpim missing');
  await assert.rejects(adapter.sendMessage('GUNKNOWN', 'hi'), /couldn't confirm GUNKNOWN is a channel \(channel_not_found\)/);
  assert.ok(!calls.some((c) => c.startsWith('post:')));
});

// What can change Slack's answer: another conversation, or whoever runs this
// host. Each answer comes from a real client against a local endpoint that
// answers as Slack does.
const confirms = 'and with direct messages turned off, this bot works only in conversations Slack confirms are channels.';

/** An adapter with DMs off, over a real client against `slackApiUrl`. */
function strictOver(slackApiUrl: string): SlackAdapter {
  const web = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl });
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  return new SlackAdapter(web as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true);
}

for (const [what, answer, next] of [
  [
    'Slack refuses the id',
    { body: { ok: false, error: 'channel_not_found' } },
    `(Slack answered channel_not_found), ${confirms} list_channels shows the ones it can use.`,
  ],
  [
    'Slack refuses the id as malformed',
    { body: { ok: false, error: 'invalid_channel_id' } },
    `(Slack answered invalid_channel_id), ${confirms} list_channels shows the ones it can use.`,
  ],
  [
    "the Slack app lacks the lookup's scope",
    { body: { ok: false, error: 'missing_scope', needed: 'channels:read', provided: 'chat:write' } },
    `(Slack answered missing_scope), ${confirms} Calling again won't change that until whoever runs this ` +
      "host adds the scope it needs (Slack names channels:read) to the Slack app's bot token scopes and reinstalls " +
      'the app.',
  ],
  [
    "the Slack app lacks a scope Slack doesn't name",
    { body: { ok: false, error: 'missing_scope' } },
    `(Slack answered missing_scope), ${confirms} Calling again won't change that until whoever runs this ` +
      "host adds the scope it needs to the Slack app's bot token scopes and reinstalls the app.",
  ],
  [
    "Slack doesn't accept the token",
    { body: { ok: false, error: 'invalid_auth' } },
    `(Slack answered invalid_auth), ${confirms} Calling again won't change Slack's answer; only whoever ` +
      "runs this host, or the workspace's admins, can.",
  ],
  [
    "Slack rate-limits the lookup without the Retry-After the client needs",
    { status: 429, body: { ok: false, error: 'ratelimited' } },
    '(Retry header did not contain a valid timeout (url: http://127.0.0.1:PORT/api/conversations.info, retry-after ' +
      `header: undefined)), ` +
      `${confirms} Try again shortly.`,
  ],
] as const) {
  test(`when ${what}, a conversation Slack can't confirm as a channel is refused, and the text says what to do`, { timeout: 5000 }, async (t) => {
    const api = await fakeSlackApi();
    t.after(() => api.close());
    api.answer(answer);
    // The local endpoint's port, in the client's own message for a 429 without
    // Retry-After, changes from run to run.
    await assert.rejects(strictOver(api.url).fetchHistory('CUNKNOWN'), (err: Error) => {
      assert.equal(err.message.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:PORT'), `Nothing was read: Slack couldn't confirm CUNKNOWN is a channel ${next}`);
      return true;
    });
    assert.deepEqual(api.calls, ['conversations.info'], 'nothing is read');
  });
}

// A check that can pass isn't refused: its own error reaches the caller,
// which the explainer reads as a request made before the read or the write,
// and nothing is read.
for (const [what, answer, error] of [
  ['Slack rate-limits the lookup', { status: 429, headers: { 'retry-after': '2' }, body: { ok: false, error: 'ratelimited' } },
    'A rate-limit has been reached, you may retry this request in 2 seconds'],
  ['Slack fails while answering', { body: { ok: false, error: 'internal_error' } }, 'An API error occurred: internal_error'],
  ['Slack answers fatal_error', { body: { ok: false, error: 'fatal_error' } }, 'An API error occurred: fatal_error'],
  ['Slack answers service_unavailable', { body: { ok: false, error: 'service_unavailable' } }, 'An API error occurred: service_unavailable'],
  ['Slack answers request_timeout', { body: { ok: false, error: 'request_timeout' } }, 'An API error occurred: request_timeout'],
  ['Slack answers ratelimited in an HTTP 200', { body: { ok: false, error: 'ratelimited' } }, 'An API error occurred: ratelimited'],
  ['Slack answers HTTP 503', { status: 503, body: { ok: false } }, 'An HTTP protocol error occurred: statusCode = 503'],
] as const) {
  test(`when ${what}, the check's own error reaches the caller, and nothing is read`, { timeout: 5000 }, async (t) => {
    const api = await fakeSlackApi();
    t.after(() => api.close());
    api.answer(answer);
    await assert.rejects(strictOver(api.url).fetchHistory('CUNKNOWN'), { message: error });
    assert.deepEqual(api.calls, ['conversations.info'], 'nothing is read');
  });
}

test("when the lookup can't reach Slack, the check's own error reaches the caller", { timeout: 5000 }, async () => {
  await assert.rejects(strictOver(await unreachableSlackApiUrl()).fetchHistory('CUNKNOWN'), {
    code: 'slack_webapi_request_error',
  });
});

test('an incoming event Slack does not mark as a channel is dropped', async () => {
  const { emit, received } = makeAdapter(true);
  await emit({ type: 'message', channel: 'G9', user: 'U1', ts: '1718000000.000100', text: 'no channel_type' });
  await emit({ type: 'message', channel: 'G8', channel_type: 'group', user: 'U1', ts: '1718000000.000200', text: 'private channel' });
  assert.deepEqual(received.map((m) => m.channelId), ['G8']);
});

test('conversations.list asks only for the types the token has a read scope for', async () => {
  const listTypes: string[] = [];
  const web = { conversations: { list: async ({ types }: any) => { listTypes.push(types); return { channels: [] }; } } } as any;
  const socket = { on() {} } as any;
  const scopes = ['channels:read', 'groups:read', 'im:read', 'chat:write'];
  await new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, false, undefined, scopes).listConversations();
  await new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, false).listConversations();
  assert.deepEqual(listTypes, ['public_channel,private_channel,im', 'public_channel,private_channel,im,mpim']);
});
