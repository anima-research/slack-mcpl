import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAccessPolicy } from '../src/access-policy.js';
import { SlackAdapter, SlackWebClient, SLACK_CLIENT_OPTIONS, OutOfCallTime, type SlackWebLike } from '../src/slack-adapter.js';
import { ErrorCode } from '@slack/web-api';
import { fakeSlackApi } from './slackApi.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize } from './harness.js';

function fixture(options: {scopes?: string[]; dmUsers?: string[]; disableDms?: boolean; fallback?: boolean; backscrollPages?: number} = {}) {
  const calls: Array<{method: string; args: any}> = [];
  let joined = true, metadataError: unknown;
  const web = {conversations: {
    async info(args: any) {
      calls.push({method: 'info', args});
      if (metadataError) throw metadataError;
      return {channel: args.channel === 'D1' ? {id: 'D1', is_im: true, is_mpim: false, user: 'UALLOWED'} :
        {id: args.channel, is_im: false, is_mpim: false, is_private: false, is_member: joined}};
    },
    async history(args: any) {
      calls.push({method: 'history', args});
      if (!joined) throw new Error('not_in_channel');
      // A pinned channel's membership proof asks for one message; a page of
      // a read may too, so only the proof is answered with none.
      return options.fallback && args.limit === 1 ? {ok: true, messages: []} : {ok: true, messages: [
        {ts: '2.0', user: 'U1', text: 'second', files: [{id: 'FVALID', mode: 'hosted', name: 'a.txt', url_private: 'https://files.slack.com/untrusted'}]},
        {ts: '1.0', user: 'U1', text: 'first'},
      ].filter(row => !args.latest || Number(row.ts) < Number(args.latest))};
    },
    async replies(args: any) {calls.push({method: 'replies', args});return {messages: [{ts: '1.0', thread_ts: '1.0', reply_count: 0}]};},
  }} as any;
  const adapter = new SlackAdapter(web, {on() {}, async start() {}, async disconnect() {}} as any,
    'UBOT', 'fixture', undefined, undefined, options.disableDms ?? false, undefined,
    options.scopes ?? ['channels:read', 'channels:history', 'im:read', 'im:history', 'files:read'],
    new SlackAccessPolicy({readJoinedChannels: true, writeChannels: ['C1'], dmUsers: options.dmUsers ?? [],
    ...(options.fallback ? {historyMembershipFallbackChannels: ['C1']} : {})}),
    { backscroll: options.backscrollPages ?? 100 });
  return {adapter, web: web as SlackWebLike, calls, revoke() {joined = false;}, failMetadata(error: unknown) {metadataError = error;}};
}

test('bounded continuation and thread reads reapply explicit membership and scope policy', async () => {
  const h = fixture();
  const first = await h.adapter.readHistory('C1', {limit: 1});
  assert.equal(first.channel.id, 'C1');
  assert.match(first.messages[0]!.attachments![0]!, /fetch_attachment\(\{"channelId":"C1","fileId":"FVALID"\}\)/);
  assert.doesNotMatch(first.messages[0]!.attachments![0]!, /untrusted/);
  const oldDataCalls = h.calls.filter(call => call.method !== 'info').length;
  h.revoke();
  await assert.rejects(h.adapter.readHistory('C1', {limit: 1, cursor: first.pagination.nextCursor}), /not a confirmed joined channel/);
  await assert.rejects(h.adapter.readThread('C1', '1.0', {}), /not a confirmed joined channel/);
  assert.equal(h.calls.filter(call => call.method !== 'info').length, oldDataCalls);
  const missing = fixture({scopes: ['channels:read']});
  await assert.rejects(missing.adapter.readHistory('C1', {}), /channels:history/);
  assert.equal(missing.calls.filter(call => call.method === 'history').length, 0);
});

test('explicit-policy metadata errors never enter legacy optional-metadata fallback', async () => {
  const h = fixture(); h.failMetadata({code: 'slack_webapi_platform_error', data: {error: 'missing_scope'}});
  await assert.rejects(h.adapter.readHistory('C1', {}), error => (error as any).data.error === 'missing_scope');
  assert.deepEqual(h.calls.map(call => call.method), ['info']);
});

test('bounded DM reads preserve the explicit policy precedence over legacy switches', async () => {
  const denied = fixture();
  await assert.rejects(denied.adapter.readHistory('D1', {}), /not allowed/);
  await assert.rejects(denied.adapter.readThread('D1', '1.0', {}), /not allowed/);
  assert.equal(denied.calls.some(call => call.method !== 'info'), false);
  const allowed = fixture({dmUsers: ['UALLOWED'], disableDms: true});
  assert.equal((await allowed.adapter.readThread('D1', '1.0', {})).messages.length, 1);
});

