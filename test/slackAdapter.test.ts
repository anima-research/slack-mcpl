/**
 * Tests for SlackAdapter incoming-message handling (mention flag, filtering).
 *
 * Run: node --import tsx --test test/slackAdapter.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';

function makeAdapter(opts: { dmUsers?: string[] } = {}) {
  let handler: ((args: { event: any; ack: () => Promise<void> }) => void) | undefined;
  const socket = {
    on(_event: string, h: any) { handler = h; },
    async start() {},
    async disconnect() {},
  } as any;
  const web = {
    users: {
      info: async ({ user }: { user: string }) => ({ user: { name: user.toLowerCase() } }),
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', opts.dmUsers);
  const received: SlackMessageData[] = [];
  adapter.onMessage((msg) => received.push(msg));
  // The constructor's handler acks then processes asynchronously; give the
  // microtask queue a beat before asserting.
  const emit = async (event: any) => {
    handler!({ event, ack: async () => {} });
    await new Promise((r) => setTimeout(r, 0));
  };
  return { emit, received };
}

test('incoming message sets mentionsBot=true when the bot is mentioned', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', channel: 'C1', user: 'U1',
    ts: '1718000000.000100', text: 'hey <@UBOT>, look at this',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].mentionsBot, true);
  assert.deepEqual(received[0].mentionIds, ['UBOT']);
});

test('incoming message sets mentionsBot=false for other mentions and broadcasts', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', channel: 'C1', user: 'U1',
    ts: '1718000000.000200', text: '<!here> <@U2> can you take this?',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].mentionsBot, false);
});

test('a thread_broadcast that names its parent only under root keeps the thread', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', subtype: 'thread_broadcast', channel: 'C1', user: 'U1',
    ts: '6.5', text: 'also to the channel', root: { thread_ts: '6.0' },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].threadTs, '6.0');
});

test('own and bot messages are filtered out', async () => {
  const { emit, received } = makeAdapter();
  await emit({ type: 'message', channel: 'C1', user: 'UBOT', ts: '1.0', text: 'self' });
  await emit({ type: 'message', channel: 'C1', user: 'U1', bot_id: 'B1', ts: '2.0', text: 'bot' });
  assert.equal(received.length, 0);
});

test('non-content subtypes and malformed payloads are dropped', async () => {
  const { emit, received } = makeAdapter();
  await emit({ type: 'message', subtype: 'message_changed', channel: 'C1', user: 'U1', ts: '1.0', text: 'edited' });
  await emit({ type: 'message', channel: 'C1', text: 'no user or ts' });
  assert.equal(received.length, 0);
});

test('DMs are flagged and the DM whitelist drops unlisted senders', async () => {
  const { emit, received } = makeAdapter({ dmUsers: ['UFRIEND'] });
  await emit({
    type: 'message', channel: 'D1', channel_type: 'im', user: 'UFRIEND',
    ts: '3.0', text: 'hi',
  });
  await emit({
    type: 'message', channel: 'D2', channel_type: 'im', user: 'USTRANGER',
    ts: '4.0', text: 'psst',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].isDM, true);
  assert.equal(received[0].authorId, 'UFRIEND');
});

test('file shares become attachment refs with mime classification', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', subtype: 'file_share', channel: 'C1', user: 'U1', ts: '5.0',
    text: 'shot attached',
    files: [{ url_private: 'https://files.slack.com/files-pri/T1-F1/shot.png', name: 'shot.png', mimetype: 'image/png' }],
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].attachments.length, 1);
  assert.equal(received[0].attachments[0].isImage, true);
  assert.equal(received[0].attachments[0].path, 'https://files.slack.com/files-pri/T1-F1/shot.png');
});
