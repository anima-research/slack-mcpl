/**
 * A rollback deletes what its checkpoint's state doesn't hold, whichever
 * branch the checkpoint is on: a rollback starts a new branch from its target,
 * and a host can hold a checkpoint from the branch an earlier rollback left.
 * Driven through the real client against a local endpoint that answers as
 * Slack does, each post with its own ts unless a test gives the ts itself.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SLACK_CLIENT_OPTIONS, SlackAdapter, SlackWebClient, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { MESSAGING_FEATURE_SET } from '../src/feature-sets.js';
import { FULL_GRANT, connectHost, initialize } from './harness.js';
import { fakeSlackApi, type FakeSlackApi } from './slackApi.js';

let api: FakeSlackApi;
let client: SlackWebClient;
before(async () => {
  api = await fakeSlackApi();
  client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
});
after(() => api.close());

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };

/** A server with slack.messaging active, whose posts get ts 1.1, 1.2, … in turn. */
async function server(t: { after(fn: () => unknown): void }) {
  api.answerFor('chat.postMessage', ...Array.from({ length: 20 }, (_, i) => ({ body: { ok: true, ts: `1.${i + 1}` } })));
  t.after(() => api.answerFor('chat.postMessage'));
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  /** Posts `content`, and gives the checkpoint its answer carries. */
  const send = async (content: string) => {
    const sent = (await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content } })) as {
      state: { checkpoint: string };
    };
    return sent.state.checkpoint;
  };
  const rollback = (checkpoint: string) => h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint,
  }) as Promise<{ success: boolean; reason?: string }>;
  /** The ts of each chat.delete from `from` on. */
  const deleted = (from: number) =>
    api.calls.flatMap((called, i) => (i >= from && called === 'chat.delete' ? [api.sent[i].get('ts')] : []));
  return { h, send, rollback, deleted };
}

test('a rollback deletes the messages sent after its checkpoint', { timeout: 5000 }, async (t) => {
  const { send, rollback, deleted } = await server(t);
  const one = await send('one');
  await send('two');
  await send('three');
  // A whole UUID, so no two checkpoints share an ID.
  assert.match(one, /^chk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const from = api.calls.length;
  assert.deepEqual(await rollback(one), { checkpoint: one, success: true });
  assert.deepEqual(deleted(from), ['1.2', '1.3']);
});

/** A messaging call's checkpoint and its parent, as the result gives them. */
type State = { checkpoint: string; parent: string | null };

test("a process's first post can be rolled back: its result names the tree's root as its checkpoint's parent", { timeout: 5000 }, async (t) => {
  const { h, rollback, deleted } = await server(t);
  const first = (await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'one' },
  })) as { state: State };
  const { checkpoint, parent } = first.state;
  assert.match(parent ?? 'none', /^chk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(parent, checkpoint);
  const from = api.calls.length;
  assert.deepEqual(await rollback(parent!), { checkpoint: parent, success: true });
  assert.deepEqual(deleted(from), ['1.1']);
});

test('each messaging result names the checkpoint before its own, which after a rollback is its target', { timeout: 5000 }, async (t) => {
  const { h, rollback } = await server(t);
  const post = async (content: string) => ((await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content },
  })) as { state: State }).state;
  const one = await post('one');
  const two = await post('two');
  assert.equal(two.parent, one.checkpoint);
  await rollback(one.checkpoint);
  const three = await post('three');
  assert.equal(three.parent, one.checkpoint, 'three starts a branch from one');
});

test('a rollback to a checkpoint on the branch an earlier rollback left deletes what the later branch sent', { timeout: 5000 }, async (t) => {
  const { send, rollback, deleted } = await server(t);
  const one = await send('one');
  const two = await send('two');
  const three = await send('three');
  await rollback(one);
  await send('four');
  let from = api.calls.length;
  // Four was sent on the branch from one, so "three"'s state doesn't hold it.
  // Two and three, which the rollback to one deleted, don't come back.
  assert.equal((await rollback(three)).success, true);
  assert.deepEqual(deleted(from), ['1.4']);
  await send('five');
  from = api.calls.length;
  // Five was sent on the branch from three, so "two"'s state doesn't hold it.
  await rollback(two);
  assert.deepEqual(deleted(from), ['1.5']);
});

test('a rollback to the current checkpoint deletes nothing sent before it', { timeout: 5000 }, async (t) => {
  const { send, rollback, deleted } = await server(t);
  await send('one');
  const two = await send('two');
  const from = api.calls.length;
  assert.deepEqual(await rollback(two), { checkpoint: two, success: true });
  assert.deepEqual(deleted(from), []);
});

