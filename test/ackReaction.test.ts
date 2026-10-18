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

test('concurrent clears while reactions.add is pending share one removal', { timeout: 5000 }, async () => {
  const { adapter, calls, release } = makeSlowAdapter();
  const added = adapter.acknowledge('C1', '1.0');
  const clears = Array.from({ length: 8 }, () => adapter.clearAck('C1'));
  release();
  await Promise.all([added, ...clears]);
  assert.equal(calls.filter((c) => c.startsWith('remove')).length, 1);
});

/** Hold each removal until the test lets Slack answer. */
function makeSlowRemovalAdapter() {
  let removes = 0;
  let afterDisconnect = 0;
  let disconnected = false;
  const answers: Array<() => void> = [];
  const socket = {
    on() {}, async start() {},
    async disconnect() { disconnected = true; },
  };
  const web = {
    chat: { async postMessage() { return { ts: '9.0' }; } },
    reactions: {
      async add() {},
      async remove() {
        // Counted here, asserted by the test: a throw here would be caught
        // as a failed removal.
        if (disconnected) afterDisconnect++;
        removes++;
        await new Promise<void>((resolve) => answers.push(resolve));
        throw new Error('network failure');
      },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  return {
    adapter,
    get removes() { return removes; },
    get afterDisconnect() { return afterDisconnect; },
    get disconnected() { return disconnected; },
    answer() { for (const resolve of answers.splice(0)) resolve(); },
  };
}

test('concurrent posts and explicit clears share each of five removal attempts', { timeout: 5000 }, async () => {
  const h = makeSlowRemovalAdapter();
  await h.adapter.acknowledge('C1', '1.0');
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Every successful post starts a fire-and-forget clearAck.
    await Promise.all(Array.from({ length: 8 }, () => h.adapter.sendMessage('C1', 'reply')));
    const clearing = h.adapter.clearAck('C1');
    await Promise.resolve();
    const observed = h.removes;
    h.answer();
    await clearing;
    assert.equal(observed, attempt, 'one in-flight attempt per reaction');
  }
  await h.adapter.clearAck('C1');
  assert.equal(h.removes, 5, 'attempt budget is exhausted');
  await h.adapter.stop();
});

test('stop joins an in-flight removal and leaves no retry after disconnect', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSlowRemovalAdapter();
  await h.adapter.start();
  await h.adapter.acknowledge('C1', '1.0');
  const clearing = h.adapter.clearAck('C1');
  await Promise.resolve();
  const stopping = h.adapter.stop();
  await Promise.resolve();
  const observed = h.removes;
  h.answer();
  await Promise.all([clearing, stopping]);
  assert.equal(observed, 1);
  assert.equal(h.disconnected, true);
  t.mock.timers.tick(20 * 60 * 1000);
  await flush();
  h.answer(); // settle any removal the tick started, so a regression fails here rather than hangs
  await h.adapter.clearAck('C1');
  assert.equal(h.afterDisconnect, 0, 'no call reached Slack after disconnect');
  assert.equal(h.removes, 1);
});

