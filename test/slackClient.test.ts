/**
 * The adapter's Web API client (SlackWebClient, with SLACK_CLIENT_OPTIONS):
 * each call answers with what happened, waiting out only a rate limit its
 * request from the host can afford, instead of the client waiting out rate
 * limits and retrying failures inside the call for up to about 30 minutes.
 * Driven through the real client against a local endpoint that answers as
 * Slack does.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebClient, type Logger } from '@slack/web-api';
import { method } from '@animalabs/mcpl-core';
import {
  CALL_SECONDS,
  GaveUp,
  OutOfCallTime,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  WAIT_PER_CALL_SECONDS,
  outsideCallTime,
  slackClients,
  stderrLogger,
  waitToAskAgain,
  withCallTime,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { explainSlackError } from '../src/slack-errors.js';
import { resolveSlackUserNames, type SlackUserInfoClient } from '../src/content.js';
import { FULL_GRANT, connectHost, nonJsonSlackApiUrl, initialize, until } from './harness.js';
import { fakeSlackApi, silentSlackApi, unreachableSlackApiUrl, type FakeSlackApi, type SlackApiAnswer } from './slackApi.js';
import { virtualClock } from './virtualClock.js';
import { clock } from '../src/clock.js';

let api: FakeSlackApi;
let client: WebClient;

before(async () => {
  api = await fakeSlackApi();
  client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
});

/** Slack's answer to a request it rate-limits, asking for `seconds`. */
const limited = (seconds: number): SlackApiAnswer =>
  ({ status: 429, headers: { 'retry-after': String(seconds) }, body: { ok: false, error: 'ratelimited' } });

after(() => api.close());

/** The error a call fails with, and how many requests it sent. */
async function failure(call: () => Promise<unknown>): Promise<{ err: unknown; sent: number }> {
  const before = api.calls.length;
  try {
    await call();
  } catch (err) {
    return { err, sent: api.calls.length - before };
  }
  throw new Error('the call did not fail');
}

// Each test that would wait out a rate limit or a retry under the client's
// defaults has a 5 s timeout, so a regression fails it instead of waiting: a
// Retry-After of 30 s, or ten retries over about 30 minutes, can't fit. The
// request counts show that nothing was sent twice.
test("a rate limit answers at once with Slack's Retry-After, and the request is sent once", { timeout: 5000 }, async () => {
  api.answer({ status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } });
  const { err, sent } = await failure(() => client.chat.postMessage({ channel: 'C1', text: 'hi' }));
  assert.equal((err as { code?: string }).code, 'slack_webapi_rate_limited_error');
  assert.equal((err as { retryAfter?: number }).retryAfter, 30);
  assert.equal(sent, 1);
});

test('a failure in transit answers at once, and the request is not sent again', { timeout: 5000 }, async () => {
  api.answer({ status: 503, body: { ok: false } });
  const answered = await failure(() => client.chat.postMessage({ channel: 'C1', text: 'hi' }));
  assert.equal((answered.err as { code?: string }).code, 'slack_webapi_http_error');
  assert.equal(answered.sent, 1, 'a post that may have reached Slack is not posted again');

  // Nothing listens, so there is no request to count: retries would hold the
  // call past the test's timeout. Node's code for the refused connection
  // stays on the error, which is how the explainer tells it from a request
  // that may have reached Slack.
  const unreachable = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await unreachableSlackApiUrl() });
  await assert.rejects(unreachable.chat.postMessage({ channel: 'C1', text: 'hi' }), (err: { code?: string; original?: { code?: string } }) => {
    assert.equal(err.code, 'slack_webapi_request_error');
    assert.equal(err.original?.code, 'ECONNREFUSED');
    return true;
  });
});

test("a request Slack doesn't answer fails at the client's timeout, and is not sent again", { timeout: 5000 }, async () => {
  const silent = await silentSlackApi();
  try {
    // The options' own timeout is 10 s; a shorter one keeps the test short.
    const waiting = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, timeout: 300, slackApiUrl: silent.url });
    await assert.rejects(waiting.chat.postMessage({ channel: 'C1', text: 'hi' }), (err: { code?: string; original?: { code?: string } }) => {
      assert.equal(err.code, 'slack_webapi_request_error');
      assert.equal(err.original?.code, 'ECONNABORTED');
      return true;
    });
    await until(() => silent.connections() >= 1, 'the connection');
    for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(silent.connections(), 1);
  } finally {
    await silent.close();
  }
});

test("connectSlack's clients: the adapter's is built with these options, and auth.test's keeps the default retries", () => {
  // The settings each client was built with are its own private fields, read
  // here because connectSlack itself calls the real Slack.
  type Built = { rejectRateLimitedCalls: boolean; retryConfig: unknown; axios: { defaults: { timeout?: number } } };
  const { auth, web } = slackClients('xoxb-test', 'xapp-test');
  assert.ok(web instanceof SlackWebClient, "the adapter's client waits out a rate limit a call can afford");
  assert.ok(!(auth instanceof SlackWebClient));
  const adapter = web as unknown as Built;
  assert.equal(adapter.rejectRateLimitedCalls, true);
  assert.deepEqual(adapter.retryConfig, { retries: 0 });
  assert.equal(adapter.axios.defaults.timeout, 10_000);
  const startup = auth as unknown as Built;
  const defaults = new WebClient('xoxb-test') as unknown as Built;
  assert.equal(startup.rejectRateLimitedCalls, false);
  assert.equal(startup.retryConfig, defaults.retryConfig, 'a launch while Slack is unreachable still waits');
  assert.equal(startup.axios.defaults.timeout, 10_000);
});

