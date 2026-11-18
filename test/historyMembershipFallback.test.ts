import nodeTest, { type TestContext } from 'node:test';
import { virtualClock } from './virtualClock.js';
const virtuals = new WeakMap<TestContext, ReturnType<typeof virtualClock>>();
const test = (name: string, run: (t: TestContext) => unknown) => nodeTest(name, async t => { virtuals.set(t, virtualClock(t)); await run(t); });
import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { SlackAdapter, OutOfCallTime, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackAccessDenied, SlackAccessPolicy, SlackScopeEvidenceError, HISTORY_MEMBERSHIP_PROOF } from '../src/access-policy.js';
import { explainSlackError } from '../src/slack-errors.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize } from './harness.js';

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
    auth: { test: record('auth', { response_metadata: { scopes: granted } }) },
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
    async reportScopes(next: string[]) {
      web.users.list = record('scopeRefresh', { members: [], response_metadata: { scopes: next } });
      await adapter.findUsers('grant-refresh');
    },
    fail(error?: Error, channel?: string) { failure = error; failChannel = channel; }, history(value: any) { history = value; }, info(value: any) { info = value; }, list(value: any[]) { listed = value; },
    async emit(channelType: string | undefined = 'channel', text = '<@UBOT> hi', subtype?: string) { handler({ event: { type: 'message', channel: PIN, channel_type: channelType, subtype, user: OWNER, ts: '1.0', text }, ack: async () => {} }); await Promise.all((adapter as any).inbound.values()); },
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
  assert.deepEqual(h.calls.map((call) => call.method), ['auth', 'history']);
});

test('a pinned channel whose proof fails is left out, and the others are still listed', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: ['channels:history', 'chat:write'], writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  h.fail(Object.assign(new Error('An API error occurred: not_in_channel'), { code: ErrorCode.PlatformError, data: { error: 'not_in_channel' } }), 'CSTALE');
  assert.deepEqual((await h.adapter.listConversations(true)).conversations.map((item) => item.id), [PIN]);
  assert.deepEqual(h.calls.filter((call) => call.method !== 'auth').map((call) => `${call.method}:${call.args.channel}`), ['history:CSTALE', `history:${PIN}`]);
  (h.adapter as any).flushAdmissionFailures();
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /verification failed.*listing.*not_in_channel/);
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
    h.fail(error === 'network failure' ? Object.assign(new Error(error), { code: ErrorCode.RequestError }) : Object.assign(new Error(error), { code: ErrorCode.PlatformError, data: { error } }));
    await assert.rejects(h.adapter.getConversationMeta(PIN), new RegExp(error));
    await assert.rejects(h.adapter.sendMessage(PIN, 'after removal'), new RegExp(error));
    assert.equal(h.calls.filter((call) => call.method === 'post').length, 1);
    assert.equal(h.calls.filter((call) => call.method === 'info').length, 0);
  });
}

for (const response of [null, undefined, {}, { ok: false, messages: [] }, { ok: 'true', messages: [] }, { ok: null }]) {
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
    assert.throws(() => new SlackAccessPolicy({ writeChannels: [PIN, 'GPRIVATE'], dmUsers: [], readJoinedChannels: true, historyMembershipFallbackChannels: fallback }), /historyMembershipFallbackChannels\[0\]|pinned public write channels/);
  }
});

test('JSON cannot forge proof and private/DM metadata cannot use the symbol', () => {
  const policy = new SlackAccessPolicy({ writeChannels: [PIN], dmUsers: [], readJoinedChannels: true, historyMembershipFallbackChannels: [PIN] });
  const proven = { id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true as const };
  assert.equal(policy.requireReadable(PIN, proven, scopes), 'channel');
  const json = JSON.parse(JSON.stringify({ ...proven, HISTORY_MEMBERSHIP_PROOF: true, 'Slack bot history membership': true }));
  assert.throws(() => policy.requireReadable(PIN, json, scopes), /channels:read/);
  assert.throws(() => policy.requireReadable(PIN, { ...proven, is_private: true }, scopes), /groups:read/);
  assert.throws(() => policy.requireReadable('D1', { ...proven, id: 'D1', is_im: true, user: 'UOTHER' }, scopes), /not an admitted direct message/);
});

test('normal metadata scope path never uses fallback, even after info refusal', async () => {
  const h = fixture({ scopes: [...scopes, 'channels:read'] });
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true });
  await h.adapter.sendMessage(PIN, 'hello');
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: false });
  await assert.rejects(h.adapter.sendMessage(PIN, 'no longer a member'), /a member can invite it/);
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
  h.fail(terminal());
  await h.emit(); await h.adapter.acknowledge(PIN, '2.0'); await h.adapter.clearAck(PIN); await h.adapter.setThreadStatus(PIN, '2.0');
  h.fail();
  const before = h.calls.length;
  await h.adapter.setThreadStatus(PIN, '3.0');
  assert.deepEqual(h.calls.slice(before).map(c => c.method), ['history', 'status'], 'the old-thread clear is retried but the new start stays latched');
  assert.equal(h.calls.at(-1)?.args.status, '');
  await h.adapter.resetThreadStatuses();
  await h.adapter.setThreadStatus(PIN, '3.0');
  assert.ok(h.calls.length > before, 'reset releases the latch and permits fresh status admission');
  assert.equal(received, 1);
  assert.equal(h.calls.filter((call) => call.method === 'reaction').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'status').length, 3);
  assert.equal(h.calls.filter((call) => call.method === 'remove').length, 0);
  await h.adapter.stop();
});

