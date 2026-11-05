import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { SlackAdapter, OutOfCallTime, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackAccessPolicy, HISTORY_MEMBERSHIP_PROOF } from '../src/access-policy.js';
import { explainSlackError } from '../src/slack-errors.js';

const PIN = 'CPINNED', OWNER = 'UOWNER';
const scopes = ['channels:history', 'chat:write', 'im:read', 'im:history', 'im:write', 'users:read', 'reactions:write'];
function fixture(options: { scopes?: string[]; dmUsers?: string[]; fallback?: string[]; writeChannels?: string[]; pages?: number } = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  const granted = [...(options.scopes ?? scopes)];
  let history: any = { ok: true, messages: [] }, failure: Error | undefined, failChannel: string | undefined;
  let info: any = { id: 'D1', is_im: true, user: OWNER };
  let listed: any[] = [];
  let handler: any; let adapter: SlackAdapter;
  const record = (method: string, result = {}) => async (args: any) => { calls.push({ method, args }); return result; };
  const web = {
    conversations: {
      history: async (args: any) => {
        calls.push({ method: 'history', args });
        if (failure && (!failChannel || args.channel === failChannel)) throw failure;
        return history;
      },
      info: async (args: any) => { calls.push({ method: 'info', args }); return { channel: info }; },
      list: async (args: any) => { calls.push({ method: 'list', args }); return { channels: listed }; },
      replies: record('replies', { messages: [] }), open: record('open', { channel: { id: 'D1' } }),
    },
    chat: { postMessage: record('post', { ts: '1.0' }), update: record('edit'), delete: record('delete') },
    reactions: { add: record('reaction'), remove: record('remove') },
    users: { info: record('userInfo', { user: { name: 'owner' } }), list: record('users', { members: [{ id: OWNER, name: 'owner' }] }) },
    files: { info: record('fileInfo', { file: { id: 'F1' } }), delete: record('fileDelete'),
      getUploadURLExternal: record('upload', { file_id: 'F1' }), completeUploadExternal: record('uploadComplete', { files: [{ id: 'F1' }] }) },
    assistant: { threads: { setStatus: record('status') } },
  } as any;
  const policy = new SlackAccessPolicy({ writeChannels: options.writeChannels ?? [PIN], dmUsers: options.dmUsers ?? [], readJoinedChannels: true,
    historyMembershipFallbackChannels: options.fallback ?? [PIN] });
  adapter = new SlackAdapter(web, { on(_event, callback) { handler = callback; }, async start() {}, async disconnect() {} }, 'UBOT', 'workspace', undefined, undefined, false, 'eyes', granted, policy, { conversations: options.pages ?? 1000 });
  return { adapter, web: web as SlackWebLike, calls, granted,
    fail(error?: Error, channel?: string) { failure = error; failChannel = channel; }, history(value: any) { history = value; }, info(value: any) { info = value; }, list(value: any[]) { listed = value; },
    async emit() { handler({ event: { type: 'message', channel: PIN, channel_type: 'channel', user: OWNER, ts: '1.0', text: '<@UBOT> hi' }, ack: async () => {} }); await Promise.all((adapter as any).inbound.values()); },
  };
}

test('pinned metadata and writes use fresh bot history without info or listing scope calls', async () => {
  const h = fixture();
  assert.deepEqual(await h.adapter.getConversationMeta(PIN), { id: PIN, kind: 'channel', name: PIN, topic: undefined, isMember: true, numMembers: undefined });
  await h.adapter.sendMessage(PIN, 'hello');
  await h.adapter.editMessage(PIN, '1.0', 'edit');
  await h.adapter.deleteMessage(PIN, '1.0');
  await h.adapter.addReaction(PIN, '1.0', 'eyes');
  assert.equal(h.adapter.canWrite(PIN), true);
  assert.equal(h.calls.filter((call) => call.method === 'history').length, 5);
  assert.ok(h.calls.filter((call) => call.method === 'history').every((call) => call.args.channel === PIN && call.args.limit === 1));
  assert.equal(h.calls.filter((call) => ['info', 'list'].includes(call.method)).length, 0);
  assert.deepEqual(h.granted, scopes);
  assert.equal((h.adapter as any).scopes.includes('channels:read'), false);
});

test('only pinned metadata is listed when no metadata listing scopes are available', async () => {
  const h = fixture({ scopes: ['channels:history', 'chat:write'] });
  assert.deepEqual((await h.adapter.listConversations(true)).conversations.map((item) => item.id), [PIN]);
  assert.deepEqual(h.calls.map((call) => call.method), ['history']);
});