test("every client connectSlack builds logs to stderr, so a rate limit at launch writes nothing to stdout, which carries the protocol", { timeout: 60_000 }, async (t) => {
  // connectSlack's auth.test, then Socket Mode's apps.connections.open when
  // the adapter starts, are each rate-limited once with a Retry-After of 0 s,
  // so each client logs, at info, that it will try again, and does. Slack
  // then refuses the connection, which ends Socket Mode's start. They run in
  // a process of their own, whose stdout is read here, and which ends with
  // the test, however it ends.
  api.answerFor('auth.test', limited(0), { body: { ok: true, user_id: 'UBOT', team: 'acme' } });
  api.answerFor('apps.connections.open', limited(0), { body: { ok: false, error: 'invalid_auth' } });
  t.after(() => {
    api.answerFor('auth.test');
    api.answerFor('apps.connections.open');
  });
  const from = api.calls.length;
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./slackClientsChild.ts', import.meta.url)), api.url], {
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: t.signal,
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  // A test that ends early aborts its signal, which kills the child and
  // reports the abort here.
  child.on('error', (err) => { stderr += `\n${String(err)}`; });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.deepEqual(
    api.calls.slice(from).filter((m) => m === 'auth.test' || m === 'apps.connections.open'),
    ['auth.test', 'auth.test', 'apps.connections.open', 'apps.connections.open'],
  );
  assert.equal(stdout, '');
  for (const client of ['auth.test', 'Socket Mode']) {
    assert.ok(stderr.includes(`[slack-mcpl] ${client} (info): API Call failed due to rate limiting. Will retry in 0 seconds.`), stderr);
  }
  // Debug lines are left out, as the clients' own logger leaves them out at
  // its default level.
  assert.doesNotMatch(stderr, /\(debug\)/);
});

test("the adapter's client logs to stderr too, and is built against the Slack API URL given", () => {
  // Of its lines at info, the one this server's requests could reach is the
  // rate limit's "Will retry", which rejectRateLimitedCalls skips. Its logger
  // and URL are private fields, read here. The body runs at once, so no
  // other test's line reaches the capture.
  const { web } = slackClients('xoxb-test', 'xapp-test', api.url);
  assert.equal((web as unknown as { slackApiUrl: string }).slackApiUrl, api.url);
  const lines: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    (web as unknown as { logger: Logger }).logger.info('a line');
  } finally {
    console.error = write;
  }
  assert.deepEqual(lines, ['[slack-mcpl] Web API (info): a line']);
});

test('stderrLogger writes info, warn and error to stderr with their level, and debug nowhere', () => {
  const logger = stderrLogger('test');
  const lines: string[] = [];
  const out: string[] = [];
  const kept = { error: console.error, log: console.log, info: console.info, warn: console.warn, debug: console.debug };
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  for (const name of ['log', 'info', 'warn', 'debug'] as const) console[name] = (...args: unknown[]) => { out.push(args.join(' ')); };
  try {
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
  } finally {
    Object.assign(console, kept);
  }
  assert.deepEqual(lines, ['[slack-mcpl] test (info): i', '[slack-mcpl] test (warn): w', '[slack-mcpl] test (error): e']);
  assert.deepEqual(out, [], 'nothing else is written');
});

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };

test("each write makes at most two Slack requests, which with the call's waiting fit in its time, inside the host's own", { timeout: 5000 }, async () => {
  // A call's time is inside mcpl-core's default request timeout of 30 s and
  // agent-framework's of 60 s. A write's two requests and the call's waiting
  // fit in it, so the start rule cuts off neither while no call is ahead.
  assert.ok(CALL_SECONDS * 1000 < 30_000);
  assert.ok(SLACK_CLIENT_OPTIONS.timeout > 0 && SLACK_CLIENT_OPTIONS.timeout * 2 + WAIT_PER_CALL_SECONDS * 1000 <= CALL_SECONDS * 1000);
  // With DMs off, a write to a conversation the adapter hasn't seen asks Slack
  // what it is first, and send_dm opens the DM first.
  api.answer({ body: { ok: true, ts: '1.1', channel: { id: 'C7', is_im: false, is_mpim: false } } });
  for (const [what, disableDms, write, asked] of [
    ['send_message', true, (s: SlackAdapter) => s.sendMessage('C7', 'hi'), 'chat.postMessage'],
    ['reply_message', true, (s: SlackAdapter) => s.sendMessage('C7', 'hi', { threadTs: '1.0' }), 'chat.postMessage'],
    ['edit_message', true, (s: SlackAdapter) => s.editMessage('C7', '1.0', 'hi'), 'chat.update'],
    ['delete_message', true, (s: SlackAdapter) => s.deleteMessage('C7', '1.0'), 'chat.delete'],
    ['add_reaction', true, (s: SlackAdapter) => s.addReaction('C7', '1.0', 'eyes'), 'reactions.add'],
    ['send_dm', false, (s: SlackAdapter) => s.sendDM('U7', 'hi'), 'chat.postMessage'],
  ] as const) {
    const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, disableDms);
    const before = api.calls.length;
    await write(slack);
    const first = what === 'send_dm' ? 'conversations.open' : 'conversations.info';
    assert.deepEqual(api.calls.slice(before), [first, asked], what);
  }
});