const rateLimit = () => Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 1 });
const terminal = () => Object.assign(new Error('not_in_channel'), { code: ErrorCode.PlatformError, data: { error: 'not_in_channel' } });
for (const error of [rateLimit(), new OutOfCallTime('conversations.history', 30),
  Object.assign(new Error('offline'), { code: ErrorCode.RequestError }),
  Object.assign(new Error('ratelimited'), { code: ErrorCode.PlatformError, data: { error: 'ratelimited' } })]) {
  test(`pinned listing marks rate limits incomplete and propagates other failures: ${error.message}`, async () => {
    const h = fixture(); h.fail(error);
    if (error.message === 'limited' || error.message === 'ratelimited') {
      const result = await h.adapter.listConversations();
      assert.deepEqual(result.conversations, []);
      assert.equal(result.admissionFailures, 1);
    } else await assert.rejects(h.adapter.listConversations(), e => e instanceof Error && e.cause === error && e.message.startsWith('No conversations were returned: '));
    assert.deepEqual(h.calls.map(c => c.method), ['auth', 'history']);
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

test('exhausted background proof isolates its pin and waiter give-up propagates', async () => {
  const h = fixture({ dmUsers: [OWNER], writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  h.fail(rateLimit(), 'CSTALE'); h.list([{ id: 'D1', is_im: true, user: OWNER }]);
  const waits: number[] = [];
  const result = await h.adapter.listConversations(false, async (wait, n) => { assert.equal(wait.attempts, 5); waits.push(n); });
  assert.deepEqual(result.conversations.map(c => c.id), [PIN, 'D1']);
  assert.equal(result.admissionFailures, 1);
  assert.deepEqual(waits, [1, 2, 3, 4]);
  assert.equal(h.calls.filter((c) => c.method === 'history' && c.args.channel === 'CSTALE').length, 5);
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
  const out = await h.adapter.listConversations(false, async () => {});
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
  await h.reportScopes([...scopes, 'channels:read']);
  release();
  if (joined) await posting;
  else await assert.rejects(posting, /a member can invite it/);
  assert.deepEqual(h.calls.map(c => c.method), joined ? ['scopeRefresh', 'info', 'post'] : ['scopeRefresh', 'info']);
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
  let occurrence: unknown;
  await assert.rejects(h.adapter.sendMessage(PIN, 'not attempted'), e => { occurrence = e; return e instanceof Error && e.cause === failure && e.message.startsWith('Nothing was posted: '); });
  const explanation = explainSlackError(occurrence, call);
  assert.match(explanation, /Nothing was posted/);
  assert.doesNotMatch(explanation, /whether the message was posted is unknown|Check fetch_history/);
  assert.equal(h.calls.some(c => c.method === 'post'), false);
  h.fail();
  const postFailure = failure; // Reuse the same source; only the new post occurrence may carry effect provenance.
  h.web.chat.postMessage = async () => { throw postFailure; };
  await assert.rejects(h.adapter.sendMessage(PIN, 'attempted'), e => { occurrence = e; return e instanceof Error && e.cause === postFailure; });
  assert.match(explainSlackError(occurrence, call), /whether the message was posted is unknown/);
});

// Real concurrent listings: no direct scope mutation. The second listing learns
// a grant while the first is paused in its final page's metadata admission.
for (const pages of [1, 2]) for (const joined of [false, true]) {
  test(`concurrent scope grant invalidates synthetic pins before cursor/page-limit return: pages=${pages}, joined=${joined}`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = fixture({ scopes: ['channels:history', 'groups:read'], pages });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    let lists = 0;
    h.web.conversations.list = async args => {
      h.calls.push({ method: 'list', args });
      assert.ok(++lists <= (pages === 1 ? 2 : 4), 'shared listing page ceiling');
      if (lists === 1) return { channels: [{ id: 'GOTHER', is_member: true }], response_metadata: { next_cursor: 'more' } };
      if (lists === 2) return { channels: [], response_metadata: { scopes: ['channels:history', 'groups:read', 'channels:read'] } };
      // After restarting, the first listing must forget the checked synthetic
      // pin and readmit it through metadata, with no old-type cursor.
      assert.equal(args.cursor, undefined);
      assert.equal(args.types, 'public_channel,private_channel');
      if (lists === 3) return { channels: [], response_metadata: {} };
      return { channels: [{ id: PIN, is_member: true }], response_metadata: { next_cursor: 'new-more' } };
    };
    h.web.conversations.info = async args => {
      h.calls.push({ method: 'info', args });
      if (args.channel === PIN) return { channel: { id: PIN, name: 'metadata-name', is_im: false, is_mpim: false, is_private: false, is_member: joined } };
      entered(); await paused;
      return { channel: { id: 'GOTHER', is_im: false, is_mpim: false, is_private: true, is_member: true } };
    };
    const first = h.adapter.listConversations(false, async () => {});
    await started;
    try { await h.adapter.listConversations(); } finally { release(); }
    const result = await first;
    assert.ok((h.adapter as any).scopes.includes('channels:read'));
    assert.deepEqual(result.conversations.map(c => [c.id, c.name]), pages === 1 ? [['GOTHER', 'GOTHER']] : joined ? [[PIN, 'metadata-name']] : []);
    assert.deepEqual(result.leftOut, []);
    assert.deepEqual(result.truncation, { reason: 'page_limit', pages, limit: pages });
    assert.equal(h.calls.filter(c => c.method === 'info' && c.args.channel === PIN).length, pages === 2 ? 1 : 0);
    assert.equal(lists, pages === 1 ? 2 : 4);
  });
}

test('listing private C metadata overrides seeded pin and denies later fallback', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: [...scopes, 'groups:read', 'groups:history'] });
  h.list([{ id: PIN, is_private: true, is_member: true, name: 'secret' }]);
  assert.deepEqual((await h.adapter.listConversations()).conversations, []);
  assert.ok(logs.mock.calls.some((c) => String(c.arguments[0]).includes('dropping private fallback pin ' + PIN)));
  await assert.rejects(h.adapter.sendMessage(PIN, 'no'), (err: unknown) =>
    err instanceof SlackAccessDenied && /Private fallback pin/.test(err.message));
  assert.deepEqual((await h.adapter.listConversations()).conversations, []);
  assert.equal(h.calls.filter((c) => c.method === 'post').length, 0);
  assert.equal(logs.mock.calls.filter(c => String(c.arguments[0]).includes('dropping private fallback pin')).length, 1);
});

test('proof response teaches channels:read and immediately uses real metadata', async () => {
  const h = fixture();
  h.history({ ok: true, messages: [], response_metadata: { scopes: [...scopes, 'channels:read'] } });
  h.info({ id: PIN, is_private: false, is_member: false });
  await assert.rejects(h.adapter.sendMessage(PIN, 'no'));
  assert.equal(h.calls.filter((c) => c.method === 'info').length, 1);
  assert.equal(h.calls.filter((c) => c.method === 'post').length, 0);
});

test('no-readable-type listing refreshes auth scopes once before admitting pins', async () => {
  const h = fixture({ scopes: ['channels:history', 'chat:write'] });
  h.web.auth = { test: async () => { h.calls.push({ method: 'auth', args: {} }); return { response_metadata: { scopes: ['channels:read', 'channels:history', 'chat:write'] } }; } } as any;
  h.list([{ id: PIN, is_member: true }]);
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true });
  assert.deepEqual((await h.adapter.listConversations()).conversations.map((c) => c.id), [PIN]);
  assert.equal(h.calls.filter((c) => c.method === 'auth').length, 1);
  assert.equal(h.calls.filter((c) => c.method === 'history').length, 0);
});

test('unreadable proof propagates from listing and reports no write', async () => {
  const h = fixture(); h.history({ ok: true, error: 'contradictory', messages: [] });
  await assert.rejects(h.adapter.listConversations());
  try { await h.adapter.sendMessage(PIN, 'no'); assert.fail('must refuse'); }
  catch (err) {
    const message = explainSlackError(err, { tool: 'send_message', args: { channelId: PIN } } as any);
    assert.match(message ?? '', /Nothing was posted/i);
    assert.match(message ?? '', /Try again shortly/);
  }
});

test('removed fallback bot advice requires membership, not public posting scope', async () => {
  const h = fixture();
  h.fail(Object.assign(new Error('not_in_channel'), { code: ErrorCode.PlatformError, data: { error: 'not_in_channel' } }));
  try { await h.adapter.sendMessage(PIN, 'no'); assert.fail('must refuse'); }
  catch (err) {
    const message = explainSlackError(err, { tool: 'send_message', args: { channelId: PIN } } as any);
    assert.match(message ?? '', /Ask someone.*re-invite.*remove/);
    assert.doesNotMatch(message ?? '', /chat:write.public/);
  }
});

test('startup explains fallback pins and missing history scope', (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  fixture({ scopes: ['chat:write'] });
  const text = logs.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(text, /CPINNED requires channels:history \(unavailable; pins denied\)/);
  assert.doesNotMatch(text, /unavailable scopes: channels:read/);
});

test('unreadable proof uses bounded background retry rather than stale-pin omission', async () => {
  const h = fixture(); h.history({ ok: true, messages: null });
  const waits: number[] = [];
  const listing = await h.adapter.listConversations(false, async (wait, attempt) => {
    assert.equal(wait.why, 'failed');
    assert.equal(wait.method, 'conversations.history');
    waits.push(attempt);
    h.history({ ok: true, messages: [] });
  });
  assert.deepEqual(waits, [1]);
  assert.deepEqual(listing.conversations.map((c) => c.id), [PIN]);
});

for (const error of [rateLimit(), Object.assign(new Error('offline'), { code: ErrorCode.RequestError })]) {
  test(`pin scope refresh retries background ${error.message} before admitting pins`, async () => {
    const h = fixture({ scopes: ['channels:history', 'chat:write'] });
    let attempts = 0;
    h.web.auth.test = async () => {
      if (++attempts === 1) throw error;
      return {};
    };
    const waits: unknown[] = [];
    const result = await h.adapter.listConversations(false, async (wait, n) => {
      assert.equal(h.calls.length, 0, 'no proof before scope refresh succeeds');
      waits.push({ ...wait, n });
    });
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [{ method: 'auth.test', seconds: error.message === 'limited' ? 1 : 30,
      why: error.message === 'limited' ? 'limited' : 'failed', attempts: 5, n: 1 }]);
    assert.deepEqual(result.conversations.map(c => c.id), [PIN]);
    assert.deepEqual(h.calls.map(c => c.method), ['history']);
  });

  test(`pin scope refresh propagates foreground ${error.message} without retry`, async () => {
    const h = fixture({ scopes: ['channels:history', 'chat:write'] });
    let attempts = 0;
    h.web.auth.test = async () => { attempts++; throw error; };
    await assert.rejects(h.adapter.listConversations(), e => e instanceof Error && e.message === error.message);
    assert.equal(attempts, 1);
    assert.deepEqual(h.calls, []);
  });
}

