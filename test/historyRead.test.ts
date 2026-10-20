/**
 * fetch_history's and fetch_thread's bounded reads, through the adapter's own
 * client against a local endpoint that stands in for Slack's Web API: filters,
 * completeness, the cursor, the limits, and how the call's time and Slack's
 * rate limits stop a read.
 */
import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_SECONDS,
  OutOfCallTime,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  withCallTime,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { PARENT_IDS, READ_ARGUMENTS, readOptions } from '../src/history-read.js';
import { explainSlackError } from '../src/slack-errors.js';
import { toolDefinitions } from '../src/tools.js';
import { fakeSlackApi, type FakeSlackApi, type SlackApiAnswer } from './slackApi.js';
import { until } from './harness.js';

let api: FakeSlackApi;
let client: SlackWebClient;
before(async () => {
  api = await fakeSlackApi();
  client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
});
after(() => api.close());

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };
const adapter = (opts: { sendChannels?: string[]; disableDms?: boolean } = {}) =>
  new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, opts.sendChannels, opts.disableDms);

type Row = { ts: string; user?: string; text?: string; [key: string]: unknown };
const row = (ts: string, user: string, text: string, extra: Record<string, unknown> = {}): Row => ({ ts, user, text, ...extra });
const page = (messages: Row[], hasMore: boolean): SlackApiAnswer => ({ body: { ok: true, messages, has_more: hasMore } });

/** Each method answers as given until the test ends. */
function answers(t: { after(fn: () => void): void }, given: Record<string, SlackApiAnswer[]>) {
  for (const [m, list] of Object.entries(given)) api.answerFor(m, ...list);
  t.after(() => { for (const m of Object.keys(given)) api.answerFor(m); });
}
/** The parameters of each request to `m` from `from` on. */
const sentTo = (m: string, from: number) =>
  api.calls.flatMap((called, i) => (i >= from && called === m ? [Object.fromEntries(api.sent[i]!)] : []));

test('a filtered read scans every page, ANDs a case-insensitive substring with authors, and says the range is covered', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('8.0', 'U1', 'noise'), row('7.0', 'U1', 'the TARGET'), row('6.0', 'U2', 'target')], true),
      page([row('5.0', 'U1', 'noise'), row('1.0', 'U1', 'Target here')], false),
    ],
    'users.info': [{ body: { ok: true, user: { profile: { display_name: 'Ann' } } } }],
  });
  const from = api.calls.length;
  const out = await adapter().readHistory('C1', { channelId: 'C1', textContains: 'target', authorIds: ['U1'], latest: '9.0' });
  assert.deepEqual(out.messages.map((m) => [m.id, m.authorId, m.author]), [['1.0', 'U1', 'Ann'], ['7.0', 'U1', 'Ann']], 'oldest first');
  assert.deepEqual(out.pagination, {
    scanned: 5, matched: 2, returned: 2, pages: 2, scanComplete: true, stopReason: 'exhausted',
    threadRepliesSearched: false, scope: 'channel_messages',
  });
  assert.deepEqual(out.channel, { id: 'C1', writable: true });
  // A filtered read asks for whole pages, backward from latest.
  assert.deepEqual(sentTo('conversations.history', from), [
    { channel: 'C1', limit: '200', inclusive: 'false', latest: '9.0' },
    { channel: 'C1', limit: '200', inclusive: 'false', latest: '6.0' },
  ]);
});

test('one returned match can scan a full candidate page without 200 one-message requests', { timeout: 5000 }, async (t) => {
  // theaspirational's case: a filtered read asks for whole pages, whatever
  // its match limit, so one sparse match among 200 takes one request.
  const many = Array.from({ length: 200 }, (_, i) => row(`${200 - i}.0`, 'U1', i === 199 ? 'target' : 'noise'));
  answers(t, { 'conversations.history': [page(many, false)] });
  const from = api.calls.length;
  const out = await adapter().readHistory('C1', { channelId: 'C1', limit: 1, textContains: 'target' });
  assert.deepEqual(out.messages.map((m) => m.id), ['1.0']);
  assert.equal(out.pagination.scanned, 200);
  assert.equal(out.pagination.pages, 1);
  assert.equal(out.pagination.scanComplete, true);
  assert.equal(sentTo('conversations.history', from)[0]!.limit, '200');
});

test('caseSensitive matches exact case only', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('2.0', 'U1', 'Target'), row('1.0', 'U1', 'target')], false)] });
  const out = await adapter().readHistory('C1', { channelId: 'C1', textContains: 'target', caseSensitive: true });
  assert.deepEqual(out.messages.map((m) => m.id), ['1.0']);
});

test('an unfiltered read asks for the matches it still needs, and a match limit mid-page leaves a cursor that resumes after it', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('9.0', 'U1', 'a'), row('8.0', 'U1', 'b'), row('7.0', 'U1', 'c')], true),
      page([row('6.0', 'U1', 'd'), row('5.0', 'U1', 'e')], false),
    ],
  });
  const reader = adapter();
  const from = api.calls.length;
  const first = await reader.readHistory('C1', { channelId: 'C1', limit: 2, latest: '10.0' });
  assert.deepEqual(first.messages.map((m) => m.id), ['8.0', '9.0']);
  assert.equal(first.pagination.stopReason, 'match_limit');
  assert.equal(first.pagination.scanComplete, false);
  assert.equal(first.pagination.scanned, 2);
  assert.equal(sentTo('conversations.history', from)[0]!.limit, '2');
  const next = await reader.readHistory('C1', { channelId: 'C1', limit: 2, latest: '10.0', cursor: first.pagination.nextCursor });
  // The answer queue gives the second page next; what matters is where it asked.
  assert.equal(sentTo('conversations.history', from)[1]!.latest, '8.0', 'resumes after the last message it returned');
  assert.deepEqual(next.messages.map((m) => m.id), ['5.0', '6.0']);
  assert.equal(next.pagination.scanComplete, true);
  assert.equal(next.pagination.nextCursor, undefined);
});

