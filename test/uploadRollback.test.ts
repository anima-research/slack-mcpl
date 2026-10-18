import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import { featureSetForTool, MESSAGING_FEATURE_SET } from '../src/feature-sets.js';
import { FULL_GRANT, MENTION_EVENT, connectHost, fakeSlack, harness, initialize, until } from './harness.js';

type ToolResult = { content: { text: string }[]; state?: { checkpoint: string }; isError?: boolean };
const call = (host: ReturnType<typeof connectHost>['host'], name: string, args: Record<string, unknown>) =>
  host.sendRequest('tools/call', { name, arguments: args }) as Promise<ToolResult>;
const uploadArgs = { channelId: 'C1', filename: 'hello.txt', content: 'hello' };
/** The ts of each chat.delete call, in order. */
const ts = (deleted: unknown[]) => deleted.map((args) => (args as { ts: string }).ts);

async function ready(h: Pick<ReturnType<typeof connectHost>, 'host' | 'hostSaw'>) {
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
}

test('rollback deletes an uploaded file and later message, preserving the checkpoint message', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await ready(h);
  const before = await call(h.host, 'send_message', { channelId: 'C1', content: 'before' });
  const uploaded = await call(h.host, 'upload_file', uploadArgs);
  assert.ok(uploaded.state?.checkpoint, 'an upload returns a checkpoint');
  await call(h.host, 'send_message', { channelId: 'C1', content: 'after' });
  const rollback = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint: before.state!.checkpoint,
  }) as { success: boolean; reason?: string };
  assert.equal(rollback.success, true);
  assert.equal(rollback.reason, undefined);
  assert.deepEqual(h.deletedFiles, ['F1'], 'delete the Slack file, not a nonexistent message timestamp');
  // The message that shared the file, 900.1, and the message after it, 100.2;
  // not the checkpoint's own message, 100.1.
  assert.deepEqual(ts(h.deletedMessages), ['900.1', '100.2']);
});

test('rolling back to the upload checkpoint preserves that file', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await ready(h);
  const uploaded = await call(h.host, 'upload_file', uploadArgs);
  await call(h.host, 'upload_file', { ...uploadArgs, filename: 'later.txt' });
  const rollback = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint: uploaded.state!.checkpoint,
  }) as { success: boolean };
  assert.equal(rollback.success, true);
  assert.deepEqual(h.deletedFiles, ['F2'], 'only files sent after the checkpoint are removed');
  assert.deepEqual(ts(h.deletedMessages), ['900.2'], 'and the message that shared it');
});

test('upload rollback tracking survives reconnect and waits for the new peer messaging grant', async (t) => {
  const fake = fakeSlack();
  const server = new SlackMcplServer(fake.slack);
  const first = connectHost(server);
  await ready(first);
  const before = await call(first.host, 'send_message', { channelId: 'C1', content: 'before' });
  await call(first.host, 'upload_file', uploadArgs);
  await first.close();
  const next = connectHost(server);
  t.after(() => next.close());
  await initialize(next, true);
  const rollback = () => next.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint: before.state!.checkpoint,
  }) as Promise<{ success: boolean }>;
  assert.equal((await rollback()).success, false);
  assert.deepEqual(fake.deletedFiles, []);
  await next.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  assert.equal((await rollback()).success, true);
  assert.deepEqual(fake.deletedFiles, ['F1']);
});

test('upload_file belongs to slack.messaging and cannot upload while that feature is inactive', async (t) => {
  assert.equal(featureSetForTool('upload_file'), MESSAGING_FEATURE_SET);
  const h = harness();
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
    effectiveCapabilities: FULL_GRANT.filter((capability) => capability !== 'channels.incoming'),
  });
  const result = await call(h.host, 'upload_file', uploadArgs);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /slack\.messaging.*not enabled/);
  assert.deepEqual(h.uploads, []);
});