test('pin scope refresh bounds retries and propagates waiter cancellation and terminal refusals', async () => {
  const h = fixture({ scopes: ['channels:history', 'chat:write'] });
  let attempts = 0;
  let error = rateLimit();
  h.web.auth.test = async () => { attempts++; throw error; };
  const waits: number[] = [];
  await assert.rejects(h.adapter.listConversations(false, async (_, n) => { waits.push(n); }), e => e instanceof Error && e.message === error.message);
  assert.equal(attempts, 5);
  assert.deepEqual(waits, [1, 2, 3, 4]);
  const cancelled = new Error('registration superseded');
  await assert.rejects(h.adapter.listConversations(false, async () => { throw cancelled; }), e => e === cancelled);
  assert.equal(attempts, 6);
  error = Object.assign(new Error('invalid_auth'), { code: ErrorCode.PlatformError, retryAfter: 0, data: { error: 'invalid_auth' } });
  await assert.rejects(h.adapter.listConversations(false, async () => { assert.fail('terminal refusal must not wait'); }), e => e instanceof Error && e.message === error.message);
  assert.equal(attempts, 7);
  assert.deepEqual(h.calls, []);
});

test('unreadable ACK admission leaves no pending reaction or cleanup request', async () => {
  const h = fixture(); h.history({ ok: true, messages: null });
  await h.adapter.acknowledge(PIN, '1.0');
  assert.equal((h.adapter as any).ackPending.size, 0);
  assert.deepEqual(h.calls.map(c => c.method), ['history']);
  h.history({ ok: true, messages: [] });
  await (h.adapter as any).clearAck(PIN);
  assert.deepEqual(h.calls.map(c => c.method), ['history']);
});

test('refused history proof immediately yields to newly learned metadata', async () => {
  const h = fixture();
  h.fail(Object.assign(new Error('not_in_channel'), {
    code: ErrorCode.PlatformError,
    data: { error: 'not_in_channel', response_metadata: { scopes: [...scopes, 'channels:read'] } },
  }));
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true });
  await h.adapter.getConversationMeta(PIN);
  assert.deepEqual(h.calls.map(c => c.method), ['history', 'info']);
});

test('fallback listings distinguish listed pins from other public channels in both tools', async (t) => {
  const { SlackMcplServer } = await import('../src/server.js');
  const { connectHost, initialize, FULL_GRANT, until } = await import('./harness.js');
  const { method } = await import('@animalabs/mcpl-core');
  const h = fixture({ scopes: ['channels:history', 'chat:write'] });
  const server = new SlackMcplServer(h.adapter), host = connectHost(server);
  t.after(() => host.close());
  await initialize(host, true);
  await host.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => (server as any).registering === undefined, 'registration');
  for (const name of ['list_channels', 'refresh_channels']) {
    const response: any = await host.host.sendRequest('tools/call', { name, arguments: {} });
    assert.notEqual(response.isError, true);
    const text = JSON.stringify(response);
    assert.match(text, /other public channels and private channels/);
    assert.doesNotMatch(text, /leaves out public channels/);
    if (name === 'list_channels') assert.match(text, /CPINNED/);
    else assert.equal(JSON.parse(response.content[0].text).visible, 1);
  }
});

for (const retryAfter of [1, 6, 11]) test(`fallback inbound retries retain the 10-second wait budget: ${retryAfter}s`, async (t) => {
  const { slept: waits } = virtuals.get(t)!;
  t.mock.method(Math, 'random', () => 0);
  const h = fixture();
  const error = Object.assign(rateLimit(), { retryAfter });
  h.fail(error);
  await assert.rejects((h.adapter as any).retryEventAdmission(PIN, { addressed: false }), (e: any) => e.code === error.code && e.retryAfter === retryAfter && e.message === 'Nothing was delivered: limited');
  assert.equal(h.calls.filter(c => c.method === 'history').length, retryAfter === 1 ? 3 : retryAfter === 6 ? 2 : 1);
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 10_000);
  assert.deepEqual(waits, retryAfter === 1 ? [1000, 200, 1000, 200] : retryAfter === 6 ? [6000] : []);
});

test('R3-1 private event rejects fallback and later writes without a proof', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture();
  let delivered = 0;
  h.adapter.onMessage(() => { delivered++; });
  await h.emit('group');
  assert.equal(delivered, 0);
  await assert.rejects(h.adapter.sendMessage(PIN, 'no'), SlackAccessDenied);
  assert.equal(h.calls.length, 0);
  await h.adapter.stop();
});

test('R3-5 SDK TypeError is retryable and explains that no write occurred', async () => {
  const h = fixture(), cause = new TypeError('warnings.forEach is not a function');
  h.fail(cause);
  await assert.rejects(h.adapter.listConversations(), e => e instanceof Error && e.cause instanceof TypeError && e.cause.cause === cause);
  try { await h.adapter.sendMessage(PIN, 'no'); assert.fail('must reject'); }
  catch (e) { assert.match(explainSlackError(e, { tool: 'send_message', args: { channelId: PIN } }) ?? '', /Nothing was posted/); }
  const waits: number[] = [];
  const result = await h.adapter.listConversations(false, async (_, n) => { waits.push(n); });
  assert.deepEqual(waits, [1, 2, 3, 4]);
  assert.deepEqual(result.conversations, []);
});

test('N3 unmarked embedder proof error creates no pending ACK', async () => {
  const h = fixture(); h.fail(Object.assign(new Error('unmarked failure'), { code: ErrorCode.RequestError }));
  await h.adapter.acknowledge(PIN, '1.0');
  assert.equal((h.adapter as any).ackPending.size, 0);
});

test('R3-3 concurrent private discovery filters an already seeded listing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: [...scopes, 'groups:read'] });
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let pages = 0;
  h.web.conversations.list = async () => {
    if (++pages === 1) { entered(); await paused; return { channels: [] }; }
    return { channels: [{ id: PIN, is_private: true }] };
  };
  const baseline = h.web.conversations.list;
  h.web.conversations.list = async () => ({ channels: [] });
  assert.deepEqual((await h.adapter.listConversations()).conversations.map(c => c.id), [PIN]);
  h.web.conversations.list = baseline;
  const first = h.adapter.listConversations();
  await started;
  assert.equal(h.calls.filter(c => c.method === 'history').length, 2, 'both listings seeded a proven pin');
  try { await h.adapter.listConversations(); } finally { release(); }
  assert.deepEqual((await first).conversations, []);
});

