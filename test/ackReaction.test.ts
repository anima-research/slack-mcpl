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

/** A web whose reactions.add waits for `release()`, to model a slow Slack. */
function makeSlowAdapter(removeFails?: () => Error | null) {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    chat: { postMessage: async ({ channel }: any) => { calls.push(`post:${channel}`); return { ts: '9.0' }; } },
    reactions: {
      add: async ({ channel, timestamp }: any) => { calls.push(`add-start:${timestamp}`); await gate; calls.push(`add-done:${timestamp}`); },
      remove: async ({ channel, timestamp }: any) => {
        const err = removeFails?.();
        calls.push(`remove:${timestamp}${err ? ':failed' : ''}`);
        if (err) throw err;
      },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  return { adapter, calls, release };
}

test('a reply that lands while the reaction is still being added does not leave it behind', async () => {
  const { adapter, calls, release } = makeSlowAdapter();
  const acked = adapter.acknowledge('C1', '1.0'); // add is in flight
  await new Promise((r) => setTimeout(r, 0));
  const posted = adapter.sendMessage('C1', 'answer');
  await new Promise((r) => setTimeout(r, 0));
  release();
  await Promise.all([acked, posted]);
  await new Promise((r) => setTimeout(r, 0));
  // The removal waits for the add to finish, so it is the last thing that happens.
  assert.deepEqual(calls, ['add-start:1.0', 'post:C1', 'add-done:1.0', 'remove:1.0']);
});

test('a removal that failed without an answer from Slack is tried again, a few times at most', async () => {
  let failure: Error | null = new Error('socket hang up');
  const { adapter, calls, release } = makeSlowAdapter(() => failure);
  release();
  await adapter.acknowledge('C1', '1.0');
  await adapter.clearAck('C1');
  assert.deepEqual(calls.filter((c) => c.startsWith('remove')), ['remove:1.0:failed']);

  failure = null;
  await adapter.clearAck('C1'); // still pending, so it is tried again
  assert.deepEqual(calls.filter((c) => c.startsWith('remove')), ['remove:1.0:failed', 'remove:1.0']);
  await adapter.clearAck('C1'); // and now it is gone
  assert.equal(calls.filter((c) => c.startsWith('remove')).length, 2);

  const flaky = makeSlowAdapter(() => new Error('socket hang up'));
  flaky.release();
  await flaky.adapter.acknowledge('C1', '3.0');
  for (let i = 0; i < 8; i++) await flaky.adapter.clearAck('C1');
  assert.equal(flaky.calls.filter((c) => c.startsWith('remove')).length, 5, 'gives up after 5 tries');
});

test('a removal Slack itself refused is not tried again', async () => {
  for (const error of ['message_not_found', 'is_archived', 'not_in_channel']) {
    const { adapter, calls, release } = makeSlowAdapter(() => Object.assign(new Error(error), { data: { error } }));
    release();
    await adapter.acknowledge('C1', '2.0');
    await adapter.clearAck('C1');
    await adapter.clearAck('C1');
    assert.equal(calls.filter((c) => c.startsWith('remove')).length, 1, error);
  }
});

test('the same message acknowledged twice gets one reaction, and a reply removes it', async () => {
  const { adapter, calls, settle } = makeAdapter({ ackReaction: 'eyes' });
  await adapter.acknowledge('C1', '1.0');
  await adapter.acknowledge('C1', '1.0'); // Slack redelivered the event
  await adapter.sendMessage('C1', 'answer');
  await settle();
  assert.deepEqual(calls, ['add:C1:1.0:eyes', 'post:C1', 'remove:C1:1.0:eyes']);
});

test('stop() takes pending reactions off', async () => {
  const { adapter, calls, release } = makeSlowAdapter();
  release();
  await adapter.acknowledge('C1', '1.0');
  await adapter.stop();
  assert.ok(calls.includes('remove:1.0'));
});

test('no new reaction once stop() has begun', async () => {
  const { adapter, calls, release } = makeSlowAdapter();
  release();
  await adapter.stop();
  await adapter.acknowledge('C1', '2.0');
  assert.deepEqual(calls, []);
});
