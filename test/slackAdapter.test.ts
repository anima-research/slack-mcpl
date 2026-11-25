/**
 * Tests for SlackAdapter incoming-message handling (mention flag, filtering).
 *
 * Run: node --import tsx --test test/slackAdapter.test.ts
 */

import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { clock } from '../src/clock.js';
import assert from 'node:assert/strict';
import { waitToAskAgain, SlackAdapter, type SlackAdapterConfig, type SlackMessageData } from '../src/slack-adapter.js';

function makeAdapter(opts: Pick<SlackAdapterConfig, 'dmUsers' | 'botMessages' | 'disableDms'> & { botUsers?: string[] } = {}) {
  let handler: ((args: { event: any; ack: () => Promise<void> }) => void) | undefined;
  const socket = {
    on(_event: string, h: any) { handler = h; },
    async start() {},
    async disconnect() {},
  } as any;
  const web = {
    users: {
      info: async ({ user }: { user: string }) => ({ user: { name: user.toLowerCase(), is_bot: opts.botUsers?.includes(user) ?? false } }),
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', opts.dmUsers,
    undefined, opts.disableDms, undefined, undefined, undefined, undefined, opts.botMessages, 'BSELF');
  const received: SlackMessageData[] = [];
  adapter.onMessage((msg) => received.push(msg));
  // The constructor's handler acks then processes asynchronously; give the
  // microtask queue a beat before asserting.
  const emit = async (event: any) => {
    handler!({ event, ack: async () => {} });
    await (adapter as any).inbound.get(event.channel ?? '');
  };
  return { emit, received, adapter, web };
}

test('incoming message sets mentionsBot=true when the bot is mentioned', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', channel: 'C1', user: 'U1',
    ts: '1718000000.000100', text: 'hey <@UBOT>, look at this',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].mentionsBot, true);
  assert.deepEqual(received[0].mentionIds, ['UBOT']);
});

test('incoming message sets mentionsBot=false for other mentions and broadcasts', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', channel: 'C1', user: 'U1',
    ts: '1718000000.000200', text: '<!here> <@U2> can you take this?',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].mentionsBot, false);
});

test('a thread_broadcast that names its parent only under root keeps the thread', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', subtype: 'thread_broadcast', channel: 'C1', user: 'U1',
    ts: '6.5', text: 'also to the channel', root: { thread_ts: '6.0' },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].threadTs, '6.0');
});

test('own and bot messages are filtered out', async () => {
  const { emit, received } = makeAdapter();
  await emit({ type: 'message', channel: 'C1', user: 'UBOT', ts: '1.0', text: 'self' });
  await emit({ type: 'message', channel: 'C1', user: 'U1', bot_id: 'B1', ts: '2.0', text: 'bot' });
  await emit({ type: 'message', subtype: 'bot_message', channel: 'C1', user: 'U1', ts: '3.0', text: 'bot' });
  assert.equal(received.length, 0);
});

for (const botMessages of ['all', ['B1'], ['U1']] as const) {
  test(`bot messages opt-in admits a bot by ${JSON.stringify(botMessages)}`, async () => {
    const { emit, received } = makeAdapter({ botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages] });
    for (const subtype of [undefined, 'bot_message', 'file_share']) {
      await emit({ type: 'message', subtype, channel: 'C1', user: 'U1', bot_id: 'B1', ts: '2.0', text: 'hi <@UBOT>' });
    }
    assert.equal(received.length, 3);
    for (const msg of received) {
      assert.equal(msg.isBot, true);
      assert.equal(msg.senderKind, 'bot');
      assert.equal(msg.authorBotId, 'B1');
      assert.equal(msg.authorId, 'U1');
      assert.equal(msg.mentionsBot, true);
    }
  });
}

test('bot allow-list drops other bots but admits already verified human messages', async () => {
  const { emit, received, adapter, web } = makeAdapter({ botMessages: ['B1', 'U2'] });
  await (adapter as any).resolveUserNames(['UHUMAN']);
  web.users.info = async () => { throw new Error('cached human must not need a lookup'); };
  await emit({ type: 'message', channel: 'C1', user: 'U3', bot_id: 'B3', ts: '1.0' });
  await emit({ type: 'message', subtype: 'bot_message', channel: 'C1', user: 'U3', ts: '2.0' });
  await emit({ type: 'message', channel: 'C1', user: 'UHUMAN', ts: '3.0' });
  assert.deepEqual(received.map((m) => m.authorId), ['UHUMAN']);
  assert.equal(received[0].isBot, undefined);
});

test('user-ID admission handles bot_message without bot_id and bots identified by users.info', async () => {
  for (const botMessages of ['all', ['U1'], ['UOTHER']] as const) {
    let lookups = 0;
    const { emit, received, web } = makeAdapter({
      botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages], botUsers: ['U1'],
    });
    for (const subtype of [undefined, 'bot_message']) {
      await emit({ type: 'message', subtype, channel: 'C1', user: 'U1', ts: '1.0' });
    }
    assert.equal(received.length, botMessages[0] === 'UOTHER' ? 0 : 2);
    for (const msg of received) assert.equal(msg.isBot, true);
  }
});

test('own user and bot identities are always dropped, even when explicitly allowed', async () => {
  for (const botMessages of ['all', ['UBOT', 'BSELF']] as const) {
    const { emit, received } = makeAdapter({ botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages] });
    for (const identity of [{ user: 'UBOT' }, { user: 'UBOT', bot_id: 'BSELF' }, { bot_id: 'BSELF' }]) {
      await emit({ type: 'message', channel: 'C1', ts: '1.0', text: '<@UBOT>', ...identity });
    }
    assert.equal(received.length, 0);
  }
});

test('opted-in bot events without a user use the bot ID as author', async () => {
  const { emit, received } = makeAdapter({ botMessages: ['B1'] });
  await emit({ type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B1', ts: '1.0', text: 'hello' });
  assert.equal(received.length, 1);
  assert.equal(received[0].authorId, 'B1');
  assert.equal(received[0].isBot, true);
});

test('bot opt-in still drops malformed and non-content events and respects DM controls', async () => {
  const { emit, received } = makeAdapter({ botMessages: 'all', disableDms: true });
  const bot = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', bot_id: 'B1', ts: '1.0' };
  await emit({ ...bot, subtype: 'message_changed' });
  await emit({ ...bot, ts: undefined });
  await emit({ ...bot, channel: undefined });
  await emit({ ...bot, channel: 'D1', channel_type: 'im' });
  assert.equal(received.length, 0);
  for (const dmUsers of [['UOTHER'], []]) {
    const dm = makeAdapter({ botMessages: 'all', dmUsers });
    await dm.emit({ ...bot, channel: 'D1', channel_type: 'im' });
    assert.equal(dm.received.length, 0);
  }
});

test('bot opt-in requires both authenticated identities for self-filtering', () => {
  for (const [userId, botId] of [[null, 'BSELF'], ['UBOT', undefined]] as const) {
    assert.throws(() => new SlackAdapter({} as any, {} as any, userId, 'acme',
      undefined, undefined, false, undefined, undefined, undefined, undefined, 'all', botId), /requires authenticated bot and user IDs/);
  }
});

test('non-content subtypes and malformed payloads are dropped', async () => {
  const { emit, received } = makeAdapter();
  await emit({ type: 'message', subtype: 'message_changed', channel: 'C1', user: 'U1', ts: '1.0', text: 'edited' });
  await emit({ type: 'message', channel: 'C1', text: 'no user or ts' });
  assert.equal(received.length, 0);
});

test('DMs are flagged and the DM whitelist drops unlisted senders', async () => {
  const { emit, received } = makeAdapter({ dmUsers: ['UFRIEND'] });
  await emit({
    type: 'message', channel: 'D1', channel_type: 'im', user: 'UFRIEND',
    ts: '3.0', text: 'hi',
  });
  await emit({
    type: 'message', channel: 'D2', channel_type: 'im', user: 'USTRANGER',
    ts: '4.0', text: 'psst',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].isDM, true);
  assert.equal(received[0].authorId, 'UFRIEND');
});

test('an empty DM whitelist admits no DM', async () => {
  const { emit, received } = makeAdapter({ dmUsers: [] });
  await emit({ type: 'message', channel: 'D2', channel_type: 'im', user: 'USTRANGER', ts: '4.0', text: 'psst' });
  await emit({ type: 'message', channel: 'C1', user: 'U1', ts: '4.1', text: 'in a channel' });
  assert.deepEqual(received.map((m) => m.channelId), ['C1']);
});

test('file shares become attachment refs with mime classification', async () => {
  const { emit, received } = makeAdapter();
  await emit({
    type: 'message', subtype: 'file_share', channel: 'C1', user: 'U1', ts: '5.0',
    text: 'shot attached',
    files: [{ url_private: 'https://files.slack.com/files-pri/T1-F1/shot.png', name: 'shot.png', mimetype: 'image/png' }],
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].attachments.length, 1);
  assert.equal(received[0].attachments[0].isImage, true);
  assert.equal(received[0].attachments[0].path, 'https://files.slack.com/files-pri/T1-F1/shot.png');
});


test('unset bot policy preserves delivery of unmarked users even if users.info identifies a bot', async () => {
  const { emit, received } = makeAdapter({ botUsers: ['U1'] });
  await emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: 'legacy' });
  assert.equal(received.length, 1);
  assert.equal(received[0].isBot, undefined);
});

