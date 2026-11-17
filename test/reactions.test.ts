import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { method } from '@animalabs/mcpl-core';
import { SlackAdapter, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
import { featureSetForTool } from '../src/feature-sets.js';
import { TOOL_CLASSES } from '../src/tool-classes.js';
import { connectHost, harness, initialize, FULL_GRANT } from './harness.js';

const args = { channelId: 'C1', messageId: '1.0', emoji: ':eyes:' };
const refusal = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), {
  code: ErrorCode.PlatformError, data: { ok: false, error },
});
async function call(h: Pick<ReturnType<typeof harness>, 'host'>, name: string, arguments_: Record<string, unknown>) {
  return await h.host.sendRequest('tools/call', { name, arguments: arguments_ }) as {
    isError?: boolean; content: Array<{ text: string }>;
  };
}

for (const name of ['fetch_history', 'fetch_thread']) {
  test(`${name} renders counts, own reactions and a per-message cap without extra Slack reads`, async t => {
    const h = harness({ historyMessages: [{ ts: '1.0', text: 'hello', reactions: [
      { name: 'eyes', count: 7, users: ['UBOT', 'U2'] },
      ...Array.from({ length: 22 }, (_, i) => ({ name: `emoji_${i}`, count: 3, users: ['U2', 'U3', 'U4'] })),
    ] }] });
    t.after(() => h.close());
    await initialize(h, false);
    const result = await call(h, name, { channelId: 'C1', ...(name === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
    assert.notEqual(result.isError, true);
    const message = JSON.parse(result.content[0]!.text).messages[0];
    assert.equal(message.reactions.length, 20);
    assert.deepEqual(message.reactions[0], { name: 'eyes', count: 7, own: true });
    assert.deepEqual(message.reactions[1], { name: 'emoji_0', count: 3, own: false });
    assert.equal(message.reactionsOmitted, 3);
    assert.deepEqual(h.reads, [name === 'fetch_history' ? 'history:C1' : 'replies:C1:1.0']);
    assert.deepEqual(h.reactions, []);
  });

  for (const reactions of [undefined, []]) {
    test(`${name} is byte-identical without reactions (${reactions === undefined ? 'absent' : 'empty'})`, async t => {
      const h = harness({ historyMessages: [{ ts: '1.0', text: 'hello', ...(reactions ? { reactions } : {}) }] });
      t.after(() => h.close());
      await initialize(h, false);
      const result = await call(h, name, { channelId: 'C1', ...(name === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
      // Literal baseline fields and ordering, captured on upstream before implementation.
      assert.equal(result.content[0]!.text, JSON.stringify({
        messages: [{ id: '1.0', author: 'bot', timestamp: '1970-01-01T00:00:01.000Z', content: 'hello', rootTs: '1.0' }],
        channel: { id: 'C1', writable: true },
        pagination: { scanned: 1, matched: 1, returned: 1, pages: 1, scanComplete: true, stopReason: 'exhausted',
          threadRepliesSearched: name === 'fetch_thread', scope: name === 'fetch_history' ? 'channel_messages' : 'single_thread' },
      }));
    });
  }
}

test('reactions count against the existing maxBytes budget', async t => {
  const h = harness({ historyMessages: Array.from({ length: 20 }, (_, i) => ({ ts: `${i + 1}.0`, text: 'hello',
    reactions: Array.from({ length: 20 }, (_, j) => ({ name: `emoji_${j}`, count: 4, users: ['UBOT'] })),
  })) });
  t.after(() => h.close());
  await initialize(h, false);
  const result = await call(h, 'fetch_history', { channelId: 'C1', maxBytes: 4096 });
  assert.notEqual(result.isError, true);
  assert.ok(Buffer.byteLength(result.content[0]!.text) <= 4096);
  const value = JSON.parse(result.content[0]!.text);
  assert.ok(value.messages.length > 0 && value.messages.length < 20);
  assert.equal(value.pagination.stopReason, 'byte_limit');
});

test('remove_reaction mirrors add_reaction schema, feature set and tool class, and dispatches success', async t => {
  const add = toolDefinitions.find(t => t.name === 'add_reaction')!;
  const remove = toolDefinitions.find(t => t.name === 'remove_reaction')!;
  assert.deepEqual(remove.inputSchema.required, add.inputSchema.required);
  assert.deepEqual(Object.keys(remove.inputSchema.properties), Object.keys(add.inputSchema.properties));
  assert.deepEqual(remove.inputSchema.properties.messageId, { type: 'string', description: 'Message ID (ts) to remove the reaction from' });
  assert.equal(featureSetForTool('remove_reaction'), featureSetForTool('add_reaction'));
  assert.deepEqual(TOOL_CLASSES.remove_reaction, TOOL_CLASSES.add_reaction);
  const h = harness(); t.after(() => h.close());
  await initialize(h, false);
  const result = await call(h, 'remove_reaction', args);
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]!.text, 'Reaction removed');
  assert.deepEqual(h.reactions, ['remove:C1:1.0:eyes']);
});

function adapterFixture(opts: { sendChannels?: string[]; disableDms?: boolean; error?: string; slowAdd?: Promise<void>; onRemove?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  let error = opts.error;
  const web = {
    conversations: { info: async () => { calls.push('info'); return { channel: { is_im: true } }; } },
    reactions: {
      add: async () => { calls.push('add'); await opts.slowAdd; },
      remove: async ({ name, timestamp }: { name: string; timestamp: string }) => { calls.push(`remove:${timestamp}:${name}`); await opts.onRemove?.(); if (error) throw refusal(error); },
    },
  } as unknown as SlackWebLike;
  const socket = { on() {}, async start() {}, async disconnect() {} };
  const slack = new SlackAdapter(web, socket, 'UBOT', 'test', undefined, opts.sendChannels, opts.disableDms, 'eyes');
  return { slack, calls, setError: (value?: string) => { error = value; } };
}

test('remove_reaction maps no_reaction to a fixed error for absent or other-user reactions', async t => {
  const f = adapterFixture({ error: 'no_reaction' });
  const h = connectHost(new SlackMcplServer(f.slack)); t.after(() => h.close());
  await initialize(h, false);
  const result = await call(h, 'remove_reaction', args);
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, "An API error occurred: no_reaction\n\nNo reaction was removed: this bot has no such reaction on that message. Only this bot's own reactions can be removed.");
});

for (const code of ['missing_scope', 'channel_not_found', 'invalid_name', 'internal_error']) {
  test(`remove_reaction explains ${code} through the shared Slack error path`, async t => {
    const f = adapterFixture({ error: code });
    const h = connectHost(new SlackMcplServer(f.slack)); t.after(() => h.close());
    await initialize(h, false);
    const result = await call(h, 'remove_reaction', args);
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, code === 'internal_error' ? /whether the reaction was removed is unknown/ : /No reaction was removed:/);
  });
}

test('send-list refusal precedes every Slack call, including the DM lookup', async t => {
  const f = adapterFixture({ sendChannels: ['COTHER'], disableDms: true });
  const h = connectHost(new SlackMcplServer(f.slack)); t.after(() => h.close());
  await initialize(h, false);
  const result = await call(h, 'remove_reaction', args);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /No reaction was removed: this bot may write only to COTHER/);
  assert.deepEqual(f.calls, []);
});

test('DM writability refusal prevents removal', async t => {
  const f = adapterFixture({ disableDms: true });
  const h = connectHost(new SlackMcplServer(f.slack)); t.after(() => h.close());
  await initialize(h, false);
  const result = await call(h, 'remove_reaction', args);
  assert.equal(result.isError, true);
  assert.deepEqual(f.calls, ['info']);
});

test('disabled feature sets refuse reads and removal before Slack', async t => {
  const h = harness(); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT, disabled: ['slack.messaging', 'slack.history'] });
  for (const name of ['remove_reaction', 'fetch_history', 'fetch_thread']) {
    const result = await call(h, name, { ...args, threadTs: '1.0' });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /turned off on this host/);
  }
  assert.deepEqual(h.reactions, []);
  assert.deepEqual(h.reads, []);
});