test("a cursor from another query, or one this server didn't give, is refused before Slack is asked", { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'target'), row('8.0', 'U1', 'target')], true)] });
  const reader = adapter();
  const first = await reader.readHistory('C1', { channelId: 'C1', limit: 1, textContains: 'target' });
  const from = api.calls.length;
  await assert.rejects(reader.readHistory('C1', { channelId: 'C1', limit: 1, textContains: 'other', cursor: first.pagination.nextCursor }),
    /^Error: No messages were returned: cursor belongs to another query\. Pass it with the same channel, thread, oldest, latest and filters as the call that gave it\.$/);
  await assert.rejects(reader.readHistory('C2', { channelId: 'C2', limit: 1, textContains: 'target', cursor: first.pagination.nextCursor }),
    /cursor belongs to another query/);
  // One of this server's own cursors, made longer than any it gives, is
  // refused by its length alone.
  const decoded = JSON.parse(Buffer.from(first.pagination.nextCursor!, 'base64url').toString());
  const padded = Buffer.from(JSON.stringify({ ...decoded, pad: 'x'.repeat(200) })).toString('base64url');
  assert.ok(padded.length > 256, String(padded.length));
  for (const cursor of ['not-a-cursor', Buffer.from(JSON.stringify({ q: 'x', at: 'nope' })).toString('base64url'), padded]) {
    await assert.rejects(reader.readHistory('C1', { channelId: 'C1', limit: 1, textContains: 'target', cursor }),
      /^Error: No messages were returned: cursor isn't a nextCursor this server gave\. Pass it exactly as pagination\.nextCursor gave it\.$/);
  }
  assert.equal(api.calls.length, from, 'nothing was asked');
  // Budgets aren't part of the query, so a cursor carries over a new limit.
  await reader.readHistory('C1', { channelId: 'C1', limit: 5, maxScanned: 10, textContains: 'target', cursor: first.pagination.nextCursor });
  assert.equal(sentTo('conversations.history', from)[0]!.latest, '9.0');
});

test('a match too big for maxBytes beside the ones before it is held back whole, uncounted, and is where the cursor resumes', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('9.0', 'U1', 'small'), row('8.0', 'U1', 'x'.repeat(4000)), row('7.0', 'U1', 'small')], true),
      page([row('8.0', 'U1', 'x'.repeat(4000)), row('7.0', 'U1', 'small')], false),
    ],
  });
  const reader = adapter();
  const from = api.calls.length;
  const out = await reader.readHistory('C1', { channelId: 'C1', maxBytes: 2048, latest: '10.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['9.0']);
  assert.equal(out.pagination.stopReason, 'byte_limit');
  assert.deepEqual([out.pagination.scanned, out.pagination.matched, out.pagination.returned], [1, 1, 1], 'the held match counts where it is returned');
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 2048);
  // Budgets aren't part of the query, so the cursor carries over a larger maxBytes.
  const next = await reader.readHistory('C1', { channelId: 'C1', maxBytes: 8192, latest: '10.0', cursor: out.pagination.nextCursor });
  assert.equal(sentTo('conversations.history', from)[1]!.latest, '9.0', 'the held message is read again');
  assert.deepEqual(next.messages.map((m) => m.id), ['7.0', '8.0']);
  assert.equal(next.pagination.scanComplete, true);
});

test("a call that can't return its first message for maxBytes fails, naming the maxBytes that fits and the way past it", { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('8.0', 'U1', 'x'.repeat(4000)), row('7.0', 'U1', 'small')], true)] });
  const reader = adapter();
  const err = await reader.readHistory('C1', { channelId: 'C1', maxBytes: 2048, latest: '9.0' }).then(() => null, (e: unknown) => e);
  const said = String((err as Error | null)?.message);
  const [, needed] = said.match(/call again with maxBytes of at least ([\d,]+)/) ?? [];
  assert.ok(needed, said);
  assert.match(said, /^No messages were returned: the next message, 8\.0, takes [\d,]+ bytes in this tool's result, which with up to [\d,]+ bytes of the result's own fields is more than maxBytes, 2,048\. /);
  assert.match(said, /to read past it, call again with the same arguments, but without cursor and with latest set to 8\.0\.$/);
  // The size it names fits, called again with the same arguments, and the
  // next message is then held back for the call after.
  const out = await reader.readHistory('C1', { channelId: 'C1', maxBytes: Number(needed!.replace(/,/g, '')), latest: '9.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['8.0']);
  assert.equal(out.pagination.stopReason, 'byte_limit');
});

test("a thread whose parent doesn't fit maxBytes fails the same way, with oldest as the way past it", { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.replies': [page([row('1.0', 'U1', 'x'.repeat(4000), { thread_ts: '1.0' }), row('2.0', 'U2', 'one', { thread_ts: '1.0' })], false)] });
  const reader = adapter();
  const err = await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', maxBytes: 2048 }).then(() => null, (e: unknown) => e);
  const said = String((err as Error | null)?.message);
  assert.match(said, /^No messages were returned: the next message, 1\.0, takes .*to read past it, call again with the same arguments, but without cursor and with oldest set to 1\.0\.$/);
  // The size it names fits, called again with the same arguments.
  const [, needed] = said.match(/call again with maxBytes of at least ([\d,]+)/) ?? [];
  assert.ok(needed, said);
  const out = await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', maxBytes: Number(needed!.replace(/,/g, '')) });
  assert.deepEqual(out.messages.map((m) => m.id), ['1.0']);
  assert.equal(out.pagination.stopReason, 'byte_limit');
});

test('many small matches stay within maxBytes, each counted with its comma', { timeout: 5000 }, async (t) => {
  const rows = Array.from({ length: 200 }, (_, i) => row(`${1000 - i}.0`, 'U1', 'a'));
  answers(t, { 'conversations.history': [page(rows, false)] });
  const out = await adapter().readHistory('C1', { channelId: 'C1', limit: 1000, maxBytes: 20480, latest: '2000.0' });
  assert.equal(out.pagination.stopReason, 'byte_limit');
  assert.ok(out.messages.length > 100, String(out.messages.length));
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 20480, String(Buffer.byteLength(JSON.stringify(out))));
});

test('maxScanned bounds the page asked for and stops the read there', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'a'), row('8.0', 'U1', 'b'), row('7.0', 'U1', 'c')], true)] });
  const from = api.calls.length;
  const out = await adapter().readHistory('C1', { channelId: 'C1', textContains: 'zzz', maxScanned: 3 });
  assert.equal(sentTo('conversations.history', from)[0]!.limit, '3');
  assert.equal(sentTo('conversations.history', from)[0]!.latest, undefined, "without latest, the first page reads to Slack's own now");
  assert.deepEqual([out.pagination.scanned, out.pagination.stopReason, out.pagination.pages], [3, 'scan_limit', 1]);
  assert.ok(out.pagination.nextCursor);
});

/** A read in a call whose clock is the test's: `left` seconds of the call
 *  remain when it starts, and the clock moves `moves` seconds while Slack
 *  holds its answer to the read's first page. */
