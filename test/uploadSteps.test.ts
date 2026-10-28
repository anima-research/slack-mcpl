/**
 * upload_file in Slack's three steps, through the real client against a local
 * endpoint that stands in for Slack's Web API: what each step's failure tells
 * the agent, which uploads a rollback deletes, and the message that shared the
 * file, which holds its comment.
 */
import http from 'node:http';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import {
  OutOfCallTime,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  UploadBytesFailed,
  fileLeftByUpload,
  withCallTime,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { explainSlackError } from '../src/slack-errors.js';
import { MESSAGING_FEATURE_SET } from '../src/feature-sets.js';
import { FULL_GRANT, connectHost, nonJsonSlackApiUrl, initialize, until, uploadEndpoint } from './harness.js';
import { fakeSlackApi, silentSlackApi, unreachableSlackApiUrl, type FakeSlackApi, type SlackApiAnswer } from './slackApi.js';
import { virtualClock } from './virtualClock.js';
import { clock } from '../src/clock.js';

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

/** A rollback's note for file F1's comment, uploaded to C1, whose sharing
 *  message this server doesn't know. */
const commentMayRemain =
  "The comment of uploaded file F1 may remain in conversation C1: this server doesn't know the message that shared " +
  "the file, so no rollback can delete it. delete_message may, by that message's id, which fetch_history shows, or " +
  'fetch_thread if the file went into a thread';

/** Methods called from `from` on, the upload's own bytes request included,
 *  less the listing a grant starts in the background. */
const called = (from: number) => api.calls.slice(from).filter((m) => m !== 'conversations.list');

test('an upload asks for a URL, sends the bytes there as the body, and shares the file', { timeout: 5000 }, async (t) => {
  const { url, bytes, posts } = await uploadEndpoint();
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
  // A POST of the bytes alone, with no token.
  const post = posts.get('FSTEP')!;
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['content-type'], 'application/octet-stream');
  assert.equal(post.headers.authorization, undefined);
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

test("a workspace's refusal of an upload says calling again won't change it, at whichever step Slack refuses (R1-2)", { timeout: 5000 }, async (t) => {
  const settings = (code: string, lead: string, allow: string, more = '') =>
    `\n\n${lead}: this workspace's settings ${allow} (${code}). Calling again won't change that; the ` +
    `workspace's admins can.${more}`;
  for (const [step, code, says] of [
    ['first', 'file_uploads_disabled', settings('file_uploads_disabled', 'Nothing was uploaded', "don't allow file uploads")],
    ['first', 'file_uploads_except_images_disabled', settings('file_uploads_except_images_disabled', 'Nothing was uploaded',
      'allow only image uploads', ' An image file may go.')],
    ['first', 'file_type_not_allowed', settings('file_type_not_allowed', 'Nothing was uploaded', "don't allow this type of file")],
    ['first', 'file_upload_size_restricted', settings('file_upload_size_restricted', 'Nothing was uploaded',
      'restrict uploads of large files', ' A smaller file may go.')],
    ['first', 'storage_limit_reached', "\n\nNothing was uploaded: this workspace has reached its file storage limit " +
      "(storage_limit_reached). Calling again won't change that; the workspace's admins can."],
    ['last', 'file_type_not_allowed', settings('file_type_not_allowed', 'Nothing was shared', "don't allow this type of file")],
    ['last', 'file_uploads_except_images_disabled', settings('file_uploads_except_images_disabled', 'Nothing was shared',
      'allow only image uploads', ' An image file may go.')],
  ] as const) {
    const refusal = { body: { ok: false, error: code } };
    await steps(t, step === 'first' ? { first: refusal } : { last: refusal });
    const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
    const said = explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } });
    assert.ok(said.endsWith(says), said);
    // A refused last step leaves its file for rollback, as not shared.
    assert.deepEqual(fileLeftByUpload(err), step === 'first' ? undefined : { fileId: 'F1', mayHaveShared: false });
  }
});