// #66 bot review 1: user-only events must not bypass an ID allow-list when
// Slack cannot establish whether their author is human.
for (const failure of ['timeout', 'unclassified error', 'missing-user', 'missing-status'] as const) {
  test(`bot allow-list fails closed and retries an unverifiable author: ${failure}`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let handler: any;
    let calls = 0;
    const adapter = new SlackAdapter({
      users: { info: async () => {
        calls++;
        if (calls > 2) return { user: { name: 'verified', is_bot: false } };
        if (failure === 'timeout') throw new Error('request timed out');
        if (failure === 'unclassified error') throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
        return failure === 'missing-user' ? {} : { user: { name: 'unknown' } };
      } },
    } as any, { on: (_: string, h: any) => { handler = h; } } as any,
    'UBOT', 'acme', undefined, undefined, false, undefined, undefined, undefined, undefined, ['BALLOWED'], 'BSELF');
    const received: SlackMessageData[] = [];
    adapter.onMessage(m => received.push(m));
    for (let n = 1; n <= 4; n++) {
      handler({ event: { type: 'message', channel: 'C1', user: 'UUNKNOWN', ts: `${n}.0` }, ack: async () => {} });
      await (adapter as any).inbound.get('C1');
      assert.equal(received.length, n >= 3 ? n - 2 : 0, 'unverified senders are dropped, verified humans pass');
      assert.equal(calls, Math.min(n, 3), 'neither a refusal nor an inconclusive answer is cached as human');
      now += 30_000;
    }
    assert.equal(received[0].authorName, 'verified');
  });
}

for (const botMessages of [undefined, 'all'] as const) {
  test(`unverifiable authors retain best-effort delivery with policy ${botMessages}`, async () => {
    let handler: any;
    let calls = 0;
    const adapter = new SlackAdapter({
      users: { info: async () => { calls++; throw Object.assign(new Error('missing_scope'), { code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } }); } },
    } as any, { on: (_: string, h: any) => { handler = h; } } as any,
    'UBOT', 'acme', undefined, undefined, false, undefined, undefined, undefined, undefined, botMessages, 'BSELF');
    const received: SlackMessageData[] = [];
    adapter.onMessage(m => received.push(m));
    for (const ts of ['1.0', '2.0']) {
      handler({ event: { type: 'message', channel: 'C1', user: 'UUNKNOWN', ts }, ack: async () => {} });
      await (adapter as any).inbound.get('C1');
    }
    assert.equal(received.length, 2);
    assert.equal(received[0].authorName, 'UUNKNOWN');
    assert.equal(received[0].isBot, undefined);
    assert.equal(received[1].isBot, undefined);
    assert.equal(calls, 1, 'legacy permanent-refusal caching is unchanged');
  });
}

test('user-less admitted bots keep Slack username, with bot ID fallback', async () => {
  const { emit, received } = makeAdapter({ botMessages: ['B1'] });
  const event = { type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B1', ts: '1.0' };
  await emit({ ...event, username: 'Deploy notifier' });
  await emit(event);
  assert.deepEqual(received.map(m => m.authorName), ['Deploy notifier', 'B1']);
  assert.deepEqual(received.map(m => m.authorId), ['B1', 'B1']);
});

// #66 bot review 1 round 2: listed unknowns pass conservatively; unlisted
// unknowns fail closed, including user-only bots without metadata.
function verificationAdapter(info: (args: { user: string }) => Promise<any>, policy = ['UALLOWED', 'BALLOWED']) {
  return new SlackAdapter({ users: { info } } as any, { on() {} } as any,
    'UBOT', 'acme', undefined, undefined, false, undefined, undefined, undefined, undefined, policy, 'BSELF') as any;
}
const verificationEvent = { type: 'message', channel: 'C1', user: 'UALLOWED', ts: '1.0', text: '' };

for (const failure of ['refusal', 'timeout', 'inconclusive']) {
  test(`explicitly listed user or bot survives ${failure} without asserting human`, async () => {
    const adapter = verificationAdapter(async () => {
      if (failure === 'inconclusive') return { user: { name: 'unknown' } };
      throw Object.assign(new Error(failure), failure === 'refusal' ? { code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } } : {});
    });
    for (const identity of [{ user: 'UALLOWED' }, { user: 'UOTHER', bot_id: 'BALLOWED' }]) {
      const msg = await adapter.prepareMessageEvent({ ...verificationEvent, ...identity });
      assert.ok(msg);
      assert.equal(msg.isBot, true);
      assert.equal(msg.senderKind, 'bot');
    }
    assert.equal(await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UUNLISTED' }), undefined);
  });
}

for (const failure of ['unclassified error', 'timeout', 'inconclusive']) {
  test(`verification failures have a cooldown, coalesce in flight, and recover as verified humans: ${failure}`, { timeout: 30_000 }, async (t) => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    let calls = 0;
    let recovering = false;
    let finish!: (value: any) => void;
    let fail!: (error: Error) => void;
    let signalStart!: () => void;
    let started = new Promise<void>(resolve => { signalStart = resolve; });
    const adapter = verificationAdapter(async () => {
      calls++;
      if (calls > 1 && !recovering) throw new Error('unexpected retry within cooldown');
      return new Promise((resolve, reject) => { finish = resolve; fail = reject; signalStart(); });
    });
    const event = { ...verificationEvent, user: 'UUNKNOWN' };
    const batch = Array.from({ length: 25 }, (_, n) =>
      adapter.prepareMessageEvent({ ...event, channel: `C${n}`, text: '<@UUNKNOWN>' }));
    await started;
    assert.equal(calls, 1, 'same author across concurrent events shares an in-flight lookup');
    if (failure === 'inconclusive') finish({ user: { name: 'not-verified' } });
    else fail(Object.assign(new Error(failure), failure === 'unclassified error' ? { data: { error: 'missing_scope' } } : {}));
    assert.ok((await Promise.all(batch)).every(m => m === undefined));
    for (let n = 0; n < 25; n++) assert.equal(await adapter.prepareMessageEvent(event), undefined);
    assert.equal(calls, 1, 'negative verification cooldown suppresses repeated requests');
    assert.equal(adapter.userNameCache.has('UUNKNOWN'), failure === 'inconclusive', 'only resolved names are retained');
    assert.equal(adapter.verifiedUsers.has('UUNKNOWN'), false);
    now += 29_999;
    assert.equal(await adapter.prepareMessageEvent(event), undefined);
    assert.equal(calls, 1, 'cooldown lasts 30 seconds');
    now++;
    recovering = true;
    started = new Promise<void>(resolve => { signalStart = resolve; });
    const retry = adapter.prepareMessageEvent(event);
    await started;
    assert.equal(calls, 2, 'retry after cooldown');
    finish({ user: { name: 'human', is_bot: false } });
    const msg = await retry;
    assert.ok(msg);
    assert.equal(msg.isBot, undefined);
    assert.equal(msg.authorName, 'human');
    assert.equal(adapter.verificationFailures.size, 0, 'success clears negative entry');
  });
}

for (const permanent of [false, true]) {
test(`negative verification cache evicts oldest failures (permanent=${permanent})`, async t => {
  t.mock.method(Date, 'now', () => 1000);
  let calls = 0;
  const adapter = verificationAdapter(async () => { calls++; throw permanent
    ? Object.assign(new Error('missing_scope'), { code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } })
    : new Error('offline'); });
  for (let n = 0; n < 257; n++) {
    assert.equal(await adapter.prepareMessageEvent({ ...verificationEvent, user: `U${n}` }), undefined);
  }
  assert.equal(adapter.verificationFailures.size, 256);
  await adapter.prepareMessageEvent({ ...verificationEvent, user: 'U256' });
  assert.equal(calls, 257, 'newest entry remains cooled down');
  await adapter.prepareMessageEvent({ ...verificationEvent, user: 'U0' });
  assert.equal(calls, 258, 'oldest evicted entry can retry');
});
}

test('shipped bot fragment qualifies permanent refusal retention by mode', t => {
  const path = new URL('../changelog.d/opt-in-bot-messages.added.md', import.meta.url);
  if (!existsSync(path)) return t.skip('pending fragment consumed at release');
  const fragment = readFileSync(path, 'utf8');
  assert.match(fragment, /Permanent refusals remain cached until restart in unset and `all` modes;\s+allow-list mode can retry them after eviction from its bounded negative cache\./);
});

for (const kind of ['timeout', 'inconclusive', 'limited', 'refused']) {
  test(`list verification logs addressed drops once per failure window: ${kind}`, async t => {
    let now = 1000;
    let calls = 0;
    const logs: string[] = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
    const adapter = verificationAdapter(async (args: { user: string }) => {
      if (args.user === 'UBOT') return { user: { name: 'self', is_bot: true } };
      calls++;
      if (kind === 'inconclusive') return { user: {} };
      throw Object.assign(new Error('private upstream detail'), kind === 'limited'
        ? { code: 'slack_webapi_rate_limited_error', retryAfter: 60 }
        : kind === 'refused' ? { code: 'slack_webapi_platform_error', data: { error: 'user_not_found' } } : {});
    });
    const event = { ...verificationEvent, user: 'UUNKNOWN' };
    assert.equal(await adapter.prepareMessageEvent(event), undefined); // ambient must not consume the warning
    assert.equal(calls, 1, 'ambient message performed verification');
    assert.ok(adapter.verificationFailures.has('UUNKNOWN'), 'ambient failure is cached before direct address');
    assert.equal(logs.length, 0);
    now += 10_000;
    for (const addressed of [{ text: '<@UBOT>' }, { channel: 'D1', channel_type: 'im' }]) {
      assert.equal(await adapter.prepareMessageEvent({ ...event, ...addressed }), undefined);
      assert.equal(logs.length, 1, 'the mention logs before the DM can mask it');
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Dropped addressed message from UUNKNOWN.*users.info/);
    if (kind === 'refused') assert.match(logs[0], /\(user_not_found\).*restart.*allow-list/);
    else assert.match(logs[0], kind === 'limited' ? /retry after 50 seconds/ : /retry after 20 seconds/);
    assert.ok(!logs[0].includes('private upstream detail'));
    now += 30_000;
    await adapter.prepareMessageEvent({ ...event, channel: 'D1' });
    assert.equal(calls, kind === 'limited' || kind === 'refused' ? 1 : 2);
    now += 30_000;
    await adapter.prepareMessageEvent({ ...event, channel: 'D1' });
    assert.equal(calls, kind === 'refused' ? 1 : kind === 'limited' ? 2 : 3);
    assert.equal(logs.length, calls);
  });
}