test('a pinned channel\'s membership proof is a request made afresh before each read, not one of its pages', async () => {
  const h = fixture({scopes: ['channels:history'], fallback: true});
  const read = await h.adapter.readHistory('C1', {});
  assert.equal(read.pagination.pages, 1, 'the proof is not a page');
  assert.equal(read.messages.length, 2);
  assert.equal(read.pagination.scanComplete, true);
  assert.deepEqual(h.calls.map(call => `${call.method}:${call.args.limit}`), ['history:1', 'history:50'], 'the proof, then the page; no info');
  h.revoke();
  await assert.rejects(h.adapter.readHistory('C1', {}), /not_in_channel/);
  assert.equal(h.calls.length, 3, 'the proof is made again, and nothing is read after it fails');
});

// Exercise the actual client and JSON-RPC tool path, not just a policy unit.
test('loopback client and real tool dispatch admit fresh pinned reads and refuse after revocation', async t => {
  t.mock.method(console, 'error', () => {});
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('conversations.history', { body: sent => ({ ok: true, messages: sent.get('limit') === '1'
    ? [] : [{ ts: '2.0', text: 'admitted' }] }) });
  const client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  const policy = new SlackAccessPolicy({ readJoinedChannels: true, writeChannels: ['C1'], dmUsers: [], historyMembershipFallbackChannels: ['C1'] });
  const adapter = new SlackAdapter(client as unknown as SlackWebLike, { on() {}, async start() {}, async disconnect() {} },
    'UBOT', 'test', undefined, undefined, false, undefined, ['channels:history'], policy);
  const h = connectHost(new SlackMcplServer(adapter)); t.after(() => h.close());
  await initialize(h, false);
  const call = () => h.host.sendRequest('tools/call', { name: 'fetch_history', arguments: { channelId: 'C1' } }) as Promise<{
    isError?: boolean; content: Array<{ text: string }>;
  }>;
  const first = await call(); assert.notEqual(first.isError, true);
  assert.equal(JSON.parse(first.content[0].text).messages[0].content, 'admitted');
  assert.deepEqual(api.calls, ['conversations.history', 'conversations.history']);
  assert.deepEqual(api.sent.map(p => p.get('limit')), ['1', '50']);
  api.answerFor('conversations.history', { body: { ok: false, error: 'not_in_channel' } });
  const denied = await call(); assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not_in_channel/);
  assert.equal(api.calls.length, 3, 'revoked proof never proceeds to a data page');
});

for (const failure of [Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 45 }),
  new OutOfCallTime('conversations.history', 30)]) {
  test(`pinned read preserves partial-result semantics after successful proof: ${failure.message}`, async () => {
    const h = fixture({ scopes: ['channels:history'], fallback: true });
    let calls = 0;
    // No user lookup or clock is needed; the first request is authorization,
    // the second scans data, and only the next data page fails.
    h.web.conversations.history = async () => {
      if (++calls === 1) return { ok: true, messages: [] };
      if (calls === 2) return { ok: true, messages: [{ ts: '2.0', text: 'kept' }], has_more: true };
      throw failure;
    };
    const read = await h.adapter.readHistory('C1', {});
    assert.deepEqual(read.messages.map(m => m.id), ['2.0']);
    assert.equal(read.pagination.pages, 1);
    assert.equal(read.pagination.scanComplete, false);
    assert.equal(read.pagination.stopReason, failure instanceof OutOfCallTime ? 'time_limit' : 'rate_limited');
    assert.ok(read.pagination.nextCursor);
    assert.equal(calls, 3);
  });
}


test('pinned thread and backscroll recheck proof, outside the backscroll page cap', async () => {
  const h = fixture({ scopes: ['channels:history'], fallback: true, backscrollPages: 1 });
  const thread = await h.adapter.readThread('C1', '1.0', {});
  assert.equal(thread.pagination.pages, 1);
  assert.deepEqual(h.calls.map(c => c.method), ['history', 'replies']);
  h.calls.length = 0;
  h.web.conversations.history = async args => {
    h.calls.push({ method: 'history', args });
    return { ok: true, messages: [], response_metadata: args.limit === 1 ? {} : { next_cursor: 'more' } };
  };
  assert.deepEqual(await h.adapter.fetchHistory('C1'), { messages: [], truncated: true });
  assert.deepEqual(h.calls.map(c => c.args.limit), [1, 50]);
  // Restore the fixture's live membership behavior for the revocation check.
  h.web.conversations.history = async args => { h.calls.push({ method: 'history', args }); throw new Error('not_in_channel'); };
  await assert.rejects(h.adapter.readThread('C1', '1.0', {}), /not_in_channel/);
  assert.ok(!h.calls.some(c => c.method === 'replies'));
});
