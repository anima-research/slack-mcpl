import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import { SlackAccessDenied, withAccessContext } from '../src/access-policy.js';
import type { SlackMessageData } from '../src/slack-adapter.js';
import { virtualClock } from './virtualClock.js';
import { FULL_GRANT, connectHost, initialize } from './harness.js';
import { accessTest as test, accessFixture } from './adapterAccessFixture.js';

const message = (channelId = 'C1', id = '1.0', addressed = true): SlackMessageData => ({
  channelId, id, authorId: 'U1', authorName: 'Human', content: 'hello', cleanContent: 'hello',
  mentionIds: [], mentionsBot: addressed, isDM: false, timestamp: new Date(0), attachments: [],
});
async function fixture(t: { after(fn: () => unknown): void }) {
  const f = accessFixture();
  await f.adapter.getConversationMeta('C1');
  const server = new SlackMcplServer(f.adapter);
  const h = connectHost(server); t.after(() => h.close()); t.after(() => f.adapter.stop());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  // Invoke the registered server callback with an already-admitted envelope.
  const deliver = (f.adapter as unknown as { messageHandlers: Array<(m: SlackMessageData) => Promise<void>> }).messageHandlers[0]!;
  return { ...f, server, h, deliver };
}

for (const failure of ['HTTP 403', 'HTTP 502', 'platform service failure', 'transport timeout', 'programming error', 'rate limit', 'unverified metadata', 'refusal']) test(`final admission handles ${failure} before committing delivery state`, async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'acknowledge', async () => {});
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  let lookups = 0;
  t.mock.method(f.adapter, 'getConversationMeta', async (_id: string, final?: boolean) => withAccessContext('Nothing was delivered', async () => {
    lookups++; assert.equal(final, true, 'no separate optional name request');
    if (failure === 'HTTP 403') throw Object.assign(new Error('forbidden'), { code: 'slack_webapi_http_error', statusCode: 403 });
    if (failure === 'HTTP 502') throw Object.assign(new Error('gateway'), { code: 'slack_webapi_http_error', statusCode: 502 });
    if (failure === 'platform service failure') throw Object.assign(new Error('service'), { code: 'slack_webapi_platform_error', data: { error: 'service_unavailable' } });
    if (failure === 'unverified metadata') throw new SlackAccessDenied('missing metadata', undefined, false);
    if (failure === 'refusal') throw new SlackAccessDenied('not a member');
    if (failure === 'rate limit') throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 });
    if (failure === 'transport timeout') throw Object.assign(new Error('request timeout'), { code: 'slack_webapi_request_error' });
    throw new TypeError('programming error');
  }));
  await f.deliver(message());
  assert.equal(lookups, 1);
  const pushes = f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT);
  const keep = ['transport timeout', 'rate limit', 'HTTP 502', 'platform service failure'].includes(failure);
  assert.equal(pushes.length, keep ? 1 : 0);
  assert.deepEqual(clears, keep ? [] : ['1.0']);
  assert.equal((f.server as any).lastChannelId, keep ? 'C1' : null);
});

test('a held final check reads current header, routing and subscription state', async t => {
  const f = await fixture(t);
  t.mock.method(f.adapter, 'acknowledge', async () => {});
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(f.adapter, 'getConversationMeta', async (id: string, final?: boolean) => {
    if (id === 'C1' && final) { entered(); await held; }
    return { id, name: id === 'C1' ? 'alpha' : 'beta', kind: 'channel', isMember: true, writable: true } as any;
  });
  (f.server as any).lastChannelId = 'C1';
  const first = f.deliver(message()); await started;
  await f.deliver(message('C2', '2.0'));
  await f.h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  (f.server as any).channelManager.register({ id: 'slack:C1' });
  (f.server as any).channelManager.open('slack:C1');
  release(); await first;
  const incoming = f.h.hostSaw.find(r => r.method === method.CHANNELS_INCOMING);
  assert.ok(incoming, 'open state observed after admission');
  assert.match(JSON.stringify(incoming.params), /alpha/);
  assert.doesNotMatch(JSON.stringify(incoming.params), /Auto-subscribed|Accepting this message will subscribe/);
  assert.equal((f.server as any).lastChannelId, 'C1');
});

test('ambient unsubscribe during final check withholds the message', async t => {
  const f = await fixture(t);
  await f.h.host.sendRequest('tools/call', { name: 'subscribe_channel', arguments: { channelId: 'C1' } });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(f.adapter, 'getConversationMeta', async () => { entered(); await held; return { id: 'C1', kind: 'channel', name: 'alpha', isMember: true } as any; });
  const pending = f.deliver(message('C1', '1.0', false)); await started;
  await f.h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  release(); await pending;
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
});

test('final rate limits retry only within the small wait budget', async t => {
  // Admission retry timers are unref'd in production.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const f = accessFixture(); t.after(() => f.adapter.stop());
  let calls = 0;
  f.web.conversations.info = async () => {
    calls++;
    throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 0.05 });
  };
  await assert.rejects(f.adapter.getConversationMeta('C1', true), /limited/);
  assert.equal(calls, 3);
});

