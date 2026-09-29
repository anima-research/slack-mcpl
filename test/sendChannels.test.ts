/**
 * Tests for the SLACK_SEND_CHANNELS write allow-list.
 *
 * Run: node --import tsx --test test/sendChannels.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';

function makeAdapter(sendChannels?: string[]) {
  const calls: string[] = [];
  const record = (name: string) => async ({ channel }: { channel: string }) => {
    calls.push(`${name}:${channel}`);
    return { ts: '1.0' };
  };
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    chat: { postMessage: record('post'), update: record('update'), delete: record('delete') },
    reactions: { add: record('react') },
    conversations: { open: async () => ({ channel: { id: 'D9' } }) },
  } as any;
  return { adapter: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, sendChannels), calls };
}

test('writes outside the allow-list are refused before reaching Slack', async () => {
  const { adapter, calls } = makeAdapter(['CALLOWED']);
  await assert.rejects(adapter.sendMessage('COTHER', 'hi'), /not allowed/);
  await assert.rejects(adapter.editMessage('COTHER', '1.0', 'hi'), /not allowed/);
  await assert.rejects(adapter.deleteMessage('COTHER', '1.0'), /not allowed/);
  await assert.rejects(adapter.addReaction('COTHER', '1.0', 'eyes'), /not allowed/);
  await assert.rejects(adapter.sendDM('U1', 'hi'), /not allowed/);
  assert.deepEqual(calls, []);
});

test('writes to an allow-listed conversation pass', async () => {
  const { adapter, calls } = makeAdapter(['CALLOWED']);
  await adapter.sendMessage('CALLOWED', 'hi');
  assert.deepEqual(calls, ['post:CALLOWED']);
});

test('no allow-list means no restriction', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.sendMessage('CANY', 'hi');
  await adapter.sendDM('U1', 'hi');
  assert.deepEqual(calls, ['post:CANY', 'post:D9']);
});