test("a rate-limited send answers the agent at once with Slack's seconds, and the next Slack call isn't held", { timeout: 5000 }, async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  api.answer({ status: 429, headers: { 'retry-after': '45' }, body: { ok: false, error: 'ratelimited' } });
  const sent = (await h.host.sendRequest('tools/call', {
    name: 'send_message',
    arguments: { channelId: 'C1', content: 'hi' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(sent.isError, true);
  assert.match(sent.content[0].text, /Nothing was posted: Slack is rate-limiting this kind of call for the workspace, and asks to wait 45 seconds/);
  // conversations.list goes through the same client, and the fake endpoint
  // answers it; a client that paused its queue for the 45 s would hold it.
  const next = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as {
    isError?: boolean;
  };
  assert.notEqual(next.isError, true);
  await h.close();
});

/** send_message for `channelId`, with how long it took and the Slack methods it called. */
async function sendMessage(h: ReturnType<typeof connectHost>, channelId: string) {
  const before = api.calls.length;
  const started = clock.now();
  const result = (await h.host.sendRequest('tools/call', {
    name: 'send_message',
    arguments: { channelId, content: 'hi' },
  })) as { isError?: boolean; content: { text: string }[] };
  return { result, ms: clock.now() - started, called: api.calls.slice(before) };
}

test('a rate limit the call can afford is waited out inside it, the request is sent once more, and the second answer stands', { timeout: 10_000 }, async (t) => {
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, false);

  const answeredAt: number[] = [];
  const timed = (answer: SlackApiAnswer): SlackApiAnswer =>
    ({ ...answer, body: () => { answeredAt.push(performance.now()); return answer.body as Record<string, unknown>; } });
  api.answer(timed(limited(1)), timed({ body: { ok: true, ts: '1.2' } }));
  const waited = await sendMessage(h, 'C1');
  assert.notEqual(waited.result.isError, true, JSON.stringify(waited.result));
  assert.equal(JSON.parse(waited.result.content[0].text).messageId, '1.2');
  assert.deepEqual(waited.called, ['chat.postMessage', 'chat.postMessage']);
  const gap = answeredAt[1] - answeredAt[0];
  assert.ok(gap >= 990, `Slack got the request again ${gap} ms after asking for a second's wait, on the real clock`);

  const { slept } = virtualClock(t);
  // Rate-limited again on the second try: that answer is the call's.
  api.answer(limited(1), limited(2));
  const twice = await sendMessage(h, 'C1');
  assert.equal(twice.result.isError, true);
  assert.match(twice.result.content[0].text, /Nothing was posted: Slack is rate-limiting this kind of call for the workspace, and asks to wait 2 seconds /);
  assert.deepEqual(twice.called, ['chat.postMessage', 'chat.postMessage']);

  // Longer than the call can afford: answered at once, the request sent once.
  api.answer(limited(WAIT_PER_CALL_SECONDS + 1));
  const longer = await sendMessage(h, 'C1');
  assert.equal(longer.result.isError, true);
  assert.match(longer.result.content[0].text, new RegExp(`asks to wait ${WAIT_PER_CALL_SECONDS + 1} seconds`));
  assert.deepEqual(longer.called, ['chat.postMessage']);

  // A Retry-After below 0 isn't a wait: answered at once too.
  api.answer(limited(-1));
  const malformed = await sendMessage(h, 'C1');
  assert.equal(malformed.result.isError, true);
  assert.deepEqual(malformed.called, ['chat.postMessage']);
  assert.deepEqual(slept, [1000], "the wait went through the server's clock");
});

test("a call's requests share its waiting: one wait can use all of what is left, and none goes past it", { timeout: 20_000 }, async (t) => {
  const { slept } = virtualClock(t);
  // With DMs off, a write asks Slack what the conversation is first, so the
  // call makes two requests.
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true)));
  t.after(() => {
    api.answerFor('conversations.info');
    return h.close();
  });
  await initialize(h, false);
  const channel = { body: { ok: true, channel: { id: 'C7', is_im: false, is_mpim: false } } };
  const first = WAIT_PER_CALL_SECONDS - 2;

  api.answerFor('conversations.info', limited(first), channel);
  api.answer(limited(2), { body: { ok: true, ts: '1.3' } });
  const allOfIt = await sendMessage(h, 'C7');
  assert.notEqual(allOfIt.result.isError, true, JSON.stringify(allOfIt.result));
  assert.deepEqual(allOfIt.called, ['conversations.info', 'conversations.info', 'chat.postMessage', 'chat.postMessage']);
  assert.ok(allOfIt.ms >= WAIT_PER_CALL_SECONDS * 1000, `${allOfIt.ms} ms`);

  // A new adapter, so the conversation is asked about again.
  const h2 = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true)));
  t.after(() => h2.close());
  await initialize(h2, false);
  api.answerFor('conversations.info', limited(first), channel);
  api.answer(limited(3));
  const pastIt = await sendMessage(h2, 'C7');
  assert.equal(pastIt.result.isError, true);
  assert.match(pastIt.result.content[0].text, /asks to wait 3 seconds/);
  assert.deepEqual(pastIt.called, ['conversations.info', 'conversations.info', 'chat.postMessage']);
  assert.deepEqual(slept, [first * 1000, 2000, first * 1000], "each wait went through the server's clock");
});

test('a rate limit outside a request from the host comes back at once, including work a request starts in the background', { timeout: 5000 }, async () => {
  api.answer(limited(1));
  const alone = await failure(() => client.chat.postMessage({ channel: 'C1', text: 'hi' }));
  assert.equal((alone.err as { retryAfter?: number }).retryAfter, 1);
  assert.equal(alone.sent, 1);
  const background = await withCallTime(Date.now(), () => failure(() => outsideCallTime(() => client.chat.postMessage({ channel: 'C1', text: 'hi' }))));
  assert.equal((background.err as { retryAfter?: number }).retryAfter, 1);
  assert.equal(background.sent, 1);
});

test("an acknowledgement's removal that a post starts keeps its own tries, outside the post's waiting", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('reactions.remove'));
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, false, 'eyes');
  t.after(() => slack.stop());
  api.answer({ body: { ok: true, ts: '1.4' } });
  await slack.acknowledge('C1', '1.1');
  api.answerFor('reactions.remove', limited(1));
  const removals = () => api.calls.filter((c) => c === 'reactions.remove').length;
  const before = removals();
  // Once its rate limit is handled, the removal's next try is armed a minute
  // on; one sent again inside the post's call would come before that.
  const realSetTimeout = globalThis.setTimeout;
  let rearmed = false;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 60_000) rearmed = true;
    return realSetTimeout(fn, ms, ...args);
  }) as unknown as typeof setTimeout);
  await withCallTime(Date.now(), () => slack.sendMessage('C1', 'hi'));
  await until(() => rearmed, "the removal's next try");
  assert.equal(removals() - before, 1, 'the rate-limited removal was sent once before its next try was armed');
});