test('list verification preserves rate limit waits for DM name resolution', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const adapter = verificationAdapter(async () => {
    throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 60 });
  });
  let errors = await adapter.resolveUserNames(['UUNKNOWN']);
  assert.deepEqual(waitToAskAgain(errors.get('UUNKNOWN'), 'users.info'),
    { method: 'users.info', seconds: 60, why: 'limited' });
  now += 10_000;
  errors = await adapter.resolveUserNames(['UUNKNOWN']);
  assert.deepEqual(waitToAskAgain(errors.get('UUNKNOWN'), 'users.info'),
    { method: 'users.info', seconds: 50, why: 'limited' });
  assert.equal(adapter.userNameCache.has('UUNKNOWN'), false);
});

test('list-mode DM listing waits out Retry-After and registers the resolved name', async t => {
  let now = 1000;
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  const adapter = verificationAdapter(async () => {
    if (++calls === 1) throw Object.assign(new Error('limited'), {
      code: 'slack_webapi_rate_limited_error', retryAfter: 60,
    });
    return { user: { name: 'alice', is_bot: false } };
  });
  const waits: unknown[] = [];
  const dm = await adapter.describeConversation({ id: 'D1', is_im: true, user: 'UALICE' }, {
    waitOut: async (wait: { seconds: number }) => { waits.push(wait); now += wait.seconds * 1000; },
  });
  assert.equal(dm.name, 'alice');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [{ method: 'users.info', seconds: 60, why: 'limited' }]);
});

// Nightly R2 regressions.
test('R2-1: an unsent deadline lookup cannot poison live admission', async t => {
  const { WebClient } = await import('@slack/web-api');
  const { SlackWebClient, withCallTime, OutOfCallTime } = await import('../src/slack-adapter.js');
  let calls = 0;
  t.mock.method(WebClient.prototype, 'apiCall', async () => {
    calls++;
    return { ok: true, user: { name: 'human', is_bot: false } };
  });
  const adapter = new SlackAdapter(new SlackWebClient(undefined, { timeout: 10_000 }) as any,
    { on() {} } as any, 'UBOT', 'acme', undefined, undefined, false, undefined,
    undefined, undefined, undefined, ['BCI'], 'BSELF') as any;
  const errors = await withCallTime<Map<string, unknown>>(Date.now() - 20_000, () => adapter.resolveUserNames(['UHUMAN']));
  assert.ok(errors.get('UHUMAN') instanceof OutOfCallTime);
  assert.equal(calls, 0);
  assert.equal(adapter.verificationFailures.size, 0);
  const msg = await adapter.prepareMessageEvent({ ...verificationEvent, channel: 'D1', user: 'UHUMAN' });
  assert.equal(msg.authorName, 'human');
  assert.equal(calls, 1);
});

for (const [label, error, seconds, why] of [
  ['network', { code: 'slack_webapi_request_error' }, 30, 'failed'],
  ['HTTP', { code: 'slack_webapi_http_error' }, 30, 'failed'],
  ['internal', { code: 'slack_webapi_platform_error', data: { error: 'internal_error' } }, 30, 'failed'],
  ['HTTP-200 limit', { code: 'slack_webapi_platform_error', data: { error: 'ratelimited', response_metadata: { retryAfter: 60 } } }, 60, 'limited'],
] as const) {
  test(`R2-2: DM naming preserves ${label} and remaining cooldown`, async t => {
    let now = 1000;
    let calls = 0;
    t.mock.method(Date, 'now', () => now);
    const adapter = verificationAdapter(async () => {
      if (++calls === 1) throw Object.assign(new Error(label), error);
      return { user: { name: 'alice', is_bot: false } };
    });
    const errors = await adapter.resolveUserNames(['UALICE']);
    assert.deepEqual(waitToAskAgain(errors.get('UALICE'), 'users.info'),
      { method: 'users.info', seconds, why });
    assert.equal(adapter.userNameCache.has('UALICE'), false);
    now += 10_000;
    const waits: unknown[] = [];
    const dm = await adapter.describeConversation({ id: 'D1', is_im: true, user: 'UALICE' }, {
      waitOut: async (wait: { seconds: number }) => { waits.push(wait); now += wait.seconds * 1000; },
    });
    assert.equal(dm.name, 'alice');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [{ method: 'users.info', seconds: seconds - 10, why }]);
  });
}

test('R2-3: list startup requires users:read only when scopes are known', () => {
  for (const policy of [undefined, 'all', ['B1']] as const) {
    for (const scopes of [undefined, [], ['chat:write'], ['users:read']]) {
      const construct = () => new SlackAdapter({} as any, { on() {} } as any, 'UBOT', 'acme',
        undefined, undefined, false, undefined, scopes,
        undefined, undefined, Array.isArray(policy) ? [...policy] : policy as 'all' | undefined, 'BSELF');
      if (Array.isArray(policy) && scopes?.[0] === 'chat:write') assert.throws(construct, /users:read/);
      else assert.doesNotThrow(construct);
    }
  }
});

test('R2-4: dropped authors do not resolve 256 mentions or lose their drop log', async t => {
  t.mock.method(Date, 'now', () => 1000);
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  let calls = 0;
  const adapter = verificationAdapter(async () => { calls++; throw new Error('offline'); });
  const event = { ...verificationEvent, user: 'UHUMAN', channel: 'D1',
    text: Array.from({ length: 256 }, (_, i) => `<@U${i}>`).join(' ') };
  assert.equal(await adapter.prepareMessageEvent(event), undefined);
  assert.equal(await adapter.prepareMessageEvent(event), undefined);
  assert.equal(calls, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /UHUMAN/);
});

test('R2-5: Slackbot is a bot only under opt-in, despite is_bot false', async () => {
  for (const botMessages of [undefined, 'all', ['BOTHER'], ['USLACKBOT']] as const) {
    let lookups = 0;
    const { emit, received, web } = makeAdapter({
      botMessages: typeof botMessages === 'object' ? [...botMessages] : botMessages,
    });
    const info = web.users.info;
    web.users.info = (...args: any[]) => { lookups++; return info(...args); };
    await emit({ type: 'message', channel: 'D1', user: 'USLACKBOT', ts: '1.0', text: 'reminder' });
    assert.equal(received.length, botMessages?.[0] === 'BOTHER' ? 0 : 1);
    assert.equal(lookups, botMessages?.[0] === 'BOTHER' ? 0 : 1);
    if (received.length) assert.equal(received[0].isBot, botMessages ? true : undefined);
  }
});

// R3: use controlled promises, not timing thresholds, to prove lookup ordering.
for (const policy of [undefined, 'all', ['UALLOWED']] as const) {
  test(`R3-1: author and mentions start together when admission needs no lookup: ${policy}`, { timeout: 30_000 }, async () => {
    const started: string[] = [];
    let bothStarted!: () => void;
    const ready = new Promise<void>(resolve => { bothStarted = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    const adapter = new SlackAdapter({ users: { info: async ({ user }: { user: string }) => {
      started.push(user);
      if (started.length === 2) bothStarted();
      await blocked;
      return { user: { name: user, is_bot: false } };
    } } } as any, { on() {} } as any, 'UBOT', 'acme', undefined, undefined,
    false, undefined, undefined, undefined, undefined, policy as any, 'BSELF') as any;
    const preparation = adapter.prepareMessageEvent({ ...verificationEvent, text: '<@UMENTION>' });
    await ready;
    try { assert.deepEqual(started.sort(), ['UALLOWED', 'UMENTION']); }
    finally { release(); await preparation; }
  });
}

for (const method of ['chat.postMessage', 'conversations.history']) {
  test(`R3-2: HTTP-200 ratelimited does not resend ${method}`, async t => {
    const { WebClient } = await import('@slack/web-api');
    const { SlackWebClient, withCallTime } = await import('../src/slack-adapter.js');
    let calls = 0;
    const error = Object.assign(new Error('ratelimited'), {
      code: 'slack_webapi_platform_error',
      data: { error: 'ratelimited', response_metadata: { retryAfter: 1 } },
    });
    t.mock.method(WebClient.prototype, 'apiCall', async () => {
      if (++calls === 1) throw error;
      return { ok: true };
    });
    const client = new SlackWebClient(undefined, { timeout: 10_000 });
    await assert.rejects(withCallTime(Date.now(), () => client.apiCall(method, {})), e => e === error);
    assert.equal(calls, 1);
    assert.deepEqual(waitToAskAgain(error, method), { method, seconds: 30, why: 'failed' });
  });
}

test('R3-3: a short host call cannot join a live verification', async () => {
  const { withCallTime, OutOfCallTime } = await import('../src/slack-adapter.js');
  let release!: (value: any) => void;
  const adapter = verificationAdapter(() => new Promise(r => { release = r; }));
  const live = adapter.verifyListUser({ user: 'UHUMAN' });
  const host = withCallTime(Date.now() - 20_000, () => adapter.verifyListUser({ user: 'UHUMAN' }));
  const outcome = host.then(() => 'resolved', (error: unknown) => error);
  try {
    // Keep the live lookup blocked. A missing guard leaves the host pending
    // after a turn instead of rejecting on the deadline start rule.
    const observed = await Promise.race([
      outcome,
      new Promise(resolve => setImmediate(() => resolve('still waiting on live lookup'))),
    ]);
    assert.ok(observed instanceof OutOfCallTime, String(observed));
  } finally {
    release({ user: { name: 'human', is_bot: false } });
    await Promise.allSettled([live, host]);
  }
});

test('all-mode short host call rejects before a held live lookup settles', async () => {
  const { withCallTime, OutOfCallTime } = await import('../src/slack-adapter.js');
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  const internal = adapter as any;
  let release!: (value: any) => void;
  let calls = 0;
  web.users.info = (() => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  }) as any;
  const live = internal.lookupAllUser({ user: 'UHUMAN' });
  const host = withCallTime(Date.now() - 20_000, () => internal.lookupAllUser({ user: 'UHUMAN' }));
  const outcome = host.then(() => 'resolved', (error: unknown) => error);
  try {
    // The live request stays blocked through an entire event-loop turn. Removing
    // the join guard must fail here, rather than leave the test hanging.
    const observed = await Promise.race([
      outcome,
      new Promise(resolve => setImmediate(() => resolve('still waiting on live lookup'))),
    ]);
    assert.ok(observed instanceof OutOfCallTime, String(observed));
    assert.equal(calls, 1, 'the host neither joins nor starts a second Slack request');
  } finally {
    release({ user: { name: 'human', is_bot: false } });
    await Promise.allSettled([live, host]);
  }
});

test('R3-3: live verification retries a joined host deadline failure', { timeout: 30_000 }, async () => {
  const { withCallTime, OutOfCallTime } = await import('../src/slack-adapter.js');
  let reject!: (e: unknown) => void;
  let calls = 0;
  const adapter = verificationAdapter(async () => {
    if (++calls === 1) return new Promise((_, r) => { reject = r; });
    return { user: { name: 'human', is_bot: false } };
  });
  const host = withCallTime(Date.now(), () => adapter.verifyListUser({ user: 'UHUMAN' }));
  const live = adapter.verifyListUser({ user: 'UHUMAN' });
  assert.equal(calls, 1, 'the live caller joined the held host lookup before release');
  reject(new OutOfCallTime('users.info', 25));
  await assert.rejects(host, OutOfCallTime);
  assert.equal((await live).user.name, 'human');
  assert.equal(calls, 2);
  assert.equal(adapter.verificationFailures.size, 0);
});

test('R3-5: all-mode Slackbot stays bot when lookup fails', async () => {
  const adapter = new SlackAdapter({ users: { info: async () => { throw new Error('offline'); } } } as any,
    { on() {} } as any, 'UBOT', 'acme', undefined, undefined, false,
    undefined, undefined, undefined, undefined, 'all', 'BSELF') as any;
  const msg = await adapter.prepareMessageEvent({ ...verificationEvent, user: 'USLACKBOT' });
  assert.equal(msg.isBot, true);
  assert.equal(msg.senderKind, 'bot');
});

test('R3-9: remaining verification waits preserve fractional expiry', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const adapter = verificationAdapter(async () => { throw new Error('offline'); });
  await adapter.resolveUserNames(['UHUMAN']);
  now += 10001;
  const errors = await adapter.resolveUserNames(['UHUMAN']);
  assert.equal(waitToAskAgain(errors.get('UHUMAN'), 'users.info')?.seconds, 19.999);
});

