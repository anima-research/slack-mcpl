/**
 * Tests for SlackAdapter incoming-message handling (mention flag, filtering).
 *
 * Run: node --import tsx --test test/slackAdapter.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, type SlackAdapterConfig, type SlackMessageData } from '../src/slack-adapter.js';

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
    undefined, opts.disableDms, undefined, undefined, opts.botMessages, 'BSELF');
  const received: SlackMessageData[] = [];
  adapter.onMessage((msg) => received.push(msg));
  // The constructor's handler acks then processes asynchronously; give the
  // microtask queue a beat before asserting.
  const emit = async (event: any) => {
    handler!({ event, ack: async () => {} });
    await new Promise((r) => setTimeout(r, 0));
  };
  return { emit, received };
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

test('bot allow-list drops other bots but does not restrict human messages', async () => {
  const { emit, received } = makeAdapter({ botMessages: ['B1', 'U2'] });
  await emit({ type: 'message', channel: 'C1', user: 'U3', bot_id: 'B3', ts: '1.0' });
  await emit({ type: 'message', subtype: 'bot_message', channel: 'C1', user: 'U3', ts: '2.0' });
  await emit({ type: 'message', channel: 'C1', user: 'UHUMAN', ts: '3.0' });
  assert.deepEqual(received.map((m) => m.authorId), ['UHUMAN']);
  assert.equal(received[0].isBot, undefined);
});

test('user-ID admission handles bot_message without bot_id and bots identified by users.info', async () => {
  for (const botMessages of ['all', ['U1'], ['UOTHER']] as const) {
    const { emit, received } = makeAdapter({
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
      undefined, undefined, false, undefined, undefined, 'all', botId), /requires authenticated bot and user IDs/);
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
for (const failure of ['timeout', 'refusal', 'missing-user', 'missing-status'] as const) {
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
        if (failure === 'refusal') throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
        return failure === 'missing-user' ? {} : { user: { name: 'unknown' } };
      } },
    } as any, { on: (_: string, h: any) => { handler = h; } } as any,
    'UBOT', 'acme', undefined, undefined, false, undefined, undefined, ['BALLOWED'], 'BSELF');
    const received: SlackMessageData[] = [];
    adapter.onMessage(m => received.push(m));
    for (let n = 1; n <= 4; n++) {
      handler({ event: { type: 'message', channel: 'C1', user: 'UUNKNOWN', ts: `${n}.0` }, ack: async () => {} });
      await new Promise(r => setTimeout(r, 0));
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
      users: { info: async () => { calls++; throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }); } },
    } as any, { on: (_: string, h: any) => { handler = h; } } as any,
    'UBOT', 'acme', undefined, undefined, false, undefined, undefined, botMessages, 'BSELF');
    const received: SlackMessageData[] = [];
    adapter.onMessage(m => received.push(m));
    for (const ts of ['1.0', '2.0']) {
      handler({ event: { type: 'message', channel: 'C1', user: 'UUNKNOWN', ts }, ack: async () => {} });
      await new Promise(r => setTimeout(r, 0));
    }
    assert.equal(received.length, 2);
    assert.equal(received[0].authorName, 'UUNKNOWN');
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
    'UBOT', 'acme', undefined, undefined, false, undefined, undefined, policy, 'BSELF') as any;
}
const verificationEvent = { type: 'message', channel: 'C1', user: 'UALLOWED', ts: '1.0', text: '' };

for (const failure of ['refusal', 'timeout', 'inconclusive']) {
  test(`explicitly listed user or bot survives ${failure} without asserting human`, async () => {
    const adapter = verificationAdapter(async () => {
      if (failure === 'inconclusive') return { user: { name: 'unknown' } };
      throw Object.assign(new Error(failure), failure === 'refusal' ? { data: { error: 'missing_scope' } } : {});
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

for (const failure of ['refusal', 'timeout', 'inconclusive']) {
  test(`verification failures have a cooldown, coalesce in flight, and recover as verified humans: ${failure}`, async (t) => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    let calls = 0;
    let recovering = false;
    let finish!: (value: any) => void;
    let fail!: (error: Error) => void;
    const adapter = verificationAdapter(async () => {
      calls++;
      if (calls > 1 && !recovering) throw new Error('unexpected retry within cooldown');
      return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    });
    const event = { ...verificationEvent, user: 'UUNKNOWN' };
    const batch = Array.from({ length: 25 }, (_, n) =>
      adapter.prepareMessageEvent({ ...event, channel: `C${n}`, text: '<@UUNKNOWN>' }));
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 1, 'same user across authors and mentions shares an in-flight lookup');
    if (failure === 'inconclusive') finish({ user: { name: 'not-verified' } });
    else fail(Object.assign(new Error(failure), failure === 'refusal' ? { data: { error: 'missing_scope' } } : {}));
    assert.ok((await Promise.all(batch)).every(m => m === undefined));
    for (let n = 0; n < 25; n++) assert.equal(await adapter.prepareMessageEvent(event), undefined);
    assert.equal(calls, 1, 'negative verification cooldown suppresses repeated requests');
    assert.equal(adapter.userNameCache.has('UUNKNOWN'), false, 'failure is not a human/name cache entry');
    now += 29_999;
    assert.equal(await adapter.prepareMessageEvent(event), undefined);
    assert.equal(calls, 1, 'cooldown lasts 30 seconds');
    now++;
    recovering = true;
    const retry = adapter.prepareMessageEvent(event);
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 2, 'retry after cooldown');
    finish({ user: { name: 'human', is_bot: false } });
    const msg = await retry;
    assert.ok(msg);
    assert.equal(msg.isBot, undefined);
    assert.equal(msg.authorName, 'human');
    assert.equal(adapter.verificationFailures.size, 0, 'success clears negative entry');
  });
}

test('negative verification cache is bounded and evicts oldest failures', async () => {
  let calls = 0;
  const adapter = verificationAdapter(async () => { calls++; throw new Error('offline'); });
  for (let n = 0; n < 257; n++) {
    assert.equal(await adapter.prepareMessageEvent({ ...verificationEvent, user: `U${n}` }), undefined);
  }
  assert.equal(adapter.verificationFailures.size, 256);
  await adapter.prepareMessageEvent({ ...verificationEvent, user: 'U256' });
  assert.equal(calls, 257, 'newest entry remains cooled down');
  await adapter.prepareMessageEvent({ ...verificationEvent, user: 'U0' });
  assert.equal(calls, 258, 'oldest evicted entry can retry');
});
