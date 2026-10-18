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

test('a match too big for maxBytes is held back whole, counted, and where the cursor resumes', { timeout: 5000 }, async (t) => {
  answers(t, {
    'conversations.history': [page([row('9.0', 'U1', 'small'), row('8.0', 'U1', 'x'.repeat(4000)), row('7.0', 'U1', 'small')], true)],
  });
  const reader = adapter();
  const from = api.calls.length;
  const out = await reader.readHistory('C1', { channelId: 'C1', maxBytes: 2048, latest: '10.0' });
  assert.deepEqual(out.messages.map((m) => m.id), ['9.0']);
  assert.equal(out.pagination.stopReason, 'byte_limit');
  assert.equal(out.pagination.scanned, 2);
  assert.equal(out.pagination.matched, 2);
  assert.equal(out.pagination.returned, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 2048);
  await reader.readHistory('C1', { channelId: 'C1', maxBytes: 2048, latest: '10.0', cursor: out.pagination.nextCursor });
  assert.equal(sentTo('conversations.history', from)[1]!.latest, '9.0', 'the held message is read again');
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
  assert.deepEqual([out.pagination.scanned, out.pagination.stopReason, out.pagination.pages], [3, 'scan_limit', 1]);
  assert.ok(out.pagination.nextCursor);
});

test("a page the call's time has no room for ends the read with what it has and a cursor, once something was scanned", { timeout: 10_000 }, async (t) => {
  // 10.5 s are left: the first page fits, and takes 1 s, after which the
  // second's 10 s don't.
  answers(t, {
    'conversations.history': [{ ...page([row('9.0', 'U1', 'a')], true), delayMs: 1000 }, page([row('8.0', 'U1', 'b')], false)],
  });
  const from = api.calls.length;
  const arrived = Date.now() - (CALL_SECONDS - SLACK_CLIENT_OPTIONS.timeout / 1000 - 0.5) * 1000;
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

test('a page with more to come but nothing in it stops the read as stalled, not covered', { timeout: 5000 }, async (t) => {
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
    [{ authorIds: ['not-a-user'] }, /authorIds must contain 1 to 50 Slack user IDs/],
  ] as const) {
    await assert.rejects(reader.readHistory('C1', { channelId: 'C1', ...args }), said, JSON.stringify(args));
  }
  await assert.rejects(reader.readHistory('U1', { channelId: 'U1' }), /channelId must be a Slack conversation ID/);
  await assert.rejects(reader.readThread('C1', 'nope', { channelId: 'C1', threadTs: 'nope' }), /threadTs must be a Slack timestamp/);
  await assert.rejects(reader.readThread('C1', '1.0', { channelId: 'C1', threadTs: '1.0', textContains: 'x' }),
    /Unknown argument: textContains/);
  assert.equal(api.calls.length, from);
});

test('with DMs off, a read of a DM is refused by the adapter\'s DM check before any page', { timeout: 5000 }, async () => {
  const from = api.calls.length;
  await assert.rejects(adapter({ disableDms: true }).readHistory('D1', { channelId: 'D1' }), /direct messages are disabled/);
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
