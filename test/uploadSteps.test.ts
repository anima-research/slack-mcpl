/**
 * upload_file in Slack's three steps, through the real client against a local
 * endpoint that answers as Slack does: what each step's failure tells the
 * agent, which uploads a rollback deletes, and the message that shared the
 * file, which holds its comment.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import {
  OutOfCallTime,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  fileLeftByUpload,
  withCallTime,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { explainSlackError } from '../src/slack-errors.js';
import { MESSAGING_FEATURE_SET } from '../src/feature-sets.js';
import { FULL_GRANT, connectHost, initialize, uploadEndpoint } from './harness.js';
import { fakeSlackApi, silentSlackApi, unreachableSlackApiUrl, type FakeSlackApi, type SlackApiAnswer } from './slackApi.js';

let api: FakeSlackApi;
let client: SlackWebClient;
before(async () => {
  api = await fakeSlackApi();
  client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
});
after(() => api.close());

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };
const adapter = () => new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
type ToolResult = { isError?: boolean; content: { text: string }[]; state?: { checkpoint: string } };

/** Slack's first answer: where to send file `id`'s bytes. */
const target = (url: string, id: string): SlackApiAnswer => ({ body: { ok: true, upload_url: url, file_id: id } });
/** Slack's last answer, sharing file `id`, by message `ts` when given. */
const sharedBy = (id: string, ts?: string): SlackApiAnswer =>
  ({ body: { ok: true, files: [{ id, ...(ts ? { shares: { public: { C1: [{ ts }] } } } : {}) }] } });

/** Each step answers as given until the test ends. */
async function steps(
  t: { after(fn: () => void): void },
  answers: { first?: SlackApiAnswer; bytes?: SlackApiAnswer; last?: SlackApiAnswer; url?: string } = {},
) {
  const url = answers.url ?? `${api.url}file-upload`;
  api.answerFor('files.getUploadURLExternal', answers.first ?? target(url, 'F1'));
  api.answerFor('file-upload', answers.bytes ?? { body: { ok: true } });
  api.answerFor('files.completeUploadExternal', answers.last ?? sharedBy('F1', '5.5'));
  api.answerFor('chat.postMessage', { body: { ok: true, ts: '1.1' } });
  t.after(() => {
    for (const m of ['files.getUploadURLExternal', 'file-upload', 'files.completeUploadExternal', 'chat.postMessage', 'chat.delete', 'files.delete']) {
      api.answerFor(m);
    }
  });
}

/** A server over the real client, with slack.messaging active, so its uploads
 *  are checkpointed and can be rolled back. */
async function server(t: { after(fn: () => Promise<void>): void }) {
  const h = connectHost(new SlackMcplServer(adapter()));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const call = (name: string, args: Record<string, unknown>) =>
    h.host.sendRequest('tools/call', { name, arguments: args }) as Promise<ToolResult>;
  const rollback = (checkpoint: string) => h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint,
  }) as Promise<{ success: boolean; reason?: string }>;
  return { h, call, rollback };
}

/** Methods called from `from` on, the upload's own bytes request included,
 *  less the listing a grant starts in the background. */
const called = (from: number) => api.calls.slice(from).filter((m) => m !== 'conversations.list');

test('an upload asks for a URL, sends the bytes there as the body, and shares the file', { timeout: 5000 }, async (t) => {
  const { url, bytes } = await uploadEndpoint();
  await steps(t, { first: target(`${url}/FSTEP`, 'FSTEP'), last: sharedBy('FSTEP', '5.5') });
  const from = api.calls.length;
  const uploaded = await adapter().uploadFile('C1', { filename: 'report.txt', data: Buffer.from('héllo'), comment: 'Here', threadTs: '1.0' });
  assert.deepEqual(uploaded, { fileId: 'FSTEP', shareTs: '5.5' });
  assert.deepEqual(called(from), ['files.getUploadURLExternal', 'files.completeUploadExternal']);
  const [first, last] = [api.sent[from], api.sent[from + 1]];
  assert.deepEqual([first.get('filename'), first.get('length')], ['report.txt', '6']);
  assert.deepEqual(
    [last.get('files'), last.get('channel_id'), last.get('initial_comment'), last.get('thread_ts')],
    [JSON.stringify([{ id: 'FSTEP', title: 'report.txt' }]), 'C1', 'Here', '1.0'],
  );
  assert.deepEqual(bytes.get('FSTEP'), Buffer.from('héllo'));
});

test("a failure of the first step uploads nothing, says so, and isn't kept for rollback", { timeout: 5000 }, async (t) => {
  for (const [first, says] of [
    [{ body: { ok: false, error: 'missing_scope', needed: 'files:write' } }, /\n\nNothing was uploaded: this bot's Slack app hasn't been granted the scope this call needs \(Slack names files:write\)/],
    [{ status: 503, body: { ok: false } }, /\n\nNothing was uploaded: Slack answered with HTTP 503\. Try again shortly\.$/],
  ] as const) {
    await steps(t, { first });
    const from = api.calls.length;
    const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
    assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }), says);
    assert.deepEqual(called(from), ['files.getUploadURLExternal']);
    assert.equal(fileLeftByUpload(err), undefined);
  }
});

