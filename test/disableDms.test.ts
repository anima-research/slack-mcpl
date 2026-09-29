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
