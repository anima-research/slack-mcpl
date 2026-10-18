/**
 * What fetch_attachment's download says when it fails: an answer that isn't a
 * file, a file over the limit, or a download that fails on the way. Driven
 * through fetchAttachmentBytes against a local server, so each failure is
 * Node's own fetch failing as it does.
 *
 * Run: node --import tsx --test test/fetchAttachment.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchAttachmentBytes, MAX_ATTACHMENT_BYTES } from '../src/content.js';
import { unreachableSlackApiUrl } from './slackApi.js';

async function fileServer(
  t: { after(fn: () => Promise<void> | void): void },
  answer: (res: http.ServerResponse, req: http.IncomingMessage) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    answer(res, req);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/files-pri/T1-F1/shot.png`;
}

const fetchFrom = (url: string) => fetchAttachmentBytes(url, 'shot.png');

for (const status of [403, 404]) {
  test(`HTTP ${status} from the file server says to pass the url exactly, and what else it may mean`, async (t) => {
    const url = await fileServer(t, (res) => res.writeHead(status).end());
    await assert.rejects(fetchFrom(url), {
      message:
        `Nothing was fetched: the file's url answered HTTP ${status} ${http.STATUS_CODES[status]}. Pass the url ` +
        'exactly as the message gives it after "fetchable via fetch_attachment:"; it starts with ' +
        'https://files.slack.com/. If it was exact, the file may have been deleted, or this bot may not be allowed ' +
        'to read it; calling again gets the same answer unless someone shares the file where this bot can read it, ' +
        "or, if the Slack app lacks files:read (Slack's file links need it), whoever runs this host adds that " +
        "scope to the app's bot token scopes and reinstalls the app.",
    });
  });
}

test('a 2xx answer with no body is an empty file: the server said it succeeded and sent no bytes', async (t) => {
  // Under Node's fetch, a 204's body is null.
  const url = await fileServer(t, (res) => res.writeHead(204).end());
  const fetched = await fetchFrom(url);
  assert.equal(fetched.buf.byteLength, 0);
});

for (const status of [408, 429, 503]) {
  test(`HTTP ${status} says to try again, since it says nothing about the url`, async (t) => {
    const url = await fileServer(t, (res) => res.writeHead(status).end());
    await assert.rejects(fetchFrom(url), {
      message: `Nothing was fetched: the file's url answered HTTP ${status} ${http.STATUS_CODES[status]}, so the server was busy or failing. Try again shortly.`,
    });
  });
}

test('a download that never reaches a server says why, and to try again', async () => {
  const url = (await unreachableSlackApiUrl()) + 'shot.png';
  await assert.rejects(fetchFrom(url), (err: Error) => {
    assert.match(err.message, /^Nothing was fetched: the download failed on the way \(connect ECONNREFUSED 127\.0\.0\.1:\d+\)\. Try again shortly\.$/);
    return true;
  });
});

test('a download cut off partway says it failed on the way, and why', async (t) => {
  const url = await fileServer(t, (res) => {
    // The answer's head and part of its body, then the connection ends: the
    // failure comes while the body is read.
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4096' });
    res.write(Buffer.alloc(1024));
    res.socket?.end();
  });
  await assert.rejects(fetchFrom(url), (err: Error) => {
    assert.match(err.message, /^Nothing was fetched: the download failed on the way \(.+\)\. Try again shortly\.$/);
    // The cause's own words, not fetch's outer "terminated".
    assert.doesNotMatch(err.message, /\(terminated\)/);
    return true;
  });
});

test("a redirect to another origin is followed, and the bot's token isn't sent there", async (t) => {
  const seen: Array<string | undefined> = [];
  const there = await fileServer(t, (res, req) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('the file');
  });
  // Another port is another origin, as another host is.
  const here = await fileServer(t, (res, req) => {
    seen.push(req.headers.authorization);
    res.writeHead(302, { location: there }).end();
  });
  const fetched = await fetchAttachmentBytes(here, 'shot.png', { headers: { Authorization: 'Bearer xoxb-test' } });
  assert.equal(fetched.buf.toString(), 'the file');
  assert.deepEqual(seen, ['Bearer xoxb-test', undefined]);
});

const limit = "fetch_attachment's limit of 5 MiB (5,242,880 bytes)";
const sameAnswer = ", so calling again gets the same answer; this server can't fetch a file that large.";

test('a file whose declared size is over the limit names its size and the limit', async (t) => {
  const url = await fileServer(t, (res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(MAX_ATTACHMENT_BYTES + 1) });
    res.write(Buffer.alloc(1));
  });
  await assert.rejects(fetchFrom(url), { message: `Nothing was fetched: the file is 5,242,881 bytes, over ${limit}${sameAnswer}` });
});

test('a download that passes the limit without declaring its size is stopped there', async (t) => {
  const url = await fileServer(t, (res) => {
    res.writeHead(200, { 'content-type': 'image/png' }); // chunked: no size declared
    for (let i = 0; i < 5; i++) res.write(Buffer.alloc(1024 * 1024));
    res.end(Buffer.alloc(1));
  });
  await assert.rejects(fetchFrom(url), { message: `Nothing was fetched: the download passed ${limit}${sameAnswer}` });
});
