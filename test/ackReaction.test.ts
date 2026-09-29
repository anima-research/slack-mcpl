/**
 * Tests for SLACK_ACK_REACTION.
 *
 * Run: node --import tsx --test test/ackReaction.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';

function makeAdapter(opts: { ackReaction?: string; sendChannels?: string[] } = {}) {
  const calls: string[] = [];
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    chat: { postMessage: async ({ channel }: any) => { calls.push(`post:${channel}`); return { ts: '9.0' }; } },
    reactions: {
      add: async ({ channel, timestamp, name }: any) => { calls.push(`add:${channel}:${timestamp}:${name}`); },
      remove: async ({ channel, timestamp, name }: any) => { calls.push(`remove:${channel}:${timestamp}:${name}`); },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, opts.sendChannels, false, opts.ackReaction);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { adapter, calls, settle };
}

test('reaction is added on acknowledge and removed when the bot posts there', async () => {
  const { adapter, calls, settle } = makeAdapter({ ackReaction: 'eyes' });
  await adapter.acknowledge('C1', '1.0');
  await adapter.acknowledge('C1', '2.0');
  await adapter.sendMessage('C1', 'answer');
  await settle();
  assert.deepEqual(calls, ['add:C1:1.0:eyes', 'add:C1:2.0:eyes', 'post:C1', 'remove:C1:1.0:eyes', 'remove:C1:2.0:eyes']);
});

test('a post in another conversation leaves the reaction in place', async () => {
  const { adapter, calls, settle } = makeAdapter({ ackReaction: 'eyes' });
  await adapter.acknowledge('C1', '1.0');
  await adapter.sendMessage('C2', 'elsewhere');
  await settle();
  assert.deepEqual(calls, ['add:C1:1.0:eyes', 'post:C2']);
});

test('no reaction outside the write allow-list, and no error', async () => {
  const { adapter, calls } = makeAdapter({ ackReaction: 'eyes', sendChannels: ['CALLOWED'] });
  await adapter.acknowledge('COTHER', '1.0');
  assert.deepEqual(calls, []);
});

test('off unless configured', async () => {
  const { adapter, calls, settle } = makeAdapter();
  await adapter.acknowledge('C1', '1.0');
  await adapter.sendMessage('C1', 'answer');
  await settle();
  assert.deepEqual(calls, ['post:C1']);
});