async function readWhileTimePasses<T>(
  t: TestContext, method: string, first: SlackApiAnswer, rest: SlackApiAnswer[], left: number, moves: number,
  read: () => Promise<T>,
): Promise<T> {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  answers(t, { [method]: [{ ...first, after: held }, ...rest] });
  const from = api.calls.length;
  const done = withCallTime(Date.now() - (CALL_SECONDS - left) * 1000, read);
  await until(() => sentTo(method, from).length === 1, "the first page's request");
  t.mock.timers.tick(moves * 1000);
  release();
  return done;
}

test("a page the call's time has no room for ends the read with what it has and a cursor, once something was scanned", { timeout: 5000 }, async (t) => {
  // 11 s are left, so the first page's 10 s fit; 2 s pass while Slack holds
  // its answer, and the second's 10 s don't fit.
  const from = api.calls.length;
  const out = await readWhileTimePasses(t, 'conversations.history', page([row('9.0', 'U1', 'a')], true),
    [page([row('8.0', 'U1', 'b')], false)], SLACK_CLIENT_OPTIONS.timeout / 1000 + 1, 2,
    () => adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' }));
  assert.deepEqual(out.messages.map((m) => m.id), ['9.0']);
  assert.equal(out.pagination.stopReason, 'time_limit');
  assert.ok(out.pagination.nextCursor);
  assert.equal(sentTo('conversations.history', from).length, 1, "the second page wasn't sent");
});

test("with nothing scanned, the call's time running out fails the call, as any call does", { timeout: 5000 }, async () => {
  const from = api.calls.length;
  const arrived = Date.now() - (CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 + 0.5) * 1000;
  const err = await withCallTime(arrived, () => adapter().readHistory('C1', { channelId: 'C1' })).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof OutOfCallTime, String(err));
  assert.equal(api.calls.length, from, 'nothing was sent');
});

test('a rate limit longer than the call can wait ends the read with what it has, Slack\'s seconds and a cursor, once something was scanned', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('9.0', 'U1', 'a')], true),
      { status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } },
    ],
  });
  const out = await withCallTime(Date.now(), () => adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' }));
  assert.deepEqual(out.messages.map((m) => m.id), ['9.0']);
  assert.equal(out.pagination.stopReason, 'rate_limited');
  assert.equal(out.pagination.retryAfterSeconds, 30);
  assert.ok(out.pagination.nextCursor);
});

test('with nothing scanned, a rate limit fails the call with Slack\'s seconds', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [{ status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } }] });
  const err = await withCallTime(Date.now(), () => adapter().readHistory('C1', { channelId: 'C1' })).then(() => null, (e: unknown) => e);
  assert.equal((err as { code?: string; retryAfter?: number }).code, 'slack_webapi_rate_limited_error');
  assert.equal((err as { retryAfter?: number }).retryAfter, 30);
});

test('a thread reads forward from its parent, skips a message Slack gives again, and resumes toward newer replies', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.replies': [
      page([row('1.0', 'U1', 'parent', { thread_ts: '1.0', reply_count: 3 }), row('2.0', 'U2', 'one', { thread_ts: '1.0' })], true),
      // Slack's parent again, before the next replies.
      page([row('1.0', 'U1', 'parent', { thread_ts: '1.0', reply_count: 3 }), row('3.0', 'U2', 'two', { thread_ts: '1.0' }),
        row('4.0', 'U2', 'three', { thread_ts: '1.0' })], false),
    ],
  });
  const from = api.calls.length;
  const out = await adapter().readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['1.0', '2.0', '3.0', '4.0'], 'oldest first, the parent once');
  assert.deepEqual(out.pagination.scope, 'single_thread');
  assert.equal(out.pagination.threadRepliesSearched, true);
  assert.equal(out.pagination.scanned, 4);
  assert.deepEqual(sentTo('conversations.replies', from).map((p) => [p.ts, p.oldest]), [['1.0', undefined], ['1.0', '2.0']]);
  assert.deepEqual(out.messages.map((m) => [m.rootTs, m.threadTs, m.replyCount]),
    [['1.0', undefined, 3], ['1.0', '1.0', undefined], ['1.0', '1.0', undefined], ['1.0', '1.0', undefined]]);
});

test("past a thread's start, a page asks one more for the parent Slack may give again, so the parent can't fill it", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.replies': [
      page([row('1.0', 'U1', 'parent', { thread_ts: '1.0' }), row('2.0', 'U2', 'one', { thread_ts: '1.0' })], true),
      // Slack's parent again, then the one reply the read still needs.
      page([row('1.0', 'U1', 'parent', { thread_ts: '1.0' }), row('3.0', 'U2', 'two', { thread_ts: '1.0' })], true),
    ],
  });
  const reader = adapter();
  const from = api.calls.length;
  const first = await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', limit: 2 });
  assert.equal(first.pagination.stopReason, 'match_limit');
  const next = await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', limit: 1, cursor: first.pagination.nextCursor });
  assert.deepEqual(sentTo('conversations.replies', from).map((p) => [p.oldest, p.limit]), [[undefined, '2'], ['2.0', '2']]);
  assert.deepEqual(next.messages.map((m) => m.id), ['3.0']);
  assert.equal(next.pagination.stopReason, 'match_limit');
});

test('maxScanned holds within a page that brings more than it asked for', { timeout: 5000 }, async (t) => {
  // Past a thread's start the page asks for one more; here Slack doesn't give
  // the parent again, so the page holds one message past the scan budget.
  answers(t, { 'conversations.replies': [page([row('3.0', 'U2', 'two', { thread_ts: '1.0' }), row('4.0', 'U2', 'three', { thread_ts: '1.0' })], true)] });
  const out = await adapter().readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', oldest: '2.0', maxScanned: 1 });
  assert.deepEqual(out.messages.map((m) => m.id), ['3.0']);
  assert.deepEqual([out.pagination.scanned, out.pagination.stopReason], [1, 'scan_limit']);
  assert.ok(out.pagination.nextCursor);
});

test("a page out of Slack's documented order is read in reading order, so the cursor rests on the furthest message read", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([row('9.0', 'U1', 'a'), row('3.0', 'U1', 'b'), row('8.0', 'U1', 'c')], true), page([], false)],
  });
  const reader = adapter();
  const from = api.calls.length;
  const first = await reader.readHistory('C1', { channelId: 'C1', limit: 2, latest: '10.0' });
  assert.deepEqual(first.messages.map((m) => m.id), ['8.0', '9.0']);
  await reader.readHistory('C1', { channelId: 'C1', limit: 2, latest: '10.0', cursor: first.pagination.nextCursor });
  assert.equal(sentTo('conversations.history', from)[1]!.latest, '8.0', "3.0 isn't passed over");
});

test("history skips a message Slack gives again at the read's position", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('9.0', 'U1', 'a'), row('8.0', 'U1', 'b')], true),
      page([row('8.0', 'U1', 'b'), row('7.0', 'U1', 'c')], false),
    ],
  });
  const out = await adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['7.0', '8.0', '9.0']);
  assert.equal(out.pagination.scanned, 3);
});

