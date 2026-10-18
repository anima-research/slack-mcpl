import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedHistoryReader, channelReadPolicy, historyRecord, readOptions, type SlackReadCall} from '../src/history-read.js';
import type {SlackHistoryMessage} from '../src/content.js';

function fixture(rows: SlackHistoryMessage[] = [], pageSize = 2) {
  const calls: Array<{method: string; args: Record<string, unknown>}> = [];
  let info: Record<string, unknown> = {id: 'C1', is_member: true, is_im: false, is_mpim: false};
  let failure: unknown;
  let now = 0;
  let afterPage = () => {};
  const call: SlackReadCall = async (method, args) => {
    calls.push({method, args});
    if (method === 'conversations.info') return {channel: info};
    if (failure) throw failure;
    const selected = rows.filter(row => (!args.oldest || Number(row.ts) > Number(args.oldest)) && Number(row.ts) < Number(args.latest))
      .sort((a, b) => method === 'conversations.history' ? Number(b.ts) - Number(a.ts) : Number(a.ts) - Number(b.ts));
    const offset = args.cursor ? Number(args.cursor) : 0;
    const messages = selected.slice(offset, offset + Math.min(pageSize, Number(args.limit)));
    const next = offset + messages.length;
    afterPage();
    return {messages, response_metadata: next < selected.length ? {next_cursor: String(next)} : {}};
  };
  const reader = new BoundedHistoryReader(call, () => false, new Map(), false, () => now);
  return {reader, calls, setInfo(value: Record<string, unknown>) {info = value;}, setFailure(value: unknown) {failure = value;},
    setClock(value: number) {now = value;}, afterPage(value: () => void) {afterPage = value;}};
}
const rows = Array.from({length: 8}, (_, i) => ({ts: `${i + 1}.0`, user: i % 2 ? 'U2' : 'U1', text: i === 0 || i === 6 ? 'TARGET' : 'noise'}));

test('one returned match can scan a full candidate page without 200 one-message requests', async () => {
  const many = Array.from({length: 200}, (_, i) => ({ts: `${i + 1}.0`, text: i === 0 ? 'target' : 'noise'}));
  const h = fixture(many, 200);
  const out = await h.reader.read('history', 'C1', {limit: 1, maxPages: 1, textContains: 'target'});
  assert.deepEqual(out.messages.map(m => m.id), ['1.0']);
  assert.equal(out.pagination.scanned, 200);
  assert.equal(out.pagination.pages, 1);
  assert.equal(out.pagination.scanComplete, true);
});

test('sparse matches traverse empty filtered pages; exact authors AND Unicode-lowercase substring', async () => {
  const h = fixture(rows);
  const out = await h.reader.read('history', 'C1', {textContains: 'target', authorIds: ['U1']});
  assert.deepEqual(out.messages.map(m => m.id), ['1.0', '7.0']);
  assert.equal(out.pagination.pages, 4);
  assert.equal(out.pagination.scanned, 8);
  assert.equal(out.pagination.matched, 2);
  assert.equal(out.pagination.scanComplete, true);
  assert.equal(out.pagination.stopReason, 'exhausted');
  assert.equal(out.pagination.threadRepliesSearched, false);
  assert.equal(out.channel.writeAllowedByPolicy, false);
  const sensitive = await h.reader.read('history', 'C1', {textContains: 'target', caseSensitive: true});
  assert.equal(sensitive.messages.length, 0);
  assert.equal(sensitive.pagination.scanComplete, true);
  const unicode = fixture([{ts: '1.0', text: 'ÄPPLE', user: 'U1'}, {ts: '2.0', text: 'ÄPPLE'}]);
  assert.equal((await unicode.reader.read('history', 'C1', {textContains: 'äpple', authorIds: ['U1']})).messages.length, 1);
});

test('zero bounded matches are explicitly incomplete and resumable', async () => {
  const h = fixture(rows);
  const first = await h.reader.read('history', 'C1', {textContains: 'absent', maxScanned: 3});
  assert.deepEqual(first.messages, []);
  assert.equal(first.pagination.scanned, 3);
  assert.equal(first.pagination.stopReason, 'scan_limit');
  assert.equal(first.pagination.scanComplete, false);
  assert.ok(first.pagination.nextCursor);
  const second = await h.reader.read('history', 'C1', {textContains: 'absent', cursor: first.pagination.nextCursor});
  assert.equal(second.pagination.scanned, 5);
  assert.equal(second.pagination.scanComplete, true);
});