test('registration that a grant starts waits out its rate limits in its own way, and logs each wait', { timeout: 5000 }, async (t) => {
  const { slept } = virtualClock(t);
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  api.answerFor('conversations.list', limited(1), { body: { ok: true, channels: [{ id: 'C9', name: 'general', is_member: true, is_im: false, is_mpim: false }] } });
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => {
    api.answerFor('conversations.list');
    return h.close();
  });
  await initialize(h, true);
  const before = api.calls.filter((c) => c === 'conversations.list').length;
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration', 4000);
  assert.deepEqual(slept, [1000], "registration's wait went through the server's clock");
  assert.equal(api.calls.filter((c) => c === 'conversations.list').length - before, 2);
  assert.ok(
    lines.some((l) => l.includes('Slack rate-limited conversations.list (try 1 of 10); registration asks again in 1 s')),
    lines.join('\n'),
  );
});

test("a request goes out only if its whole timeout fits before its call's deadline, and a wait only if the request still fits after it", { timeout: 5000 }, async () => {
  const timeoutS = SLACK_CLIENT_OPTIONS.timeout / 1000;
  /** A call that reached this server with `left` seconds of its time left now. */
  const arrivedWith = (left: number) => Date.now() - (CALL_SECONDS - left) * 1000;
  api.answer({ body: { ok: true, ts: '1.5' } });

  const late = await withCallTime(arrivedWith(timeoutS - 0.2), () => failure(() => client.chat.postMessage({ channel: 'C1', text: 'hi' })));
  assert.ok(late.err instanceof OutOfCallTime, String(late.err));
  assert.equal((late.err as OutOfCallTime).method, 'chat.postMessage');
  // 15.2 s used, and over 15 is too many for a 10 s request: rounded up, so
  // the seconds the text gives never leave room for it.
  assert.equal((late.err as OutOfCallTime).usedSeconds, CALL_SECONDS - timeoutS + 1);
  assert.equal(late.sent, 0, 'nothing was sent');

  const before = api.calls.length;
  await withCallTime(arrivedWith(timeoutS + 1), () => client.chat.postMessage({ channel: 'C1', text: 'hi' }));
  assert.equal(api.calls.length - before, 1, 'with a whole timeout left, it goes out');

  // Half a second over a timeout left: the request goes out, but after a 1 s
  // wait it wouldn't fit, so the rate limit comes back at once.
  api.answer(limited(1), { body: { ok: true, ts: '1.5' } });
  const limitedLate = await withCallTime(arrivedWith(timeoutS + 0.5), () => failure(() => client.chat.postMessage({ channel: 'C1', text: 'hi' })));
  assert.equal((limitedLate.err as { code?: string }).code, 'slack_webapi_rate_limited_error');
  assert.equal(limitedLate.sent, 1);
});

test("a wait counts the call's time that an earlier request's wait used", { timeout: 5000 }, async (t) => {
  const { slept } = virtualClock(t);
  t.after(() => api.answerFor('conversations.info'));
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true);
  api.answerFor('conversations.info', limited(1), { body: { ok: true, channel: { id: 'C9', is_im: false, is_mpim: false } } });
  api.answer(limited(2));
  const before = api.calls.length;
  const leftS = SLACK_CLIENT_OPTIONS.timeout / 1000 + 2.5;
  const arrived = clock.now() - (CALL_SECONDS - leftS) * 1000;
  await assert.rejects(
    withCallTime(arrived, () => slack.sendMessage('C9', 'hi')),
    (err) => (err as { code?: string }).code === 'slack_webapi_rate_limited_error',
  );
  assert.deepEqual(api.calls.slice(before), ['conversations.info', 'conversations.info', 'chat.postMessage']);
  assert.deepEqual(slept, [1000], "the post's 2 s wait didn't fit in what the first wait left");
});

test("a request sent again after a wait keeps the start rule as it goes out, so a timer that fires late can't send it past the deadline", { timeout: 5000 }, async (t) => {
  const firesLateByMs = 600;
  const base = Date.now();
  let offset = 0;
  const slept: number[] = [];
  t.mock.method(clock, 'now', () => base + offset);
  t.mock.method(clock, 'sleep', async (ms: number) => {
    slept.push(ms);
    offset += ms + firesLateByMs;
  });
  // 11.5 s are left: a 1 s wait and the request's whole timeout fit after it.
  const arrived = clock.now() - (CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 - 1.5) * 1000;
  api.answer(limited(1), { body: { ok: true, ts: '1.7' } });
  const { err, sent } = await withCallTime(arrived, () => failure(() => client.chat.postMessage({ channel: 'C1', text: 'hi' })));
  assert.deepEqual(slept, [1000], "the wait went through the server's clock");
  assert.ok(err instanceof OutOfCallTime, String(err));
  assert.equal(sent, 1, 'the request was not sent again');
});

test('a write that fails on its way inside a call is not sent again', { timeout: 5000 }, async () => {
  api.answer({ status: 503, body: { ok: false } });
  const { err, sent } = await withCallTime(Date.now(), () => failure(() => client.chat.postMessage({ channel: 'C1', text: 'hi' })));
  assert.equal((err as { code?: string }).code, 'slack_webapi_http_error');
  assert.equal(sent, 1, 'a post that may have reached Slack is not posted again');
});