test('R3-2 registration retains a healthy pin and DM after one pin exhausts', async (t) => {
  const { SlackMcplServer } = await import('../src/server.js');
  const { connectHost, initialize, FULL_GRANT, until } = await import('./harness.js');
  const { method } = await import('@animalabs/mcpl-core');
  const { clock } = await import('../src/clock.js');
  t.mock.method(console, 'error', () => {});
  const h = fixture({ dmUsers: [OWNER], writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  h.fail(rateLimit(), 'CSTALE'); h.list([{ id: 'D1', is_im: true, user: OWNER }]);
  const server = new SlackMcplServer(h.adapter), host = connectHost(server);
  t.after(() => host.close());
  await initialize(host, true);
  await host.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => (server as any).registering === undefined, 'registration');
  const registrations = host.hostSaw.filter(r => r.method === method.CHANNELS_REGISTER);
  assert.equal(registrations.length, 1);
  assert.deepEqual((registrations[0].params as any).channels.map((c: any) => c.id), [`slack:${PIN}`, 'slack:D1']);
  assert.equal(h.calls.filter(c => c.method === 'history' && c.args.channel === 'CSTALE').length, 5);
  assert.deepEqual((server as any).registrationIncomplete, { reason: 'admission_failed', failed: 1 });
  h.fail(undefined);
  const response = await host.host.sendRequest('tools/call', { name: 'refresh_channels', arguments: {} }) as any;
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const refreshed = JSON.parse(response.content[0].text);
  assert.equal(refreshed.registration, undefined, 'healthy refresh clears failed admission despite unreadable types');
  assert.equal((server as any).registrationIncomplete, undefined);
  assert.equal((h.adapter as any).scopes.includes('channels:read'), false);

});

test('R3-2 background deadline isolates its pin', async () => {
  const h = fixture({ writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  h.fail(new OutOfCallTime('conversations.history', 30), 'CSTALE');
  const result = await h.adapter.listConversations(false, async () => {});
  assert.deepEqual(result.conversations.map(c => c.id), [PIN]);
});

test('R3-1 missing event type retains attested fallback admission', async () => {
  const h = fixture();
  // null is not used: an omitted property is the supported legacy event shape.
  const prepared = await (h.adapter as any).prepareMessageEvent({ type: 'message', channel: PIN, user: OWNER, ts: '1.0', text: 'hello' });
  assert.equal(prepared?.channelId, PIN);
  assert.equal(h.calls.filter(c => c.method === 'history').length, 1);
  assert.equal((h.adapter as any).rejectedPrivatePins.size, 0);
  await h.adapter.stop();
});

for (const extra of [{ subtype: 'message_changed' }, { bot_id: 'B1' }, { user: 'UBOT' }]) {
  test(`private evidence survives content filtering: ${JSON.stringify(extra)}`, async t => {
    const logs = t.mock.method(console, 'error', () => {});
    const h = fixture();
    for (let i = 0; i < 3; i++) {
      assert.equal(await (h.adapter as any).prepareMessageEvent({ type: 'message', channel: PIN,
        channel_type: 'group', user: OWNER, ts: '1.0', ...extra }), undefined);
    }
    await assert.rejects(h.adapter.sendMessage(PIN, 'no'), SlackAccessDenied);
    assert.equal(h.calls.length, 0);
    assert.equal(logs.mock.calls.filter(c => String(c.arguments[0]).includes('dropping private fallback pin')).length, 1);
    await h.adapter.stop();
  });
}

test('unclassified proof failures explain the pre-write outcome', async () => {
  const h = fixture(); h.fail(new Error('connection failed'));
  await assert.rejects(h.adapter.sendMessage(PIN, 'no'), err => {
    assert.match(explainSlackError(err, { tool: 'send_message', args: {} }), /Nothing was posted.*no write was attempted/);
    return true;
  });
});

test('transient pre-status proof failure owns no phantom status', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); h.fail(rateLimit());
  await h.adapter.setThreadStatus(PIN, '1.0');
  h.fail();
  await h.adapter.setThreadStatus(PIN, undefined);
  assert.equal(h.calls.filter(c => c.method === 'status').length, 0);
});


test('metadata admission resumes status after a prior fallback admission denial', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); await h.emit('group');
  await h.adapter.setThreadStatus(PIN, '1.0');
  assert.equal(h.calls.length, 0);
  await h.reportScopes([...scopes, 'channels:read', 'groups:read']);
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: true, is_member: true });
  await h.adapter.setThreadStatus(PIN, '2.0');
  assert.equal(h.calls.filter(c => c.method === 'status').length, 1);
  await h.adapter.stop();
});

test('real SDK malformed warnings remain retryable pre-write admission', async t => {
  const { SlackWebClient, SLACK_CLIENT_OPTIONS } = await import('../src/slack-adapter.js');
  const { fakeSlackApi } = await import('./slackApi.js');
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('conversations.history', { body: { ok: true, messages: [], response_metadata: { warnings: 42 } } });
  const h = fixture();
  const client = new SlackWebClient('test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  h.web.conversations.history = args => client.conversations.history(args as any) as any;
  await assert.rejects(h.adapter.sendMessage(PIN, 'no'), err => {
    assert.match(explainSlackError(err, { tool: 'send_message', args: {} }), /Nothing was posted.*Try again shortly/s);
    return true;
  });
  assert.equal(api.calls.length, 1);
  assert.equal(h.calls.some(c => c.method === 'post'), false);
});

for (const scopesChange of [false, true]) test(`page-wide private evidence precedes candidate work: scopeChange=${scopesChange}`, async t => {
  t.mock.method(console, 'error', () => {});
  const grants = [...scopes.filter(s => s !== 'im:read'), 'groups:read'];
  const h = fixture({ scopes: grants, pages: 1, dmUsers: [OWNER] });
  h.web.conversations.list = async () => ({ channels: [{ id: 'GOTHER', is_member: true }, { id: PIN, is_private: true }],
    response_metadata: { next_cursor: 'next', ...(scopesChange ? { scopes: [...grants, 'im:read'] } : {}) } });
  h.web.conversations.info = async () => { throw rateLimit(); };
  const result = await h.adapter.listConversations();
  assert.equal(result.admissionFailures, 1);
  const before = h.calls.length;
  await assert.rejects(h.adapter.sendMessage(PIN, 'no'), /Private fallback pin/);
  assert.equal(h.calls.length, before);
});

for (const error of ['invalid_auth', 'missing_scope', 'unmarked']) test(`unverified pin cannot silently disappear in a foreground scan: ${error}`, async () => {
  const h = fixture();
  const failure = error === 'unmarked' ? new Error('unmarked') : Object.assign(new Error(error), { code: ErrorCode.PlatformError, data: { error } });
  h.fail(failure);
  await assert.rejects(h.adapter.listConversations(), e => e instanceof Error && e.cause === failure && e.message.startsWith('No conversations were returned: '));
});

test('real status-effect refusal survives a metadata scope grant', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); let effects = 0;
  h.web.assistant!.threads.setStatus = async () => { effects++; throw Object.assign(new Error('refused'), { code: ErrorCode.PlatformError, data: { error: 'not_allowed_token_type' } }); };
  await h.adapter.setThreadStatus(PIN, '1.0');
  assert.equal((h.adapter as any).statusRefused.has(PIN), true);
  await h.reportScopes([...scopes, 'channels:read']);
  await h.adapter.setThreadStatus(PIN, '2.0');
  assert.equal(effects, 1);
});

test('a failed held proof defers to independently learned metadata grants', async () => {
  const h = fixture(); let entered!: () => void, reject!: (err: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.web.conversations.history = async () => { entered(); return new Promise((_resolve, fail) => { reject = fail; }); };
  const sending = h.adapter.sendMessage(PIN, 'yes');
  await started;
  await h.reportScopes([...scopes, 'channels:read']);
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true });
  reject(new Error('old proof failed'));
  await sending;
  assert.equal(h.calls.filter(c => c.method === 'info').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'post').length, 1);
});

test('private discovery logs once per distinct pin, including filtered events', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const h = fixture({ fallback: ['CONE', 'CTWO'], writeChannels: ['CONE', 'CTWO'] });
  for (const channel of ['CONE', 'CTWO', 'CONE', 'CTWO']) {
    await (h.adapter as any).prepareMessageEvent({ type: 'message', channel, channel_type: 'group', bot_id: 'B1', user: OWNER, ts: '1.0' });
  }
  assert.equal(log.mock.calls.filter(c => String(c.arguments[0]).includes('dropping private fallback pin')).length, 2);
  assert.equal((h.adapter as any).admissionFailures.size, 0, 'filtered bot messages are not delivery losses');
  assert.equal(h.calls.length, 0);
});