test("a first answer with no file ID uploads nothing, and one with no upload URL leaves its file for rollback", { timeout: 5000 }, async (t) => {
  for (const [body, says, left] of [
    [{ ok: true, upload_url: `${api.url}file-upload` }, 'no file ID', undefined],
    [{ ok: true, file_id: 7, upload_url: `${api.url}file-upload` }, 'no file ID', undefined],
    [{ ok: true, file_id: '', upload_url: `${api.url}file-upload` }, 'no file ID', undefined],
    [{ ok: true, file_id: 'F1' }, 'no upload URL', { fileId: 'F1', mayHaveShared: false }],
    [{ ok: true, file_id: 'F1', upload_url: '' }, 'no upload URL', { fileId: 'F1', mayHaveShared: false }],
    [{ ok: true, file_id: 'F1', upload_url: 7 }, 'no upload URL', { fileId: 'F1', mayHaveShared: false }],
  ] as const) {
    await steps(t, { first: { body } });
    const from = api.calls.length;
    const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
    assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
      `files.getUploadURLExternal: Slack's answer gave ${says}, so nothing was uploaded`);
    assert.deepEqual(called(from), ['files.getUploadURLExternal']);
    assert.deepEqual(fileLeftByUpload(err), left, JSON.stringify(body));
  }
});

test("bytes the call's time leaves no room for aren't sent, nothing is uploaded, and the file's ID is left for rollback", { timeout: 10_000 }, async (t) => {
  // 12.5 s are left, and the first step takes 3 s of them.
  virtualClock(t);
  await steps(t, { first: { ...target(`${api.url}file-upload`, 'F1'), elapseMs: 3000 } });
  const from = api.calls.length;
  const err = await withCallTime(clock.now() - 12_500, () => adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }))
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof OutOfCallTime, String(err));
  assert.equal(err.usedSeconds, 16, "the first step's 3 s count among the 15.5 used");
  assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    /^The upload of the file's bytes: out of this call's time\n\nNothing was uploaded: this server gives each call 25 seconds/);
  assert.deepEqual(called(from), ['files.getUploadURLExternal']);
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false });
});

test("bytes whose connection fails share nothing, say so, and leave the file for rollback", { timeout: 5000 }, async (t) => {
  await steps(t, { url: `${await unreachableSlackApiUrl()}file-upload` });
  const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    "The upload of the file's bytes: the connection failed\n\nNothing was shared: the connection to Slack's upload " +
      "server failed. Slack shares a file only at the upload's last step, which wasn't sent. Try again shortly. If it " +
      "keeps failing, whoever runs this host has to check its connection to Slack's upload server.");
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false });
});

test("bytes Slack's upload server answers with an error share nothing, say so, and leave the file for rollback", { timeout: 5000 }, async (t) => {
  await steps(t, { bytes: { status: 500, body: { ok: false } } });
  const from = api.calls.length;
  const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    "The upload of the file's bytes: HTTP 500\n\nNothing was shared: Slack's upload server answered the file's bytes " +
      "with HTTP 500. Slack shares a file only at the upload's last step, which wasn't sent. Try again shortly.");
  assert.deepEqual(called(from), ['files.getUploadURLExternal', 'file-upload'], 'the file was never shared');
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false });
});

test("bytes the upload server doesn't take and answer within the client's timeout share nothing, and calling again is safe", { timeout: 5000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  await steps(t, { url: `${silent.url}file-upload` });
  // The post's own timeout, the client's 10 s, fires here once the server has
  // the request, so the test waits on that, not on a length of time.
  const asked: number[] = [];
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { asked.push(ms); return timeout.signal; });
  const failed = adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  await until(() => silent.requests() === 1, 'the bytes at the upload server');
  timeout.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  const err = await failed;
  assert.deepEqual(asked, [SLACK_CLIENT_OPTIONS.timeout]);
  assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    "The upload of the file's bytes: timed out\n\nNothing was shared: the post of the file's bytes to Slack's upload " +
      "server didn't finish within 10 seconds. Slack shares a file only at the upload's last step, which wasn't sent, so " +
      "calling again is safe. If it keeps timing out, Slack's upload server or this server's connection to it is too " +
      'slow for this file within 10 seconds: a smaller file may go through, and whoever runs this host can look ' +
      'into the connection.');
  assert.equal(silent.requests(), 1);
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false });
});