test("a write's DM check that can't be made keeps its own error: out of the call's time, or rate-limited", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.info'));
  // With DMs off, the write asks Slack what the conversation is first.
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true);
  const before = api.calls.length;
  const arrived = Date.now() - (CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 + 0.5) * 1000;
  const late = await withCallTime(arrived, () => slack.sendMessage('C8', 'hi').then(() => null, (err: unknown) => err));
  assert.ok(late instanceof OutOfCallTime && late.method === 'conversations.info', String(late));
  assert.match(explainSlackError(late, { tool: 'send_message', args: { channelId: 'C8', content: 'hi' } }), /\n\nNothing was posted: this server gives each call/);
  assert.equal(api.calls.length, before, 'nothing was sent');

  api.answerFor('conversations.info', limited(30));
  const limitedCheck = await withCallTime(Date.now(), () => slack.sendMessage('C8', 'hi').then(() => null, (err: unknown) => err));
  assert.equal((limitedCheck as { code?: string }).code, 'slack_webapi_rate_limited_error');
  assert.match(
    explainSlackError(limitedCheck, { tool: 'send_message', args: { channelId: 'C8', content: 'hi' } }),
    /\n\nNothing was posted: Slack is rate-limiting this kind of call for the workspace, and asks to wait 30 seconds/,
  );
  assert.deepEqual(api.calls.slice(before), ['conversations.info'], 'the post was not sent');
});

test("a request before a write that fails on the way, or by Slack's own failure, says nothing was written", { timeout: 5000 }, async (t) => {
  t.after(() => {
    api.answerFor('conversations.info');
    api.answerFor('conversations.open');
  });
  // With DMs off, the write asks Slack what the conversation is first.
  const checked = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true);
  const said = async (tool: string, write: () => Promise<unknown>) => {
    const err = await withCallTime(Date.now(), () => write().then(() => null, (e: unknown) => e));
    return explainSlackError(err, { tool, args: { channelId: 'C8', userId: 'U8', content: 'hi' } });
  };
  const before = api.calls.length;
  api.answerFor('conversations.info', { status: 503, body: { ok: false } });
  assert.match(await said('send_message', () => checked.sendMessage('C8', 'hi')), /\n\nNothing was posted: Slack answered with HTTP 503\. Try again shortly\.$/);
  api.answerFor('conversations.info', { body: { ok: false, error: 'internal_error' } });
  assert.match(await said('send_message', () => checked.sendMessage('C8', 'hi')), /\n\nNothing was posted: Slack failed while handling the call\. Try again shortly\.$/);
  // send_dm opens the DM first.
  const dms = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  api.answerFor('conversations.open', { status: 503, body: { ok: false } });
  assert.match(await said('send_dm', () => dms.sendDM('U8', 'hi')), /\n\nNothing was sent: Slack answered with HTTP 503\. Try again shortly\.$/);
  assert.deepEqual(api.calls.slice(before), ['conversations.info', 'conversations.info', 'conversations.open'], 'no write was sent');
});

test("a write's second request isn't sent once its first has left too little of the call's time", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.info'));
  // With DMs off, the write asks Slack what the conversation is first.
  virtualClock(t);
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true);
  api.answerFor('conversations.info', { body: { ok: true, channel: { id: 'C8', is_im: false, is_mpim: false } }, elapseMs: 2000 });
  api.answer({ body: { ok: true, ts: '1.6' } });
  const before = api.calls.length;
  // 11.5 s are left as the call starts, and the DM check takes 2 of them.
  const arrived = clock.now() - (CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 - 1.5) * 1000;
  await assert.rejects(
    withCallTime(arrived, () => slack.sendMessage('C8', 'hi')),
    (err) => err instanceof OutOfCallTime && err.method === 'chat.postMessage',
  );
  assert.deepEqual(api.calls.slice(before), ['conversations.info'], 'the post was not sent');
});

test("a DM whose name lookup its call has no time left for is marked to wait, not labelled for good", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  virtualClock(t);
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  // 11.5 s are left as the listing starts, and its one page takes 2 of them,
  // so the lookup of the DM's user can't go out.
  api.answerFor('conversations.list', { body: { ok: true, channels: [{ id: 'D5', is_im: true, user: 'U5' }] }, elapseMs: 2000 });
  const before = api.calls.length;
  const arrived = clock.now() - (CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 - 1.5) * 1000;
  const { conversations: [dm] } = await withCallTime(arrived, () => slack.listConversations());
  assert.deepEqual(api.calls.slice(before), ['conversations.list'], 'users.info was not sent');
  assert.equal(dm.name, 'U5');
  // refresh_channels leaves out a new DM with a name wait, for a later refresh to announce by name.
  assert.deepEqual(dm.nameWait, { method: 'users.info', seconds: 0, why: 'failed' });
});

test("a call that reaches the server after an earlier call's time has run out has time of its own", { timeout: 5000 }, async (t) => {
  virtualClock(t);
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, false);
  api.answer({ body: { ok: true, ts: '1.9' }, elapseMs: (CALL_SECONDS + 5) * 1000 });
  const slow = await sendMessage(h, 'C1');
  assert.notEqual(slow.result.isError, true, JSON.stringify(slow.result));
  api.answer({ body: { ok: true, ts: '2.1' } });
  const next = await sendMessage(h, 'C1');
  assert.notEqual(next.result.isError, true, JSON.stringify(next.result));
  assert.deepEqual(next.called, ['chat.postMessage']);
});