test("textContains matches a message's content as returned: Slack's escapes decoded, a link by its label, a mention by its user id", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([
      row('4.0', 'U1', 'the R&amp;D plan'),
      row('3.0', 'U1', 'see <https://example.com/x|the design doc>'),
      row('2.0', 'U1', 'ask <@U77>'),
      row('1.0', 'U1', 'unrelated'),
    ], false)],
  });
  const reader = adapter();
  for (const [needle, ids] of [['R&D', ['4.0']], ['the design doc', ['3.0']], ['uid:U77', ['2.0']], ['&amp;', []]] as const) {
    const out = await reader.readHistory('C1', { channelId: 'C1', textContains: needle });
    assert.deepEqual(out.messages.map((m) => m.id), ids, needle);
  }
});

test("authorIds selects a bot's messages by the authorBotId the records give", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([
      { ts: '3.0', bot_id: 'B1', username: 'deploybot', text: 'deployed' },
      row('2.0', 'U1', 'deployed'),
    ], false)],
  });
  const out = await adapter().readHistory('C1', { channelId: 'C1', authorIds: ['B1'] });
  assert.deepEqual(out.messages.map((m) => [m.id, m.authorBotId]), [['3.0', 'B1']]);
});

test('textContains is counted in characters, as the schema counts them', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([], false)] });
  const reader = adapter();
  await reader.readHistory('C1', { channelId: 'C1', textContains: '\u{1F600}'.repeat(256) });
  await assert.rejects(reader.readHistory('C1', { channelId: 'C1', textContains: '\u{1F600}'.repeat(257) }),
    /textContains must contain 1 to 256 characters/);
});

test("a message too big for even maxBytes' most fails with how to read past it", { timeout: 10_000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('8.0', 'U1', 'x'.repeat(1_100_000)), row('7.0', 'U1', 'small')], true)] });
  await assert.rejects(adapter().readHistory('C1', { channelId: 'C1', latest: '9.0' }),
    /maxBytes goes up to 1,048,576, so this tool can't return it whole; to read past it, call again with the same arguments, but without cursor and with latest set to 8\.0\.$/);
});

test("a page Slack answers without a list of messages, or with a message without a ts, fails the read with what wasn't returned", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      { body: { ok: true, has_more: false } },
      page([row('nope', 'U1', 'a')], false),
      page([null as unknown as Row], false),
    ],
  });
  const reader = adapter();
  const unreadable = "Calling again may work; if it fails the same way, this server can't read Slack's answer for this range.";
  await assert.rejects(reader.readHistory('C1', { channelId: 'C1' }),
    { message: `No messages were returned: Slack's answer for a page of messages held no list of them. ${unreadable}` });
  for (const what of ['a message without a ts', 'an entry that is no message']) {
    await assert.rejects(reader.readHistory('C1', { channelId: 'C1' }),
      { message: `No messages were returned: Slack gave a message without a valid timestamp, so this read can't place it. ${unreadable}` }, what);
  }
});

test('a message Slack lists twice in one page is taken once', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'a'), row('8.0', 'U1', 'b'), row('9.0', 'U1', 'a')], false)] });
  const out = await adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['8.0', '9.0']);
  assert.equal(out.pagination.scanned, 2);
});

test("a mention matches by its user ID only, whatever name the content shows or label Slack sent", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([row('2.0', 'U1', 'ask <@U77>'), row('1.0', 'U1', 'ask <@U78|bob>')], false)],
    'users.info': [{ body: { ok: true, user: { profile: { display_name: 'Ann' } } } }],
  });
  const reader = adapter();
  // A read without a filter looks the names up, so the content shows them.
  const shown = await reader.readHistory('C1', { channelId: 'C1' });
  assert.deepEqual(shown.messages.map((m) => m.content), ['ask @Ann (uid:U78)', 'ask @Ann (uid:U77)']);
  for (const [needle, ids] of [['Ann', []], ['bob', []], ['uid:U77', ['2.0']], ['@U78', ['1.0']]] as const) {
    const out = await reader.readHistory('C1', { channelId: 'C1', textContains: needle });
    assert.deepEqual(out.messages.map((m) => m.id), ids, needle);
  }
});

test('fetch_thread passes latest on to Slack as the bound of every page', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.replies': [
      page([row('1.0', 'U1', 'parent', { thread_ts: '1.0' }), row('2.0', 'U2', 'one', { thread_ts: '1.0' })], true),
      page([row('3.0', 'U2', 'two', { thread_ts: '1.0' })], false),
    ],
  });
  const from = api.calls.length;
  await adapter().readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', latest: '9.0' });
  assert.deepEqual(sentTo('conversations.replies', from).map((p) => [p.oldest, p.latest]), [[undefined, '9.0'], ['2.0', '9.0']]);
});

test("a history read given only oldest names latest on its first page, as the host's now plus a minute", { timeout: 5000 }, async (t) => {
  // Date alone: the fake API still answers through a real setTimeout.
  t.mock.timers.enable({ apis: ['Date'], now: 1_718_000_000_000 });
  answers(t, {
    'conversations.history': [
      page([row('8.0', 'U1', 'eight'), row('7.0', 'U1', 'seven')], true),
      page([row('6.0', 'U1', 'six')], false),
    ],
    'users.info': [{ body: { ok: true, user: { profile: { display_name: 'Ann' } } } }],
  });
  const from = api.calls.length;
  const out = await adapter().readHistory('C1', { channelId: 'C1', oldest: '5.0' });
  const sent = sentTo('conversations.history', from).map((p) => [p.oldest, p.latest]);
  assert.deepEqual(sent, [['5.0', '1718000060.000000'], ['5.0', '7.0']]);
  assert.deepEqual(out.messages.map((m) => m.id), ['6.0', '7.0', '8.0']);
});

test("a thread page out of Slack's documented order is read in reading order too", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.replies': [page([row('3.0', 'U2', 'two', { thread_ts: '1.0' }), row('1.0', 'U1', 'parent', { thread_ts: '1.0' }),
      row('2.0', 'U2', 'one', { thread_ts: '1.0' })], false)],
  });
  const out = await adapter().readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['1.0', '2.0', '3.0']);
  assert.equal(out.pagination.scanned, 3);
});

test("past a thread's start, a page that wants Slack's page size or more asks for that, not one more", { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.replies': [page([row('3.0', 'U2', 'two', { thread_ts: '1.0' })], false)] });
  const from = api.calls.length;
  await adapter().readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', oldest: '2.0', limit: 500 });
  assert.equal(sentTo('conversations.replies', from)[0]!.limit, '200');
});