test("a first answer with no upload URL or file ID uploads nothing", { timeout: 5000 }, async (t) => {
  for (const body of [{ ok: true, file_id: 'F1' }, { ok: true, upload_url: `${api.url}file-upload` }]) {
    await steps(t, { first: { body } });
    const from = api.calls.length;
    const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
    assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
      "files.getUploadURLExternal: Slack's answer gave no upload URL or file ID, so nothing was uploaded");
    assert.deepEqual(called(from), ['files.getUploadURLExternal']);
  }
});

test("bytes the call's time leaves no room for aren't sent, and nothing is uploaded", { timeout: 10_000 }, async (t) => {
  // 11 s are left, and the first step takes 1.2 s of them.
  await steps(t, { first: { ...target(`${api.url}file-upload`, 'F1'), delayMs: 1200 } });
  const from = api.calls.length;
  const err = await withCallTime(Date.now() - 14_000, () => adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }))
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof OutOfCallTime, String(err));
  assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    /^The upload of the file's bytes: out of this call's time\n\nNothing was uploaded: this server gives each call 25 seconds/);
  assert.deepEqual(called(from), ['files.getUploadURLExternal']);
});

test("bytes whose connection fails share nothing, and say so", { timeout: 5000 }, async (t) => {
  await steps(t, { url: `${await unreachableSlackApiUrl()}file-upload` });
  const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    "The upload of the file's bytes: the connection failed\n\nNothing was uploaded: the connection to Slack's upload " +
      "server failed while it took the file's bytes, and Slack shares a file only once they have arrived. Try again shortly.");
});

test("bytes that don't reach Slack's upload server share nothing, and say so", { timeout: 5000 }, async (t) => {
  await steps(t, { bytes: { status: 500, body: { ok: false } } });
  const from = api.calls.length;
  const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    "The upload of the file's bytes: HTTP 500\n\nNothing was uploaded: Slack's upload server answered HTTP 500 while it " +
      "took the file's bytes, and Slack shares a file only once they have arrived. Try again shortly.");
  assert.deepEqual(called(from), ['files.getUploadURLExternal', 'file-upload'], 'the file was never shared');
  assert.equal(fileLeftByUpload(err), undefined);
});

test("bytes that don't arrive within the client's timeout share nothing, and calling again is safe", { timeout: 5000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  await steps(t, { url: `${silent.url}file-upload` });
  // The post's own timeout, the client's 10 s, held to 50 ms here.
  const real = AbortSignal.timeout.bind(AbortSignal);
  const asked: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { asked.push(ms); return real(50); });
  const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  assert.deepEqual(asked, [SLACK_CLIENT_OPTIONS.timeout]);
  assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    "The upload of the file's bytes: timed out\n\nNothing was uploaded: Slack's upload server didn't take the file's " +
      'bytes within 10 seconds, and Slack shares a file only once they have arrived, so calling again is safe. If ' +
      "it keeps timing out, this server's connection to Slack is too slow to send this file within 10 seconds.");
  assert.equal(silent.requests(), 1);
});

test("a last step the call's time leaves no room for isn't sent, shares nothing, and isn't kept for rollback", { timeout: 10_000 }, async (t) => {
  // 11 s of the call's 25 are left: enough for the first two steps, each of
  // whose 10 s fits, and the bytes take 1.2 s, after which the last step's
  // 10 s don't.
  await steps(t, { bytes: { body: { ok: true }, delayMs: 1200 } });
  const from = api.calls.length;
  const err = await withCallTime(Date.now() - 14_000, () => adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }))
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof OutOfCallTime, String(err));
  assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    /\n\nNothing was shared: this server gives each call 25 seconds .* It wasn't sent, so calling again is safe\.$/);
  assert.deepEqual(called(from), ['files.getUploadURLExternal', 'file-upload']);
  assert.equal(fileLeftByUpload(err), undefined);
});