for (const error of [undefined, 'no_reaction']) {
  test(`manual removal retires only the matching ACK (${error ?? 'success'})`, async () => {
    const f = adapterFixture();
    await f.slack.acknowledge('C1', '1.0');
    await f.slack.acknowledge('C1', '2.0');
    f.setError(error);
    const removed = f.slack.removeReaction('C1', '1.0', ':eyes:');
    if (error) await assert.rejects(removed); else await removed;
    f.setError();
    await f.slack.clearAck('C1');
    assert.deepEqual(f.calls, ['add', 'add', 'remove:1.0:eyes', 'remove:2.0:eyes']);
  });
}

test('manual removal waits for a pending ACK add and shares cleanup with clearAck', async () => {
  let release!: () => void;
  const f = adapterFixture({ slowAdd: new Promise<void>(r => { release = r; }) });
  const acked = f.slack.acknowledge('C1', '1.0');
  const removed = f.slack.removeReaction('C1', '1.0', 'eyes');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(f.calls, ['add']);
  const cleared = f.slack.clearAck('C1');
  release();
  await Promise.all([acked, removed, cleared]);
  await f.slack.clearAck('C1');
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes']);
});

test('failed manual removal retains ACK cleanup; another emoji does not retire it', async () => {
  const f = adapterFixture();
  await f.slack.acknowledge('C1', '1.0');
  await f.slack.removeReaction('C1', '1.0', 'thumbsup');
  f.setError('internal_error');
  await assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'));
  f.setError();
  await f.slack.clearAck('C1');
  assert.deepEqual(f.calls, ['add', 'remove:1.0:thumbsup', 'remove:1.0:eyes', 'remove:1.0:eyes']);
});