for (const member of [false, undefined]) test(`fresh final metadata distinguishes refusal from unavailable evidence: member=${member}`, async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'acknowledge', async () => {});
  t.mock.method(f.adapter, 'clearAck', async (_channel: string, id: string) => { clears.push(id); });
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  f.state.conversation = member === false
    ? { id: 'C1', is_im: false, is_mpim: false, is_private: false, is_member: false }
    : undefined;
  await f.deliver(message());
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
  assert.deepEqual(clears, ['1.0']);
});


test('policy delivery does not read header state before final admission settles', async t => {
  const f = await fixture(t);
  t.mock.method(f.adapter, 'acknowledge', async () => {});
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  let settled = false;
  let readsBeforeAdmission = 0;
  let lastChannel: string | null = null;
  Object.defineProperty(f.server, 'lastChannelId', {
    configurable: true,
    get: () => { if (!settled) readsBeforeAdmission++; return lastChannel; },
    set: (value: string | null) => { lastChannel = value; },
  });
  t.mock.method(f.adapter, 'getConversationMeta', async () => {
    await Promise.resolve();
    settled = true;
    return { id: 'C1', name: 'alpha', kind: 'channel', isMember: true, writable: true } as any;
  });
  await f.deliver(message());
  assert.equal(readsBeforeAdmission, 0);
  assert.equal(lastChannel, 'C1');
});

for (const code of ['token_expired', 'not_authed', 'ekm_access_denied', 'channel_not_found', 'missing_scope', 'invalid_arguments']) test(`platform final admission refusal drops and releases ACK: ${code}`, async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'acknowledge', async () => {});
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  t.mock.method(f.adapter, 'getConversationMeta', async () => {
    throw Object.assign(new Error(code), { code: 'slack_webapi_platform_error', data: { error: code } });
  });
  await f.deliver(message());
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
  assert.deepEqual(clears, ['1.0']);
});

test('a held final admission cannot deliver after adapter stop', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  t.mock.method(f.adapter, 'getConversationMeta', async () => { entered(); await held; return { id: 'C1', kind: 'channel', name: 'alpha', isMember: true } as any; });
  const pending = f.deliver(message()); await started;
  await f.adapter.stop(); release(); await pending;
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
});

test('final admission enforces its cumulative two-second retry budget', async t => {
  const { slept } = virtualClock(t);
  const f = accessFixture(); t.after(() => f.adapter.stop());
  let calls = 0;
  f.web.conversations.info = async () => {
    calls++;
    throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 1.5 });
  };
  await assert.rejects(f.adapter.getConversationMeta('C1', true), /limited/);
  assert.equal(calls, 2); assert.deepEqual(slept, [1500]);
});

test('a pending final lookup drops at the five-second delivery wait bound', async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'acknowledge', async () => {});
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(f.adapter, 'getConversationMeta', async () => { entered(); await held; return { id: 'C1', kind: 'channel', name: 'alpha', isMember: true } as any; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = f.deliver(message()).finally(() => { settled = true; }); await started;
  t.mock.timers.tick(4999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'delivery must still be pending at 4,999 ms');
  assert.deepEqual(clears, [], 'must not expire before five seconds');
  t.mock.timers.tick(1);
  await Promise.race([pending, new Promise<never>((_, reject) => {
    AbortSignal.timeout(1000).addEventListener('abort', () => reject(new Error('delivery deadline did not settle')));
  })]);
  release();
  assert.deepEqual(clears, ['1.0']);
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
});

for (const earlier of ['membership refusal', 'history grant withdrawal'] as const) test(`transient final admission cannot override ${earlier}`, async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  // The membership refusal reaches the ordered evidence through the real
  // backscroll admission, not through a server-side flag.
  if (earlier === 'membership refusal') f.state.conversation = { ...f.state.conversation, is_member: false };
  const real = f.adapter.fetchHistory.bind(f.adapter);
  const backscroll = t.mock.method(f.adapter, 'fetchHistory', async (...args: Parameters<typeof real>) => {
    if (earlier === 'membership refusal') return real(...args);
    (f.adapter as any).scopes = ['channels:read'];
    throw Object.assign(new Error('limited after withdrawal'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 });
  });
  const final = t.mock.method(f.adapter, 'getConversationMeta', async () => withAccessContext('Nothing was delivered', async () => {
    throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 });
  }));
  await f.deliver(message());
  assert.equal(backscroll.mock.callCount(), 1);
  assert.equal(final.mock.callCount(), 1);
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
  assert.deepEqual(clears, ['1.0']);
});