test('a pinned channel whose proof fails is left out, and the others are still listed', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: ['channels:history', 'chat:write'], writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  h.fail(new Error('An API error occurred: not_in_channel'), 'CSTALE');
  assert.deepEqual((await h.adapter.listConversations(true)).conversations.map((item) => item.id), [PIN]);
  assert.deepEqual(h.calls.map((call) => `${call.method}:${call.args.channel}`), ['history:CSTALE', `history:${PIN}`]);
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /Access admission denied.*listing/);
  // Still fail-closed: the stale pin is not readable or writable meanwhile.
  await assert.rejects(h.adapter.getConversationMeta('CSTALE'), /not_in_channel/);
});

test('allowed DM listing remains separate and never requests public/private types without their scopes', async () => {
  const h = fixture({ dmUsers: [OWNER] }); h.list([{ id: 'D1', is_im: true, user: OWNER }]);
  assert.deepEqual((await h.adapter.listConversations(true)).conversations.map((item) => item.id), [PIN, 'D1']);
  assert.equal(h.calls.find((call) => call.method === 'list')?.args.types, 'im');
  await h.adapter.sendDM(OWNER, 'hello');
  assert.equal(h.calls.filter((call) => call.method === 'open').length, 1);
});

for (const error of ['not_in_channel', 'missing_scope', 'ratelimited', 'network failure']) {
  test(`fresh membership refusal fails future reads and writes closed: ${error}`, async () => {
    const h = fixture(); await h.adapter.sendMessage(PIN, 'before removal');
    h.fail(new Error(error));
    await assert.rejects(h.adapter.getConversationMeta(PIN), new RegExp(error));
    await assert.rejects(h.adapter.sendMessage(PIN, 'after removal'), new RegExp(error));
    assert.equal(h.calls.filter((call) => call.method === 'post').length, 1);
    assert.equal(h.calls.filter((call) => call.method === 'info').length, 0);
  });
}

for (const response of [{}, { ok: false, messages: [] }, { ok: 'true', messages: [] }, { ok: null }]) {
  test(`malformed or unsuccessful history is never membership proof: ${JSON.stringify(response)}`, async () => {
    const h = fixture(); h.history(response);
    await assert.rejects(h.adapter.sendMessage(PIN, 'hello'), /freshly confirm/);
    assert.equal(h.calls.filter((call) => call.method === 'post').length, 0);
  });
}

test('affirmative history success proves membership without inspecting message content', async () => {
  const h = fixture(); h.history({ ok: true, messages: [] });
  await h.adapter.getConversationMeta(PIN);
  assert.deepEqual(h.calls.map((call) => call.method), ['history']);
});

test('other public IDs, private channels and DMs cannot borrow the pinned proof', async () => {
  const h = fixture();
  for (const id of ['COTHER', 'GPRIVATE', 'D1']) {
    h.info({ id, is_im: id === 'D1', is_mpim: false, is_private: id === 'GPRIVATE', is_member: true, user: 'UOTHER' });
    await assert.rejects(h.adapter.getConversationMeta(id));
  }
  assert.equal(h.calls.filter((call) => call.method === 'history').length, 0);
});

test('fallback configuration is restricted to explicit public write pins', () => {
  for (const fallback of [['COTHER'], ['GPRIVATE'], ['D1'], ['UOWNER']]) {
    assert.throws(() => new SlackAccessPolicy({ writeChannels: [PIN, 'GPRIVATE'], dmUsers: [], readJoinedChannels: true, historyMembershipFallbackChannels: fallback }), /pinned public write channels/);
  }
});

test('JSON cannot forge proof and private/DM metadata cannot use the symbol', () => {
  const policy = new SlackAccessPolicy({ writeChannels: [PIN], dmUsers: [], readJoinedChannels: true, historyMembershipFallbackChannels: [PIN] });
  const proven = { id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true as const };
  assert.equal(policy.requireReadable(PIN, proven, scopes), 'channel');
  const json = JSON.parse(JSON.stringify({ ...proven, HISTORY_MEMBERSHIP_PROOF: true, 'Slack bot history membership': true }));
  assert.throws(() => policy.requireReadable(PIN, json, scopes), /channels:read/);
  assert.throws(() => policy.requireReadable(PIN, { ...proven, is_private: true }, scopes), /groups:read/);
  assert.throws(() => policy.requireReadable('D1', { ...proven, id: 'D1', is_im: true, user: 'UOTHER' }, scopes), /not allowed/);
});