test('match limits and time bounds resume toward older history without dropping matches', async () => {
  const h = fixture(rows);
  const args = {oldest: '1.0', latest: '8.0', limit: 2};
  const first = await h.reader.read('history', 'C1', args);
  assert.deepEqual(first.messages.map(m => m.id), ['6.0', '7.0']);
  assert.equal(first.pagination.stopReason, 'match_limit');
  const second = await h.reader.read('history', 'C1', {...args, cursor: first.pagination.nextCursor});
  assert.deepEqual(second.messages.map(m => m.id), ['4.0', '5.0']);
  assert.equal(second.pagination.scanComplete, false);
  const third = await h.reader.read('history', 'C1', {...args, cursor: second.pagination.nextCursor});
  assert.deepEqual(third.messages.map(m => m.id), ['2.0', '3.0']);
  assert.equal(third.pagination.scanComplete, true);
});

test('threads count the parent and resume toward newer replies, not complete channel searches', async () => {
  const h = fixture([{ts: '1.0', thread_ts: '1.0', reply_count: 2}, {ts: '2.0', thread_ts: '1.0'}, {ts: '3.0', thread_ts: '1.0'}]);
  const first = await h.reader.read('thread', 'C1', {limit: 2}, '1.0');
  assert.deepEqual(first.messages.map(m => m.id), ['1.0', '2.0']);
  assert.equal(first.messages[0]!.rootTs, '1.0');
  assert.equal(first.messages[0]!.replyCount, 2);
  assert.equal(first.messages[1]!.threadTs, '1.0');
  assert.equal(first.pagination.scope, 'single_thread');
  const second = await h.reader.read('thread', 'C1', {limit: 2, cursor: first.pagination.nextCursor}, '1.0');
  assert.deepEqual(second.messages.map(m => m.id), ['3.0']);
  assert.equal(second.pagination.scanComplete, true);
  assert.equal(second.pagination.threadRepliesSearched, true);
});

test('page and elapsed-time budgets stop traversal independently', async () => {
  const h = fixture(rows);
  const onePage = await h.reader.read('history', 'C1', {maxPages: 1});
  assert.equal(onePage.pagination.stopReason, 'page_limit');
  assert.equal(onePage.pagination.pages, 1);
  h.afterPage(() => h.setClock(10001));
  const timed = await h.reader.read('history', 'C1', {});
  assert.equal(timed.pagination.stopReason, 'time_limit');
  assert.equal(timed.pagination.scanned, 0);
  assert.equal(timed.pagination.scanComplete, false);
});

test('deadline aborts an in-flight read; no subsequent call is made', async () => {
  let calls = 0, aborted = false;
  const reader = new BoundedHistoryReader(async (method, _, signal) => {
    calls++;
    if (method === 'conversations.info') return {channel: {id: 'C1'}};
    return new Promise((_, reject) => signal.addEventListener('abort', () => {aborted = true; reject(new Error('aborted'));}, {once: true}));
  }, () => true, new Map(), false);
  const output = await reader.read('history', 'C1', {maxMs: 100});
  assert.equal(output.pagination.stopReason, 'time_limit');
  assert.equal(aborted, true);
  assert.equal(calls, 2);
});