for (const failure of ['rate', 'malformed'] as const) test(`post-byte fallback ${failure} retains its file for rollback`, async t => {
  const { SlackMcplServer } = await import('../src/server.js');
  const { connectHost, initialize, FULL_GRANT, until } = await import('./harness.js');
  const { method } = await import('@animalabs/mcpl-core');
  const h = fixture({ scopes: [...scopes, 'files:read', 'files:write'] });
  const server = new SlackMcplServer(h.adapter), host = connectHost(server); t.after(() => host.close());
  await initialize(host, true);
  await host.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => (server as any).registering === undefined, 'registration');
  const before = await host.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: PIN, content: 'checkpoint' } }) as any;
  h.web.files.getUploadURLExternal = async () => ({ file_id: 'F1', upload_url: 'https://files.slack.com/upload' });
  let bytes = 0;
  t.mock.method(globalThis, 'fetch', async () => { bytes++; if (failure === 'rate') h.fail(rateLimit()); else h.history(null); return new Response('OK'); });
  const result = await host.host.sendRequest('tools/call', { name: 'upload_file', arguments: { channelId: PIN, filename: 'x', content: 'x' } }) as any;
  assert.equal(result.isError, true); assert.equal(bytes, 1);
  assert.match(JSON.stringify(result), /F1.*may remain/);
  assert.doesNotMatch(JSON.stringify(result), /Nothing was uploaded/);
  assert.ok(!h.calls.some(c => c.method === 'uploadComplete'));
  h.fail(); h.history({ ok: true, messages: [] });
  const rollback = await host.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint: before.state.checkpoint }) as any;
  assert.match(rollback.reason, /0\/1 files deleted/);
  assert.match(rollback.reason, /F1.*CPINNED/);
});

test('real SDK top-level null proof cannot authorize a post', async t => {
  const { SlackWebClient, SLACK_CLIENT_OPTIONS } = await import('../src/slack-adapter.js');
  const { fakeSlackApi } = await import('./slackApi.js');
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('conversations.history', { body: null });
  const h = fixture();
  const client = new SlackWebClient('test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  h.web.conversations.history = args => client.conversations.history(args as any) as any;
  await assert.rejects(h.adapter.sendMessage(PIN, 'no'), err => {
    assert.match(explainSlackError(err, { tool: 'send_message', args: {} }), /Nothing was posted/); return true;
  });
  assert.equal(h.calls.some(c => c.method === 'post'), false);
});

for (const source of ['listing', 'metadata', 'filtered event'] as const) {
  test(`private pin evidence survives inactive fallback and later scope withdrawal: ${source}`, async t => {
    t.mock.method(console, 'error', () => {});
    const h = fixture({ scopes: [...scopes, 'channels:read', 'groups:read'] });
    const privatePin = { id: PIN, is_im: false, is_mpim: false, is_member: true, is_private: true };
    h.info(privatePin);
    if (source === 'listing') {
      h.list([privatePin]);
      await h.adapter.listConversations();
    } else if (source === 'metadata') {
      await h.adapter.getConversationMeta(PIN);
    } else {
      await (h.adapter as any).prepareMessageEvent({ type: 'message', channel: PIN, channel_type: 'group', bot_id: 'B1', user: OWNER, ts: '1.0' });
    }
    await h.reportScopes(scopes);
    const before = h.calls.length;
    await assert.rejects(h.adapter.sendMessage(PIN, 'must not send'), /Private fallback pin/);
    assert.equal(h.calls.length, before, 'latched veto precedes even history proof');
  });
}

test('foreground pin listing surfaces a missing history grant instead of omitting the pin', async () => {
  const h = fixture({ scopes: ['chat:write'] });
  await assert.rejects(h.adapter.listConversations(), /requires granted scope 'channels:history'/);
  assert.equal(h.calls.some(c => c.method === 'history'), false);
});


test('pin-loop scope denial has listing outcome and recovery guidance through the tool', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture({ scopes: ['chat:write'] });
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, false);
  f.calls.length = 0;
  const result = await h.host.sendRequest('tools/call', {
    name: 'list_channels', arguments: {},
  }) as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  const text = result.content.map(c => c.text).join('\n');
  assert.match(text, /No conversations were returned/);
  assert.match(text, /required Slack permission channels:history is not granted/);
  assert.match(text, /Retrying unchanged will not help/);
  assert.match(text, /ask whoever runs this host/);
  assert.deepEqual(f.calls.map(call => call.method), ['auth'], 'pin scope denial precedes history/list requests');
});

test('queued private ambient evidence denies writes before a held delivery releases', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const delivering = new Promise<void>(resolve => { entered = resolve; });
  let filterCalls = 0, delivered = 0;
  h.adapter.setAmbientMessageFilter(() => { filterCalls++; return false; });
  h.adapter.onMessage(async () => { delivered++; entered(); await held; });
  await h.adapter.getConversationMeta(PIN); // Seed the old public history proof.
  const first = h.emit(); // Addressed public event reaches a held host delivery.
  await delivering;
  const queued = h.emit('group', 'private ambient message');
  const historyBefore = h.calls.filter(c => c.method === 'history').length;
  try {
    assert.equal(filterCalls, 0); // Subscription eligibility must not run ahead.
    await assert.rejects(h.adapter.sendMessage(PIN, 'must not post'), /Private fallback pin/);
    assert.equal(h.calls.filter(c => c.method === 'post').length, 0);
    assert.equal(h.calls.filter(c => c.method === 'history').length, historyBefore);
  } finally {
    release();
    await Promise.all([first, queued]);
    await h.adapter.stop();
  }
  assert.equal(delivered, 1);
  await assert.rejects(h.adapter.sendMessage(PIN, 'still denied'), /Private fallback pin/);
});


test('listing hints exclude fallback pins lacking history grants', async () => {
  const f = fixture({ scopes: ['users:read'] });
  assert.equal(f.adapter.hasHistoryFallbackPins, false);
});

test('pure fallback gate independently requires the history grant', () => {
  const p = new SlackAccessPolicy({ readJoinedChannels: true, writeChannels: ['C1'],
    dmUsers: [], historyMembershipFallbackChannels: ['C1'] });
  const proof = { id: 'C1', is_im: false, is_mpim: false, is_private: false,
    is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true as const };
  assert.throws(() => p.requireReadable('C1', proof, ['chat:write']), /channels:history/);
  assert.equal(p.requireReadable('C1', proof, ['channels:history']), 'channel');
});


test('background missing_scope pin failure preserves an otherwise admitted DM', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ dmUsers: [OWNER] });
  t.after(() => h.adapter.stop());
  h.list([{ id: 'D1', is_im: true, user: OWNER }]);
  h.fail(Object.assign(new Error('missing scope'), { code: ErrorCode.PlatformError, data: { error: 'missing_scope' } }), PIN);
  await assert.rejects(h.adapter.listConversations(), /missing scope/);
  const listing = await h.adapter.listConversations(false, async () => {});
  assert.deepEqual(listing.conversations.map(row => row.id), ['D1']);
  assert.ok(h.calls.some(call => call.method === 'history' && call.args.channel === PIN));
  assert.ok(h.calls.some(call => call.method === 'info' && call.args.channel === 'D1'));
});

test('malformed policy page channels cannot bypass reported grant replacement', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ dmUsers: [OWNER] });
  t.after(() => h.adapter.stop());
  h.web.conversations.list = async () => ({ channels: {} as never,
    response_metadata: { scopes: scopes.filter(scope => scope !== 'chat:write') } });
  await assert.rejects(h.adapter.listConversations(), /malformed channels page/);
  assert.equal((h.adapter as any).scopes.includes('chat:write'), false);
});


test('pure synthetic proof requires an explicitly configured fallback pin', () => {
  const p = new SlackAccessPolicy({ readJoinedChannels: true, writeChannels: ['C1'], dmUsers: [] });
  const proof = { id: 'C1', is_im: false, is_mpim: false, is_private: false, is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true as const };
  assert.throws(() => p.requireReadable('C1', proof, ['channels:history']), /fresh.*metadata/);
});