test('review 10: addressed lookup failure logs even after concurrent cache eviction', async t => {
  const logs: string[] = [];
  const evictedAtLog: boolean[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.join(' '));
    evictedAtLog.push(!adapter.verificationFailures.has('UFIRST'));
  });
  const adapter = verificationAdapter(async () => { throw new Error('offline'); });
  const addressed = Array.from({ length: 10 }, () => adapter.prepareMessageEvent({ ...verificationEvent, user: 'UFIRST', channel: 'D1', channel_type: 'im' }));
  // Start after preparation's ack yield: these failures evict the author's
  // entry before the resolver returns its errors to admission.
  await Promise.resolve();
  const others = Array.from({ length: 257 }, (_, n) => adapter.resolveUserNames([`U${n}`]));
  await Promise.all([...addressed, ...others]);
  assert.equal(adapter.verificationFailures.has('UFIRST'), false);
  assert.equal(logs.filter(line => line.includes('Dropped addressed message from UFIRST')).length, 1);
  assert.deepEqual(evictedAtLog, [true], 'eviction preceded the warning');
});


test('already verified unlisted authors keep mention lookups batched', async t => {
  const adapter = verificationAdapter(async ({ user }) => ({ user: { name: user, is_bot: false } }));
  await adapter.resolveUserNames(['UHUMAN']);
  assert.equal(adapter.verifiedUsers.has('UHUMAN'), true);
  const resolve = adapter.resolveUserNames.bind(adapter);
  const batches: unknown[] = [];
  t.mock.method(adapter, 'resolveUserNames', (ids: string[]) => { batches.push(ids); return resolve(ids); });
  const message = await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UHUMAN', text: '<@UMENTION>' });
  assert.ok(message);
  assert.deepEqual(batches, [['UHUMAN', 'UMENTION']]);
});

test('review: cooldown hits retain one diagnostic identity after eviction', async t => {
  t.mock.method(Date, 'now', () => 1000);
  const logs: string[] = [];
  const evictedAtLog: boolean[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.join(' '));
    evictedAtLog.push(!adapter.verificationFailures.has('UFIRST'));
  });
  const adapter = verificationAdapter(async () => { throw new Error('offline'); });
  await adapter.resolveUserNames(['UFIRST']);
  const cached = adapter.verificationFailures.get('UFIRST');
  const errors = await adapter.resolveUserNames(['UFIRST']);
  assert.equal(errors.get('UFIRST'), cached.error);
  assert.equal(cached.retryAt, cached.error.retryAt);
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const resolve = adapter.resolveUserNames.bind(adapter);
  t.mock.method(adapter, 'resolveUserNames', async (ids: string[], ...rest: any[]) => {
    const result = await resolve(ids, ...rest);
    if (ids.includes('UFIRST')) await barrier;
    return result;
  });
  const addressed = Array.from({ length: 10 }, () => adapter.prepareMessageEvent({ ...verificationEvent, user: 'UFIRST', channel: 'D1', channel_type: 'im' }));
  await Promise.resolve();
  await Promise.all(Array.from({ length: 257 }, (_, n) => adapter.resolveUserNames([`U${n}`])));
  release();
  await Promise.all(addressed);
  assert.equal(adapter.verificationFailures.has('UFIRST'), false);
  assert.equal(logs.filter(line => line.includes('Dropped addressed message from UFIRST')).length, 1);
  assert.deepEqual(evictedAtLog, [true], 'cooldown warning follows eviction');
});
test('review: shared retry waits retain legacy numeric values', () => {
  for (const seconds of [0.5, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(waitToAskAgain({ code: 'slack_webapi_rate_limited_error', retryAfter: seconds }, 'users.info'),
      { method: 'users.info', seconds, why: 'limited' });
  }
});

for (const initialLookup of ['live', 'history-name'] as const) {
  test(`all mode retries inconclusive ${initialLookup} classification despite a returned name`, async () => {
    let calls = 0;
    const adapter = new SlackAdapter({ users: { info: async () => {
      calls++;
      return { user: calls === 1 ? { name: 'Alice' } : { name: 'Alice', is_bot: false } };
    } } } as any, { on() {} } as any, 'UBOT', 'acme', undefined,
      undefined, false, undefined, undefined, undefined, undefined, 'all', 'BSELF') as any;
    const event = { ...verificationEvent, user: 'UHUMAN' };
    if (initialLookup === 'live') {
      assert.equal((await adapter.prepareMessageEvent(event)).isBot, undefined);
    } else {
      await adapter.resolveUserNames(['UHUMAN']);
    }
    assert.equal(adapter.userNameCache.get('UHUMAN'), 'Alice');
    assert.equal(adapter.verifiedUsers.has('UHUMAN'), false);
    const recovered = await adapter.prepareMessageEvent(event);
    assert.equal(calls, 2);
    assert.equal(recovered.isBot, undefined);
    assert.equal(recovered.authorName, 'Alice');
    await adapter.prepareMessageEvent(event);
    assert.equal(calls, 2, 'conclusive classification remains cached');
  });
}

test('missing-scope verification explains repair and identifies an unreplayed drop', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  const adapter = verificationAdapter(async () => {
    throw Object.assign(new Error('scope'), {
      code: 'slack_webapi_platform_error', data: { error: 'missing_scope' },
    });
  });
  await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UUNKNOWN', channel: 'D1', ts: '42.1' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /in D1 at 42.1.*not replayed/);
  assert.match(logs[0], /add users:read and reinstall the app.*restart/);
});