test('normal metadata scope path never uses fallback, even after info refusal', async () => {
  const h = fixture({ scopes: [...scopes, 'channels:read'] });
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true });
  await h.adapter.sendMessage(PIN, 'hello');
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: false });
  await assert.rejects(h.adapter.sendMessage(PIN, 'no longer a member'), /not a confirmed joined/);
  assert.equal(h.calls.filter((call) => call.method === 'history').length, 0);
});

test('fallback needs channels:history and does not invent file or directory scopes', async () => {
  const h = fixture({ scopes: ['chat:write'] });
  await assert.rejects(h.adapter.getConversationMeta(PIN), /channels:history/);
  await assert.rejects(h.adapter.resolveFileDownload(PIN, 'F1'), /files:read/);
  await assert.rejects(h.adapter.findUsers('owner'), /users:read/);
  assert.equal(h.calls.length, 0);
  const readable = fixture();
  await assert.rejects(readable.adapter.uploadFile(PIN, { filename: 'x', data: Buffer.from('x') }), /files:write/);
  await assert.rejects(readable.adapter.deleteFile(PIN, 'F1'), /files:write/);
  assert.equal(readable.calls.filter((call) => ['upload', 'fileDelete'].includes(call.method)).length, 0);
  const found = await readable.adapter.findUsers('owner');
  assert.ok(Array.isArray(found));
  assert.deepEqual(found.map((user) => user.userId), [OWNER]);
});

test('incoming, ACK and status also recheck the pinned membership proof', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); let received = 0; h.adapter.onMessage(() => received++);
  await h.emit(); await h.adapter.acknowledge(PIN, '1.0'); await h.adapter.setThreadStatus(PIN, '1.0');
  assert.equal(received, 1);
  h.fail(new Error('not_in_channel'));
  await h.emit(); await h.adapter.acknowledge(PIN, '2.0'); await h.adapter.clearAck(PIN); await h.adapter.setThreadStatus(PIN, '2.0');
  assert.equal(received, 1);
  assert.equal(h.calls.filter((call) => call.method === 'reaction').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'status').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'remove').length, 0);
  await h.adapter.stop();
});

const rateLimit = () => Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 1 });
const terminal = () => Object.assign(new Error('not_in_channel'), { code: ErrorCode.PlatformError, data: { error: 'not_in_channel' } });
for (const error of [rateLimit(), new OutOfCallTime('conversations.history', 30),
  Object.assign(new Error('offline'), { code: ErrorCode.RequestError }),
  Object.assign(new Error('ratelimited'), { code: ErrorCode.PlatformError, data: { error: 'ratelimited' } })]) {
  test(`pinned listing propagates transient/deadline errors rather than hiding them: ${error.message}`, async () => {
    const h = fixture(); h.fail(error);
    await assert.rejects(h.adapter.listConversations(), e => e === error);
    assert.deepEqual(h.calls.map(c => c.method), ['history']);
  });
}

test('pinned proofs retry per candidate, outside the successful listing page budget', async () => {
  const h = fixture({ scopes: [...scopes, 'groups:read'], fallback: ['C1', 'C2'], writeChannels: ['C1', 'C2'], pages: 1 });
  const attempts = new Map<string, number>();
  h.web.conversations.history = async args => {
    const id = String(args.channel), n = (attempts.get(id) ?? 0) + 1; attempts.set(id, n);
    assert.ok(n <= 5, 'proof retry ceiling');
    if (n < 5) throw rateLimit();
    return { ok: true, messages: [] };
  };
  h.web.conversations.list = async () => ({ channels: [], response_metadata: { next_cursor: 'more' } });
  const waits: number[] = [];
  const out = await h.adapter.listConversations(false, async (why, n) => { assert.equal(why.method, 'conversations.history'); waits.push(n); });
  assert.deepEqual(waits, [1, 2, 3, 4, 1, 2, 3, 4]);
  assert.deepEqual(out.conversations.map(c => c.id), ['C1', 'C2']);
  assert.deepEqual(out.truncation, { reason: 'page_limit', pages: 1, limit: 1 });
});

test('exhausted proof retries and waiter give-up are never swallowed', async () => {
  const h = fixture(); h.fail(rateLimit());
  const waits: number[] = [];
  await assert.rejects(h.adapter.listConversations(false, async (_, n) => { waits.push(n); }), /limited/);
  assert.deepEqual(waits, [1, 2, 3, 4]);
  assert.equal(h.calls.length, 5);
  const giveUp = new Error('waiter stopped');
  await assert.rejects(h.adapter.listConversations(false, async () => { throw giveUp; }), e => e === giveUp);
});