test('synthetic proof validates missing or malformed grant evidence before denial classification', () => {
  const p = new SlackAccessPolicy({ readJoinedChannels: true, writeChannels: ['C1'], dmUsers: [], historyMembershipFallbackChannels: ['C1'] });
  const proof = { id: 'C1', is_im: false, is_mpim: false, is_private: false, is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true as const };
  for (const scopes of [undefined, [null], 'channels:history']) {
    assert.throws(() => p.requireReadable('C1', proof, scopes as never), SlackScopeEvidenceError);
  }
});

test('background fallback proofs share the ambient scheduler and report retired slots', async t => {
  const h = fixture({ writeChannels: ['C1', 'C2'], fallback: ['C1', 'C2'] });
  const { clock } = await import('../src/clock.js');
  const starts: number[] = [];
  h.web.conversations.history = async () => { starts.push(clock.monotonic()); return { ok: true, messages: [] }; };
  await h.adapter.listConversations(false, async () => {});
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 1200);
  const internal = h.adapter as unknown as { paceEventAdmission: () => Promise<boolean> };
  t.mock.method(internal, 'paceEventAdmission', async () => false);
  const skipped = await h.adapter.listConversations(false, async () => {});
  assert.equal(skipped.admissionFailures, 2);
  assert.deepEqual(skipped.conversations, []);
  assert.equal(starts.length, 2, 'no proof after a retired slot');
});

test('real history-proof rate limit extends the shared admission cooldown', async t => {
  const { SlackWebClient, SLACK_CLIENT_OPTIONS, failedRequest } = await import('../src/slack-adapter.js');
  const { fakeSlackApi } = await import('./slackApi.js');
  const { clock } = await import('../src/clock.js');
  t.mock.method(console, 'error', () => {});
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('conversations.history',
    { status: 429, headers: { 'retry-after': '60' }, body: { ok: false, error: 'ratelimited' } },
    { body: { ok: true, messages: [] } });
  const web = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url }) as unknown as SlackWebLike;
  const policy = new SlackAccessPolicy({ readJoinedChannels: true, writeChannels: ['C1', 'C2'], dmUsers: [], historyMembershipFallbackChannels: ['C1', 'C2'] });
  const adapter = new SlackAdapter(web, { on() {}, async start() {}, async disconnect() {} }, 'UBOT', 'test', undefined, undefined, false, undefined, ['channels:history'], policy);
  t.after(() => adapter.stop());
  const start = clock.monotonic();
  await assert.rejects((adapter as any).retryEventAdmission('C1', { addressed: true }), err => {
    assert.equal(failedRequest(err), 'conversations.history'); return true;
  });
  assert.equal((adapter as any).nextEventAdmissionAt, start + 60_000);
  await (adapter as any).retryEventAdmission('C2', { addressed: true });
  assert.ok(clock.monotonic() >= start + 60_000, 'next proof waits out shared history cooldown');
  assert.equal(api.calls.filter(c => c === 'conversations.history').length, 2);
});

for (const freshMetadata of [false, true]) {
  test(`public delivery rechecks after successful final admission: metadata=${freshMetadata}`, async t => {
    const { method } = await import('@animalabs/mcpl-core');
    const { FULL_GRANT, until } = await import('./harness.js');
    const logs = t.mock.method(console, 'error', () => {});
    const f = fixture();
    const server = new SlackMcplServer(f.adapter), host = connectHost(server);
    t.after(() => host.close()); t.after(() => f.adapter.stop());
    await initialize(host, true);
    await host.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => (server as any).registering === undefined, 'initial registration');
    host.hostSaw.length = 0; f.calls.length = 0;
    const clear = t.mock.method(f.adapter, 'clearAck', async () => {});
    const meta = f.adapter.getConversationMeta.bind(f.adapter);
    let privateEvent: Promise<unknown> | undefined;
    let checked = false;
    t.mock.method(f.adapter, 'getConversationMeta', async (id: string, forDelivery = false) => {
      if (forDelivery && freshMetadata) {
        (f.adapter as any).scopes = [...scopes, 'channels:read'];
        f.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true, name: 'fresh' });
      }
      const result = await meta(id, forDelivery);
      if (forDelivery && !checked) {
        checked = true;
        // The real final proof has succeeded. Receipt now latches the veto,
        // before the original event reaches its synchronous commit point.
        privateEvent = f.emit('group', '', 'message_deleted');
      }
      return result;
    });
    await f.emit();
    await privateEvent;
    const delivered = host.hostSaw.filter(r => [method.PUSH_EVENT, method.CHANNELS_INCOMING].includes(r.method as any));
    assert.equal(delivered.length, freshMetadata ? 1 : 0);
    assert.equal((server as any).lastChannelId, freshMetadata ? PIN : null);
    assert.equal(f.calls.filter(c => c.method === 'history' && c.args.limit === 1).length, freshMetadata ? 3 : 4);
    if (!freshMetadata) {
      assert.ok(clear.mock.calls.some(c => c.arguments[0] === PIN && c.arguments[1] === '1.0'));
      assert.match(logs.mock.calls.map(c => c.arguments.join(' ')).join('\n'), /Dropped message 1\.0 in CPINNED: delivery admission failed/);
    }
  });
}