test('newly classified and cached unlisted bots spend no mention lookups or human cooldowns', async () => {
  const calls: string[] = [];
  const adapter = verificationAdapter(async ({ user }) => {
    calls.push(user);
    if (user === 'UMENTION') throw new Error('transient');
    return { user: { name: user, is_bot: user === 'UOTHERBOT' } };
  });
  for (let n = 0; n < 2; n++) {
    assert.equal(await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UOTHERBOT', text: '<@UMENTION>' }), undefined);
  }
  assert.deepEqual(calls, ['UOTHERBOT']);
  assert.equal(adapter.verificationFailures.has('UMENTION'), false);
});

test('list-mode DM naming retains inconclusive display names without waiting, then retries classification', async t => {
  let calls = 0;
  let now = 1000;
  t.mock.method(clock, 'now', () => now);
  const adapter = verificationAdapter(async () => {
    calls++;
    return { user: { profile: { display_name: 'Alice' }, ...(calls > 1 ? { is_bot: false } : {}) } };
  });
  const dm = await adapter.describeConversation({ id: 'D1', is_im: true, user: 'UALICE' },
    { waitOut: async () => { assert.fail('name already resolved'); } });
  assert.equal(dm.name, 'Alice');
  assert.equal(adapter.verifiedUsers.has('UALICE'), false);
  assert.equal(await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UALICE' }), undefined);
  now += 30_000;
  assert.equal((await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UALICE' })).authorName, 'Alice');
  assert.equal(calls, 2);
});

for (const error of ['missing_scope', 'user_not_found']) {
  test(`all-mode permanent ${error} settles an earlier inconclusive name`, async () => {
    let calls = 0;
    const adapter = new SlackAdapter({ users: { info: async () => {
      if (++calls === 1) return { user: { name: 'Alice' } };
      throw Object.assign(new Error(error), { code: 'slack_webapi_platform_error', data: { error } });
    } } } as any, { on() {} } as any, 'UBOT', 'acme', undefined,
      undefined, false, undefined, undefined, undefined, undefined, 'all', 'BSELF') as any;
    await adapter.resolveUserNames(['UALICE']);
    await adapter.resolveUserNames(['UALICE']);
    await adapter.resolveUserNames(['UALICE']);
    assert.equal(calls, 2);
    assert.equal(adapter.inconclusiveNames.has('UALICE'), false);
    assert.equal(adapter.userNameCache.get('UALICE'), 'Alice');
    assert.equal(adapter.verifiedUsers.has('UALICE'), false);
  });
}

test('all-mode inconclusive names evict oldest without preventing later verification', async () => {
  let conclusive = false;
  const adapter = new SlackAdapter({ users: { info: async () => ({
    user: { name: 'Alice', ...(conclusive ? { is_bot: false } : {}) },
  }) } } as any, { on() {} } as any, 'UBOT', 'acme', undefined,
    undefined, false, undefined, undefined, undefined, undefined, 'all', 'BSELF') as any;
  for (let i = 0; i < 257; i++) await adapter.resolveUserNames([`U${i}`]);
  assert.equal(adapter.inconclusiveNames.size, 256);
  assert.equal(adapter.inconclusiveNames.has('U0'), false);
  assert.equal(adapter.userNameCache.has('U0'), false);
  assert.equal(adapter.userNameCache.get('U256'), 'Alice');
  conclusive = true;
  await adapter.resolveUserNames(['U0']);
  assert.equal(adapter.verifiedUsers.has('U0'), true);
  assert.equal(adapter.userNameCache.get('U0'), 'Alice');
});




test('newly verified unlisted human resolves mentions after admission', async () => {
  const calls: string[] = [];
  const adapter = verificationAdapter(async ({ user }: { user: string }) => {
    calls.push(user);
    return { user: { name: user === 'UMENTION' ? 'mentioned' : 'human', is_bot: false } };
  });
  const msg = await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UHUMAN', text: '<@UMENTION>' });
  assert.deepEqual(calls, ['UHUMAN', 'UMENTION']);
  assert.equal(msg.cleanContent, '@mentioned (uid:UMENTION)');
});




test('addressed-drop diagnostic follows original text, not supplemental mentions', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  const adapter = verificationAdapter(async () => { throw new Error('offline'); });
  const event = { ...verificationEvent, user: 'UUNKNOWN', text: 'status', attachments: [{ text: '<@UBOT>' }] };
  assert.equal(await adapter.prepareMessageEvent(event), undefined);
  assert.deepEqual(logs, [], 'a mention only in rendered attachment text is not addressing');
  assert.equal(await adapter.prepareMessageEvent({ ...event, text: '<@UBOT>' }), undefined);
  assert.equal(logs.length, 1);
});

test('a rate limit without Retry-After uses the 30-second verification cooldown', async t => {
  let now = 1000;
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  const adapter = verificationAdapter(async () => {
    calls++;
    throw Object.assign(new Error('limited'), { code: 'slack_webapi_platform_error', data: { error: 'ratelimited' } });
  });
  const event = { ...verificationEvent, user: 'UUNKNOWN' };
  assert.equal(await adapter.prepareMessageEvent(event), undefined);
  now += 29_999;
  assert.equal(await adapter.prepareMessageEvent(event), undefined);
  assert.equal(calls, 1);
  now++;
  assert.equal(await adapter.prepareMessageEvent(event), undefined);
  assert.equal(calls, 2);
});



for (const scopes of [undefined, ['chat:write', 'channels:read', 'groups:read', 'im:read', 'mpim:read']] as const) {
  test(`all-mode missing users:read warns once and does not classify unknown humans as bots (${scopes ? 'known' : 'unknown'} scopes)`, async t => {
    const logs: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
    let calls = 0;
    const adapter = new SlackAdapter({ users: { info: async () => {
      calls++;
      throw Object.assign(new Error('missing_scope'), {
        code: 'slack_webapi_platform_error', data: { error: 'missing_scope' },
      });
    } } } as any, { on() {} } as any, 'UBOT', 'acme', undefined, undefined,
    false, undefined, scopes ? [...scopes] : undefined, undefined, undefined, 'all', 'BSELF') as any;
    assert.equal(logs.length, scopes ? 1 : 0, 'known missing scopes warn at construction, before any lookup');
    if (scopes) assert.match(logs[0], /users:read.*reinstall/i);
    for (const user of ['UALICE', 'UBOB', 'UALICE']) {
      const msg = await adapter.prepareMessageEvent({ ...verificationEvent, user, text: '<@UBOT>' });
      assert.equal(msg.isBot, undefined, 'a refusal is not evidence of a bot');
      assert.equal(adapter.verifiedUsers.has(user), false, 'unknown is not verified human');
    }
    const bot = await adapter.prepareMessageEvent({ ...verificationEvent, user: 'UAPP', bot_id: 'BAPP' });
    assert.equal(bot.isBot, true, 'explicit bot evidence still applies');
    assert.equal(calls, 4, 'permanent refusals still cache per identity, including the mention');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /users:read.*reinstall/i);
  });
}

test('review 11-5: concurrent inconclusive-name eviction cannot resurrect an untracked name', async () => {
  let conclusive = false;
  let calls = 0;
  const adapter = new SlackAdapter({ users: { info: async () => {
    calls++;
    return { user: { name: 'Alice', ...(conclusive ? { is_bot: true } : {}) } };
  } } } as any, { on() {} } as any, 'UBOT', 'acme', undefined, undefined,
    false, undefined, undefined, undefined, undefined, 'all', 'BSELF') as any;
  // Queue all wrappers before any shared-resolver cache continuation.
  await Promise.all(Array.from({ length: 257 }, (_, i) => adapter.resolveUserNames([`U${i}`])));
  assert.equal(adapter.inconclusiveNames.size, 256);
  assert.equal(adapter.inconclusiveNames.has('U0'), false);
  assert.equal(adapter.userNameCache.has('U0'), false);
  conclusive = true;
  const msg = await adapter.prepareMessageEvent({ ...verificationEvent, user: 'U0' });
  assert.equal(calls, 258, 'evicted identity is classified again');
  assert.equal(msg.isBot, true);
});

test('review 11-6: a later list-mode chunk reuses an identity verified by another batch', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const adapter = verificationAdapter(async ({ user }) => {
    calls.push(user);
    if (user !== 'ULATER') await held;
    return { user: user === 'ULATER' && calls.filter(id => id === user).length > 1
      ? { name: 'inferior' } : { name: user, is_bot: false } };
  });
  const batch = adapter.resolveUserNames([...Array.from({ length: 8 }, (_, i) => `U${i}`), 'ULATER']);
  try {
    await adapter.resolveUserNames(['ULATER']);
  } finally {
    release();
  }
  await batch;
  assert.equal(calls.filter(id => id === 'ULATER').length, 1);
  assert.equal(adapter.userNameCache.get('ULATER'), 'ULATER');
  assert.equal(adapter.verificationFailures.has('ULATER'), false);
});

test('all-mode unclassified refusal-shaped errors cannot settle or overwrite names', async () => {
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  const internal = adapter as any;
  web.users.info = async () => ({ user: { name: 'known' } });
  await internal.resolveUserNames(['U1']);
  web.users.info = async () => { throw { data: { error: 'missing_scope' } }; };
  const errors = await internal.resolveUserNames(['U1', 'U2']);
  assert.equal(errors.has('U1'), true);
  assert.equal(internal.userNameCache.get('U1'), 'known');
  assert.equal(internal.userNameCache.has('U2'), false);
});


test('list-mode rechecks bot identity after yielding before mention lookups', async () => {
  const { adapter, web } = makeAdapter({ botMessages: ['BOTHER'] });
  const internal = adapter as any;
  const calls: string[] = [];
  web.users.info = async ({ user }: { user: string }) => {
    calls.push(user);
    return { user: { name: user, is_bot: false } };
  };
  const pending = internal.prepareMessageEvent({
    type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: '<@UMENTION>',
  });
  internal.botUsers.add('U1');
  internal.verifiedUsers.add('U1');
  assert.equal(await pending, undefined);
  assert.deepEqual(calls, []);
});

for (const failure of [
  Object.assign(new Error('limited'), {code: 'slack_webapi_platform_error', data: {error: 'ratelimited'}}),
  new Error('Retry header did not contain a valid timeout (url: users.info, retry-after header: undefined)'),
]) {
  test(`rate-limit diagnostic identifies missing Retry-After: ${failure.message}`, async t => {
    t.mock.method(Date, 'now', () => 1000);
    const logs: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
    const adapter = verificationAdapter(async () => { throw failure; });
    assert.equal(await adapter.prepareMessageEvent({...verificationEvent, user: 'UUNKNOWN', channel: 'D1'}), undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /rate-limited verification without usable Retry-After; retry after 30 seconds/);
  });
}

test('list-mode inconclusive display names are evicted with negative entries', async () => {
  const adapter = verificationAdapter(async () => ({user: {name: 'inconclusive'}}));
  await Promise.all(Array.from({length: 300}, (_, n) => adapter.resolveUserNames([`U${n}`])));
  assert.equal(adapter.verificationFailures.size, 256);
  assert.equal(adapter.userNameCache.size, 256);
  for (const id of adapter.userNameCache.keys()) assert.ok(adapter.verificationFailures.has(id));
  assert.equal(adapter.verifiedUsers.size, 0);
});

for (const policy of ['all', ['BOTHER'], ['UAPP']] as const) {
  test(`app-as-user bot admission follows opt-in classification: ${policy}`, async () => {
    const adapter = new SlackAdapter({users: {info: async () => ({user: {name: 'app', is_bot: true}})}} as any,
      {on() {}} as any, 'UBOT', 'acme', undefined, undefined, false, undefined, undefined,
      undefined, undefined, typeof policy === 'string' ? policy : [...policy], 'BSELF') as any;
    const msg = await adapter.prepareMessageEvent({...verificationEvent, user: 'UAPP', app_id: 'AAPP'});
    if (policy[0] === 'BOTHER') assert.equal(msg, undefined);
    else assert.equal(msg.isBot, true);
  });
}

for (const failure of [
  Object.assign(new Error('offline'), { code: 'slack_webapi_request_error' }),
  Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 60 }),
]) {
  test(`unset DM timing equals main's unaged wait formula: ${failure.message}`, async t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const { adapter, web } = makeAdapter();
    web.users.info = async ({ user }: { user: string }) => {
      if (user === 'UFIRST') throw failure;
      now += 10_000;
      return { user: { name: 'last' } };
    };
    web.conversations = { list: async () => ({ channels: [
      { id: 'D1', is_im: true, user: 'UFIRST' },
      { id: 'D2', is_im: true, user: 'ULAST' },
    ] }) };
    const result = await adapter.listConversations();
    // d885b862 returns waitToAskAgain at failure, without subtracting listing time.
    const mainWait = waitToAskAgain(failure, 'users.info');
    assert.deepEqual(result.conversations[0].nameWait, mainWait);
    assert.equal(mainWait?.seconds, failure.message === 'offline' ? 30 : 60);
    assert.equal(now, 11_000);
  });
}