test("a first page with more to come but nothing in it fails the call, since the read can't move", { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([], true)] });
  await assert.rejects(adapter().readHistory('C1', { channelId: 'C1' }),
    /^Error: No messages were returned: Slack's page held no message past where this read started, though it said more remain\. Calling again may get them; if it stops the same way, Slack's answers don't take this read past its start\.$/);
});

test("a read Slack fails before it moves says that no messages were returned, with a rate limit's seconds when Slack gave them", { timeout: 5000 }, async (t) => {
  for (const [answer, said] of [
    [{ headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } },
      /\n\nNo messages were returned: Slack is rate-limiting this kind of call for the workspace, and asks to wait 30 seconds before trying again\.$/],
    [{ body: { ok: false, error: 'ratelimited' } },
      /\n\nNo messages were returned: Slack is rate-limiting this kind of call for the workspace\. Try again shortly\.$/],
    // A code the explainer doesn't know, and the client's own error for a 429
    // without a Retry-After it can read, still say what the read returned.
    [{ body: { ok: false, error: 'invalid_arguments' } }, /^An API error occurred: invalid_arguments\n\nNo messages were returned\.$/],
    [{ status: 429, headers: { 'retry-after': 'soon' }, body: { ok: false, error: 'ratelimited' } },
      /^Retry header did not contain a valid timeout .*\n\nNo messages were returned\.$/s],
  ] as const) {
    answers(t, { 'conversations.history': [answer] });
    const err = await withCallTime(Date.now(), () => adapter().readHistory('C1', { channelId: 'C1' })).then(() => null, (e: unknown) => e);
    assert.match(explainSlackError(err, { tool: 'fetch_history', args: { channelId: 'C1' } }), said, JSON.stringify(answer));
  }
});

test('a later page with more to come but nothing in it stops the read as stalled, not covered', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'a')], true), page([], true)] });
  const out = await adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' });
  assert.equal(out.pagination.stopReason, 'pagination_stalled');
  assert.equal(out.pagination.scanComplete, false);
  assert.ok(out.pagination.nextCursor);
});

test('arguments are checked before Slack is asked: unknown names, bounds, timestamps, filters and ids', { timeout: 5000 }, async () => {
  const reader = adapter();
  const from = api.calls.length;
  const historyTakes = 'It takes channelId, limit, oldest, latest, cursor, maxScanned, maxBytes, textContains, caseSensitive, authorIds.';
  const bound = "Take one from fetch_history's ids, or from a message's id=.";
  const authors = "authorIds must contain 1 to 50 Slack user or bot IDs, as a message's authorId or authorBotId gives them, or " +
    "find_user's userId.";
  const author = (i: number, value: string) => `authorIds[${i}] must be a Slack user or bot ID, as a message's authorId or ` +
    `authorBotId gives it, or find_user's userId, and this call passed ${value}.`;
  for (const [args, said] of [
    [{ regex: '.*' }, `fetch_history takes no argument named regex. ${historyTakes}`],
    [{ maxPages: 3, maxMs: 100 }, `fetch_history takes no arguments named maxPages, maxMs. ${historyTakes}`],
    [{ threadTs: '1.0' }, `fetch_history takes no argument named threadTs. ${historyTakes}`],
    // A slip for an argument names it: by case, by edits, or as part of it.
    [{ textcontains: 'x' }, `fetch_history takes no argument named textcontains (did you mean textContains?). ${historyTakes}`],
    [{ lmit: 5 }, `fetch_history takes no argument named lmit (did you mean limit?). ${historyTakes}`],
    [{ max: 5, author: 'U1' }, 'fetch_history takes no arguments named max (did you mean maxScanned or maxBytes?), author (did you ' +
      `mean authorIds?). ${historyTakes}`],
    [{ limit: 0 }, 'limit must be an integer from 1 to 1000.'],
    [{ limit: 1.5 }, 'limit must be an integer from 1 to 1000.'],
    [{ limit: '50' }, 'limit must be an integer from 1 to 1000.'],
    [{ maxScanned: 10001 }, 'maxScanned must be an integer from 1 to 10000.'],
    [{ maxBytes: 1000 }, 'maxBytes must be an integer from 2048 to 1048576.'],
    // The value given is named: a string quoted, so a stray space shows, or
    // what else it is.
    [{ oldest: 'yesterday' }, `oldest must be a Slack timestamp, which looks like 1718000000.000100, and this call passed "yesterday". ${bound}`],
    [{ latest: '1.0 ' }, `latest must be a Slack timestamp, which looks like 1718000000.000100, and this call passed "1.0 ". ${bound}`],
    [{ latest: 5 }, `latest must be a Slack timestamp, which looks like 1718000000.000100, and this call passed a number. ${bound}`],
    [{ oldest: null }, `oldest must be a Slack timestamp, which looks like 1718000000.000100, and this call passed null. ${bound}`],
    [{ oldest: ['1.0'] }, `oldest must be a Slack timestamp, which looks like 1718000000.000100, and this call passed an array. ${bound}`],
    [{ oldest: {} }, `oldest must be a Slack timestamp, which looks like 1718000000.000100, and this call passed an object. ${bound}`],
    [{ oldest: '2.0', latest: '1.0' }, 'oldest must precede latest.'],
    [{ textContains: '' }, 'textContains must contain 1 to 256 characters.'],
    [{ caseSensitive: 'yes' }, 'caseSensitive must be a boolean.'],
    // A malformed entry is named by its place, the first one when there are more.
    [{ authorIds: ['not-a-user'] }, author(0, '"not-a-user"')],
    [{ authorIds: ['U1', 'B2', 'Ann', 'nope'] }, author(2, '"Ann"')],
    [{ authorIds: ['U1', 5] }, author(1, 'a number')],
    // An array the pattern would pass once made a string, as 'B2'.
    [{ authorIds: ['U1', ['B2']] }, author(1, 'an array')],
    [{ authorIds: [] }, authors],
    [{ authorIds: Array.from({ length: 51 }, (_, i) => `U${i}`) }, authors],
    [{ authorIds: 'U1' }, authors],
  ] as const) {
    await assert.rejects(reader.readHistory('C1', { channelId: 'C1', ...args }), { message: `No messages were returned: ${said}` },
      JSON.stringify(args));
  }
  await assert.rejects(reader.readHistory('U1', { channelId: 'U1' }), {
    message: 'No messages were returned: channelId must be a Slack conversation id, such as C0123456789, and this call passed "U1". ' +
      "Take it from the message's channelId=, or list_channels shows each conversation's id.",
  });
  await assert.rejects(reader.readThread('C1', 'nope', { channelId: 'C1', threadTs: 'nope' }), {
    message: 'No messages were returned: threadTs must be a Slack timestamp, which looks like 1718000000.000100, and this call ' +
      "passed \"nope\". Pass the thread's parent id: a reply's thread=, a message's own id= when it shows no thread=, or a message's rootTs in fetch_history or fetch_thread " +
      'results.',
  });
  await assert.rejects(reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', textContains: 'x' }), {
    message: 'No messages were returned: fetch_thread takes no argument named textContains. It takes channelId, threadTs, ' +
      'limit, oldest, latest, cursor, maxScanned, maxBytes.',
  });
  assert.equal(api.calls.length, from);
});