test("a call's time counts from when it reaches the server, so one queued past its time answers at once, unsent", { timeout: 10_000 }, async (t) => {
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  const slow = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: silent.url });
  const h = connectHost(new SlackMcplServer(new SlackAdapter(slow as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, false);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  type Result = { isError?: boolean; content: { text: string }[] };
  const send = (content: string) =>
    h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content } }) as Promise<Result>;
  // The server stamps each request's arrival as it parses it, before this
  // listener hears it.
  let arrived = 0;
  h.serverConn.on('request', () => arrived++);
  const first = send('first');
  const second = send('second');
  await until(() => arrived === 2 && silent.requests() === 1, "both calls' arrival, and the first call's post");
  // The second call waits. By the server's clock, more than all of its time
  // passes meanwhile, and the text gives at most all of it.
  t.mock.timers.tick((CALL_SECONDS + 5) * 1000);
  silent.end();
  const [one, two] = await Promise.all([first, second]);
  assert.match(one.content[0].text, /whether the message was posted is unknown/);
  assert.equal(two.isError, true);
  assert.match(
    two.content[0].text,
    new RegExp(`Nothing was posted: this server gives each call ${CALL_SECONDS} seconds from when it reaches this server, and this one had used ${CALL_SECONDS} of them`),
  );
  assert.equal(silent.requests(), 1, 'the second call sent nothing');
});

test('a user Slack refuses to look up is kept as the id, and a lookup that fails otherwise is asked again', { timeout: 5000 }, async () => {
  const users = client as unknown as SlackUserInfoClient;
  const cache = new Map<string, string>();
  const asks = () => api.calls.filter((c) => c === 'users.info').length;
  api.answer({ body: { ok: false, error: 'user_not_found' } });
  const refused = await resolveSlackUserNames(users, cache, ['U1']);
  assert.equal(cache.get('U1'), 'U1', 'Slack answers the same until the user or the app changes');
  assert.equal(refused.has('U1'), false, 'a refusal is cached, so its error is not returned');
  const asked = asks();
  await resolveSlackUserNames(users, cache, ['U1']);
  assert.equal(asks(), asked, 'a refused lookup is not asked again');

  for (const answer of [
    { status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } },
    { status: 503, body: { ok: false } },
    { body: { ok: false, error: 'internal_error' } },
    { body: { ok: false, error: 'request_timeout' } },
    { body: { ok: false, error: 'ratelimited' } },
  ]) {
    api.answer(answer);
    const failed = await resolveSlackUserNames(users, cache, ['U2']);
    assert.equal(cache.has('U2'), false, `after ${JSON.stringify(answer.body)}, the name is still unknown, not the id`);
    assert.ok(failed.has('U2'), 'and its error comes back to the caller');
  }
  api.answer({ body: { ok: true, user: { profile: { display_name: 'ann' } } } });
  await resolveSlackUserNames(users, cache, ['U2']);
  assert.equal(cache.get('U2'), 'ann');
});

test("a lookup answered in a form Slack doesn't use isn't a refusal, so it isn't kept and is asked again", { timeout: 5000 }, async (t) => {
  const page = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t) });
  const cache = new Map<string, string>();
  const failed = await resolveSlackUserNames(page as unknown as SlackUserInfoClient, cache, ['U3']);
  assert.equal(cache.has('U3'), false, 'the name is still unknown, not the id');
  assert.ok(failed.has('U3'), 'and its error comes back to the caller');
});

test("work no call waits on waits after an answer in a form Slack doesn't use, as after an HTTP error, and asks again", { timeout: 5000 }, async (t) => {
  const page = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t) });
  const { err } = await failure(() => page.conversations.list({}));
  assert.deepEqual(waitToAskAgain(err, 'conversations.list'), { method: 'conversations.list', seconds: 30, why: 'failed' });
});

test("with DMs off, a conversation check answered in a form Slack doesn't use writes nothing, and says to try again", { timeout: 5000 }, async (t) => {
  // The adapter's own client, which marks its errors with the request they
  // came from, so the explainer reads the check as a request before the post.
  const page = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t) });
  const web = {
    conversations: { info: (args: Record<string, unknown>) => page.conversations.info(args as never) },
    chat: { postMessage: (args: Record<string, unknown>) => client.chat.postMessage(args as never) },
  } as unknown as SlackWebLike;
  const slack = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, true);
  const from = api.calls.length;
  const err = await slack.sendMessage('C7', 'hi').then(() => null, (e: unknown) => e);
  assert.equal(api.calls.slice(from).filter((c) => c === 'chat.postMessage').length, 0, 'nothing was posted');
  const said = explainSlackError(err, { tool: 'send_message', args: { channelId: 'C7', content: 'hi' } });
  assert.ok(said.endsWith(
    "\n\nNothing was posted: Slack answered in a form this server can't read. Try again shortly. If it keeps failing, " +
      'whoever runs this host has to check its connection to Slack.'), said);
});