test("an answer to the bytes whose body stalls times out, as the whole post is under the timeout", { timeout: 5000 }, async (t) => {
  // Headers at once, then a body that never ends.
  const stalled = http.createServer((req, res) => { req.resume(); res.writeHead(200); res.write('{'); });
  await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => { stalled.closeAllConnections(); stalled.close(); });
  const { port } = stalled.address() as { port: number };
  await steps(t, { url: `http://127.0.0.1:${port}/file-upload` });
  // The post's own timeout, the client's 10 s, fires here once fetch has the
  // answer's headers and before the body is read: the moment Node 22's fetch
  // rejects the read with an AbortError where Node 24's gives the signal's
  // TimeoutError, so the post has to read its timeout from its own signal.
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const answer = await realFetch(...args);
    timeout.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    return answer;
  });
  const from = api.calls.length;
  const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof UploadBytesFailed && err.why === 'TimeoutError', String(err));
  assert.deepEqual(called(from), ['files.getUploadURLExternal'], 'the last step was never sent');
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false });
});

test("a last step the call's time leaves no room for isn't sent, shares nothing, and leaves its file for rollback", { timeout: 10_000 }, async (t) => {
  // 12.5 s of the call's 25 are left: enough for the first two steps, each
  // of whose 10 s fits, and the bytes take 3 s, after which the last step's
  // 10 s don't.
  virtualClock(t);
  await steps(t, { bytes: { body: { ok: true }, elapseMs: 3000 } });
  const from = api.calls.length;
  const err = await withCallTime(clock.now() - 12_500, () => adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }))
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof OutOfCallTime, String(err));
  assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    /\n\nNothing was shared: this server gives each call 25 seconds .* It wasn't sent, so calling again is safe\.$/);
  assert.deepEqual(called(from), ['files.getUploadURLExternal', 'file-upload']);
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false });
});

test("a refusal of the last step says nothing was shared, and a rollback still deletes the file it left, with no note of a comment", { timeout: 5000 }, async (t) => {
  await steps(t, { last: { body: { ok: false, error: 'not_in_channel' } } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  const refused = await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text,
    /\n\nNothing was shared: this bot isn't a member of conversation C1, so Slack didn't let it share the file there\. /);
  const from = api.calls.length;
  assert.deepEqual(await rollback(before.state!.checkpoint), { checkpoint: before.state!.checkpoint, success: true });
  assert.deepEqual(called(from), ['files.delete']);
  assert.equal(api.sent.at(-1)?.get('file'), 'F1');
});

test("a last step that may have shared the file with its comment notes on rollback that the comment may remain", { timeout: 5000 }, async (t) => {
  await steps(t, { last: { body: { ok: false, error: 'internal_error' } } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  assert.equal((await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' })).isError, true);
  assert.equal((await rollback(before.state!.checkpoint)).reason, commentMayRemain);
  // Without a comment, there's none to note.
  const next = await call('send_message', { channelId: 'C1', content: 'next' });
  assert.equal((await call('upload_file', { channelId: 'C1', filename: 'b.txt', content: 'b' })).isError, true);
  assert.equal((await rollback(next.state!.checkpoint)).reason, undefined);
});

test("a last step Slack can't find the upload's file for shares nothing, and calling again starts a new upload", { timeout: 5000 }, async (t) => {
  await steps(t, { last: { body: { ok: false, error: 'file_not_found' } } });
  const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
  assert.equal(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }),
    "An API error occurred: file_not_found\n\nNothing was shared: Slack couldn't find the file this upload's first step " +
      'set up. Calling again starts a new upload.');
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false });
});

test("a last step answered in a form Slack doesn't use may have shared the file, and says to check before uploading again", { timeout: 5000 }, async (t) => {
  await steps(t);
  // The first step goes to the fake; the last to a page that isn't JSON.
  const last = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t) });
  const web = {
    files: { getUploadURLExternal: client.files.getUploadURLExternal, completeUploadExternal: last.files.completeUploadExternal },
  } as unknown as SlackWebLike;
  const err = await new SlackAdapter(web, socket, 'UBOT', 'acme').uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') })
    .then(() => null, (e: unknown) => e);
  assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: true }, String(err));
  assert.ok(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }).endsWith(
    "\n\nSlack answered in a form this server can't read, so whether the file was shared is unknown. Check fetch_history " +
      "for conversation C1 before uploading again, so it isn't shared twice."), String(err));
});