test('with DMs off, a read of a DM or its thread is refused by the adapter\'s DM check before any page', { timeout: 5000 }, async () => {
  const from = api.calls.length;
  // A read's refusal opens as its other failures do.
  const refused =
    'No messages were returned: D1 is a direct message or group DM, and this bot works only in channels here, ' +
    'since direct messages are turned off. list_channels shows the ones it can use.';
  await assert.rejects(adapter({ disableDms: true }).readHistory('D1', { channelId: 'D1' }), { message: refused });
  await assert.rejects(adapter({ disableDms: true }).readThread('D1', '1.0', { channelId: 'D1', threadTs: '1.0' }), {
    message: refused,
  });
  assert.equal(api.calls.length, from);
});

test("channel.writable is the write allow-list's answer, as list_channels gives it", { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([], false)], 'conversations.replies': [page([], false)] });
  const reader = adapter({ sendChannels: ['C9'] });
  assert.deepEqual((await reader.readHistory('C1', { channelId: 'C1' })).channel, { id: 'C1', writable: false });
  assert.deepEqual((await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0' })).channel, { id: 'C1', writable: false });
  assert.deepEqual((await reader.readThread('C9', '1.0', { channelId: 'C9', threadTs: '1.0' })).channel, { id: 'C9', writable: true });
});

test('the thread fields: a root from the parent, a broadcast reply and an ordinary message; a reply count only when Slack gives a valid one; the posting bot', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([
      row('9.0', 'U1', 'thread_ts ahead of the root', { thread_ts: '1.0', root: { ts: '3.0', thread_ts: '3.0' } }),
      row('8.0', 'U1', 'an invalid thread_ts, then the root', { thread_ts: 'nope', root: { thread_ts: 'nope', ts: '3.0' } }),
      row('7.0', 'U1', "the root's thread_ts alone", { subtype: 'thread_broadcast', root: { thread_ts: '3.0' } }),
      row('6.0', 'U1', "the root's ts alone", { subtype: 'thread_broadcast', root: { ts: '3.0' } }),
      row('5.0', 'U1', 'broadcast', { subtype: 'thread_broadcast', root: { ts: '3.0', thread_ts: '3.0' } }),
      row('4.0', 'U1', 'plain', { reply_count: -1 }),
      row('3.0', 'U1', 'parent', { thread_ts: '3.0', reply_count: 2 }),
      { ts: '2.0', bot_id: 'B1', username: 'deploybot', text: 'from a bot', reply_count: 1.5 },
      row('1.0', 'U1', 'a parent whose replies are gone', { thread_ts: '1.0', reply_count: 0 }),
    ], false)],
  });
  const out = await adapter().readHistory('C1', { channelId: 'C1' });
  assert.deepEqual(out.messages.map((m) => [m.id, m.rootTs, m.replyCount, m.authorBotId, m.author]), [
    ['1.0', '1.0', 0, undefined, 'U1'],
    ['2.0', '2.0', undefined, 'B1', 'deploybot'],
    ['3.0', '3.0', 2, undefined, 'U1'],
    ['4.0', '4.0', undefined, undefined, 'U1'],
    ['5.0', '3.0', undefined, undefined, 'U1'],
    ['6.0', '3.0', undefined, undefined, 'U1'],
    ['7.0', '3.0', undefined, undefined, 'U1'],
    ['8.0', '3.0', undefined, undefined, 'U1'],
    ['9.0', '1.0', undefined, undefined, 'U1'],
  ]);
});
test('a history read passes oldest on to Slack as the bound of every page', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'a')], true), page([row('8.0', 'U1', 'b')], false)] });
  const from = api.calls.length;
  await adapter().readHistory('C1', { channelId: 'C1', oldest: '2.0', latest: '10.0' });
  assert.deepEqual(sentTo('conversations.history', from).map((p) => [p.latest, p.oldest]), [['10.0', '2.0'], ['9.0', '2.0']]);
});

test('a read without limit asks Slack for its default match count: 50 history messages, 100 of a thread', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([], false)], 'conversations.replies': [page([], false)] });
  const reader = adapter();
  const from = api.calls.length;
  await reader.readHistory('C1', { channelId: 'C1' });
  await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0' });
  assert.equal(sentTo('conversations.history', from)[0]!.limit, '50');
  assert.equal(sentTo('conversations.replies', from)[0]!.limit, '100');
});

test("a thread read stopped by a long rate limit, or by the call's time, returns what it read and a cursor toward newer replies", { timeout: 5000 }, async (t) => {
  const first = page([row('1.0', 'U1', 'parent', { thread_ts: '1.0' }), row('2.0', 'U2', 'one', { thread_ts: '1.0' })], true);
  const reader = adapter();
  answers(t, { 'conversations.replies': [first, { status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } }] });
  const limited = await withCallTime(Date.now(), () => reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0' }));
  assert.deepEqual([limited.messages.map((m) => m.id), limited.pagination.stopReason, limited.pagination.retryAfterSeconds],
    [['1.0', '2.0'], 'rate_limited', 30]);
  const timed = await readWhileTimePasses(t, 'conversations.replies', first, [page([row('3.0', 'U2', 'two', { thread_ts: '1.0' })], false)],
    SLACK_CLIENT_OPTIONS.timeout / 1000 + 1, 2, () => reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0' }));
  assert.deepEqual([timed.messages.map((m) => m.id), timed.pagination.stopReason], [['1.0', '2.0'], 'time_limit']);
  for (const cursor of [limited.pagination.nextCursor, timed.pagination.nextCursor]) {
    const from = api.calls.length;
    await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', cursor });
    assert.equal(sentTo('conversations.replies', from)[0]!.oldest, '2.0', 'it continues after the last reply it read');
  }
});

test("Slack's ratelimited refusal after the first pages stops the read as a rate limit, with Slack's seconds when they came with it", { timeout: 5000 }, async (t) => {
  // Zero seconds are seconds; a negative count isn't one.
  for (const [headers, seconds] of [[{ 'retry-after': '30' }, 30], [{ 'retry-after': '0' }, 0], [{ 'retry-after': '-1' }, undefined], [{}, undefined]] as const) {
    answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'a')], true), { headers, body: { ok: false, error: 'ratelimited' } }] });
    const out = await withCallTime(Date.now(), () => adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' }));
    assert.deepEqual(out.messages.map((m) => m.id), ['9.0']);
    assert.equal(out.pagination.stopReason, 'rate_limited');
    assert.equal(out.pagination.retryAfterSeconds, seconds);
    assert.ok(out.pagination.nextCursor);
  }
});