test("an acknowledgement's add counts as there, and is removed, only when it may have landed", { timeout: 5000 }, async (t) => {
  const unreachable = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await unreachableSlackApiUrl() });
  // A Slack that takes the request and never answers, so the client's timeout ends it, shortened here.
  const silent = await silentSlackApi();
  t.after(() => silent.close());
  const timedOut = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, timeout: 200, slackApiUrl: silent.url });
  // A page that isn't JSON, which the client reads as a refusal whose code is the body.
  const page = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t) });
  const removals = () => api.calls.filter((c) => c === 'reactions.remove').length;
  for (const [what, add, removed] of [
    ['an HTTP 503', { status: 503, body: { ok: false } }, true],
    ['a request Slack took and never answered', 'timed out', true],
    ["Slack's own failure", { body: { ok: false, error: 'internal_error' } }, true],
    ['fatal_error', { body: { ok: false, error: 'fatal_error' } }, true],
    ['service_unavailable', { body: { ok: false, error: 'service_unavailable' } }, true],
    ["already_reacted, this bot's reaction being there already", { body: { ok: false, error: 'already_reacted' } }, true],
    ["an answer in no form of Slack's", 'a page', true],
    // The client throws a TypeError reading a 200 it can't read: Slack may have added it.
    ['a JSON body of null, in an HTTP 200', { body: null }, true],
    ['a connection never made', 'unreachable', false],
    ['a rate limit', { status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } }, false],
    ['ratelimited in an HTTP 200', { body: { ok: false, error: 'ratelimited' } }, false],
    ['request_timeout, Slack having received the request only in part', { body: { ok: false, error: 'request_timeout' } }, false],
    ['a refusal', { body: { ok: false, error: 'invalid_name' } }, false],
    ["this server's own refusal, the conversation being outside the write allow-list", 'not writable', false],
  ] as const) {
    // The add goes to the endpoint, to a port nothing listens on, or to a Slack
    // that never answers; the removal always goes to the endpoint.
    const adds = add === 'unreachable' ? unreachable : add === 'timed out' ? timedOut : add === 'a page' ? page : client;
    const web = {
      reactions: {
        add: (args: Record<string, unknown>) => adds.reactions.add(args as never),
        remove: (args: Record<string, unknown>) => client.reactions.remove(args as never),
      },
    } as unknown as SlackWebLike;
    const writable = add === 'not writable' ? ['C2'] : undefined;
    const slack = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, writable, false, 'eyes');
    if (typeof add !== 'string') api.answer(add);
    await slack.acknowledge('C1', '1.1');
    const before = removals();
    api.answer({ body: { ok: false, error: 'no_reaction' } });
    await slack.clearAck('C1', '1.1');
    assert.equal(removals() - before, removed ? 1 : 0, what);
  }
});

test("an acknowledgement whose DM check fails added nothing, so nothing is removed for it", { timeout: 5000 }, async () => {
  // With DMs off, the add's DM check asks Slack about an unknown conversation
  // first; that request failing leaves the add unsent.
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, true, 'eyes');
  const from = api.calls.length;
  const removals = () => api.calls.filter((c) => c === 'reactions.remove').length;
  for (const answer of [{ body: { ok: false, error: 'internal_error' } }, { status: 503, body: { ok: false } }] as const) {
    api.answer(answer);
    await slack.acknowledge('C7', '1.1');
    const before = removals();
    api.answer({ body: { ok: false, error: 'no_reaction' } });
    await slack.clearAck('C7', '1.1');
    assert.equal(removals() - before, 0, JSON.stringify(answer));
  }
  assert.equal(api.calls.slice(from).filter((c) => c === 'reactions.add').length, 0, 'no add was sent');
});

test('a listing in the background waits out each rate-limited page, then asks for that page again', { timeout: 5000 }, async () => {
  // The client's own rate-limit error, so the listing reads its real shape.
  api.answer({ status: 429, headers: { 'retry-after': '3' }, body: { ok: false, error: 'ratelimited' } });
  const { err: limited } = await failure(() => client.conversations.info({ channel: 'C1' }));
  // Page 1, then page 2 rate-limited twice, then page 3 rate-limited once.
  const script: Array<'limited' | { id: string; next?: string }> = [
    { id: 'C1', next: 'p2' }, 'limited', 'limited', { id: 'C2', next: 'p3' }, 'limited', { id: 'C3' },
  ];
  const asked: Array<string | undefined> = [];
  const web = {
    conversations: {
      async list({ cursor }: { cursor?: string }) {
        asked.push(cursor);
        const answer = script.shift();
        if (answer === 'limited') throw limited;
        const channel = { id: answer!.id, is_member: true, is_im: false, is_mpim: false };
        return { channels: [channel], ...(answer!.next ? { response_metadata: { next_cursor: answer!.next } } : {}) };
      },
    },
  } as unknown as SlackWebLike;
  const slack = new SlackAdapter(web, socket, 'UBOT', 'acme');
  const waits: Array<[string, number, string, number]> = [];
  const { conversations: listed } = await slack.listConversations(false, async (wait, inARow) => { waits.push([wait.method, wait.seconds, wait.why, inARow]); });
  assert.deepEqual(listed.map((c) => c.id), ['C1', 'C2', 'C3']);
  assert.deepEqual(asked, [undefined, 'p2', 'p2', 'p2', 'p3', 'p3']);
  assert.deepEqual(waits, [
    ['conversations.list', 3, 'limited', 1], ['conversations.list', 3, 'limited', 2], ['conversations.list', 3, 'limited', 1],
  ], "each page's count starts again");

  // Without a wait, the page Slack rate-limits ends the listing at once.
  script.push({ id: 'C1', next: 'p2' }, 'limited');
  await assert.rejects(slack.listConversations(), (err) => err === limited);
});

test('a listing in the background asks again 30 s after a failure that can pass, and ends at a refusal', { timeout: 5000 }, async () => {
  // The client's own errors, so the listing reads their real shapes.
  const errors: Record<string, unknown> = {};
  for (const [name, answer] of [
    ['503', { status: 503, body: { ok: false } }],
    ['internal_error', { body: { ok: false, error: 'internal_error' } }],
    ['missing_scope', { body: { ok: false, error: 'missing_scope' } }],
  ] as const) {
    api.answer(answer);
    errors[name] = (await failure(() => client.conversations.info({ channel: 'C1' }))).err;
  }
  const unreachable = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await unreachableSlackApiUrl() });
  errors.unsent = (await failure(() => unreachable.conversations.info({ channel: 'C1' }))).err;
  const script = ['503', 'unsent', 'internal_error', 'ok'];
  const web = {
    conversations: {
      async list() {
        const next = script.shift()!;
        if (next !== 'ok') throw errors[next];
        return { channels: [{ id: 'C1', is_member: true, is_im: false, is_mpim: false }] };
      },
    },
  } as unknown as SlackWebLike;
  const slack = new SlackAdapter(web, socket, 'UBOT', 'acme');
  const waits: Array<[string, number, string, number]> = [];
  const { conversations: listed } = await slack.listConversations(false, async (wait, inARow) => { waits.push([wait.method, wait.seconds, wait.why, inARow]); });
  assert.deepEqual(listed.map((c) => c.id), ['C1']);
  assert.deepEqual(waits, [['conversations.list', 30, 'failed', 1], ['conversations.list', 30, 'failed', 2], ['conversations.list', 30, 'failed', 3]]);

  // Slack's answer to a refusal will be the same next time, so the listing ends with it.
  script.push('missing_scope');
  await assert.rejects(slack.listConversations(false, async () => {}), (err) => err === errors.missing_scope);
});