test('stop joining a removal that has just failed leaves no retry', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail!: (err: Error) => void;
  const answer = new Promise<void>((_, reject) => { fail = reject; });
  let removes = 0;
  let started!: () => void;
  const removing = new Promise<void>((resolve) => { started = resolve; });
  let disconnected = false;
  const socket = { on() {}, async start() {}, async disconnect() { disconnected = true; } };
  const web = {
    chat: { async postMessage() { return { ts: '9.0' }; } },
    reactions: {
      async add() {},
      remove() { removes++; started(); return answer; },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket as any, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  await adapter.start();
  await adapter.acknowledge('C1', '1.0');
  const clearing = adapter.clearAck('C1');
  await removing;
  // Registered after the removal's own await: its failure arms a retry first,
  // then this starts stop() while that removal is still the shared one.
  let stopping!: Promise<void>;
  const stopStarted = answer.catch(() => { stopping = adapter.stop(); });
  fail(new Error('network failure'));
  await stopStarted;
  await Promise.all([clearing, stopping]);
  assert.equal(disconnected, true);
  assert.equal(removes, 1);
  t.mock.timers.tick(20 * 60 * 1000);
  await flush();
  assert.equal(removes, 1, 'no removal is tried after stop() resolves');
});

test('a removal that fails while stop() is still draining is not retried', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const removes: string[] = [];
  const socket = { on() {}, async start() {}, async disconnect() {} };
  const web = {
    chat: { async postMessage() { return { ts: '9.0' }; } },
    reactions: {
      async add() {},
      async remove({ channel }: any) {
        removes.push(channel);
        if (channel === 'C1') return held; // keeps stop() draining
        throw new Error('network failure');
      },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket as any, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  await adapter.start();
  await adapter.acknowledge('C1', '1.0');
  await adapter.acknowledge('C2', '2.0');
  const stopping = adapter.stop();
  await flush();
  // C2's removal has failed and C1's is still open, so stop() hasn't resolved.
  t.mock.timers.tick(20 * 60 * 1000);
  await flush();
  assert.deepEqual(removes.sort(), ['C1', 'C2'], 'no retry while stop() drains');
  release();
  await stopping;
});

test('a failed shutdown cleanup drops the scheduled retry and expiry timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, calls, release } = makeSlowAdapter(() => new Error('network failure'));
  release();
  await adapter.acknowledge('C1', '1.0');
  await adapter.clearAck('C1'); // schedule a retry
  await adapter.stop(); // final cleanup attempt
  assert.equal(calls.filter((c) => c.startsWith('remove')).length, 2);
  t.mock.timers.tick(20 * 60 * 1000);
  await adapter.clearAck('C1');
  assert.equal(calls.filter((c) => c.startsWith('remove')).length, 2);
});

/** Let timer callbacks and the removals they start run to completion. */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

const removals = (calls: string[]) => calls.filter((c) => c.startsWith('remove'));

test('an unanswered acknowledgement comes off at the ten-minute mark, with no post', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, calls, release } = makeSlowAdapter();
  release();
  await adapter.acknowledge('C1', '1.0');
  t.mock.timers.tick(10 * 60 * 1000 - 1);
  await flush();
  assert.deepEqual(removals(calls), []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(removals(calls), ['remove:1.0']);
});

test('a failed removal is tried again a minute later, with no one calling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failure: Error | null = new Error('socket hang up');
  const { adapter, calls, release } = makeSlowAdapter(() => failure);
  release();
  await adapter.acknowledge('C1', '1.0');
  await adapter.clearAck('C1'); // the bot posted there, and this attempt fails
  failure = null;
  t.mock.timers.tick(60 * 1000 - 1);
  await flush();
  assert.deepEqual(removals(calls), ['remove:1.0:failed']);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(removals(calls), ['remove:1.0:failed', 'remove:1.0']);
});

test('a retry replaces the expiry timer: no extra attempt when the ten minutes run out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, calls, release } = makeSlowAdapter(() => new Error('socket hang up'));
  release();
  await adapter.acknowledge('C1', '1.0');
  t.mock.timers.tick(9.5 * 60 * 1000);
  await adapter.clearAck('C1'); // fails at 9.5 minutes, so the retry is due at 10.5
  t.mock.timers.tick(30 * 1000);
  await flush();
  assert.equal(removals(calls).length, 1, 'nothing at 10 minutes: the expiry timer was cancelled');
  t.mock.timers.tick(30 * 1000);
  await flush();
  assert.equal(removals(calls).length, 2, 'the retry at 10.5 minutes');
});

test('an add that failed leaves no timer to clear a later acknowledgement early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  let addFails = true;
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    chat: { async postMessage() { return { ts: '9.0' }; } },
    reactions: {
      add: async ({ timestamp }: any) => { if (addFails) throw new Error('missing_scope'); calls.push(`add:${timestamp}`); },
      remove: async ({ timestamp }: any) => { calls.push(`remove:${timestamp}`); },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  await adapter.acknowledge('C1', '1.0'); // the add fails, so the entry is dropped
  t.mock.timers.tick(5 * 60 * 1000);
  addFails = false;
  await adapter.acknowledge('C1', '1.0'); // the same message, acknowledged again, now added
  t.mock.timers.tick(5 * 60 * 1000); // the first acknowledgement's ten minutes
  await flush();
  assert.deepEqual(calls, ['add:1.0'], 'not cleared early by the dropped entry\'s timer');
  t.mock.timers.tick(5 * 60 * 1000); // its own ten minutes
  await flush();
  assert.deepEqual(calls, ['add:1.0', 'remove:1.0']);
});