test('any other failure after the first pages fails the call, since a read is safe to repeat', { timeout: 5000 }, async (t) => {
  for (const [failure, code] of [
    [{ status: 503, body: { ok: false } }, 'slack_webapi_http_error'],
    [{ body: { ok: false, error: 'internal_error' } }, 'slack_webapi_platform_error'],
  ] as const) {
    answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'a')], true), failure] });
    const err = await withCallTime(Date.now(), () => adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' }))
      .then(() => null, (e: unknown) => e);
    assert.equal((err as { code?: string } | null)?.code, code, JSON.stringify(failure));
  }
});

test('a filtered read that scanned only messages it leaves out, then met a long rate limit, returns no matches with its counts and a cursor', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('9.0', 'U1', 'noise'), row('8.0', 'U1', 'noise')], true),
      { status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } },
    ],
  });
  const out = await withCallTime(Date.now(), () => adapter().readHistory('C1', { channelId: 'C1', textContains: 'target', latest: '10.0' }));
  assert.deepEqual(out.messages, []);
  assert.deepEqual([out.pagination.scanned, out.pagination.matched, out.pagination.stopReason], [2, 0, 'rate_limited']);
  assert.ok(out.pagination.nextCursor);
});

test("a later page with more to come that holds only a message read before, or a thread's parent again, stops as stalled", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([row('9.0', 'U1', 'a'), row('8.0', 'U1', 'b')], true), page([row('8.0', 'U1', 'b')], true)],
    'conversations.replies': [
      page([row('1.0', 'U1', 'parent', { thread_ts: '1.0' }), row('2.0', 'U2', 'one', { thread_ts: '1.0' })], true),
      page([row('1.0', 'U1', 'parent', { thread_ts: '1.0' })], true),
    ],
  });
  const reader = adapter();
  const history = await reader.readHistory('C1', { channelId: 'C1', latest: '10.0' });
  const thread = await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0' });
  for (const [out, ids] of [[history, ['8.0', '9.0']], [thread, ['1.0', '2.0']]] as const) {
    assert.deepEqual(out.messages.map((m) => m.id), ids);
    assert.deepEqual([out.pagination.stopReason, out.pagination.scanComplete], ['pagination_stalled', false]);
    assert.ok(out.pagination.nextCursor);
  }
});

test('a filtered read looks up the names of its matches, not of the messages it leaves out', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'mine'), row('8.0', 'U2', 'theirs, for <@U3>')], false)] });
  const from = api.calls.length;
  await adapter().readHistory('C1', { channelId: 'C1', authorIds: ['U1'] });
  assert.deepEqual(sentTo('users.info', from).map((p) => p.user), ['U1']);
});

test('a record gives its time in ISO form, and each attachment with how to fetch it', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([row('1718000000.000100', 'U1', 'see the file', {
      files: [{ name: 'plan.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/files-pri/T1-F1/plan.pdf' }, { name: 'raw' }],
    })], false)],
  });
  const [record] = (await adapter().readHistory('C1', { channelId: 'C1' })).messages;
  assert.equal(record!.timestamp, '2024-06-10T06:13:20.000Z');
  assert.deepEqual(record!.attachments, [
    'plan.pdf (application/pdf) — fetchable via fetch_attachment: https://files.slack.com/files-pri/T1-F1/plan.pdf',
    'raw',
  ]);
});

test('maxBytes counts UTF-8 bytes, so a message whose characters would fit but whose bytes do not is held back', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('9.0', 'U1', 'small'), row('8.0', 'U1', '\u{1F600}'.repeat(400))], true)] });
  const out = await adapter().readHistory('C1', { channelId: 'C1', maxBytes: 2048, latest: '10.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['9.0']);
  assert.equal(out.pagination.stopReason, 'byte_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 2048, String(Buffer.byteLength(JSON.stringify(out))));
});

test('timestamps within one second are read in the order of their fractions, and a read continues from one', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('1718000000.000100', 'U1', 'a'), row('1718000000.000300', 'U1', 'c'), row('1718000000.000200', 'U1', 'b')], true),
      page([row('1718000000.000100', 'U1', 'a')], false),
    ],
  });
  const reader = adapter();
  const from = api.calls.length;
  const first = await reader.readHistory('C1', { channelId: 'C1', limit: 2, latest: '1718000001' });
  assert.deepEqual(first.messages.map((m) => m.id), ['1718000000.000200', '1718000000.000300']);
  const next = await reader.readHistory('C1', { channelId: 'C1', limit: 2, latest: '1718000001', cursor: first.pagination.nextCursor });
  assert.equal(sentTo('conversations.history', from)[1]!.latest, '1718000000.000200');
  assert.deepEqual(next.messages.map((m) => m.id), ['1718000000.000100']);
});

test('authorIds matches a message by any of the ids it lists', { timeout: 5000 }, async (t) => {
  answers(t, { 'conversations.history': [page([row('3.0', 'U1', 'a'), row('2.0', 'U2', 'b'), row('1.0', 'U3', 'c')], false)] });
  const out = await adapter().readHistory('C1', { channelId: 'C1', authorIds: ['U3', 'U1'] });
  assert.deepEqual(out.messages.map((m) => m.id), ['1.0', '3.0']);
});

test('a cursor belongs to its whole query: another thread, bound or filter refuses it, and the same authors in another order take it', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([row('9.0', 'U1', 'target'), row('8.0', 'U2', 'target')], true)],
    'conversations.replies': [page([row('1.0', 'U1', 'parent', { thread_ts: '1.0' }), row('2.0', 'U2', 'one', { thread_ts: '1.0' })], true)],
  });
  const reader = adapter();
  const query = { channelId: 'C1', limit: 1, textContains: 'target', authorIds: ['U1', 'U2'], oldest: '1.0', latest: '10.0' };
  const history = (await reader.readHistory('C1', query)).pagination.nextCursor;
  const thread = (await reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', limit: 1 })).pagination.nextCursor;
  const from = api.calls.length;
  for (const changed of [{ oldest: '2.0' }, { latest: '11.0' }, { caseSensitive: true }, { authorIds: ['U1'] }]) {
    await assert.rejects(reader.readHistory('C1', { ...query, ...changed, cursor: history }), /cursor belongs to another query/,
      JSON.stringify(changed));
  }
  await assert.rejects(reader.readThread('C1', '3.0', { channelId: 'C1', threadTs: '3.0', limit: 1, cursor: thread }),
    /cursor belongs to another query/);
  assert.equal(api.calls.length, from, 'nothing was asked');
  await reader.readHistory('C1', { ...query, authorIds: ['U2', 'U1', 'U2'], cursor: history });
  assert.equal(sentTo('conversations.history', from)[0]!.latest, '9.0', 'the same authors, reordered and repeated, continue the read');
});