test("a listing in the background waits out a DM's name lookup that can pass, and keeps a refused one's id", { timeout: 5000 }, async () => {
  api.answer({ status: 429, headers: { 'retry-after': '7' }, body: { ok: false, error: 'ratelimited' } });
  const { err: limitedLookup } = await failure(() => client.users.info({ user: 'U1' }));
  api.answer({ body: { ok: false, error: 'user_not_found' } });
  const { err: refusedLookup } = await failure(() => client.users.info({ user: 'U2' }));
  api.answer({ body: { ok: false, error: 'internal_error' } });
  const { err: failedLookup } = await failure(() => client.users.info({ user: 'U3' }));
  const lookups: Record<string, unknown[]> = { U1: [limitedLookup, limitedLookup], U2: [refusedLookup], U3: [failedLookup] };
  const web = {
    conversations: {
      async list() {
        return {
          channels: [{ id: 'D1', is_im: true, user: 'U1' }, { id: 'D2', is_im: true, user: 'U2' }, { id: 'D3', is_im: true, user: 'U3' }],
        };
      },
    },
    users: {
      async info({ user }: { user: string }) {
        const next = lookups[user].shift();
        if (next) throw next;
        return { user: { profile: { display_name: 'ann' } } };
      },
    },
  } as unknown as SlackWebLike;
  const slack = new SlackAdapter(web, socket, 'UBOT', 'acme');
  const waits: Array<[string, number, string, number]> = [];
  const { conversations: listed } = await slack.listConversations(false, async (wait, inARow) => { waits.push([wait.method, wait.seconds, wait.why, inARow]); });
  assert.deepEqual(listed.map((c) => [c.id, c.name]), [['D1', 'ann'], ['D2', 'U2'], ['D3', 'ann']]);
  // Slack's seconds for a rate limit, and 30 s after Slack's own failure.
  assert.deepEqual(waits, [['users.info', 7, 'limited', 1], ['users.info', 7, 'limited', 2], ['users.info', 30, 'failed', 1]]);

  // Without a wait, as on a call's own listing, a rate-limited or failed lookup leaves the id.
  const fresh = new SlackAdapter(web, socket, 'UBOT', 'acme');
  lookups.U1.push(limitedLookup);
  lookups.U2.push(refusedLookup);
  lookups.U3.push(failedLookup);
  const { conversations: now } = await fresh.listConversations();
  assert.deepEqual(now.map((c) => c.name), ['U1', 'U2', 'U3']);
  // A name that's still missing says how long to wait before asking again; a refused one's id is its name.
  assert.deepEqual(now.map((c) => c.nameWait), [
    { method: 'users.info', seconds: 7, why: 'limited' }, undefined, { method: 'users.info', seconds: 30, why: 'failed' },
  ]);
});

test("a DM whose user's name the listing gives up on is labelled with the id, and later DMs aren't waited for", { timeout: 5000 }, async (t) => {
  api.answer({ body: { ok: false, error: 'internal_error' } });
  const { err: failedLookup } = await failure(() => client.users.info({ user: 'U1' }));
  const asked: Record<string, number> = {};
  const web = {
    conversations: {
      async list() {
        return {
          channels: [
            { id: 'D1', is_im: true, user: 'U1' },
            { id: 'C2', name: 'general', is_member: true, is_im: false, is_mpim: false },
            { id: 'D3', is_im: true, user: 'U3' },
            { id: 'D4', is_im: true, user: 'U4' },
          ],
        };
      },
    },
    users: {
      async info({ user }: { user: string }) {
        asked[user] = (asked[user] ?? 0) + 1;
        if (user === 'U4') return { user: { profile: { display_name: 'dee' } } };
        throw failedLookup;
      },
    },
  } as unknown as SlackWebLike;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  // Registration's wait gives up at its tenth try; here, at the third.
  const waits: number[] = [];
  const { conversations: listed } = await new SlackAdapter(web, socket, 'UBOT', 'acme').listConversations(false, async (_wait, inARow) => {
    waits.push(inARow);
    if (inARow >= 3) throw new GaveUp(`Slack rate-limited or failed the same request ${inARow} times in a row`);
  });
  assert.deepEqual(listed.map((c) => [c.id, c.name]), [['D1', 'U1'], ['C2', 'general'], ['D3', 'U3'], ['D4', 'dee']]);
  assert.deepEqual(waits, [1, 2, 3], "only the first DM's name was waited for");
  assert.deepEqual(asked, { U1: 3, U3: 1, U4: 1 }, 'a later DM is looked up once');
  assert.deepEqual(listed.map((c) => c.nameWait?.why), ['failed', undefined, 'failed', undefined]);
  assert.deepEqual(logged, [
    '[slack-mcpl] Gave up on the name of user U1: Slack rate-limited or failed the same request 3 times in a row. ' +
      "DM D1 is labelled with the user's id, and the listing's later DMs are looked up without waiting.",
  ]);
  // Any other rejection, such as a superseded registration's, still ends the listing.
  const superseded = new Error('A newer registration superseded this one');
  await assert.rejects(
    new SlackAdapter(web, socket, 'UBOT', 'acme').listConversations(false, async () => { throw superseded; }),
    (err) => err === superseded,
  );
});
