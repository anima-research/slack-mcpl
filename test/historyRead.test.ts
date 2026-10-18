/**
 * fetch_history's and fetch_thread's bounded reads, through the adapter's own
 * client against a local endpoint that answers as Slack does: filters,
 * completeness, the cursor, the limits, and how the call's time and Slack's
 * rate limits stop a read.
 */
import test, { after, before } from 'node:test';
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
import { fakeSlackApi, type FakeSlackApi, type SlackApiAnswer } from './slackApi.js';

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
    /^Error: cursor belongs to another query: pass it with the same channel, thread, oldest, latest and filters/);
  await assert.rejects(reader.readHistory('C2', { channelId: 'C2', limit: 1, textContains: 'target', cursor: first.pagination.nextCursor }),
    /cursor belongs to another query/);
  for (const cursor of ['not-a-cursor', Buffer.from(JSON.stringify({ q: 'x', at: 'nope' })).toString('base64url'), 'x'.repeat(300)]) {
    await assert.rejects(reader.readHistory('C1', { channelId: 'C1', limit: 1, textContains: 'target', cursor }),
      /cursor is not a nextCursor this server gave/);
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
  await assert.rejects(adapter().readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', maxBytes: 2048 }),
    /^Error: No messages were returned: the next message, 1\.0, takes .*to read past it, call again with the same arguments, but without cursor and with oldest set to 1\.0\.$/);
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

test("a page the call's time has no room for ends the read with what it has and a cursor, once something was scanned", { timeout: 10_000 }, async (t) => {
  // 12 s are left: the first page fits if it starts within 2 s, and takes
  // 3 s, after which the second's 10 s don't.
  answers(t, {
    'conversations.history': [{ ...page([row('9.0', 'U1', 'a')], true), delayMs: 3000 }, page([row('8.0', 'U1', 'b')], false)],
  });
  const from = api.calls.length;
  const arrived = Date.now() - (CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 - 2) * 1000;
  const out = await withCallTime(arrived, () => adapter().readHistory('C1', { channelId: 'C1', latest: '10.0' }));
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
  await assert.rejects(reader.readHistory('C1', { channelId: 'C1' }),
    /^Error: No messages were returned: Slack's answer for a page of messages held no list of them$/);
  for (const what of ['a message without a ts', 'an entry that is no message']) {
    await assert.rejects(reader.readHistory('C1', { channelId: 'C1' }),
      /^Error: No messages were returned: Slack gave a message without a valid ts, so this read can't place it$/, what);
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
    /^Error: No messages were returned: Slack's page held no message past where this read started, though it said more remain\. Calling again may get them; if it stops the same way, Slack isn't giving the rest of this range just now\.$/);
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
  for (const [args, said] of [
    [{ regex: '.*' }, /^Error: Unknown argument: regex$/],
    [{ maxPages: 3, maxMs: 100 }, /^Error: Unknown arguments: maxPages, maxMs$/],
    [{ threadTs: '1.0' }, /Unknown argument: threadTs/],
    [{ limit: 0 }, /limit must be an integer from 1 to 1000/],
    [{ limit: 1.5 }, /limit must be an integer/],
    [{ limit: '50' }, /limit must be an integer/],
    [{ maxScanned: 10001 }, /maxScanned must be an integer from 1 to 10000/],
    [{ maxBytes: 1000 }, /maxBytes must be an integer from 2048 to 1048576/],
    [{ oldest: 'yesterday' }, /oldest must be a Slack timestamp/],
    [{ oldest: '2.0', latest: '1.0' }, /oldest must precede latest/],
    [{ textContains: '' }, /textContains must contain 1 to 256 characters/],
    [{ caseSensitive: 'yes' }, /caseSensitive must be a boolean/],
    [{ authorIds: ['not-a-user'] }, /authorIds must contain 1 to 50 Slack user or bot IDs/],
  ] as const) {
    await assert.rejects(reader.readHistory('C1', { channelId: 'C1', ...args }), said, JSON.stringify(args));
  }
  await assert.rejects(reader.readHistory('U1', { channelId: 'U1' }), /channelId must be a Slack conversation ID/);
  await assert.rejects(reader.readThread('C1', 'nope', { channelId: 'C1', threadTs: 'nope' }), /threadTs must be a Slack timestamp/);
  await assert.rejects(reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', textContains: 'x' }),
    /Unknown argument: textContains/);
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
  answers(t, { 'conversations.history': [page([], false)] });
  const out = await adapter({ sendChannels: ['C9'] }).readHistory('C1', { channelId: 'C1' });
  assert.deepEqual(out.channel, { id: 'C1', writable: false });
});

test('the thread fields: a root from the parent, a broadcast reply and an ordinary message; a reply count only when Slack gives a valid one; the posting bot', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([
      row('5.0', 'U1', 'broadcast', { subtype: 'thread_broadcast', root: { ts: '3.0', thread_ts: '3.0' } }),
      row('4.0', 'U1', 'plain', { reply_count: -1 }),
      row('3.0', 'U1', 'parent', { thread_ts: '3.0', reply_count: 2 }),
      { ts: '2.0', bot_id: 'B1', username: 'deploybot', text: 'from a bot', reply_count: 1.5 },
    ], false)],
  });
  const out = await adapter().readHistory('C1', { channelId: 'C1' });
  assert.deepEqual(out.messages.map((m) => [m.id, m.rootTs, m.replyCount, m.authorBotId, m.author]), [
    ['2.0', '2.0', undefined, 'B1', 'deploybot'],
    ['3.0', '3.0', 2, undefined, 'U1'],
    ['4.0', '4.0', undefined, undefined, 'U1'],
    ['5.0', '3.0', undefined, undefined, 'U1'],
  ]);
});
