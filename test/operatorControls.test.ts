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
    /disabled/,
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