for (const elapsed of [0.001, 20, 60, 61]) {
test(`DM name waits subtract ${elapsed}s spent listing later conversations`, async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const adapter = verificationAdapter(async ({user}) => {
    if (user === 'UFIRST') throw Object.assign(new Error('limited'), {
      code: 'slack_webapi_rate_limited_error', retryAfter: 60,
    });
    now += elapsed * 1000;
    return {user: {name: 'last', is_bot: false}};
  });
  adapter.web.conversations = {list: async () => ({channels: [
    {id: 'D1', is_im: true, user: 'UFIRST'},
    {id: 'D2', is_im: true, user: 'ULAST'},
  ]})};
  const result = await adapter.listConversations();
  assert.equal(result.conversations[0].nameWait.seconds, Math.max(0, 60 - elapsed));
  assert.equal(result.conversations[1].name, 'last');
});
}


for (const botMessages of ['all', ['UOTHER']] as const) {
  test(`bot_message subtype overrides human lookup in ${JSON.stringify(botMessages)}`, async () => {
    const { adapter, emit, received } = makeAdapter({ botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages] });
    await (adapter as any).resolveUserNames(['U1']);
    assert.equal((adapter as any).verifiedUsers.has('U1'), true);
    await emit({ type: 'message', subtype: 'bot_message', channel: 'C1', user: 'U1', ts: '1.0' });
    assert.equal(received.length, botMessages === 'all' ? 1 : 0);
    if (received.length) assert.equal(received[0].isBot, true);
  });
}

test('malformed opted-in events return without throwing or looking up names', async () => {
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  let calls = 0;
  web.users.info = async () => { calls++; return { user: { name: 'unexpected' } }; };
  const valid = { type: 'message', channel: 'C1', user: 'U1', ts: '1.0' };
  for (const defect of [{ channel: undefined }, { user: undefined }, { ts: undefined }]) {
    assert.equal(await (adapter as any).prepareMessageEvent({ ...valid, ...defect }), undefined);
  }
  assert.equal(calls, 0, 'malformed events must not start lookups');
});

test('DM allow-list uses bot ID for user-less opted-in posts', async () => {
  for (const dmUsers of [['B1'], ['BOTHER'], []]) {
    const { emit, received } = makeAdapter({ botMessages: 'all', dmUsers });
    await emit({ type: 'message', channel: 'D1', channel_type: 'im', bot_id: 'B1', ts: '1.0' });
    assert.equal(received.length, dmUsers.includes('B1') ? 1 : 0);
    if (received.length) {
      assert.equal(received[0].authorId, 'B1');
      assert.equal(received[0].isDM, true);
      assert.equal(received[0].isBot, true);
    }
  }
});

test('nameless all-mode answer does not suppress a background DM name retry', async () => {
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  const internal = adapter as any;
  web.users.info = async () => ({ user: {} });
  await internal.resolveUserNames(['U1']);
  assert.equal(internal.userNameCache.has('U1'), false);
  let calls = 0;
  web.users.info = async () => {
    if (++calls === 1) throw { code: 'slack_webapi_rate_limited_error', retryAfter: 2 };
    return { user: { name: 'Alice', is_bot: false } };
  };
  const waits: unknown[] = [];
  const dm = await internal.describeConversation({ id: 'D1', is_im: true, user: 'U1' }, {
    waitOut: async (wait: unknown) => { waits.push(wait); },
  });
  assert.deepEqual(waits, [{ method: 'users.info', seconds: 2, why: 'limited' }]);
  assert.equal(calls, 2);
  assert.equal(dm.name, 'Alice');
  assert.equal(dm.nameWait, undefined);
});


for (const botMessages of ['all', ['UOTHER']]) {
  test(`nameless verification preserves an earlier display name in ${JSON.stringify(botMessages)}`, async () => {
    const { adapter, web } = makeAdapter({ botMessages: botMessages as 'all' | string[] });
    const internal = adapter as any;
    web.users.info = async () => ({ user: { name: 'Alice' } });
    await internal.resolveUserNames(['U1']);
    assert.equal(internal.userNameCache.get('U1'), 'Alice');
    web.users.info = async () => ({ user: { is_bot: false } });
    internal.verificationFailures.clear();
    await internal.resolveUserNames(['U1']);
    assert.equal(internal.verifiedUsers.has('U1'), true);
    assert.equal(internal.userNameCache.get('U1'), 'Alice');
  });
}

test('an initially empty all-mode profile waits before announcing a DM label', async t => {
  t.mock.method(Date, 'now', () => 1000);
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  const internal = adapter as any;
  let calls = 0;
  web.users.info = async () => ++calls === 1
    ? { user: {} } : { user: { name: 'Alice', is_bot: false } };
  const waits: unknown[] = [];
  const dm = await internal.describeConversation({ id: 'D1', is_im: true, user: 'U1' }, {
    waitOut: async (wait: unknown) => { waits.push(wait); },
  });
  assert.deepEqual(waits, [{ method: 'users.info', seconds: 30, why: 'failed' }]);
  assert.equal(calls, 2);
  assert.equal(dm.name, 'Alice');
  assert.equal(dm.nameWait, undefined);
});

test('DM listing subtracts elapsed time from the actual fractional verification expiry', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const adapter = verificationAdapter(async ({ user }) => {
    if (user === 'UFIRST') throw new Error('offline');
    now += 950;
    return { user: { name: 'last', is_bot: false } };
  });
  await adapter.resolveUserNames(['UFIRST']);
  now += 29100; // Only 0.9 s of the cached cooldown remains.
  adapter.web.conversations = { list: async () => ({ channels: [
    { id: 'D1', is_im: true, user: 'UFIRST' },
    { id: 'D2', is_im: true, user: 'ULAST' },
  ] }) };
  const result = await adapter.listConversations();
  assert.equal(result.conversations[0].nameWait.seconds, 0);
});

for (const botMessages of ['all', ['U1']]) {
  test(`a 257-author batch retains resolved names despite FIFO eviction in ${JSON.stringify(botMessages)}`, async () => {
    const { adapter, web } = makeAdapter({ botMessages: botMessages as 'all' | string[] });
    const internal = adapter as any;
    web.users.info = async ({ user }: { user: string }) => ({ user: { name: `name-${user}` } });
    const rows = Array.from({ length: 257 }, (_, i) => ({ user: `U${i + 1}`, ts: `${i + 1}.0`, text: `<@U${i + 1}>` }));
    const history = await internal.shapeHistory(rows);
    assert.equal(internal.userNameCache.has('U1'), false, 'shared cache remains bounded');
    assert.equal(history.length, 257);
    for (let i = 0; i < history.length; i++) {
      assert.equal(history[i].authorName, `name-U${i + 1}`);
      assert.equal(history[i].content, `@name-U${i + 1} (uid:U${i + 1})`);
    }
    internal.verificationFailures.clear();
    internal.inconclusiveNames.clear();
    internal.userNameCache.clear();
    const live = await internal.prepareMessageEvent({ type: 'message', channel: 'C1', user: 'U1', ts: '300.0',
      text: rows.map(row => row.text).join(' ') });
    assert.equal(live.authorName, 'name-U1');
    assert.equal(live.cleanContent, rows.map((_, i) => `@name-U${i + 1} (uid:U${i + 1})`).join(' '));
  });
}