for (const later of ['newer membership confirmation', 'unrelated backscroll refusal'] as const) test(`transient final admission delivers after ${later}`, async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  const real = f.adapter.fetchHistory.bind(f.adapter);
  const meta = f.adapter.getConversationMeta.bind(f.adapter);
  t.mock.method(f.adapter, 'fetchHistory', async (...args: Parameters<typeof real>) => {
    if (later === 'unrelated backscroll refusal') {
      f.state.infoError = undefined;
      (f.web.conversations as any).history = async () => { throw Object.assign(new Error('bad args'), { code: 'slack_webapi_platform_error', data: { error: 'invalid_arguments' } }); };
      return real(...args);
    }
    f.state.conversation = { ...f.state.conversation, is_member: false };
    const refusal = await real(...args).then(() => assert.fail('expected refusal'), (err: unknown) => err);
    // A newer, independent admission sees the bot re-invited.
    f.state.conversation = { ...f.state.conversation, is_member: true };
    await meta('C1');
    throw refusal;
  });
  const final = t.mock.method(f.adapter, 'getConversationMeta', async () => withAccessContext('Nothing was delivered', async () => {
    throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 });
  }));
  await f.deliver(message());
  assert.equal(final.mock.callCount(), 1);
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 1);
  assert.deepEqual(clears, []);
});

for (const result of [undefined, null]) test(`missing channel final result drops and releases ACK: ${result}`, async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  t.mock.method(f.adapter, 'getConversationMeta', async () => result as any);
  await f.deliver(message());
  assert.deepEqual(clears, ['1.0']);
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
});

test('scope withdrawal reported by an earlier response vetoes a later real 429 fallback', async t => {
  const f = await fixture(t);
  const clears: string[] = [];
  t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  // A successful response reports the withdrawal; the 429 itself carries no
  // scope metadata, as @slack/web-api's rate-limited error never does.
  f.state.infoScopes = ['channels:read'];
  await f.adapter.getConversationMeta('C1');
  f.state.infoError = Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 });
  await f.deliver(message());
  assert.equal(f.h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0);
  assert.deepEqual(clears, ['1.0']);
});

test('policy DM unknown post reaches rollback with its opened destination', async t => {
  const f = await fixture(t);
  const call = (name: string, args: Record<string, unknown>) => f.h.host.sendRequest('tools/call', { name, arguments: args }) as Promise<any>;
  const base = await call('send_message', { channelId: 'C1', content: 'base' });
  f.state.conversation = { id: 'D1', is_im: true, is_mpim: false, user: 'U1' };
  f.web.chat.postMessage = async () => { throw Object.freeze(Object.assign(new Error('post timed out'), { code: 'slack_webapi_request_error' })); };
  const failure = await call('send_dm', { userId: 'U1', content: 'uncertain' });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /DM D1 was opened/);
  assert.doesNotMatch(failure.content[0].text, /Nothing was sent/);
  f.web.chat.postMessage = async () => ({ ts: '2.0' });
  await call('send_dm', { userId: 'U1', content: 'named' });
  const result = await f.h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint: base.state.checkpoint }) as any;
  assert.match(result.reason, /message in D1 whose id this server doesn't know/);
});

for (const addressed of [true, false]) test(`unset shutdown abandonment preserves main diagnostics and cleanup: addressed=${addressed}`, async t => {
  const f = accessFixture({ legacy: true });
  const server = new SlackMcplServer(f.adapter, { subscribeMemberChannels: true });
  const h = connectHost(server); t.after(() => h.close()); t.after(() => f.adapter.stop());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const clears: string[] = [], logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
  t.mock.method(f.adapter, 'acknowledge', async () => {});
  t.mock.method(f.adapter, 'clearAck', async (_c: string, id: string) => { clears.push(id); });
  Object.defineProperty(f.adapter, 'isStopping', { get() { throw new Error('legacy must not consult policy shutdown state'); } });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(f.adapter, 'fetchHistory', async () => { entered(); await held; return { messages: [], truncated: false }; });
  t.mock.method(f.adapter, 'getConversationMeta', async () => { entered(); await held; return null; });
  const deliver = (f.adapter as any).messageHandlers[0];
  deliver(message('C1', '1.0', addressed));
  await started; await f.adapter.stop(); await h.close(); release();
  await Promise.all((server as any).forwarding.values());
  assert.deepEqual(logs.filter(line => line.includes('Dropped ')), addressed
    ? ['[slack-mcpl] Dropped addressed message 1.0 in C1 before delivery: its peer disconnected'] : []);
  assert.deepEqual(clears, addressed ? ['1.0'] : []);
});

test('policy shutdown during server forwarding names recovery for an acknowledged reply', async t => {
  const f = await fixture(t);
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.mock.method(f.adapter, 'fetchHistory', async () => {
    entered(); await held; return { messages: [] };
  });
  const delivery = f.deliver({ ...message('C1', '2.0'), threadTs: '1.0' });
  await started;
  await f.adapter.stop();
  release(); await delivery;
  assert.match(logs.find(line => line.includes('Dropped ')) ?? '',
    /message 2\.0 in C1 \(thread 1\.0\).*stopping.*Slack will not replay it; after restart, recover it in Slack/);
});