test('SLACK_DISABLE_DMS refuses an upload before Slack receives file bytes', async (t) => {
  const h = harness({ disableDms: true });
  t.after(() => h.close());
  await ready(h);
  const result = await call(h.host, 'upload_file', { ...uploadArgs, channelId: 'D1' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SLACK_DISABLE_DMS/);
  assert.deepEqual(h.uploads, []);
});

test('a successful upload clears the acknowledgement reaction', async (t) => {
  const h = harness({ ackReaction: 'eyes' });
  t.after(() => h.close());
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => h.reactions.includes('add:C1:111.1:eyes'), 'ack reaction');
  const result = await call(h.host, 'upload_file', uploadArgs);
  assert.notEqual(result.isError, true);
  await until(() => h.reactions.includes('remove:C1:111.1:eyes'), 'ack removal');
});

test('a refused upload keeps the acknowledgement reaction, which only a confirmed one clears', async (t) => {
  const h = harness({ ackReaction: 'eyes' });
  t.after(() => h.close());
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => h.reactions.includes('add:C1:111.1:eyes'), 'ack reaction');
  const refused = await call(h.host, 'upload_file', { ...uploadArgs, title: 'refused' });
  assert.equal(refused.isError, true);
  // A removal the refused call started would be recorded by now: the fake
  // answered the add at once, so clearAck reaches reactions.remove in
  // microtasks, and the fake records it as it's called, before the call's
  // answer can reach the host.
  assert.ok(!h.reactions.includes('remove:C1:111.1:eyes'), 'the reaction stays');
  assert.notEqual((await call(h.host, 'upload_file', uploadArgs)).isError, true);
  await until(() => h.reactions.includes('remove:C1:111.1:eyes'), 'ack removal');
});

test('rollback reports a failed file deletion while still deleting its sharing message and later messages', async (t) => {
  const fake = fakeSlack();
  t.mock.method(fake.slack, 'deleteFile', async () => { throw new Error('Slack refused file deletion'); });
  const h = connectHost(new SlackMcplServer(fake.slack));
  t.after(() => h.close());
  await ready(h);
  const before = await call(h.host, 'send_message', { channelId: 'C1', content: 'before' });
  await call(h.host, 'upload_file', uploadArgs);
  await call(h.host, 'send_message', { channelId: 'C1', content: 'after' });
  const rollback = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint: before.state!.checkpoint,
  }) as { success: boolean; reason?: string };
  assert.equal(rollback.success, true, 'rollback retains the existing best-effort contract');
  assert.equal(rollback.reason, 'Rolled back (2/2 messages and 0/1 files deleted)');
  assert.deepEqual(ts(fake.deletedMessages), ['900.1', '100.2']);
});

test('an upload marks its conversation as the one last posted in, so a message there names no conversation', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await ready(h);
  await call(h.host, 'upload_file', uploadArgs);
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push/event');
  const pushed = h.hostSaw.find((r) => r.method === method.PUSH_EVENT)!.params as { payload: { content: { text: string }[] } };
  assert.doesNotMatch(pushed.payload.content.map((c) => c.text).join('\n'), /#general \(acme\)/);
  // Without the upload, the same message names its conversation.
  const fresh = harness();
  t.after(() => fresh.close());
  await ready(fresh);
  await fresh.socket.emitMessage(MENTION_EVENT);
  await until(() => fresh.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push/event');
  const first = fresh.hostSaw.find((r) => r.method === method.PUSH_EVENT)!.params as { payload: { content: { text: string }[] } };
  assert.match(first.payload.content.map((c) => c.text).join('\n'), /#general \(acme\)/);
});

test('file deletion retains the upload destination allow-list and DM guards', async () => {
  const restricted = fakeSlack({ sendChannels: ['C1'] });
  await assert.rejects(restricted.slack.deleteFile('C9', 'F1'), /not allowed/);
  assert.deepEqual(restricted.deletedFiles, []);
  const noDms = fakeSlack({ disableDms: true });
  await assert.rejects(noDms.slack.deleteFile('D1', 'F1'), /SLACK_DISABLE_DMS/);
  assert.deepEqual(noDms.deletedFiles, []);
});