test('live second host deadline join logs an addressed drop without caching a failure', async t => {
  const { withCallTime, OutOfCallTime } = await import('../src/slack-adapter.js');
  const { adapter, web } = makeAdapter({ botMessages: ['UOTHER'] });
  const internal = adapter as any;
  const rejects: Array<(error: unknown) => void> = [];
  web.users.info = () => new Promise((_, reject) => { rejects.push(reject); });
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  const original = internal.verifyListUser.bind(adapter);
  let secondHost!: Promise<unknown>;
  internal.verifyListUser = (args: { user: string }, retryJoined = true) => {
    if (!retryJoined) {
      // A second host starts in the gap before the live caller's one retry.
      secondHost = withCallTime(Date.now(), () => original(args));
      secondHost.catch(() => {});
    }
    return original(args, retryJoined);
  };
  const firstHost = withCallTime(Date.now(), () => original({ user: 'U1' }));
  const live = internal.prepareMessageEvent({ type: 'message', channel: 'D1', user: 'U1', ts: '1.0' });
  await Promise.resolve(); // prepareMessageEvent yields before resolving names.
  rejects[0](new OutOfCallTime('users.info', 25));
  await assert.rejects(firstHost, OutOfCallTime);
  // Let the retry join the second host before ending that host's budget.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejects.length, 2);
  rejects[1](new OutOfCallTime('users.info', 25));
  await assert.rejects(secondHost, OutOfCallTime);
  assert.equal(await live, undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Dropped addressed message from U1.*joined host calls ran out of time/);
  assert.match(logs[0], /verification did not complete/);
  assert.doesNotMatch(logs[0], /verification was not sent/);
  assert.equal(internal.verificationFailures.size, 0);
  web.users.info = async () => ({ user: { name: 'human', is_bot: false } });
  assert.equal((await internal.prepareMessageEvent({ type: 'message', channel: 'D1', user: 'U1', ts: '2.0' })).authorName, 'human');
});

test('unlisted rejected authors are not rendered, including during cooldown', async () => {
  const { adapter, web } = makeAdapter({ botMessages: ['UOTHER'] });
  let calls = 0;
  web.users.info = async () => { calls++; throw new Error('offline'); };
  const event = { type: 'message', channel: 'C1', user: 'U1', ts: '1.0',
    get blocks(): never { throw new Error('rejected payload must not be rendered'); } };
  assert.equal(await (adapter as any).prepareMessageEvent(event), undefined);
  assert.equal(await (adapter as any).prepareMessageEvent(event), undefined);
  assert.equal(calls, 1);
});

test('joined host deadline failure propagates to another host without retry', async () => {
  const { withCallTime, OutOfCallTime } = await import('../src/slack-adapter.js');
  let reject!: (e: unknown) => void;
  let calls = 0;
  const adapter = verificationAdapter(async () => {
    calls++;
    return new Promise((_, r) => { reject = r; });
  });
  const owner = withCallTime(Date.now(), () => adapter.verifyListUser({ user: 'UHUMAN' }));
  const joiner = withCallTime(Date.now(), () => adapter.verifyListUser({ user: 'UHUMAN' }));
  assert.equal(calls, 1, 'host joined the held lookup');
  const failure = new OutOfCallTime('users.info', 25);
  const outcomes = Promise.allSettled([owner, joiner]);
  reject(failure);
  assert.deepEqual(await outcomes, [
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  assert.equal(calls, 1, 'host joiner must not retry');
  assert.equal(adapter.verificationFailures.size, 0);
});

test('addressed drops retain their own failure after eviction and replacement', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  const adapter = verificationAdapter(async () => { throw new Error('offline'); });
  const resolve = adapter.resolveUserNames.bind(adapter);
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { ready = r; });
  let first = true;
  t.mock.method(adapter, 'resolveUserNames', async (...args: any[]) => {
    const errors = await resolve(...args);
    if (first) {
      first = false;
      ready();
      await held;
    }
    return errors;
  });
  const event = { ...verificationEvent, user: 'UFIRST', channel: 'D1', channel_type: 'im' };
  const older = adapter.prepareMessageEvent(event);
  await started;
  const oldFailure = adapter.verificationFailures.get('UFIRST').error;
  for (let n = 0; n < 256; n++) await resolve([`UEVICT${n}`]);
  assert.equal(adapter.verificationFailures.has('UFIRST'), false);
  await resolve(['UFIRST']);
  const newerFailure = adapter.verificationFailures.get('UFIRST').error;
  assert.notEqual(oldFailure, newerFailure);
  release();
  assert.equal(await older, undefined);
  assert.equal(oldFailure.addressedLogged, true);
  assert.equal(newerFailure.addressedLogged, false);
  assert.equal(await adapter.prepareMessageEvent({ ...event, ts: '2.0' }), undefined);
  assert.equal(newerFailure.addressedLogged, true);
  assert.equal(logs.filter(line => line.includes('Dropped addressed message from UFIRST')).length, 2);
});


for (const answer of ['bot', 'inconclusive', 'failure'] as const) {
  test(`all-mode concurrent authors share one ${answer} lookup`, async () => {
    let finish!: (value: any) => void;
    let fail!: (error: Error) => void;
    let calls = 0;
    const adapter = new SlackAdapter({ users: { info: () => {
      calls++;
      return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    } } } as any, { on() {} } as any, 'UBOT', 'acme', undefined, undefined,
      false, undefined, undefined, undefined, undefined, 'all', 'BSELF') as any;
    const a = adapter.prepareMessageEvent({ ...verificationEvent, user: 'UOTHER' });
    const b = adapter.prepareMessageEvent({ ...verificationEvent, user: 'UOTHER', channel: 'C2' });
    await Promise.resolve();
    assert.equal(calls, 1);
    if (answer === 'failure') fail(new Error('offline'));
    else finish({ user: answer === 'bot' ? { name: 'Bot', is_bot: true } : { name: 'Unknown' } });
    const messages = await Promise.all([a, b]);
    assert.equal(calls, 1);
    for (const msg of messages) {
      assert.equal(msg.isBot, answer === 'bot' ? true : undefined);
      assert.equal(msg.authorName, answer === 'bot' ? 'Bot' : answer === 'inconclusive' ? 'Unknown' : 'UOTHER');
    }
    assert.equal(adapter.verificationInFlight.size, 0);
  });
}

test('three overlapping DM name requests coalesce while the first lookup settles', async () => {
  const { adapter, web } = makeAdapter({ botMessages: ['UALLOWED'] });
  const internal = adapter as any;
  let finish!: (value: any) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  web.users.info = () => { calls++; return reply as any; };
  const conv = { id: 'D1', is_im: true, user: 'U1' };
  const first = internal.describeConversation(conv);
  let second!: Promise<any>;
  let third!: Promise<any>;
  // The raw lookup's finally runs before this reaction, but LIST's enclosing
  // verification is still pending. Its map entry must survive that finally.
  void reply.then(() => {
    second = internal.describeConversation(conv);
    third = internal.describeConversation(conv);
  });
  finish({ user: { is_bot: false } });
  await reply;
  const descriptions = await Promise.all([first, second, third]);
  assert.equal(calls, 1, 'settling raw lookup must not expose a gap in the enclosing verification');
  assert.deepEqual(descriptions.map(dm => dm.name), ['U1', 'U1', 'U1']);
  assert.equal(internal.verifiedUsers.has('U1'), true);
  assert.equal(internal.botUsers.has('U1'), false);
  assert.equal(internal.verificationInFlight.size, 0);
});

for (const method of ['lookupAllUser', 'verifyListUser']) {
  test(`${method} settlement preserves a replacement for a third overlapping request`, async () => {
    const { adapter, web } = makeAdapter({ botMessages: ['UALLOWED'] });
    const internal = adapter as any;
    let finishFirst!: (value: any) => void;
    let finishSecond!: (value: any) => void;
    let calls = 0;
    web.users.info = () => {
      calls++;
      return new Promise(resolve => { finishFirst = resolve; });
    };
    const args = { user: 'U1' };
    const first = internal[method](args);
    const second = new Promise(resolve => { finishSecond = resolve; });
    // Model a newer owner taking the slot while the old owner is settling.
    // Exercise each cleanup independently, including LIST's outer wrapper.
    internal.verificationInFlight.set('U1', second);
    finishFirst({ user: { is_bot: false } });
    await first;
    assert.equal(internal.verificationInFlight.get('U1'), second);
    const third = internal[method](args);
    assert.equal(calls, 1, 'third request must join the replacement, not send a duplicate');
    const answer = { user: { name: 'Current bot', is_bot: true } };
    finishSecond(answer);
    assert.equal(await third, answer);
  });
}

for (const botMessages of ['all', ['UALLOWED']] as const) {
  test(`nameless classification retries DM name in ${JSON.stringify(botMessages)}`, async () => {
    const { adapter, web } = makeAdapter({ botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages] });
    let calls = 0;
    web.users.info = async () => ({ user: ++calls === 1 ? { is_bot: false } : { name: 'Alice' } });
    const internal = adapter as any;
    await internal.resolveUserNames(['U1']);
    assert.equal(internal.userNameCache.has('U1'), false);
    assert.equal(internal.verifiedUsers.has('U1'), true);
    const dm = await internal.describeConversation({ id: 'D1', is_im: true, user: 'U1' });
    assert.equal(dm.name, 'Alice');
    assert.equal(calls, 2);
    assert.equal(internal.verifiedUsers.has('U1'), true);
  });
}

test('DM description retains its own inconclusive name after cache eviction', async t => {
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  web.users.info = async () => ({ user: { name: 'Alice' } });
  const internal = adapter as any;
  const resolve = internal.resolveUserNames.bind(internal);
  t.mock.method(internal, 'resolveUserNames', async (ids: string[], names: Map<string, string>) => {
    const result = await resolve(ids, names);
    internal.userNameCache.delete('U1');
    return result;
  });
  const dm = await internal.describeConversation({ id: 'D1', is_im: true, user: 'U1' });
  assert.equal(dm.name, 'Alice');
});

test('opt-in send_dm rejects bot IDs with applicable source-conversation guidance', async () => {
  const { adapter } = makeAdapter({ botMessages: 'all' });
  await assert.rejects(adapter.sendDM('B123', 'hello'), /bot ID.*source conversation.*fetch_history/);
});


