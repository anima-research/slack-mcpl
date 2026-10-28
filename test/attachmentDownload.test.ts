/**
 * fetch_attachment's download keeps its call's time, as every request a call
 * makes does: it starts only if its whole timeout, the Web API client's, fits
 * before the call's deadline, and that timeout ends it, while its body is
 * still arriving too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  CALL_SECONDS,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { fetchAttachmentBytes } from '../src/content.js';
import { connectHost, initialize, until } from './harness.js';
import { silentSlackApi } from './slackApi.js';

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };
const FILE_URL = 'https://files.slack.com/files-pri/T1-F1/report.txt';
type Result = { isError?: boolean; content: { text: string }[] };
const timedOut = (err: unknown) => (err as { name?: unknown } | null)?.name === 'TimeoutError';

/** What AbortSignal.timeout aborts with. */
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

test('a download that gets no answer ends when its signal aborts', { timeout: 5000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  const abort = new AbortController();
  const download = fetchAttachmentBytes(`${silent.url}report.txt`, 'report.txt', { signal: abort.signal });
  await until(() => silent.requests() === 1, 'the request');
  abort.abort(timeout());
  await assert.rejects(download, timedOut);
});

test("a download its caller's signal ends rejects with the caller's own reason", { timeout: 5000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  const abort = new AbortController();
  const download = fetchAttachmentBytes(`${silent.url}report.txt`, 'report.txt', { signal: abort.signal });
  await until(() => silent.requests() === 1, 'the request');
  const reason = new Error('stop');
  abort.abort(reason);
  await assert.rejects(download, (err: unknown) => err === reason);
});

test('a download every address of the file host refuses says why, for each address', { timeout: 5000 }, async (t) => {
  const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: new AggregateError([refused('10.0.0.1:443'), refused('[::1]:443')]) });
  });
  await assert.rejects(fetchAttachmentBytes(FILE_URL, 'report.txt'), {
    message: 'Nothing was fetched: the download failed on the way (connect ECONNREFUSED 10.0.0.1:443; connect ' +
      'ECONNREFUSED [::1]:443). Try again shortly.',
  });
});

test('a download whose body stalls after the headers ends when its signal aborts too', { timeout: 5000 }, async (t) => {
  // The headers and the first bytes, then nothing more.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
    res.write('the first bytes');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as { port: number };
  // The signal aborts once the response, headers and all, has arrived, so
  // what it ends is the body.
  let answered = false;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    answered = true;
    return response;
  });
  const abort = new AbortController();
  const download = fetchAttachmentBytes(`http://127.0.0.1:${port}/report.txt`, 'report.txt', { signal: abort.signal });
  await until(() => answered, 'the headers');
  abort.abort(timeout());
  await assert.rejects(download, timedOut);
});

test("fetch_attachment's download has the client's timeout, and one that runs out says calling again is safe", { timeout: 5000 }, async (t) => {
  // Each signal AbortSignal.timeout gives is one the test aborts, so no real
  // 10 s pass. The download is the one fetch the call makes.
  const signals = new Map<AbortSignal, { ms: number; abort: AbortController }>();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const abort = new AbortController();
    signals.set(abort.signal, { ms, abort });
    return abort.signal;
  });
  const downloads: Array<{ url: string; signal?: AbortSignal | null }> = [];
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
    downloads.push({ url: String(url), signal: init?.signal });
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
  });
  const client = new SlackWebClient('xoxb-test', SLACK_CLIENT_OPTIONS);
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, false);
  const answer = h.host.sendRequest('tools/call', { name: 'fetch_attachment', arguments: { url: FILE_URL } }) as Promise<Result>;
  await until(() => downloads.length === 1, 'the download');
  assert.equal(downloads[0].url, FILE_URL);
  const timer = downloads[0].signal ? signals.get(downloads[0].signal) : undefined;
  assert.equal(timer?.ms, SLACK_CLIENT_OPTIONS.timeout, "the download's signal is AbortSignal.timeout's, with the client's timeout");
  timer!.abort.abort(timeout());
  const result = await answer;
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    'The operation was aborted due to timeout\n\n' +
      `Nothing was fetched: Slack's file host didn't finish sending the file within ${SLACK_CLIENT_OPTIONS.timeout / 1000} ` +
      "seconds. Fetching changes nothing, so calling again is safe. If it keeps timing out, Slack's file host or this " +
      `server's connection to it is too slow to send this file within ${SLACK_CLIENT_OPTIONS.timeout / 1000} seconds.`,
  );
});

test("a download its call's time has no room for isn't started, and says calling again is safe", { timeout: 10_000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  const slow = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: silent.url });
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    downloads++;
    throw new Error('no download was expected');
  });
  const h = connectHost(new SlackMcplServer(new SlackAdapter(slow as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, false);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // The server stamps each request's arrival as it parses it, before this
  // listener hears it.
  let arrived = 0;
  h.serverConn.on('request', () => arrived++);
  const post = h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'hi' } });
  const fetchCall = h.host.sendRequest('tools/call', { name: 'fetch_attachment', arguments: { url: FILE_URL } }) as Promise<Result>;
  await until(() => arrived === 2 && silent.requests() === 1, "both calls' arrival, and the first call's post");
  // By the server's clock, the download's call waits until one second less
  // than the download's timeout is left of its time.
  const used = CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 + 1;
  t.mock.timers.tick(used * 1000);
  silent.end();
  const [, result] = await Promise.all([post, fetchCall]);
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "The download from files.slack.com: out of this call's time\n\n" +
      `Nothing was fetched: this server gives each call ${CALL_SECONDS} seconds from when it reaches this server, and ` +
      `this one had used ${used} of them, waiting behind earlier calls or on its own earlier requests, so too few were ` +
      "left to send this request to Slack. It wasn't sent, so calling again is safe.",
  );
  assert.equal(downloads, 0, 'nothing was downloaded');
});
