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

async function ready(h: ReturnType<typeof connectHost>) {
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
  assert.equal(h.deletedMessages.length, 1, 'only the message after the upload is deleted');
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
  assert.deepEqual(h.deletedMessages, []);
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

test('rollback reports a failed file deletion while still deleting later messages', async (t) => {
  const fake = fakeSlack();
  t.mock.method(fake.slack, 'deleteUploadedFile', async () => { throw new Error('Slack refused file deletion'); });
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
  assert.equal(rollback.reason, 'Rolled back (1/2 messages/files deleted)');
  assert.equal(fake.deletedMessages.length, 1);
});

test('file deletion retains the upload destination allow-list and DM guards', async () => {
  const restricted = fakeSlack({ sendChannels: ['C1'] });
  await assert.rejects(restricted.slack.deleteUploadedFile('C9', 'F1'), /not allowed/);
  assert.deepEqual(restricted.deletedFiles, []);
  const noDms = fakeSlack({ disableDms: true });
  await assert.rejects(noDms.slack.deleteUploadedFile('D1', 'F1'), /SLACK_DISABLE_DMS/);
  assert.deepEqual(noDms.deletedFiles, []);
});