test('a last step that fails in a way that may have shared the file says what to check, and its file is rolled back', { timeout: 5000 }, async (t) => {
  for (const [last, cause, partly] of [
    [{ body: { ok: false, error: 'internal_error' } }, 'Slack failed while handling the call', ' (Slack says part of a call can take effect before this error)'],
    [{ body: { ok: false, error: 'service_unavailable' } }, 'Slack failed while handling the call', ''],
    [{ body: { ok: false, error: 'file_update_failed' } }, 'Slack failed while handling the call', ''],
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
  assert.equal(api.sent.at(-1)?.get('channel'), 'C1');
});

test('a sharing message already gone when the file was deleted counts as deleted', { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  api.answerFor('chat.delete', { body: { ok: false, error: 'message_not_found' } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  const from = api.calls.length;
  const rolledBack = await rollback(before.state!.checkpoint);
  assert.deepEqual(rolledBack, { checkpoint: before.state!.checkpoint, success: true });
  assert.deepEqual(called(from), ['files.delete', 'chat.delete']);
  assert.equal(api.sent.at(-1)?.get('ts'), '5.5');
});

test("a sharing message Slack refuses to delete counts as a message not deleted, and the file as deleted", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  api.answerFor('chat.delete', { body: { ok: false, error: 'cant_delete_message' } });
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  const rolledBack = await rollback(before.state!.checkpoint);
  // Slack will refuse it the same way, so nothing says to try it again.
  assert.equal(rolledBack.reason, 'Rolled back (0/1 messages and 1/1 files deleted). Slack refused to delete these, and calling again ' +
    "won't change that: message 5.5 in C1, which shared file F1");
  assert.deepEqual(lines.filter((l) => l.includes('Rollback')), [
    "[slack-mcpl] Rollback couldn't delete message 5.5, which shared file F1, in C1: An API error occurred: cant_delete_message",
  ]);
});

test("a file Slack refuses to delete counts as a file not deleted, and its sharing message is still deleted", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  api.answerFor('files.delete', { body: { ok: false, error: 'cant_delete_file' } });
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  const from = api.calls.length;
  assert.equal((await rollback(before.state!.checkpoint)).reason, 'Rolled back (1/1 messages and 0/1 files deleted). Slack refused to delete these, ' +
    "and calling again won't change that: file F1 in C1");
  assert.deepEqual(called(from), ['files.delete', 'chat.delete']);
  // stderr names the file left, for whoever runs this host to clean up.
  assert.ok(lines.some((line) => line.includes('F1')), lines.join('\n'));
});

test("a rollback whose file and sharing message Slack both refuses to delete names each, with its conversation", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  api.answerFor('files.delete', { body: { ok: false, error: 'cant_delete_file' } });
  api.answerFor('chat.delete', { body: { ok: false, error: 'cant_delete_message' } });
  t.mock.method(console, 'error', () => {});
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  assert.equal((await rollback(before.state!.checkpoint)).reason,
    "Rolled back (0/1 messages and 0/1 files deleted). Slack refused to delete these, and calling again won't change that: file F1 in C1; " +
      'message 5.5 in C1, which shared file F1');
});

test("a rollback names apart what Slack refused for good and what may remain, each with what can be done", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  // Slack's own failure can pass; this bot may delete only its own messages.
  api.answerFor('files.delete', { body: { ok: false, error: 'internal_error' } });
  api.answerFor('chat.delete', { body: { ok: false, error: 'cant_delete_message' } });
  t.mock.method(console, 'error', () => {});
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  assert.equal((await rollback(before.state!.checkpoint)).reason,
    'Rolled back (0/1 messages and 0/1 files deleted). May remain: file F1 in C1. No rollback tries these again: no tool here ' +
      "deletes a file, and whoever runs this host can delete it with Slack's files.delete, by its id. Slack refused to delete these, and " +
      "calling again won't change that: message 5.5 in C1, which shared file F1");
});

