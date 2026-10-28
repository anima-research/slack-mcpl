/**
 * The operator controls seen from the host: what the server registers, tells
 * the agent, delivers and posts. The real server over the in-memory harness.
 *
 * Run: node --import tsx --test test/operatorControls.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until, type Harness } from './harness.js';

const pushes = (h: Harness) => h.hostSaw.filter((r) => r.method === method.PUSH_EVENT);
const pushText = (h: Harness, i: number) =>
  (pushes(h)[i].params as { payload: { content: { text: string }[] } }).payload.content.map((b) => b.text).join('\n');

async function ready(h: Harness) {
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
}

for (const limit of [0, 7]) {
  test(`backscroll limit ${limit} controls automatic history without disabling explicit reads`, async (t) => {
    const previous = process.env.SLACK_BACKSCROLL_LIMIT;
    process.env.SLACK_BACKSCROLL_LIMIT = String(limit);
    t.after(() => {
      if (previous === undefined) delete process.env.SLACK_BACKSCROLL_LIMIT;
      else process.env.SLACK_BACKSCROLL_LIMIT = previous;
    });
    const h = harness({ historyMessages: [{ ts: '100.1', user: 'U2', text: 'earlier context' }] });
    t.after(() => h.close());
    await ready(h);

    await h.socket.emitMessage(MENTION_EVENT);
    await until(() => pushes(h).length === 1, 'push/event');
    assert.deepEqual(h.reads, limit === 0 ? [] : ['history:C1']);
    if (limit === 0) assert.doesNotMatch(pushText(h, 0), /<backscroll/);
    else assert.match(pushText(h, 0), /earlier context/);

    const result = await h.host.sendRequest('tools/call', {
      name: 'fetch_history', arguments: { channelId: 'C1' },
    }) as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /earlier context/);
    assert.deepEqual(h.reads, limit === 0 ? ['history:C1'] : ['history:C1', 'history:C1']);
  });
}

test('zero backscroll keeps the auto-subscribe conversation name after an outbound write', async (t) => {
  const previous = process.env.SLACK_BACKSCROLL_LIMIT;
  process.env.SLACK_BACKSCROLL_LIMIT = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_BACKSCROLL_LIMIT;
    else process.env.SLACK_BACKSCROLL_LIMIT = previous;
  });
  const h = harness();
  t.after(() => h.close());
  await ready(h);

  // An outbound write sets the current conversation without taking its
  // first inbound message, so the next delivery won't need a new header.
  const sent = await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'hello' },
  }) as { isError?: boolean };
  assert.notEqual(sent.isError, true);
  assert.equal(h.posts.length, 1);

  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => pushes(h).length === 1, 'push/event');
  assert.deepEqual(h.reads, []);
  assert.match(pushText(h, 0), /Auto-subscribed to #general because you were mentioned/);
});

test('backscroll limits preserve integer-prefix parsing and fallback bounds', (t) => {
  const previous = process.env.SLACK_BACKSCROLL_LIMIT;
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_BACKSCROLL_LIMIT;
    else process.env.SLACK_BACKSCROLL_LIMIT = previous;
  });
  const h = harness();
  t.after(() => h.close());
  for (const [raw, expected] of [
    [undefined, 50], ['', 50], ['0', 0], ['1000', 1000],
    ['-1', 50], ['1001', 50], ['abc', 50],
    ['0junk', 0], ['7junk', 7], ['1.5', 1],
  ] as const) {
    if (raw === undefined) delete process.env.SLACK_BACKSCROLL_LIMIT;
    else process.env.SLACK_BACKSCROLL_LIMIT = raw;
    assert.equal(Reflect.get(h.server, 'backscrollLimit'), expected, `raw=${raw}`);
  }
});

test('a conversation outside the write allow-list is registered inbound, listed as not writable, and the agent is told', async () => {
  const h = harness({ sendChannels: ['C9'] });
  await ready(h);

  const registered = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!.params as {
    channels: { id: string; direction: string }[];
  };
  assert.equal(registered.channels.find((c) => c.id === 'slack:C1')!.direction, 'inbound');

  const listed = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as {
    content: { text: string }[];
  };
  assert.match(listed.content[0].text, /"writable":false/);

  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => pushes(h).length === 1, 'push/event');
  assert.match(pushText(h, 0), /cannot write to conversation C1/);

  await h.close();
});

test('a writable conversation is bidirectional and carries no read-only note', async () => {
  const h = harness({ sendChannels: ['C1'] });
  await ready(h);
  const registered = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!.params as {
    channels: { id: string; direction: string }[];
  };
  assert.equal(registered.channels[0].direction, 'bidirectional');
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => pushes(h).length === 1, 'push/event');
  assert.doesNotMatch(pushText(h, 0), /cannot write/);
  await h.close();
});

test('channels/publish outside the allow-list is refused and posts nothing', async () => {
  const h = harness({ sendChannels: ['C9'] });
  await ready(h);
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'hi' }] }),
  );
  assert.equal(h.posts.length, 0);
  await h.close();
});

test('channels/publish to a DM is refused when DMs are disabled', async () => {
  const h = harness({ disableDms: true });
  await ready(h);
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:D1', content: [{ type: 'text', text: 'hi' }] }),
    /Nothing was posted: D1 is a direct message or group DM, and this bot works only in channels here, since direct messages are turned off\. list_channels shows the ones it can use\.$/,
  );
  assert.equal(h.posts.length, 0);
  await h.close();
});

test('unsubscribe_channel silences a member channel for real', async () => {
  const h = harness({ subscribeMemberChannels: true });
  await ready(h);
  const ambient = (ts: string) => ({ type: 'message', channel: 'C1', user: 'U2', text: 'chatter', ts });

  await h.socket.emitMessage(ambient('1.1'));
  await until(() => pushes(h).length === 1, 'the first ambient message');

  await h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  await h.socket.emitMessage(ambient('1.2'));
  assert.equal(pushes(h).length, 1, 'muted: nothing new arrives');

  // A mention still comes through.
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '1.3' });
  await until(() => pushes(h).length === 2, 'the mention');

  await h.close();
});

test('the reaction is taken off when the host does not accept the message', async () => {
  const h = harness({ ackReaction: 'eyes', pushAccepted: false });
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => h.reactions.length >= 2, 'add then remove');
  assert.deepEqual(h.reactions, ['add:C1:111.1:eyes', 'remove:C1:111.1:eyes']);
  await h.close();
});

test('the reaction stays while the host has the message', async () => {
  const h = harness({ ackReaction: 'eyes' });
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => pushes(h).length === 1, 'push/event');
  await new Promise((r) => setTimeout(r, 50)); // a wrong removal would land here
  assert.deepEqual(h.reactions, ['add:C1:111.1:eyes']);
  await h.close();
});

test('the read-only note comes with the first message, even when that one is ambient', async () => {
  const h = harness({ sendChannels: ['C9'], subscribeMemberChannels: true });
  await ready(h);
  await h.socket.emitMessage({ type: 'message', channel: 'C1', user: 'U2', text: 'chatter', ts: '1.1' });
  await until(() => pushes(h).length === 1, 'the ambient message');
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '1.2' });
  await until(() => pushes(h).length === 2, 'the mention');
  assert.match(pushText(h, 0), /cannot write to conversation C1/);
  assert.doesNotMatch(pushText(h, 1), /cannot write/, 'told once');
  await h.close();
});

test('a mention does not undo a mute', async () => {
  const h = harness({ subscribeMemberChannels: true });
  await ready(h);
  await h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  await h.socket.emitMessage(MENTION_EVENT); // first message from C1: the auto-subscribe path
  await until(() => pushes(h).length === 1, 'the mention');
  await h.socket.emitMessage({ type: 'message', channel: 'C1', user: 'U2', text: 'chatter', ts: '2.1' });
  assert.equal(pushes(h).length, 1, 'still muted');
  await h.close();
});

test('send_dm is not offered when DMs are disabled', async () => {
  const h = harness({ disableDms: true });
  await initialize(h, true);
  const { tools } = (await h.host.sendRequest('tools/list')) as { tools: { name: string }[] };
  assert.equal(tools.some((t) => t.name === 'send_dm'), false);
  assert.equal(tools.some((t) => t.name === 'send_message'), true);
  await h.close();
});

test('the read-only note is given again when the host did not take the message that carried it', async () => {
  const h = harness({ sendChannels: ['C9'], pushAccepted: false });
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '111.2' });
  await until(() => pushes(h).length === 2, 'two pushes');
  assert.match(pushText(h, 0), /cannot write/);
  assert.match(pushText(h, 1), /cannot write/);
  await h.close();
});

test('send_dm is not offered when the write list names no DM', async () => {
  const h = harness({ sendChannels: ['C9'] });
  await initialize(h, true);
  const { tools } = (await h.host.sendRequest('tools/list')) as { tools: { name: string }[] };
  assert.equal(tools.some((t) => t.name === 'send_dm'), false);
  await h.close();
});