test('thread replies have their own reactions, without an omitted count below the cap', async t => {
  const h = harness({ historyMessages: [
    { ts: '1.0', text: 'parent' },
    { ts: '2.0', thread_ts: '1.0', text: 'reply', reactions: [{ name: 'thumbsup', count: 5 }] },
  ] });
  t.after(() => h.close());
  await initialize(h, false);
  const result = await call(h, 'fetch_thread', { channelId: 'C1', threadTs: '1.0' });
  assert.notEqual(result.isError, true);
  const [parent, reply] = JSON.parse(result.content[0]!.text).messages;
  assert.equal(parent.reactions, undefined);
  assert.deepEqual(reply.reactions, [{ name: 'thumbsup', count: 5 }]);
  assert.equal(reply.reactionsOmitted, undefined);
});

test('an unknown bot user ID marks no reaction as own', async () => {
  const web = { conversations: { history: async () => ({ messages: [
    { ts: '1.0', reactions: [{ name: 'eyes', count: 1, users: ['UBOT'] }] },
  ] }) } } as unknown as SlackWebLike;
  const slack = new SlackAdapter(web, { on() {}, async start() {}, async disconnect() {} }, null, 'test');
  const result = await slack.readHistory('C1', {});
  assert.deepEqual(result.messages[0]!.reactions, [{ name: 'eyes', count: 1 }]);
});

/** Drain asynchronous work started by timer callbacks or JSON-RPC dispatch. */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
}

test('manual removal joins automatic timer cleanup first, without another Slack call or an error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  let present = true;
  const f = adapterFixture({ onRemove: async () => {
    await pending;
    if (!present) throw refusal('no_reaction');
    present = false;
  } });
  const h = connectHost(new SlackMcplServer(f.slack));
  t.after(async () => { release(); await f.slack.stop(); await h.close(); });
  await initialize(h, false);
  await f.slack.acknowledge('C1', '1.0');
  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  const removed = call(h, 'remove_reaction', args);
  await flush();
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes'], 'manual call must wait, not send a competing removal');
  release();
  const result = await removed;
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]!.text, 'Nothing changed: ACK cleanup for message 1.0 already finished.');
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes']);
  t.mock.timers.tick(20 * 60 * 1000);
  await flush();
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes']);
});

test('manual failure cancels the old expiry and retries on its new timer, then retires cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = adapterFixture({ error: 'internal_error' });
  t.after(() => f.slack.stop());
  await f.slack.acknowledge('C1', '1.0');
  t.mock.timers.tick(9.5 * 60 * 1000);
  await assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'));
  f.setError();
  t.mock.timers.tick(30 * 1000);
  await flush();
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes'], 'old ten-minute expiry must be cancelled');
  t.mock.timers.tick(30 * 1000 - 1);
  await flush();
  assert.equal(f.calls.length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes', 'remove:1.0:eyes'], 'retry is due one minute after failure');
  t.mock.timers.tick(20 * 60 * 1000);
  await flush();
  assert.equal(f.calls.length, 3, 'successful timer cleanup must retire the entry');
});