test("the remedy says what can be done for each kind that may remain, and nothing for a kind Slack refused", { timeout: 5000 }, async (t) => {
  // Slack's own failure can pass; this bot may delete only its own files.
  t.mock.method(console, 'error', () => {});
  for (const [file, says] of [
    [{ body: { ok: false, error: 'cant_delete_file' } }, 'May remain: message 5.5 in C1, which shared file F1. No rollback tries ' +
      "these again: delete_message can try a message among them again, by its id. Slack refused to delete these, and calling again won't " +
      'change that: file F1 in C1'],
    [{ body: { ok: false, error: 'internal_error' } }, 'May remain: file F1 in C1; message 5.5 in C1, which shared file F1. No ' +
      'rollback tries these again: delete_message can try a message among them again, by its id, and no tool here deletes a ' +
      "file, and whoever runs this host can delete it with Slack's files.delete, by its id"],
  ] as const) {
    await steps(t, { last: sharedBy('F1', '5.5') });
    api.answerFor('files.delete', file);
    api.answerFor('chat.delete', { body: { ok: false, error: 'internal_error' } });
    const { call, rollback } = await server(t);
    const before = await call('send_message', { channelId: 'C1', content: 'before' });
    await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
    assert.equal((await rollback(before.state!.checkpoint)).reason, `Rolled back (0/1 messages and 0/1 files deleted). ${says}`);
  }
});

test("a delete whose outcome is unknown leaves its item named as one that may remain", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  // Slack's own failure: part of a call can take effect before it.
  api.answerFor('chat.delete', { body: { ok: false, error: 'internal_error' } });
  t.mock.method(console, 'error', () => {});
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  assert.equal((await rollback(before.state!.checkpoint)).reason,
    'Rolled back (0/1 messages and 1/1 files deleted). May remain: message 5.5 in C1, which shared file F1. ' +
      'No rollback tries these again: delete_message can try a message among them again, by its id');
});

test("a rollback that leaves one upload's file names it, and still notes another's comment it can't reach", { timeout: 5000 }, async (t) => {
  await steps(t);
  api.answerFor('files.getUploadURLExternal', target(`${api.url}file-upload`, 'F1'), target(`${api.url}file-upload`, 'F2'));
  api.answerFor('files.completeUploadExternal', sharedBy('F1', '5.5'), sharedBy('F2'));
  api.answerFor('files.delete', { body: { ok: false, error: 'cant_delete_file' } }, { body: { ok: true } });
  t.mock.method(console, 'error', () => {});
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'One' });
  await call('upload_file', { channelId: 'C1', filename: 'b.txt', content: 'b', comment: 'Two' });
  assert.equal((await rollback(before.state!.checkpoint)).reason,
    "Rolled back (1/1 messages and 1/2 files deleted). Slack refused to delete these, and calling again won't change that: file F1 in C1. The comment of uploaded file F2 may " +
      "remain in conversation C1: this server doesn't know the message that shared the file, so no rollback can delete it. " +
      "delete_message may, by that message's id, which fetch_history shows, or fetch_thread if the file went into a thread");
});