test('UTF-8 byte budget covers the entire JSON result and resumes before oversized match', async () => {
  const h = fixture([{ts: '1.0', text: 'small'}, {ts: '2.0', text: '😀'.repeat(1500)}]);
  const first = await h.reader.read('history', 'C1', {maxBytes: 2048});
  assert.equal(first.messages.length, 0);
  assert.equal(first.pagination.stopReason, 'byte_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2048);
  const resumed = await h.reader.read('history', 'C1', {maxBytes: 16000, cursor: first.pagination.nextCursor});
  assert.deepEqual(resumed.messages.map(m => m.id), ['1.0', '2.0']);
  assert.equal(resumed.pagination.scanComplete, true);
});

test('partial-page byte stop resumes without skipping the held message', async () => {
  const h = fixture([{ts: '1.0', text: 'x'.repeat(2000)}, {ts: '2.0', text: 'small'}]);
  const first = await h.reader.read('history', 'C1', {maxBytes: 2048});
  assert.deepEqual(first.messages.map(m => m.id), ['2.0']);
  const resumed = await h.reader.read('history', 'C1', {maxBytes: 8000, cursor: first.pagination.nextCursor});
  assert.deepEqual(resumed.messages.map(m => m.id), ['1.0']);
});

test('cursor tampering, filter/channel/method mismatch, expiry and another instance all refuse before calls', async () => {
  const h = fixture(rows);
  const first = await h.reader.read('history', 'C1', {limit: 1, textContains: 'noise', authorIds: ['U2', 'U1']});
  const cursor = first.pagination.nextCursor!;
  const count = h.calls.length;
  for (const args of [{cursor: cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'), textContains: 'noise', authorIds: ['U1', 'U2']},
    {cursor, textContains: 'other', authorIds: ['U1', 'U2']}, {cursor, textContains: 'noise', authorIds: ['U1']}]) {
    await assert.rejects(h.reader.read('history', 'C1', args), /cursor/);
  }
  await assert.rejects(h.reader.read('history', 'C2', {cursor, textContains: 'noise', authorIds: ['U1', 'U2']}), /cursor/);
  await assert.rejects(h.reader.read('history', 'C1', {cursor, textContains: 'noise', authorIds: ['U1', 'U2'], oldest: '1.0'}), /cursor/);
  await assert.rejects(h.reader.read('history', 'C1', {cursor, textContains: 'noise', authorIds: ['U1', 'U2'], caseSensitive: true}), /cursor/);
  await assert.rejects(h.reader.read('thread', 'C1', {cursor}, '1.0'), /cursor/);
  assert.equal(h.calls.length, count);
  await assert.rejects(fixture(rows).reader.read('history', 'C1', {cursor, textContains: 'noise', authorIds: ['U1', 'U2']}), /cursor/);
  const valid = await h.reader.read('history', 'C1', {cursor, textContains: 'noise', authorIds: ['U1', 'U2']});
  assert.equal(valid.pagination.scanComplete, true, 'author order is normalized');
  h.setClock(900001);
  await assert.rejects(h.reader.read('history', 'C1', {cursor, textContains: 'noise', authorIds: ['U1', 'U2']}), /cursor/);
});

test('bounded continuation store evicts old handles instead of retaining unbounded positions', async () => {
  const h = fixture(rows);
  const first = await h.reader.read('history', 'C1', {limit: 1});
  for (let i = 0; i < 128; i++) await h.reader.read('history', 'C1', {limit: 1});
  await assert.rejects(h.reader.read('history', 'C1', {cursor: first.pagination.nextCursor}), /cursor/);
});

test('resumption checks current membership and propagates revoked Slack read permission', async () => {
  const h = fixture(rows);
  const first = await h.reader.read('history', 'C1', {limit: 1});
  h.setInfo({id: 'C1', is_member: false});
  await assert.rejects(h.reader.read('history', 'C1', {cursor: first.pagination.nextCursor}), /no longer joined/);
  h.setInfo({id: 'C1', is_member: true});
  h.setFailure({code: 'slack_webapi_platform_error', data: {error: 'not_in_channel'}});
  await assert.rejects(h.reader.read('history', 'C1', {cursor: first.pagination.nextCursor}), error => (error as any).data.error === 'not_in_channel');
});

test('missing info scope yields unknown metadata, not a new grant requirement or writable claim', async () => {
  const reader = new BoundedHistoryReader(async method => {
    if (method === 'conversations.info') throw {data: {error: 'missing_scope'}};
    return {messages: [{ts: '1.0', text: 'readable'}]};
  }, () => true, new Map(), false);
  const out = await reader.read('history', 'C1', {});
  assert.equal(out.channel.slack.metadataAvailable, false);
  assert.equal(out.channel.slack.channelPostAllowedByMetadata, null);
  assert.equal(out.messages.length, 1);
});

test('policy hints separate channel posting from thread replies and retain unknown restrictions', () => {
  const baseline = {is_archived: false, is_frozen: false, is_read_only: false, is_thread_only: false, is_non_threadable: false,
    properties: {posting_restricted_to: {type: []}, threads_restricted_to: {type: []}}};
  const threadOnly = channelReadPolicy('C1', false, {...baseline, is_thread_only: true});
  assert.equal(threadOnly.writeAllowedByPolicy, false);
  assert.equal(threadOnly.slack.channelPostAllowedByMetadata, false);
  assert.equal(threadOnly.slack.threadReplyAllowedByMetadata, true);
  const noThreads = channelReadPolicy('C1', true, {...baseline, is_non_threadable: true});
  assert.equal(noThreads.slack.channelPostAllowedByMetadata, true);
  assert.equal(noThreads.slack.threadReplyAllowedByMetadata, false);
  const roles = channelReadPolicy('C1', true, {...baseline, properties: {posting_restricted_to: {type: ['admin']}}});
  assert.equal(roles.slack.postingRestricted, true);
  assert.equal(roles.slack.channelPostAllowedByMetadata, null);
  assert.equal(roles.slack.threadReplyAllowedByMetadata, null);
  for (const flag of ['is_read_only', 'is_archived', 'is_frozen']) {
    const denied = channelReadPolicy('C1', true, {[flag]: true});
    assert.equal(denied.slack.channelPostAllowedByMetadata, false);
    assert.equal(denied.slack.threadReplyAllowedByMetadata, false);
  }
});

test('parent, ordinary reply, broadcast, zero/unknown/malformed counts and stable identities', () => {
  const names = new Map([['U1', 'Ada']]);
  const parent = historyRecord({ts: '1.0', thread_ts: '1.0', user: 'U1', reply_count: 0}, names);
  assert.equal(parent.authorId, 'U1'); assert.equal(parent.author, 'Ada');
  assert.equal(parent.rootTs, '1.0'); assert.equal(parent.rootSource, 'reported'); assert.equal(parent.replyCount, 0);
  assert.equal('threadTs' in parent, false);
  const broadcast = historyRecord({ts: '2.0', root: {thread_ts: '1.0'}, bot_id: 'B1'}, names);
  assert.equal(broadcast.threadTs, '1.0'); assert.equal(broadcast.authorBotId, 'B1'); assert.equal('authorId' in broadcast, false);
  assert.equal(historyRecord({ts: '3.0', root: {ts: '1.0'}}, names).rootTs, '1.0');
  assert.equal(historyRecord({ts: '2.0', thread_ts: '1.0'}, names).rootTs, '1.0');
  for (const reply_count of [undefined, -1, 1.5, NaN]) assert.equal('replyCount' in historyRecord({ts: '1.0', reply_count}, names), false);
  assert.equal(historyRecord({ts: '1.0'}, names).rootSource, 'message');
});

test('bounded integer, filter and timestamp validation fails before Slack calls', async () => {
  const h = fixture(rows);
  for (const [name, minimum, maximum] of [['limit', 1, 1000], ['maxScanned', 1, 10000], ['maxPages', 1, 50], ['maxMs', 100, 30000], ['maxBytes', 2048, 1048576]] as const) {
    for (const value of [minimum - 1, maximum + 1, 1.5, NaN, Infinity, '2', null]) await assert.rejects(h.reader.read('history', 'C1', {[name]: value}), /integer/);
  }
  for (const args of [{authorIds: []}, {authorIds: ['Ada']}, {textContains: ''}, {caseSensitive: 'false'}, {oldest: 'bad'}, {oldest: '2.0', latest: '1.0'}, {regex: 'x'}]) await assert.rejects(h.reader.read('history', 'C1', args));
  assert.equal(h.calls.length, 0);
  assert.throws(() => readOptions({authorIds: ['U1']}, 'thread'), /Unknown/);
});

test('has_more timestamp fallback and empty/repeated cursors never loop without a budget', async () => {
  let calls = 0;
  const reader = new BoundedHistoryReader(async (method, args) => {
    if (method === 'conversations.info') return {channel: {id: 'C1'}};
    calls++;
    return calls === 1 ? {messages: [{ts: '2.0'}], has_more: true} : {messages: [{ts: '1.0'}]};
  }, () => true, new Map(), false);
  const result = await reader.read('history', 'C1', {});
  assert.deepEqual(result.messages.map(m => m.id), ['1.0', '2.0']);
  assert.equal(calls, 2);
  const empty = new BoundedHistoryReader(async method => method === 'conversations.info' ? {channel: {id: 'C1'}} :
    {messages: [], response_metadata: {next_cursor: 'repeated'}}, () => true, new Map(), false);
  assert.equal((await empty.read('history', 'C1', {})).pagination.stopReason, 'pagination_stalled');
});

test('rate limits return partial status without retrying', async () => {
  let calls = 0;
  const reader = new BoundedHistoryReader(async () => {calls++; throw {code: 'slack_webapi_rate_limited_error', retryAfter: 60};}, () => true, new Map(), false);
  const result = await reader.read('history', 'C1', {});
  assert.equal(result.pagination.stopReason, 'rate_limited');
  assert.equal(result.pagination.retryAfterSeconds, 60);
  assert.equal(result.pagination.scanComplete, false);
  assert.equal(calls, 1);
});

test('continuation composes scan, match and page budgets without gaps across sparse results', async () => {
  for (const limit of [1, 2, 7]) for (const maxScanned of [1, 3, 10]) for (const maxPages of [1, 2]) {
    const h = fixture(rows, 2);
    const args = {limit, maxScanned, maxPages, textContains: 'target'};
    const ids: string[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let call = 0; call < 10; call++) {
      const out = await h.reader.read('history', 'C1', {...args, ...(cursor ? {cursor} : {})});
      ids.unshift(...out.messages.map(m => m.id));
      assert.ok(out.pagination.scanned <= maxScanned);
      assert.ok(out.pagination.pages <= maxPages);
      assert.ok(out.messages.length <= limit);
      cursor = out.pagination.nextCursor;
      if (out.pagination.scanComplete) {complete = true; break;}
    }
    assert.equal(complete, true);
    assert.deepEqual(ids, ['1.0', '7.0']);
  }
});