for (const error of ['message_not_found', 'no_reaction']) {
  test(`manual ${error} refusal retires ACK cleanup without a timer retry`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = adapterFixture({ error });
    t.after(() => f.slack.stop());
    await f.slack.acknowledge('C1', '1.0');
    await assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'));
    t.mock.timers.tick(20 * 60 * 1000);
    await flush();
    assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes']);
  });
}

test('manual and automatic removal failures share the five-attempt ACK limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = adapterFixture({ error: 'internal_error' });
  t.after(() => f.slack.stop());
  await f.slack.acknowledge('C1', '1.0');
  for (let i = 0; i < 4; i++) await assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'));
  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.equal(f.calls.length, 6, 'four manual attempts plus the fifth automatic attempt');
  for (let i = 0; i < 20; i++) { t.mock.timers.tick(60 * 1000); await flush(); }
  assert.equal(f.calls.length, 6, 'no sixth automatic attempt');
});

test('a fifth manual failure drops cleanup rather than arming a sixth attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = adapterFixture({ error: 'internal_error' });
  t.after(() => f.slack.stop());
  await f.slack.acknowledge('C1', '1.0');
  for (let i = 0; i < 5; i++) await assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'));
  t.mock.timers.tick(20 * 60 * 1000);
  await flush();
  assert.equal(f.calls.length, 6);
});

test('a manual removal failing during stop leaves no retry timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const f = adapterFixture({ error: 'internal_error', onRemove: () => pending });
  t.after(() => { release(); });
  await f.slack.acknowledge('C1', '1.0');
  // One observer, calling through: stop's final sweep would hide a re-arm
  // from a calls-only assertion, so count the timers actually armed.
  const timers = t.mock.method(f.slack as unknown as { armAck(channel: string, ts: string, ms: number): ReturnType<typeof setTimeout> }, 'armAck');
  const failed = assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'));
  await flush();
  const stopped = f.slack.stop();
  release();
  await Promise.all([failed, stopped]);
  assert.equal(timers.mock.callCount(), 0, 'no retry may be armed once stopping');
  t.mock.timers.tick(20 * 60 * 1000);
  await flush();
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes']);
});