test('a file Slack says is gone, or no longer visible to this bot, counts as deleted, and its sharing message is still deleted', { timeout: 5000 }, async (t) => {
  for (const error of ['file_deleted', 'file_not_found']) {
    await steps(t, { last: sharedBy('F1', '5.5') });
    api.answerFor('files.delete', { body: { ok: false, error } });
    const { call, rollback } = await server(t);
    const before = await call('send_message', { channelId: 'C1', content: 'before' });
    await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a' });
    const from = api.calls.length;
    assert.deepEqual(await rollback(before.state!.checkpoint), { checkpoint: before.state!.checkpoint, success: true }, error);
    assert.deepEqual(called(from), ['files.delete', 'chat.delete'], error);
    assert.equal(api.sent.at(-1)?.get('ts'), '5.5');
  }
});

test('a private channel\'s sharing message is the one a rollback deletes', { timeout: 5000 }, async (t) => {
  await steps(t, { last: { body: { ok: true, files: [{ id: 'F1', shares: { private: { C1: [{ ts: '6.6' }] } } }] } } });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  const from = api.calls.length;
  assert.deepEqual(await rollback(before.state!.checkpoint), { checkpoint: before.state!.checkpoint, success: true });
  assert.deepEqual(called(from), ['files.delete', 'chat.delete']);
  assert.equal(api.sent.at(-1)?.get('ts'), '6.6');
});

test("an upload's failed last step says which file it left and whether Slack may have shared it", { timeout: 5000 }, async (t) => {
  for (const [last, mayHaveShared] of [
    [{ body: { ok: false, error: 'not_in_channel' } }, false],
    [{ status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } }, false],
    // Without a usable Retry-After, the client's error for a 429 is a plain
    // Error, which it doesn't classify: Slack didn't act on the request.
    [{ status: 429, body: { ok: false } }, false],
    // A 200 the client can't read throws a TypeError: Slack may have acted.
    [{ body: null }, true],
    // Slack received the request only in part, so it didn't act on it.
    [{ body: { ok: false, error: 'request_timeout' } }, false],
    [{ body: { ok: false, error: 'internal_error' } }, true],
    [{ body: { ok: false, error: 'fatal_error' } }, true],
    [{ body: { ok: false, error: 'service_unavailable' } }, true],
    [{ body: { ok: false, error: 'file_update_failed' } }, true],
    [{ status: 503, body: { ok: false } }, true],
    [{ body: { ok: true, files: [] } }, true],
    // Files that aren't a list of files name none.
    [{ body: { ok: true, files: [null] } }, true],
    [{ body: { ok: true, files: {} } }, true],
  ] as const) {
    await steps(t, { last });
    const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }).then(() => null, (e: unknown) => e);
    assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared }, JSON.stringify(last));
  }
});

test('a last step whose connection was never made counts as not shared, and one that timed out as maybe shared', { timeout: 5000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  for (const [url, timeout, mayHaveShared] of [
    [await unreachableSlackApiUrl(), SLACK_CLIENT_OPTIONS.timeout, false],
    [silent.url, 50, true],
  ] as const) {
    await steps(t);
    // The first step goes to the fake; the last to `url`.
    const last = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, timeout, slackApiUrl: url });
    const web = {
      files: { getUploadURLExternal: client.files.getUploadURLExternal, completeUploadExternal: last.files.completeUploadExternal },
    } as unknown as SlackWebLike;
    const err = await new SlackAdapter(web, socket, 'UBOT', 'acme').uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') })
      .then(() => null, (e: unknown) => e);
    assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared }, String(err));
  }
});