for (const failure of ['429', 'timeout'] as const) for (const veto of [false, true]) {
  test(`public delivery rechecks a held final proof before transient fallback: ${failure}, veto=${veto}`, async t => {
    const { method } = await import('@animalabs/mcpl-core');
    const { FULL_GRANT, until } = await import('./harness.js');
    const logs = t.mock.method(console, 'error', () => {});
    const f = fixture();
    const server = new SlackMcplServer(f.adapter), host = connectHost(server);
    t.after(() => host.close()); t.after(() => f.adapter.stop());
    await initialize(host, true);
    await host.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => (server as any).registering === undefined, 'initial registration');
    host.hostSaw.length = 0; f.calls.length = 0;
    let final = false, entered!: () => void, reject!: (err: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const meta = f.adapter.getConversationMeta.bind(f.adapter);
    // Observe the boundary; admission itself remains the real adapter path.
    t.mock.method(f.adapter, 'getConversationMeta', (id: string, forDelivery = false) => {
      if (forDelivery) final = true;
      return meta(id, forDelivery);
    });
    f.web.conversations.history = async args => {
      f.calls.push({ method: 'history', args });
      if (final) { entered(); return new Promise((_resolve, fail) => { reject = fail; }); }
      return { ok: true, messages: [] };
    };
    if (failure === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const incoming = f.emit();
    await started;
    // Socket receipt must latch the veto even though this event queues behind delivery.
    const privateEvent = veto ? f.emit('group', 'private ambient event') : Promise.resolve();
    try {
      assert.equal(host.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
      if (failure === '429') reject(Object.assign(rateLimit(), { retryAfter: 60 }));
      else t.mock.timers.tick(5000);
      await incoming;
      await privateEvent;
      const delivered = host.hostSaw.filter(r => [method.PUSH_EVENT, method.CHANNELS_INCOMING].includes(r.method as any));
      assert.equal(delivered.length, veto || failure === 'timeout' ? 0 : 1);
      assert.equal((server as any).lastChannelId, veto || failure === 'timeout' ? null : PIN);
      assert.equal(f.calls.filter(c => c.method === 'history' && c.args.limit === 1).length, failure === 'timeout' && !veto ? 5 : 4, 'initial, ACK, backscroll, final proof and any cleanup admission ran; no proof retry');
      const text = logs.mock.calls.map(c => c.arguments.join(' ')).join('\n');
      if (veto || failure === 'timeout') assert.match(text, /Dropped message 1\.0 in CPINNED: delivery admission failed/);
      else assert.match(text, /using original admission/);
    } finally {
      final = false; // Cleanup must not hold another proof.
      reject(Object.assign(rateLimit(), { retryAfter: 60 })); // Settle the underlying request after a timeout too.
    }
  });
}

test('background failed-pin count survives an unrelated listing-scope restart', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture({ dmUsers: [OWNER], writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  t.after(() => f.adapter.stop());
  f.fail(new OutOfCallTime('conversations.history', 30), 'CSTALE');
  f.web.conversations.list = async args => {
    f.calls.push({ method: 'list', args });
    return { channels: [{ id: 'D1', is_im: true, user: OWNER }], response_metadata: { scopes: [...scopes, 'groups:read'] } };
  };
  const result = await f.adapter.listConversations(false, async () => {});
  assert.deepEqual(result.conversations.map(c => c.id), [PIN, 'D1']);
  assert.equal(f.calls.filter(c => c.method === 'list').length, 2, 'grant restarts listing types');
  assert.equal(f.calls.filter(c => c.method === 'history' && c.args.channel === 'CSTALE').length, 5, 'pin exhausted once; restart did not retry it');
  assert.equal(result.admissionFailures, 1);
  f.fail();
  const healthy = await f.adapter.listConversations(false, async () => {});
  assert.deepEqual(healthy.conversations.map(c => c.id), ['CSTALE', PIN, 'D1']);
  assert.equal(healthy.admissionFailures, undefined, 'new healthy scan clears incomplete count');
});

test('public registration reports failed pins across a scope restart and refresh recovers', async t => {
  const { method } = await import('@animalabs/mcpl-core');
  const { FULL_GRANT, until } = await import('./harness.js');
  const logs = t.mock.method(console, 'error', () => {});
  const f = fixture({ dmUsers: [OWNER], writeChannels: ['CSTALE', PIN], fallback: ['CSTALE', PIN] });
  t.after(() => f.adapter.stop());
  f.fail(new OutOfCallTime('conversations.history', 30), 'CSTALE');
  f.web.conversations.list = async args => {
    f.calls.push({ method: 'list', args });
    return { channels: [{ id: 'D1', is_im: true, user: OWNER }], response_metadata: { scopes: [...scopes, 'groups:read'] } };
  };
  const server = new SlackMcplServer(f.adapter), host = connectHost(server);
  t.after(() => host.close());
  await initialize(host, true);
  await host.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => (server as any).registering === undefined, 'registration');
  const registered = host.hostSaw.filter(r => r.method === method.CHANNELS_REGISTER).flatMap(r => (r.params as any).channels.map((c: any) => c.id));
  assert.deepEqual(registered, [`slack:${PIN}`, 'slack:D1']);
  assert.equal(f.calls.filter(c => c.method === 'list').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'history' && c.args.channel === 'CSTALE').length, 5);
  assert.match(logs.mock.calls.map(c => c.arguments.join(' ')).join('\n'), /Conversation registration incomplete: 1 candidate admissions did not complete/);
  const failed = await host.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }) as any;
  assert.equal(failed.isError, true, 'foreground proof failure remains explicit, not an apparently complete listing');
  f.fail();
  const result = await host.host.sendRequest('tools/call', { name: 'refresh_channels', arguments: {} }) as any;
  assert.notEqual(result.isError, true);
  const refreshed = JSON.parse(result.content[0].text);
  assert.equal(refreshed.visible, 3);
  assert.deepEqual(refreshed.added.map((c: any) => c.id), ['slack:CSTALE']);
  assert.equal(refreshed.registration, undefined);
  const listed = await host.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }) as any;
  assert.deepEqual(JSON.parse(listed.content[0].text).map((c: any) => c.id), ['CSTALE', PIN, 'D1']);
});

test('public delivery still admits a latched private pin through fresh metadata', async t => {
  const { method } = await import('@animalabs/mcpl-core');
  const { FULL_GRANT, until } = await import('./harness.js');
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  const server = new SlackMcplServer(f.adapter), host = connectHost(server);
  t.after(() => host.close()); t.after(() => f.adapter.stop());
  await initialize(host, true);
  await host.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => (server as any).registering === undefined, 'initial registration');
  await f.emit('group', 'unsubscribed private event'); // Latches without delivering.
  const privatePin = { id: PIN, is_im: false, is_mpim: false, is_private: true, is_member: true };
  f.info(privatePin);
  f.web.auth.test = async () => ({ response_metadata: { scopes: [...scopes, 'channels:read', 'groups:read', 'groups:history'] } });
  f.web.conversations.list = async () => ({ channels: [privatePin],
    response_metadata: { scopes: [...scopes, 'channels:read', 'groups:read', 'groups:history'] } });
  assert.deepEqual((await f.adapter.listConversations()).conversations.map(c => c.id), [PIN]);
  host.hostSaw.length = 0; f.calls.length = 0;
  await f.emit('group');
  assert.equal(host.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 1);
  assert.equal(f.calls.filter(c => c.method === 'info').length, 4, 'initial, ACK, backscroll and final admissions use fresh metadata');
  assert.equal(f.calls.filter(c => c.method === 'history' && c.args.limit === 1).length, 0, 'no history membership fallback');
});


function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const fileScopes = [...scopes, 'files:read', 'files:write'];
const associated = { id: 'F1', mode: 'hosted', channels: [PIN], url_private: 'https://files.slack.com/file' };

test('a private receipt during the upload ticket wait prevents byte transfer and records residue', async t => {
  const { fileLeftByUpload } = await import('../src/slack-adapter.js');
  t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: fileScopes }); t.after(() => h.adapter.stop());
  const entered = gate<void>(), ticket = gate<any>();
  h.web.files.getUploadURLExternal = async () => { entered.resolve(); return ticket.promise; };
  let bytes = 0; t.mock.method(globalThis, 'fetch', async () => { bytes++; return new Response('OK'); });
  const result = h.adapter.uploadFile(PIN, { filename: 'x', data: Buffer.from('x') });
  await entered.promise;
  await h.emit('group', '', 'message_deleted');
  ticket.resolve({ file_id: 'F1', upload_url: 'https://files.slack.com/upload' });
  await assert.rejects(result, err => {
    assert.match(String(err), /Private fallback pin/);
    assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false, policy: true });
    return true;
  });
  assert.equal(bytes, 0);
  assert.equal(h.calls.some(c => c.method === 'uploadComplete'), false);
});

test('a veto landing after the final writable proof prevents upload sharing', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: fileScopes }); t.after(() => h.adapter.stop());
  h.web.files.getUploadURLExternal = async () => ({ file_id: 'F1', upload_url: 'https://files.slack.com/upload' });
  let bytes = 0; t.mock.method(globalThis, 'fetch', async () => { bytes++; return new Response('OK'); });
  const adapter = h.adapter as any, original = adapter.requireWritableConversation.bind(adapter);
  let checks = 0;
  t.mock.method(adapter, 'requireWritableConversation', async (...args: any[]) => {
    const admission = await original(...args);
    if (++checks === 2) queueMicrotask(() => adapter.rejectPrivatePin(PIN));
    return admission;
  });
  await assert.rejects(h.adapter.uploadFile(PIN, { filename: 'x', data: Buffer.from('x') }), /Private fallback pin/);
  assert.equal(bytes, 1);
  assert.equal(checks, 2);
  assert.equal(h.calls.some(c => c.method === 'uploadComplete'), false);
});

for (const operation of ['download', 'delete'] as const) test(`private receipt during file metadata prevents ${operation}`, async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: fileScopes }); t.after(() => h.adapter.stop());
  (h.adapter as any).policyUploads.set('F1', PIN);
  const entered = gate<void>(), metadata = gate<any>();
  h.web.files.info = async () => { entered.resolve(); return metadata.promise; };
  const result = operation === 'download' ? h.adapter.resolveFileDownload(PIN, 'F1') : h.adapter.deleteFile(PIN, 'F1');
  await entered.promise;
  await h.emit('group', '', 'message_deleted');
  metadata.resolve({ file: associated });
  await assert.rejects(result, /Private fallback pin/);
  assert.equal(h.calls.some(c => c.method === 'fileDelete'), false);
});

