/**
 * Tests for SLACK_DISABLE_DMS.
 *
 * Run: node --import tsx --test test/disableDms.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';

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
  await assert.rejects(adapter.sendDM('U1', 'hi'), /disabled/);
  await assert.rejects(adapter.fetchHistory('D1'), /disabled/);
  await assert.rejects(adapter.fetchThread('D1', '1.0'), /disabled/);
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
        if (channel === 'G2') return { channel: { id: 'G2', name: 'secret', is_private: true, is_member: true } };
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
  await assert.rejects(adapter.sendMessage('D1', 'hi'), /disabled/);
  await assert.rejects(adapter.editMessage('D1', '1.0', 'hi'), /disabled/);
  await assert.rejects(adapter.deleteMessage('D1', '1.0'), /disabled/);
  await assert.rejects(adapter.addReaction('D1', '1.0', 'eyes'), /disabled/);
  await assert.rejects(adapter.fetchHistory('D1'), /disabled/);
  assert.deepEqual(calls, []);
});

test('a group DM is told from a private channel by asking Slack, and unknown means refused', async () => {
  const { adapter, calls } = makeStrictAdapter();
  await assert.rejects(adapter.fetchHistory('G1'), /disabled/);
  await assert.rejects(adapter.fetchThread('G1', '1.0'), /disabled/);
  await assert.rejects(adapter.sendMessage('G1', 'hi'), /disabled/);
  assert.ok(!calls.some((c) => /^(history|replies|post):G1/.test(c)));

  await adapter.fetchHistory('G2'); // an old-style private channel is fine
  await adapter.sendMessage('G2', 'hi');
  assert.ok(calls.includes('history:G2'));
  assert.equal(calls.filter((c) => c === 'info:G2').length, 1, 'asked about once');

  await assert.rejects(adapter.fetchHistory('GUNKNOWN'), /disabled/, 'fail closed when Slack cannot say');
});

test('with DMs disabled, conversations.list is not asked for DMs or group DMs', async () => {
  const { adapter, listTypes } = makeStrictAdapter();
  await adapter.listConversations();
  assert.deepEqual(listTypes, ['public_channel,private_channel']);
});

test('a user ID is refused: posting to it would land in that user\'s DM', async () => {
  const { adapter, calls } = makeStrictAdapter();
  await assert.rejects(adapter.sendMessage('U123', 'hi'), /disabled/);
  await assert.rejects(adapter.fetchHistory('CUNKNOWN'), /disabled/);
  assert.ok(!calls.some((c) => /^(post|history):/.test(c)));
});