test("the comments of two uploads whose sharing messages this server doesn't know are noted together", { timeout: 5000 }, async (t) => {
  await steps(t);
  api.answerFor('files.getUploadURLExternal', target(`${api.url}file-upload`, 'F1'), target(`${api.url}file-upload`, 'F2'));
  api.answerFor('files.completeUploadExternal', sharedBy('F1'), sharedBy('F2'));
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'One' });
  await call('upload_file', { channelId: 'C1', filename: 'b.txt', content: 'b', comment: 'Two' });
  assert.equal((await rollback(before.state!.checkpoint)).reason,
    "The comments of uploaded files F1 in C1, F2 in C1 may remain: this server doesn't know the messages that shared " +
      "them, so no rollback can delete them. delete_message may, by those messages' ids, which fetch_history shows, " +
      'or fetch_thread if the file went into a thread');
});

test("an upload's acknowledgement removal keeps its own tries, outside the upload's call", { timeout: 5000 }, async (t) => {
  await steps(t);
  t.after(() => api.answerFor('reactions.remove'));
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  await slack.acknowledge('C1', '1.1');
  api.answerFor('reactions.remove', { status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } });
  const removals = () => api.calls.filter((c) => c === 'reactions.remove').length;
  const before = removals();
  // Once its rate limit is handled, the removal's next try is armed a minute
  // on; one sent again inside the upload's call would come before that.
  const realSetTimeout = globalThis.setTimeout;
  let rearmed = false;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 60_000) rearmed = true;
    return realSetTimeout(fn, ms, ...args);
  }) as unknown as typeof setTimeout);
  await withCallTime(Date.now(), () => slack.uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }));
  await until(() => rearmed, "the removal's next try");
  assert.equal(removals() - before, 1, 'the rate-limited removal was sent once before its next try was armed');
});

test("an acknowledgement's removal answered in a form Slack doesn't use is tried again later", { timeout: 5000 }, async (t) => {
  await steps(t);
  // The removal goes to a page that isn't JSON; everything else to the fake.
  const page = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t) });
  const web = {
    reactions: { add: client.reactions.add, remove: page.reactions.remove },
    files: { getUploadURLExternal: client.files.getUploadURLExternal, completeUploadExternal: client.files.completeUploadExternal },
  } as unknown as SlackWebLike;
  const slack = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  await slack.acknowledge('C1', '1.1');
  // Its next try is armed a minute on, as for a failure that can pass; a
  // lasting refusal would drop it.
  const realSetTimeout = globalThis.setTimeout;
  let rearmed = false;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 60_000) rearmed = true;
    return realSetTimeout(fn, ms, ...args);
  }) as unknown as typeof setTimeout);
  await withCallTime(Date.now(), () => slack.uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') }));
  await until(() => rearmed, "the removal's next try");
});

test("a confirmed upload answers without waiting for its acknowledgement's removal", { timeout: 5000 }, async (t) => {
  await steps(t);
  t.after(() => api.answerFor('reactions.remove'));
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  await slack.acknowledge('C1', '1.1');
  // The removal's answer is held until the upload has answered.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  api.answerFor('reactions.remove', { body: { ok: true }, after: held });
  const removals = () => api.calls.filter((c) => c === 'reactions.remove').length;
  const before = removals();
  assert.deepEqual(await withCallTime(Date.now(), () => slack.uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') })),
    { fileId: 'F1', shareTs: '5.5' });
  await until(() => removals() > before, 'the removal, sent');
  release();
});

test("a first step whose connection is never made, or that Slack doesn't answer, uploads nothing and leaves no file", { timeout: 5000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  for (const [url, timeout, says] of [
    [await unreachableSlackApiUrl(), SLACK_CLIENT_OPTIONS.timeout, /\n\nNothing was uploaded: Slack couldn't be reached\. Try again shortly\./],
    [silent.url, 50, /\n\nNothing was uploaded: Slack went 10 seconds without answering, or the connection to it failed\. Try again shortly\.$/],
    // An answer in no form of Slack's to the first step, which comes before
    // the upload, wrote nothing either.
    [await nonJsonSlackApiUrl(t), SLACK_CLIENT_OPTIONS.timeout,
      /\n\nNothing was uploaded: Slack answered in a form this server can't read\. Try again shortly\. If it keeps failing, whoever runs this host has to check its connection to Slack\.$/],
  ] as const) {
    await steps(t);
    // The first step goes to `url`; the rest to the fake.
    const first = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, timeout, slackApiUrl: url });
    const web = {
      files: { getUploadURLExternal: first.files.getUploadURLExternal, completeUploadExternal: client.files.completeUploadExternal },
    } as unknown as SlackWebLike;
    const from = api.calls.length;
    const err = await new SlackAdapter(web, socket, 'UBOT', 'acme').uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a') })
      .then(() => null, (e: unknown) => e);
    assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }), says, String(err));
    assert.deepEqual(called(from), [], 'no bytes and no last step');
    assert.equal(fileLeftByUpload(err), undefined);
  }
});