test('a prepared history event is vetoed after its awaited author-name lookup', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); t.after(() => h.adapter.stop());
  const entered = gate<void>(), user = gate<any>();
  h.web.users.info = async () => { entered.resolve(); return user.promise; };
  let delivered = 0; h.adapter.onMessage(() => { delivered++; });
  const incoming = h.emit();
  await entered.promise;
  const privateReceipt = h.emit('group', '', 'message_deleted');
  user.resolve({ user: { name: 'owner' } });
  await incoming; await privateReceipt;
  assert.equal(delivered, 0);
});

test('each embedded callback rechecks prepared history-proof provenance', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); t.after(() => h.adapter.stop());
  let privateReceipt: Promise<void> | undefined, later = 0;
  h.adapter.onMessage(msg => {
    assert.equal(msg[HISTORY_MEMBERSHIP_PROOF], true);
    privateReceipt = h.emit('group', '', 'message_deleted');
  });
  h.adapter.onMessage(() => { later++; });
  await h.emit();
  assert.ok(privateReceipt, 'the first callback installed its private receipt');
  await privateReceipt;
  assert.equal(later, 0);
});

test('metadata success after a scope restart reconciles the failed pin ID', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ dmUsers: [OWNER] }); t.after(() => h.adapter.stop());
  h.fail(new OutOfCallTime('conversations.history', 30), PIN);
  h.web.conversations.list = async args => {
    h.calls.push({ method: 'list', args });
    return { channels: [{ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true }],
      response_metadata: { scopes: [...scopes, 'channels:read'] } };
  };
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true });
  const listing = await h.adapter.listConversations(false, async () => {});
  assert.equal(h.calls.filter(c => c.method === 'history').length, 5);
  assert.equal(h.calls.filter(c => c.method === 'info').length, 1);
  assert.deepEqual(listing.conversations.map(c => c.id), [PIN]);
  assert.equal(listing.admissionFailures, undefined);
});

for (const failed of [false, true]) test(`a stopped pinned scan does not count shutdown or continue paging: failed=${failed}`, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  const h = fixture();
  const entered = gate<void>(), proof = gate<any>();
  h.web.conversations.history = async () => { entered.resolve(); return proof.promise; };
  const listing = h.adapter.listConversations(false, async () => {});
  await entered.promise; await h.adapter.stop();
  proof.resolve(failed ? null : { ok: true, messages: [] });
  await assert.rejects(listing, /listing stopped/);
  assert.equal(h.calls.some(c => c.method === 'list'), false);
  assert.doesNotMatch(logs.mock.calls.map(c => c.arguments.join(' ')).join('\n'), /candidate|incomplete|retired before proof/);
});

for (const refusal of ['channel_not_found', 'unjoined prefilter'] as const) test(`a restarted scan reconciles the failed pin on ${refusal}`, async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ dmUsers: [OWNER] }); t.after(() => h.adapter.stop());
  h.fail(new OutOfCallTime('conversations.history', 30), PIN);
  h.web.conversations.list = async args => { h.calls.push({ method: 'list', args }); return ({
    channels: [{ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: refusal !== 'unjoined prefilter' }],
    response_metadata: { scopes: [...scopes, 'channels:read'] },
  }); };
  h.web.conversations.info = async args => {
    h.calls.push({ method: 'info', args });
    throw Object.assign(new Error('not found'), { code: ErrorCode.PlatformError, data: { error: 'channel_not_found' } });
  };
  const result = await h.adapter.listConversations(false, async () => {});
  assert.equal(h.calls.filter(c => c.method === 'history').length, 5, 'exhausted the failed proof');
  assert.equal(h.calls.filter(c => c.method === 'list').length, 2, 'scope report restarted the scan');
  assert.equal(h.calls.filter(c => c.method === 'info').length, refusal === 'channel_not_found' ? 1 : 0);
  assert.deepEqual(result.conversations, []);
  assert.equal(result.admissionFailures, undefined);
});

test('a private receipt while a successful proof is held vetoes the post after proof', async t => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); t.after(() => h.adapter.stop());
  const entered = gate<void>(), proof = gate<any>();
  h.web.conversations.history = async () => { entered.resolve(); return proof.promise; };
  const pending = h.adapter.sendMessage(PIN, 'must not post');
  await entered.promise;
  await h.emit('group', '', 'message_deleted');
  proof.resolve({ ok: true, messages: [] });
  await assert.rejects(pending, /Private fallback pin/);
  assert.equal(h.calls.some(c => c.method === 'post'), false);
});

for (const negative of ['refusal', 'withdrawal'] as const) test(`older fallback proof cannot undo a later ${negative}`, async t => {
  const h = fixture(); t.after(() => h.adapter.stop());
  await h.adapter.getConversationMeta(PIN);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  let calls = 0;
  h.web.conversations.history = async () => {
    if (++calls === 1) { entered(); await held; return { ok: true, messages: [], response_metadata: { scopes, next_cursor: '' } }; }
    if (negative === 'refusal') throw Object.assign(new Error('removed'), { code: ErrorCode.PlatformError, data: { error: 'not_in_channel' } });
    return { ok: true, messages: [], response_metadata: { scopes: scopes.filter(s => s !== 'channels:history'), next_cursor: '' } };
  };
  const older = h.adapter.getConversationMeta(PIN).then(() => true, () => false);
  await started;
  await assert.rejects(h.adapter.getConversationMeta(PIN));
  release();
  assert.equal(await older, false);
  assert.throws(() => h.adapter.assertKnownDeliveryAdmission(PIN));
  h.web.conversations.history = async () => ({ ok: true, messages: [], response_metadata: { scopes, next_cursor: '' } });
  // A new scope refresh/check is allowed to establish recovered access.
  await h.adapter.listConversations();
  await h.adapter.getConversationMeta(PIN);
  assert.doesNotThrow(() => h.adapter.assertKnownDeliveryAdmission(PIN));
});

test('foreground fallback listing preserves admitted pins when a later pin is rate limited', async t => {
  const h = fixture({ scopes: ['channels:history', 'chat:write'], writeChannels: [PIN, 'CSECOND'], fallback: [PIN, 'CSECOND'] });
  t.after(() => h.adapter.stop());
  h.fail(rateLimit(), 'CSECOND');
  const result = await h.adapter.listConversations();
  assert.deepEqual(result.conversations.map(c => c.id), [PIN]);
  assert.equal(result.admissionFailures, 1);
  assert.deepEqual(h.calls.filter(c => c.method === 'history').map(c => c.args.channel), [PIN, 'CSECOND']);
});

test('fallback history A/B/C recovers without re-stamping the known refusal', async t => {
  const h = fixture();
  const startedA = gate<void>(), startedC = gate<void>(), heldA = gate<void>(), heldC = gate<void>();
  t.after(async () => { heldA.resolve(); heldC.resolve(); await h.adapter.stop(); });
  let calls = 0;
  h.web.conversations.history = async () => {
    const call = ++calls;
    if (call === 1) { startedA.resolve(); await heldA.promise; }
    if (call === 2) throw terminal();
    if (call === 3) { startedC.resolve(); await heldC.promise; }
    return { ok: true, messages: [], response_metadata: { scopes, next_cursor: '' } };
  };
  const a = h.adapter.getConversationMeta(PIN).then(() => undefined, error => error);
  await startedA.promise;
  await assert.rejects(h.adapter.getConversationMeta(PIN), /not_in_channel/);
  const c = h.adapter.getConversationMeta(PIN).then(value => ({ value }), error => ({ error }));
  await startedC.promise;
  heldA.resolve();
  assert.ok(await a);
  assert.throws(() => h.adapter.assertKnownDeliveryAdmission(PIN));
  heldC.resolve();
  const result = await c;
  if ('error' in result) throw result.error;
  assert.equal(result.value?.id, PIN);
  assert.doesNotThrow(() => h.adapter.assertKnownDeliveryAdmission(PIN));
  assert.equal(calls, 3);
});