test('stale proof isolates only its pin, preserving ordinary conversations', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: [...scopes, 'im:read'], dmUsers: [OWNER], writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  h.fail(terminal(), 'CSTALE'); h.list([{ id: 'D1', is_im: true, user: OWNER }]);
  assert.deepEqual((await h.adapter.listConversations()).conversations.map(c => c.id), [PIN, 'D1']);
  await assert.rejects(h.adapter.readHistory('CSTALE', {}), /not_in_channel/);
  await assert.rejects(h.adapter.sendMessage('CSTALE', 'denied'), /not_in_channel/);
  assert.ok(!h.calls.some(c => c.method === 'post'));
});

for (const joined of [false, true]) test(`scope restart rechecks history pins with normal metadata: joined=${joined}`, async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: [...scopes, 'groups:read'], pages: 2 }); let pages = 0;
  h.info({ id: PIN, name: 'metadata-name', is_im: false, is_mpim: false, is_private: false, is_member: joined });
  h.web.conversations.list = async () => {
    assert.ok(++pages <= 2, 'listing ceiling');
    return { channels: [{ id: PIN, is_member: true }], response_metadata: { scopes: ['channels:read'], next_cursor: String(pages) } };
  };
  const out = await h.adapter.listConversations();
  assert.deepEqual(out.conversations.map(c => [c.id, c.name]), joined ? [[PIN, 'metadata-name']] : []);
  assert.deepEqual(out.truncation, { reason: 'page_limit', pages: 2, limit: 2 });
  assert.deepEqual(h.calls.map(c => c.method), ['history', 'info']);
});

test('unset fallback and unknown scopes never make history proof requests', async () => {
  for (const options of [{ fallback: [] }, { scopes: [] }]) {
    const h = fixture(options);
    await assert.rejects(h.adapter.getConversationMeta(PIN));
    assert.ok(!h.calls.some(c => c.method === 'history'));
  }
});


test('metadata API refusal with channels:read cannot activate pinned history fallback', async () => {
  const h = fixture({ scopes: [...scopes, 'channels:read'] });
  h.web.conversations.info = async () => { throw terminal(); };
  await assert.rejects(h.adapter.readHistory(PIN, {}), /not_in_channel/);
  assert.ok(!h.calls.some(c => c.method === 'history'));
});

for (const joined of [false, true]) test(`in-flight proof yields to newly learned metadata scope: joined=${joined}`, async () => {
  const h = fixture();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.web.conversations.history = async () => { entered(); await paused; return { ok: true, messages: [] }; };
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: joined });
  const posting = h.adapter.sendMessage(PIN, 'after scope grant');
  await started;
  (h.adapter as any).takeScopes(['channels:read']);
  release();
  if (joined) await posting;
  else await assert.rejects(posting, /not a confirmed joined/);
  assert.deepEqual(h.calls.map(c => c.method), joined ? ['info', 'post'] : ['info']);
});

test('synthetic proof cannot pass the pure gate once normal metadata scope is known', () => {
  const policy = new SlackAccessPolicy({ writeChannels: [PIN], dmUsers: [], readJoinedChannels: true, historyMembershipFallbackChannels: [PIN] });
  const proof = { id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true as const };
  assert.throws(() => policy.requireReadable(PIN, proof, [...scopes, 'channels:read']), /fresh.*metadata/);
});

test('failed history admission is pre-write, without reclassifying an actual post failure', async () => {
  const h = fixture();
  const failure = Object.assign(new Error('timeout'), { code: ErrorCode.RequestError, original: { code: 'ETIMEDOUT' } });
  const call = { tool: 'send_message', args: { channelId: PIN } };
  // An unmarked error keeps the #61 uncertain-write interpretation.
  assert.match(explainSlackError(failure, call), /whether the message was posted is unknown/);
  h.fail(failure);
  await assert.rejects(h.adapter.sendMessage(PIN, 'not attempted'), e => e === failure);
  const explanation = explainSlackError(failure, call);
  assert.match(explanation, /Nothing was posted/);
  assert.doesNotMatch(explanation, /whether the message was posted is unknown|Check fetch_history/);
  assert.equal(h.calls.some(c => c.method === 'post'), false);
  h.fail();
  const postFailure = Object.assign(new Error('post timeout'), { code: ErrorCode.RequestError });
  h.web.chat.postMessage = async () => { throw postFailure; };
  await assert.rejects(h.adapter.sendMessage(PIN, 'attempted'), e => e === postFailure);
  assert.match(explainSlackError(postFailure, call), /whether the message was posted is unknown/);
});