test('negative bot admission returns normally, not through the socket error sink', async () => {
  for (const policy of [undefined, 'all', ['BOTHER']] as const) {
    const { adapter } = makeAdapter({ botMessages: typeof policy === 'string' || policy === undefined ? policy : [...policy] });
    for (const event of [
      { ...verificationEvent, user: 'UBOT' },
      { ...verificationEvent, user: undefined, bot_id: 'BSELF' },
      ...(policy === 'all' ? [] : [{ ...verificationEvent, user: 'UDENIED', bot_id: 'BDENIED' }]),
    ]) {
      assert.equal(await (adapter as any).prepareMessageEvent(event), undefined);
    }
  }
});

for (const botMessages of ['all', ['UOTHER']] as const) {
  test(`classified nameless DM retries naming in ${JSON.stringify(botMessages)}`, async () => {
    const { adapter, web } = makeAdapter({ botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages] });
    let calls = 0;
    web.users.info = async () => ++calls === 1
      ? { user: { is_bot: false } }
      : { user: { name: 'Alice', is_bot: false } };
    const waits: unknown[] = [];
    const dm = await (adapter as any).describeConversation({ id: 'D1', is_im: true, user: 'U1' }, {
      waitOut: async (wait: unknown) => { waits.push(wait); },
    });
    assert.equal(dm.name, 'Alice');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [{ method: 'users.info', seconds: 30, why: 'failed' }]);
  });
}

test('all-mode permanent refusal settles a verified nameless user', async () => {
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  let calls = 0;
  web.users.info = async () => {
    if (++calls === 1) return { user: { is_bot: false } };
    throw { code: 'slack_webapi_platform_error', data: { error: 'user_not_found' } };
  };
  for (let i = 0; i < 4; i++) await (adapter as any).resolveUserNames(['U1']);
  assert.equal(calls, 2);
  assert.equal((adapter as any).userNameCache.get('U1'), 'U1');
});

test('opt-in DM controls return normally and user IDs can still send DMs', async () => {
  for (const opts of [{ disableDms: true }, { dmUsers: ['UOTHER'] }, { dmUsers: [] }]) {
    const { adapter } = makeAdapter({ botMessages: 'all', ...opts });
    assert.equal(await (adapter as any).prepareMessageEvent({
      type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '1.0', text: 'hello',
    }), undefined);
  }
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  web.conversations = { open: async ({ users }: any) => {
    assert.equal(users, 'U123'); return { channel: { id: 'D123' } };
  } };
  web.chat = { postMessage: async () => ({ ts: '1.0' }) };
  assert.deepEqual(await adapter.sendDM('U123', 'hello'), { channelId: 'D123', messageId: '1.0' });
});

test('formatting never enumerates the process-lifetime name cache', async () => {
  for (const botMessages of [undefined, 'all'] as const) {
    const { adapter } = makeAdapter({ botMessages });
    const cache = (adapter as any).userNameCache as Map<string, string>;
    cache.set('U2', 'Bob');
    cache[Symbol.iterator] = () => { throw new Error('whole cache copied'); };
    const msg = await (adapter as any).prepareMessageEvent({
      type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi <@U2>',
    });
    assert.match(msg.cleanContent, /Bob/);
    const rows = await (adapter as any).shapeHistory([{
      user: 'U1', ts: '1.0', text: 'hi <@U2>',
    }]);
    assert.match(rows[0].content, /Bob/);
  }
});

test('opt-in non-string live text still renders readable blocks', async () => {
  const { adapter } = makeAdapter({ botMessages: 'all' });
  const msg = await (adapter as any).prepareMessageEvent({
    type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: 123,
    blocks: [{ type: 'section', text: { type: 'plain_text', text: 'readable' } }],
  });
  assert.match(msg.cleanContent, /readable/);
  assert.equal(msg.rawContent, '');
  assert.deepEqual(msg.mentionIds, []);
});

for (const botMessages of ['all', ['UALLOWED']] as const) {
  for (const answer of ['named', 'nameless', 'inconclusive', 'refused', 'failed'] as const) {
    test(`abandoned opt-in history cannot publish ${answer} in ${JSON.stringify(botMessages)}`, async () => {
      const { adapter, web } = makeAdapter({ botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages] });
      const internal = adapter as any;
      const abort = new AbortController();
      let finish!: (value: any) => void;
      let reject!: (error: unknown) => void;
      web.users.info = () => new Promise((resolve, fail) => { finish = resolve; reject = fail; });
      const names = new Map<string, string>();
      const pending = internal.resolveUserNames(['U1'], names, abort.signal);
      const stopped = assert.rejects(pending, error => error === abort.signal.reason);
      abort.abort();
      if (answer === 'refused') reject({ code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } });
      else if (answer === 'failed') reject(new Error('offline'));
      else finish({ user: answer === 'named' ? { name: 'Late', is_bot: true }
        : answer === 'nameless' ? { is_bot: false } : { name: 'Late' } });
      await stopped;
      assert.equal(names.size, 0);
      for (const field of ['userNameCache', 'verifiedUsers', 'botUsers', 'verificationFailures', 'inconclusiveNames', 'verificationInFlight']) {
        assert.equal(internal[field].size, 0, field);
      }
      assert.equal(internal.warnedMissingUsersRead, false);
      web.users.info = async () => ({ user: { name: 'Current', is_bot: false } });
      await internal.resolveUserNames(['U1']);
      assert.equal(internal.userNameCache.get('U1'), 'Current');
    });
  }

  test(`live lookup does not inherit an abortable history owner in ${JSON.stringify(botMessages)}`, async () => {
    const { adapter, web } = makeAdapter({ botMessages: typeof botMessages === 'string' ? botMessages : [...botMessages] });
    const internal = adapter as any;
    const abort = new AbortController();
    let finish!: (value: any) => void;
    let calls = 0;
    web.users.info = () => ++calls === 1 ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ user: { name: 'Live', is_bot: false } });
    const history = internal.resolveUserNames(['U1'], undefined, abort.signal);
    const stopped = assert.rejects(history, error => error === abort.signal.reason);
    await internal.resolveUserNames(['U1']);
    abort.abort();
    finish({ user: { name: 'Late', is_bot: true } });
    await stopped;
    assert.equal(calls, 2);
    assert.equal(internal.userNameCache.get('U1'), 'Live');
    assert.equal(internal.botUsers.has('U1'), false);
  });
}

for (const error of [new TypeError('malformed response'), new Error('Retry header did not contain a valid timeout (url: users.info)')]) {
  test(`all-mode DM naming retries an unclassified ${error.message}`, async () => {
    const { adapter, web } = makeAdapter({ botMessages: 'all' });
    let calls = 0;
    web.users.info = async () => {
      if (++calls === 1) throw error;
      return { user: { name: 'Alice', is_bot: false } };
    };
    const waits: unknown[] = [];
    const dm = await (adapter as any).describeConversation({ id: 'D1', is_im: true, user: 'U1' }, {
      waitOut: async (wait: unknown) => { waits.push(wait); },
    });
    assert.equal(dm.name, 'Alice');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [{ method: 'users.info', seconds: 30, why: 'failed' }]);
  });
}

test('aborted history does not retry a joined host deadline failure', async () => {
  const { OutOfCallTime } = await import('../src/slack-adapter.js');
  const { adapter, web } = makeAdapter({ botMessages: ['UALLOWED'] });
  const internal = adapter as any;
  let reject!: (error: unknown) => void;
  const owner = new Promise((_, fail) => { reject = fail; });
  internal.verificationInFlight.set('U1', owner);
  let calls = 0;
  web.users.info = async () => { calls++; return { user: { name: 'Unexpected', is_bot: false } }; };
  const abort = new AbortController();
  const pending = internal.resolveUserNames(['U1'], undefined, abort.signal);
  const stopped = assert.rejects(pending, error => error === abort.signal.reason);
  abort.abort();
  internal.verificationInFlight.delete('U1');
  reject(new OutOfCallTime('users.info', 25));
  await stopped;
  assert.equal(calls, 0);
  assert.equal(internal.verificationFailures.size, 0);
});


test('list-mode late partial history answer preserves a live verified name', async () => {
  const { adapter, web } = makeAdapter({ botMessages: ['UALLOWED'] });
  const internal = adapter as any;
  const replies: Array<(value: any) => void> = [];
  web.users.info = () => new Promise(resolve => { replies.push(resolve); });
  const history = internal.resolveUserNames(['U1'], undefined, new AbortController().signal);
  const live = internal.resolveUserNames(['U1']);
  assert.equal(replies.length, 2, 'abortable history is not shared as owner');
  replies[1]({ user: { name: 'Verified', is_bot: false } });
  await live;
  replies[0]({ user: { name: 'Stale' } });
  const failures = await history;
  assert.equal(failures.size, 0);
  assert.equal(internal.userNameCache.get('U1'), 'Verified');
  assert.equal(internal.verificationFailures.size, 0);
});

test('all-mode permanent refusal clears a late partial marker on a verified user', async () => {
  const { adapter, web } = makeAdapter({ botMessages: 'all' });
  const internal = adapter as any;
  const replies: Array<(value: any) => void> = [];
  let calls = 0;
  web.users.info = () => {
    calls++;
    if (calls <= 2) return new Promise(resolve => { replies.push(resolve); });
    return Promise.reject({ code: 'slack_webapi_platform_error', data: { error: 'user_not_found' } });
  };
  const history = internal.resolveUserNames(['U1'], undefined, new AbortController().signal);
  const live = internal.resolveUserNames(['U1']);
  replies[1]({ user: { is_bot: false } });
  await live;
  replies[0]({ user: { name: 'Recovered' } });
  await history;
  assert.equal(internal.inconclusiveNames.has('U1'), true, 'late partial answer requests another lookup');
  await internal.resolveUserNames(['U1']);
  assert.equal(internal.inconclusiveNames.has('U1'), false, 'permanent refusal settles even an already verified identity');
  await internal.resolveUserNames(['U1']);
  assert.equal(calls, 3, 'a settled refusal does not repeat on every event');
  assert.equal(internal.userNameCache.get('U1'), 'Recovered');
});