test('a rollback that deletes a file but not a later message counts each kind apart', { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1', '5.5') });
  // Answered in the order asked: the sharing message goes; the later message
  // doesn't.
  api.answerFor('chat.delete', { body: { ok: true } }, { body: { ok: false, error: 'cant_delete_message' } });
  t.mock.method(console, 'error', () => {});
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a' });
  await call('send_message', { channelId: 'C1', content: 'after' });
  const from = api.calls.length;
  assert.equal((await rollback(before.state!.checkpoint)).reason,
    "Rolled back (1/2 messages and 1/1 files deleted). Slack refused to delete these, and calling again won't change that: message 1.1 in C1");
  assert.deepEqual(api.calls.flatMap((m, i) => (i >= from && m === 'chat.delete' ? [api.sent[i]!.get('ts')] : [])), ['5.5', '1.1']);
});

test("an upload whose answer named no sharing message says on rollback that its comment may remain", { timeout: 5000 }, async (t) => {
  await steps(t, { last: sharedBy('F1') });
  const { call, rollback } = await server(t);
  const before = await call('send_message', { channelId: 'C1', content: 'before' });
  // Confirmed, though Slack's answer named no sharing message.
  const uploaded = await call('upload_file', { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'Here' });
  // This server's listing found no conversations, so C1 has no label and the
  // answer no `to`.
  assert.deepEqual(JSON.parse(uploaded.content[0].text), { fileId: 'F1' });
  const from = api.calls.length;
  const rolledBack = await rollback(before.state!.checkpoint);
  assert.deepEqual(called(from), ['files.delete']);
  assert.equal(rolledBack.reason, commentMayRemain);
  // Without a comment, there is nothing to say.
  const next = await call('send_message', { channelId: 'C1', content: 'next' });
  await call('upload_file', { channelId: 'C1', filename: 'b.txt', content: 'b' });
  assert.equal((await rollback(next.state!.checkpoint)).reason, undefined);
});

test("the explainer gives upload_file's messageId the thread's parent, and its own way into or out of a thread", async (t) => {
  for (const [last, says] of [
    [{ body: { ok: false, error: 'message_not_found' } }, /Pass the thread's parent id: a reply's thread=, a message's own id= when it shows no thread=, or a message's rootTs in fetch_history or fetch_thread results/],
    [{ body: { ok: false, error: 'restricted_action_thread_only_channel' } }, /takes messages only as thread replies\. Pass messageId, the id of the message whose thread the file goes in\.$/],
    [{ body: { ok: false, error: 'restricted_action_non_threadable_channel' } }, /doesn't take thread replies\. Upload without messageId instead\.$/],
  ] as const) {
    await steps(t, { last });
    const err = await adapter().uploadFile('C1', { filename: 'a.txt', data: Buffer.from('a'), threadTs: '1.7' }).then(() => null, (e: unknown) => e);
    assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1', messageId: '1.7' } }), says);
  }
});