test("every text that says where a thread's parent id comes from names a reply's thread=, a message's own id= and a result's rootTs", () => {
  const described = (tool: string, argument?: string): string => {
    const definition = toolDefinitions.find((d) => d.name === tool)!;
    if (!argument) return definition.description;
    return (definition.inputSchema.properties as Record<string, { description: string }>)[argument]!.description;
  };
  for (const [where, text] of [
    ['PARENT_IDS, for the refusals and fetch_thread', PARENT_IDS],
    ["fetch_thread's description", described('fetch_thread')],
    ["reply_message's description", described('reply_message')],
    ["reply_message's messageId", described('reply_message', 'messageId')],
    ["upload_file's messageId", described('upload_file', 'messageId')],
  ] as const) {
    for (const route of ['thread=', 'id=', 'rootTs']) assert.ok(text.includes(route), `${where} names ${route}: ${text}`);
  }
});

test("each read tool's schema takes what its read takes: the same arguments, each bound at its edge, and the defaults", () => {
  type Property = { type: string; minimum?: number; maximum?: number; default?: unknown; minItems?: number; maxItems?: number;
    minLength?: number; maxLength?: number; items?: { pattern: string } };
  for (const kind of ['history', 'thread'] as const) {
    const tool = kind === 'history' ? 'fetch_history' : 'fetch_thread';
    const schema = toolDefinitions.find((d) => d.name === tool)!.inputSchema;
    const properties = schema.properties as Record<string, Property>;
    const given: Record<string, unknown> = kind === 'history' ? { channelId: 'C1' } : { channelId: 'C1', threadTs: '1.0' };
    const read = (args: Record<string, unknown>) => readOptions({ ...given, ...args }, kind, 'C1', kind === 'thread' ? '1.0' : undefined);
    assert.deepEqual(Object.keys(properties).sort(), [...READ_ARGUMENTS[kind]].sort(), tool);
    assert.equal(schema.additionalProperties, false, tool);
    assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(given).sort(), tool);
    assert.throws(() => read({ notAnArgument: 1 }), /takes no argument named notAnArgument\./, tool);
    const defaults: Record<string, unknown> = read({});
    for (const [name, p] of Object.entries(properties)) {
      const at = (value: unknown) => read({ [name]: value });
      const refuses = (value: unknown) => assert.throws(() => at(value), new RegExp(name + ' must'), tool + ' ' + name + ' ' + JSON.stringify(value));
      if (p.type === 'integer') {
        assert.ok(Number.isInteger(p.minimum) && Number.isInteger(p.maximum), tool + ' ' + name + ' is bounded');
        assert.equal(defaults[name], p.default, tool + ' ' + name + "'s default");
        at(p.minimum); at(p.maximum);
        refuses(p.minimum! - 1); refuses(p.maximum! + 1);
      } else if (p.type === 'array') {
        const ids = (n: number) => Array.from({ length: n }, (_, i) => 'U' + i);
        at(ids(p.minItems!)); at(ids(p.maxItems!));
        refuses(ids(p.minItems! - 1)); refuses(ids(p.maxItems! + 1));
        // An entry the pattern refuses is named by its place.
        for (const id of ['U1', 'W1', 'B1', 'u1', 'C1', 'U-1']) {
          if (new RegExp(p.items!.pattern).test(id)) at([id]);
          else assert.throws(() => at([id]), new RegExp(`${name}\\[0\\] must`), tool + ' ' + name + ' ' + JSON.stringify([id]));
        }
      } else if (p.type === 'boolean') {
        assert.equal(defaults[name], p.default, tool + ' ' + name + "'s default");
        at(true);
        refuses('true');
      } else if (p.maxLength !== undefined) {
        // Characters as the schema counts them: code points.
        at('\u{1F600}'.repeat(p.minLength!)); at('\u{1F600}'.repeat(p.maxLength));
        refuses('\u{1F600}'.repeat(p.minLength! - 1)); refuses('\u{1F600}'.repeat(p.maxLength + 1));
      }
    }
  }
});

test("a rate limit's seconds past Number.MAX_SAFE_INTEGER are left out", { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [
      page([row('9.0', 'U1', 'a')], true),
      { status: 429, headers: { 'retry-after': '100000000000000000000' }, body: { ok: false, error: 'ratelimited' } },
    ],
  });
  const out = await adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' });
  assert.equal(out.pagination.stopReason, 'rate_limited');
  assert.equal(out.pagination.retryAfterSeconds, undefined);
});

test('a read stopped by a rate limit stays within maxBytes with the longest seconds it can carry, at the largest message that fits', { timeout: 10_000 }, async (t) => {
  // Every other field of the result as long as its bound: the counts as wide
  // as their limits, and the longest timestamp a cursor can hold, 16 digits
  // and 6 decimals, whose leading zeros keep it within Date's range.
  const ts = '0008639999999999.999999';
  const read = (size: number) => {
    api.answerFor('conversations.history', page([row(ts, 'U1', 'x'.repeat(size))], true),
      { status: 429, headers: { 'retry-after': String(Number.MAX_SAFE_INTEGER) }, body: { ok: false, error: 'ratelimited' } });
    return adapter().readHistory('C1', { channelId: 'C1', limit: 2, maxScanned: 2, maxBytes: 2048 }).catch(() => undefined);
  };
  t.after(() => api.answerFor('conversations.history'));
  // The largest message that fits beside the result's own fields, by halves:
  // a larger one fails the read at its start.
  let fits = 0, fails = 2048;
  while (fails - fits > 1) {
    const size = Math.floor((fits + fails) / 2);
    if (await read(size)) fits = size;
    else fails = size;
  }
  const out = (await read(fits))!;
  assert.equal(out.pagination.stopReason, 'rate_limited');
  assert.equal(out.pagination.retryAfterSeconds, Number.MAX_SAFE_INTEGER);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 2048, String(Buffer.byteLength(JSON.stringify(out))));
});