test("a message delete_message removed isn't deleted again by a rollback", { timeout: 5000 }, async (t) => {
  const { h, send, rollback, deleted } = await server(t);
  const one = await send('one');
  await send('two');
  const removed = (await h.host.sendRequest('tools/call', {
    name: 'delete_message', arguments: { channelId: 'C1', messageId: '1.2' },
  })) as { isError?: boolean };
  assert.notEqual(removed.isError, true);
  const from = api.calls.length;
  assert.deepEqual(await rollback(one), { checkpoint: one, success: true });
  assert.deepEqual(deleted(from), []);
});

test('delete_message forgets only its message, in its own conversation', { timeout: 5000 }, async (t) => {
  const { h, send, rollback } = await server(t);
  const zero = await send('zero');
  // A ts is unique within a conversation, not across them: the first two
  // posts both get 7.7. The third, in C1 too, gets 7.8.
  api.answerFor('chat.postMessage', { body: { ok: true, ts: '7.7' } }, { body: { ok: true, ts: '7.7' } }, { body: { ok: true, ts: '7.8' } });
  const post = (channelId: string) =>
    h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId, content: 'x' } });
  await post('C1');
  await post('C2');
  await post('C1');
  await h.host.sendRequest('tools/call', { name: 'delete_message', arguments: { channelId: 'C1', messageId: '7.7' } });
  const from = api.calls.length;
  await rollback(zero);
  const deletes = api.calls.flatMap((called, i) =>
    (i >= from && called === 'chat.delete' ? [[api.sent[i].get('channel'), api.sent[i].get('ts')]] : []));
  assert.deepEqual(deletes, [['C2', '7.7'], ['C1', '7.8']]);
});

test('a message published after the last checkpoint, which no checkpoint covers yet, is deleted by a rollback to it', { timeout: 5000 }, async (t) => {
  const { h, send, rollback, deleted } = await server(t);
  const one = await send('one');
  const published = (await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: 'slack:C1', content: [{ type: 'text', text: 'published' }],
  })) as { delivered: boolean; messageId?: string };
  assert.deepEqual(published, { delivered: true, messageId: '1.2' });
  const from = api.calls.length;
  assert.deepEqual(await rollback(one), { checkpoint: one, success: true });
  assert.deepEqual(deleted(from), ['1.2']);
});

test("a checkpoint covers every message sent since the one before it, a published one included", { timeout: 5000 }, async (t) => {
  const { h, send, rollback, deleted } = await server(t);
  const one = await send('one');
  await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'published' }] });
  const two = await send('two');
  let from = api.calls.length;
  assert.deepEqual(await rollback(two), { checkpoint: two, success: true });
  assert.deepEqual(deleted(from), [], "two's state holds the published message");
  from = api.calls.length;
  await rollback(one);
  assert.deepEqual(deleted(from), ['1.2', '1.3']);
});

test("a message Slack says is gone counts as deleted: delete_message forgets it, and a rollback's delete of it succeeds", { timeout: 5000 }, async (t) => {
  const { h, send, rollback, deleted } = await server(t);
  t.after(() => api.answerFor('chat.delete'));
  const one = await send('one');
  await send('two');
  await send('three');
  api.answerFor('chat.delete', { body: { ok: false, error: 'message_not_found' } });
  const removed = (await h.host.sendRequest('tools/call', {
    name: 'delete_message', arguments: { channelId: 'C1', messageId: '1.2' },
  })) as { isError?: boolean };
  assert.equal(removed.isError, true, "delete_message still says Slack didn't find it");
  const from = api.calls.length;
  // Three's delete is answered message_not_found too, as one someone else made.
  assert.deepEqual(await rollback(one), { checkpoint: one, success: true });
  assert.deepEqual(deleted(from), ['1.3'], 'two was forgotten');
});

test('a delete_message whose outcome is unknown keeps its message, for a rollback to delete', { timeout: 5000 }, async (t) => {
  const { h, send, rollback, deleted } = await server(t);
  t.after(() => api.answerFor('chat.delete'));
  const one = await send('one');
  await send('two');
  api.answerFor('chat.delete', { status: 503, body: { ok: false } });
  const removed = (await h.host.sendRequest('tools/call', {
    name: 'delete_message', arguments: { channelId: 'C1', messageId: '1.2' },
  })) as { isError?: boolean };
  assert.equal(removed.isError, true);
  api.answerFor('chat.delete');
  const from = api.calls.length;
  assert.deepEqual(await rollback(one), { checkpoint: one, success: true });
  assert.deepEqual(deleted(from), ['1.2']);
});