test("a refusal of the last step says nothing was shared, and a rollback still deletes the file it left", { timeout: 5000 }, async (t) => {
  await steps(t, { last: { body: { ok: false, error: 'not_in_channel' } } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  const refused = await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text,
    /\n\nNothing was shared: this bot isn't a member of conversation C1, so Slack didn't let it share the file there\. /);
  const from = api.calls.length;
  assert.equal((await rollback(before.state!.checkpoint)).success, true);
  assert.deepEqual(called(from), ['files.delete']);
  assert.equal(api.sent.at(-1)?.get('file'), 'F1');
});

test('a last step that fails in a way that may have shared the file says what to check, and its file is rolled back', { timeout: 5000 }, async (t) => {
  for (const [last, cause, partly] of [
    [{ body: { ok: false, error: 'internal_error' } }, 'Slack failed while handling the call', ' (Slack says part of a call can take effect before this error)'],
    [{ body: { ok: false, error: 'service_unavailable' } }, 'Slack failed while handling the call', ''],
    [{ status: 503, body: { ok: false } }, 'Slack answered with HTTP 503', ''],
  ] as const) {
    await steps(t, { last });
    const { call, rollback } = await server(t);
    const before = await call('send_message', { channelId: 'C1', content: 'before' });
    const failed = await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', messageId: '1.7' });
    assert.equal(failed.isError, true);
    assert.ok(failed.content[0].text.endsWith(
      `\n\n${cause}, so whether the file was shared is unknown${partly}. Check fetch_thread for the thread under ` +
        "message 1.7 in conversation C1 before uploading again, so it isn't shared twice."), failed.content[0].text);
    const from = api.calls.length;
    await rollback(before.state!.checkpoint);
    assert.deepEqual(called(from), ['files.delete'], cause);
  }
});

test('a last step answered without the file leaves the file for rollback', { timeout: 5000 }, async (t) => {
  await steps(t, { last: { body: { ok: true, files: [] } } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  assert.equal((await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a' })).isError, true);
  const from = api.calls.length;
  await rollback(before.state!.checkpoint);
  assert.deepEqual(called(from), ['files.delete']);
  assert.equal(api.sent.at(-1)?.get('file'), 'F1');
});

test('a rollback deletes the file and then the message that shared it, which holds its comment', { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  assert.notEqual((await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' })).isError, true);
  const from = api.calls.length;
  const rolledBack = await rollback(before.state!.checkpoint);
  assert.deepEqual(rolledBack, { checkpoint: before.state!.checkpoint, success: true });
  assert.deepEqual(called(from), ['files.delete', 'chat.delete']);
  assert.equal(api.sent.at(-1)?.get('ts'), '5.5');
});

test('a sharing message already gone when the file was deleted counts as deleted', { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  api.answerFor('chat.delete', { body: { ok: false, error: 'message_not_found' } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  const rolledBack = await rollback(before.state!.checkpoint);
  assert.deepEqual(rolledBack, { checkpoint: before.state!.checkpoint, success: true });
});

test("a sharing message that can't be deleted leaves the upload counted as not deleted, and says which", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  api.answerFor('chat.delete', { body: { ok: false, error: 'cant_delete_message' } });
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  const rolledBack = await rollback(before.state!.checkpoint);
  assert.equal(rolledBack.reason, 'Rolled back (0/1 files deleted)');
  assert.deepEqual(lines.filter((l) => l.includes('Rollback')), [
    "[slack-mcpl] Rollback couldn't delete file F1 in C1: deleted the file, but not its sharing message 5.5: An API error occurred: cant_delete_message",
  ]);
});

test('a rollback that deletes a file but not a later message counts each kind apart', { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  // The sharing message goes; the later message doesn't.
  api.answerFor('chat.delete', { body: { ok: true } }, { body: { ok: false, error: 'cant_delete_message' } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a' });
  await call('send_message', { channelId: 'C1', content: 'after' });
  assert.equal((await rollback(before.state!.checkpoint)).reason, 'Rolled back (0/1 messages and 1/1 files deleted)');
});

test("an upload whose answer named no sharing message says on rollback that its comment may remain", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1') });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  const from = api.calls.length;
  const rolledBack = await rollback(before.state!.checkpoint);
  assert.deepEqual(called(from), ['files.delete']);
  assert.equal(rolledBack.reason, "The comment of uploaded file F1 may remain: Slack's answer named no message that shared it");
  // Without a comment, there is nothing to say.
  const next = await call('send_message', { channelId: 'C1', content: 'next' });
  await call('upload_file', { channelId: 'C1', filename: 'b.txt', content: 'b' });
  assert.equal((await rollback(next.state!.checkpoint)).reason, undefined);
});

test("the explainer gives upload_file's messageId the thread's parent, and its own way into or out of a thread", async (t) => {
  for (const [last, says] of [
    [{ body: { ok: false, error: 'message_not_found' } }, /Pass the thread's parent id: a reply's thread=, or the id of the message the replies are under/],
    [{ body: { ok: false, error: 'restricted_action_thread_only_channel' } }, /takes messages only as thread replies\. Pass messageId, the id of the message whose thread the file goes in\.$/],
    [{ body: { ok: false, error: 'restricted_action_non_threadable_channel' } }, /doesn't take thread replies\. Upload without messageId instead\.$/],
  ] as const) {
    await steps(t, { last });
    const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a'), threadTs: '1.7' }).then(() => null, (e: unknown) => e);
    assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1', messageId: '1.7' } }), says);
  }
});