for (const name of ['fetch_history', 'fetch_thread']) {
  test(`${name} distinguishes absent from unknown ownership and validates reaction metadata`, async t => {
    const h = harness({ historyMessages: [{ ts: '1.0', reactions: [
      null, 1, 'eyes', [], { name: {} },
      { name: 'own_partial', count: 7, users: ['UBOT'] },
      { name: 'other_complete', count: 1, users: ['U2'] },
      { name: 'unknown_partial', count: 2, users: ['U2'] },
      { name: 'unknown_missing', count: 2 },
      { name: 'unknown_string', count: 1, users: 'notUBOTsuffix' },
      { name: 'unknown_object', count: 1, users: { length: 1, includes: true } },
      { name: 'bad_string_count', count: '1', users: ['U2'] },
      { name: 'bad_infinite_count', count: Infinity, users: ['UBOT'] },
      { name: 'bad_fraction_count', count: 1.5 },
      { name: 'bad_negative_count', count: -1 },
      { name: 'bad_unsafe_count', count: Number.MAX_SAFE_INTEGER + 1 },
      { name: 'missing_count', users: ['U2'] },
    ] }] });
    t.after(() => h.close());
    await initialize(h, false);
    const result = await call(h, name, { channelId: 'C1', ...(name === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0]!.text).messages[0].reactions, [
      { name: 'own_partial', count: 7, own: true },
      { name: 'other_complete', count: 1, own: false },
      { name: 'unknown_partial', count: 2 },
      { name: 'unknown_missing', count: 2 },
      { name: 'unknown_string', count: 1 },
      { name: 'unknown_object', count: 1 },
      { name: 'bad_string_count' },
      { name: 'bad_infinite_count', own: true },
      { name: 'bad_fraction_count' },
      { name: 'bad_negative_count' },
      { name: 'bad_unsafe_count' },
      { name: 'missing_count' },
    ]);
  });
  for (const reactions of ['eyes', { length: 1 }, [null, 'eyes', { name: 1 }]]) {
    test(`${name} ignores malformed reactions ${JSON.stringify(reactions)}`, async t => {
      const h = harness({ historyMessages: [{ ts: '1.0', reactions }] });
      t.after(() => h.close());
      await initialize(h, false);
      const result = await call(h, name, { channelId: 'C1', ...(name === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
      assert.notEqual(result.isError, true);
      const message = JSON.parse(result.content[0]!.text).messages[0];
      assert.equal(message.reactions, undefined);
      assert.equal(message.reactionsOmitted, undefined);
    });
  }
}

test('read tool descriptions expose reaction fields, cap and unknown ownership', () => {
  for (const name of ['fetch_history', 'fetch_thread']) {
    const description = toolDefinitions.find(t => t.name === name)!.description;
    for (const term of ['reactions', 'reactionsOmitted', 'own', '20', 'unknown']) assert.ok(description.includes(term));
  }
});

for (const reason of ['is_archived', 'missing_scope', 'stopping', 'exhausted']) {
  test(`joining ACK cleanup dropped for ${reason} still asks Slack and reports its refusal`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    let hold = false;
    const error = reason === 'stopping' || reason === 'exhausted' ? 'internal_error' : reason;
    const f = adapterFixture({ error, onRemove: async () => { if (hold) await pending; } });
    const h = connectHost(new SlackMcplServer(f.slack));
    t.after(async () => { release(); await f.slack.stop(); await h.close(); });
    await initialize(h, false);
    await f.slack.acknowledge('C1', '1.0');
    if (reason === 'exhausted') {
      for (let i = 0; i < 4; i++) await assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'));
    }
    hold = true;
    t.mock.timers.tick((reason === 'exhausted' ? 1 : 10) * 60 * 1000);
    await flush();
    const before = f.calls.length;
    const removed = call(h, 'remove_reaction', args);
    await flush();
    assert.equal(f.calls.length, before, 'manual removal waits for the automatic outcome');
    const stopped = reason === 'stopping' ? f.slack.stop() : undefined;
    release();
    const result = await removed;
    await stopped;
    assert.equal(result.isError, true, 'dropping cleanup does not prove the reaction is gone');
    assert.match(result.content[0]!.text, new RegExp(`An API error occurred: ${error}`));
    assert.equal(f.calls.length, before + 1, 'manual call must obtain its own Slack answer');
    t.mock.timers.tick(20 * 60 * 1000);
    await flush();
    assert.equal(f.calls.length, before + 1, 'terminal cleanup remains retired');
  });
}

test('joining automatic no_reaction confirms absence without a second Slack call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const f = adapterFixture({ error: 'no_reaction', onRemove: () => pending });
  const h = connectHost(new SlackMcplServer(f.slack));
  t.after(async () => { release(); await f.slack.stop(); await h.close(); });
  await initialize(h, false);
  await f.slack.acknowledge('C1', '1.0');
  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  const removed = call(h, 'remove_reaction', args);
  await flush();
  release();
  const result = await removed;
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]!.text, 'Nothing changed: ACK cleanup for message 1.0 already finished.');
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes']);
});

test('overlapping manual removals share confirmed ACK removal at the adapter', async t => {
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  let present = true;
  const f = adapterFixture({ onRemove: async () => {
    await pending;
    if (!present) throw refusal('no_reaction');
    present = false;
  } });
  t.after(async () => { release(); await f.slack.stop(); });
  await f.slack.acknowledge('C1', '1.0');
  const first = f.slack.removeReaction('C1', '1.0', 'eyes');
  await flush();
  const second = f.slack.removeReaction('C1', '1.0', 'eyes');
  await flush();
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes']);
  const results = Promise.all([first, second]);
  release();
  assert.deepEqual(await results, [true, false], 'the joining caller reports Nothing changed');
  assert.equal(present, false);
  assert.deepEqual(f.calls, ['add', 'remove:1.0:eyes'], 'exactly one reactions.remove');
});
