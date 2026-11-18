import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { method, type ChannelsListResult } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import type { SlackWaitOut } from '../src/slack-adapter.js';
import { accessFixture, joined } from './adapterAccessFixture.js';
import { connectHost, initialize, FULL_GRANT, until } from './harness.js';
import { clock } from '../src/clock.js';
import { virtualClock } from './virtualClock.js';

const limited = () => Object.assign(new Error('retryable'), { code: ErrorCode.RateLimitedError, retryAfter: 1 });

for (const legacy of [true, false]) test(legacy
  ? 'real registration gives up once on three failing DM names at REGISTRATION_TRIES'
  : 'real registration admits 25 candidates that each recover after one retry', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const time = virtualClock(t);
  const f = accessFixture({ legacy });
  const attempts = new Map<string, number>();
  if (legacy) {
    f.state.listed = ['1', '3', '4'].map((id) => ({ id: `D${id}`, user: `U${id}`, is_im: true }));
    f.web.users.info = async ({ user }) => {
      attempts.set(user, (attempts.get(user) ?? 0) + 1);
      if (attempts.get(user)! > 12) throw new Error('test safety ceiling');
      throw limited();
    };
  } else {
    f.state.listed = Array.from({ length: 25 }, (_, i) => joined(`C${i + 1}`));
    f.web.conversations.info = async ({ channel }) => {
      const count = (attempts.get(channel) ?? 0) + 1; attempts.set(channel, count);
      if (count === 1) throw limited();
      return { channel: joined(channel) };
    };
  }
  const waits: number[] = [];
  const listing = f.adapter.listConversations.bind(f.adapter);
  t.mock.method(f.adapter, 'listConversations', (include = false, wait?: SlackWaitOut) =>
    listing(include, async (why, n) => { waits.push(n); await wait!(why, n); }));
  const server = new SlackMcplServer(f.adapter);
  const h = connectHost(server); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => (server as unknown as { registering?: unknown }).registering === undefined, 'registration to finish');
  const registered = (await h.host.sendRequest(method.CHANNELS_LIST)) as ChannelsListResult;
  assert.deepEqual(registered.channels.map((c) => c.id), f.state.listed.map((c) => `slack:${c.id}`));
  const lines = log.mock.calls.map((call) => call.arguments.join(' '));
  if (legacy) {
    // This invokes the real server waiter, including its REGISTRATION_TRIES = 10 threshold.
    assert.deepEqual(waits, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(time.slept.length, 9); // the tenth call throws GaveUp before sleeping
    assert.deepEqual([...attempts], [['U1', 10], ['U3', 1], ['U4', 1]]);
    assert.equal(lines.filter((line) => line.includes('Gave up on the name')).length, 1);
    assert.deepEqual(registered.channels.map((c) => c.label), ['DM: @U1 (test)', 'DM: @U3 (test)', 'DM: @U4 (test)']);
  } else {
    assert.deepEqual(waits, Array(25).fill(1));
    assert.deepEqual([...attempts.values()], Array(25).fill(2));
    assert.equal(time.slept.filter(ms => ms === 1000).length, 25, 'retry waits; shared pacing adds separate quota sleeps');
    assert.ok(!lines.some((line) => /Gave up|registration stopped/.test(line)));
  }
});

test('background listing skips and counts exhausted candidate admission', async (t) => {
  virtualClock(t);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  f.state.listed = Array.from({ length: 10 }, (_, i) => joined(`C${i}`));
  const attempts = new Map<string, number>();
  f.web.conversations.info = async ({ channel }) => {
    attempts.set(channel, (attempts.get(channel) ?? 0) + 1);
    if (channel === 'C5') throw limited();
    return { channel: joined(channel) };
  };
  const waits: number[] = [];
  const listing = await f.adapter.listConversations(false, async (wait, n) => {
    assert.equal(wait.attempts, 5);
    waits.push(n);
  });
  assert.equal(listing.conversations.length, 9);
  assert.equal(listing.conversations.some(c => c.id === 'C5'), false);
  assert.equal(listing.admissionFailures, 1);
  assert.equal(attempts.get('C5'), 5);
  assert.deepEqual(waits, [1, 2, 3, 4]);
  await f.adapter.stop();
});

test('listing vetoes disallowed listed IM peers and unnamed MPIM IDs before metadata', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  f.state.listed = [
    ...Array.from({ length: 100 }, (_, i) => ({ id: `D${i + 2}`, is_im: true, user: 'UNOT' })),
    ...Array.from({ length: 100 }, (_, i) => ({ id: `G${i + 2}`, is_mpim: true })),
    { id: 'D1', is_im: true, user: 'U1' },
  ];
  f.state.conversation = f.state.listed[200];
  assert.equal((await f.adapter.listConversations()).conversations.length, 1);
  assert.equal(f.methods().filter((m) => m === 'info').length, 1);
});

for (const code of [ErrorCode.RateLimitedError, ErrorCode.RequestError]) {
  test(`inbound transient admission retries then delivers: ${code}`, async (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(Math, 'random', () => 0.5);
    const time = virtualClock(t);
    const f = accessFixture();
    let calls = 0;
    f.web.conversations.info = async () => {
      if (++calls === 1) throw Object.assign(new Error('transient'), { code, retryAfter: 1 });
      return { channel: { id: 'D1', is_im: true, user: 'U1' } };
    };
    const messages: unknown[] = [];
    f.adapter.onMessage((m) => messages.push(m));
    await f.emit({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '1.0' });
    assert.equal(messages.length, 1);
    assert.equal(calls, 2);
    assert.deepEqual(time.slept, [1125, 75]);
  });
}

test('inbound local vetoes cost no metadata calls and timed notices separate drops', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = accessFixture({ config: { readJoinedChannels: false, writeChannels: [], dmUsers: ['U1'] } });
  for (const [channel, user] of [['D2', 'U2'], ['C1', 'U1']]) {
    await f.emit({ type: 'message', channel, user, ts: '1.0' });
  }
  assert.deepEqual(f.methods(), []);
  f.state.infoError = Object.assign(limited(), { retryAfter: 60 });
  await f.emit({ type: 'message', channel: 'D1', user: 'U1', ts: '1.0' });
  assert.equal(log.mock.calls.length, 0);
  t.mock.timers.tick(60_000);
  const lines = log.mock.calls.map((c) => c.arguments.join(' '));
  assert.ok(lines.some((line) => line.includes('denied by policy (event): 2')));
  assert.ok(lines.some((line) => line.includes('message dropped: 1')));
  await f.adapter.stop();
});

test('inbound retries exhaust at three fresh checks and never deliver unverifiable content', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const log = t.mock.method(console, 'error', () => {});
  const time = virtualClock(t);
  const f = accessFixture();
  f.state.infoError = limited();
  const messages: unknown[] = [];
  f.adapter.onMessage((m) => messages.push(m));
  await f.emit({ type: 'message', channel: 'D1', user: 'U1', ts: '1.0' });
  assert.equal(f.methods().filter((m) => m === 'info').length, 3);
  assert.deepEqual(time.slept, [1125, 75, 1125, 75]);
  assert.deepEqual(messages, []);
  await f.adapter.stop();
  assert.ok(log.mock.calls.some((c) => c.arguments.join(' ').includes('message dropped: 1')));
});

test('policy tool description does not promise unjoined public listings', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  const result = await h.host.sendRequest('tools/list', {}) as { tools: Array<{ name: string; description: string; inputSchema: { properties: { includeNonMember: { description: string } } } }> };
  const tool = result.tools.find((tool) => tool.name === 'list_channels')!;
  assert.match(tool.description, /includeNonMember has no effect/);
  assert.match(tool.inputSchema.properties.includeNonMember.description, /Has no effect in policy mode/);
});

test('R2-2: typed denial, Slack failure, unexpected error and peer mismatch are distinct and content-free', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  const event = { type: 'message', channel: 'D1', user: 'U1', ts: '1.0', text: 'SECRET_CONTENT' };
  for (const code of ['invalid_auth', 'missing_scope']) {
    f.state.infoError = Object.assign(new Error('SECRET_CONTENT'), { code: ErrorCode.PlatformError, data: { error: code } });
    await f.emit(event);
  }
  f.state.infoError = new Error('SECRET_CONTENT');
  await f.emit(event);
  f.state.infoError = undefined;
  f.state.conversation = { id: 'D1', is_im: true, user: 'W1' };
  await f.emit(event);
  f.state.conversation = { ...joined('D1'), is_member: false };
  await f.emit(event);
  await f.adapter.stop();
  const lines = log.mock.calls.map(c => c.arguments.join(' ')).join('\n');
  assert.match(lines, /verification failed \(event, invalid_auth\): 1/);
  assert.match(lines, /verification failed \(event, missing_scope\): 1/);
  assert.match(lines, /verification failed \(event, unexpected_error\): 1/);
  assert.match(lines, /denied by policy \(event\): 1/);
  assert.match(lines, /verification failed \(event, membership_metadata\): 1/);
  assert.doesNotMatch(lines, /SECRET_CONTENT|refresh_channels/);
});

test('R2-3: burst shares retry admission only while pending, retaining order and per-event peer checks', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(Math, 'random', () => 0.5);
  const time = virtualClock(t);
  const f = accessFixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  f.web.conversations.info = async () => {
    calls++;
    await barrier;
    if (calls < 3) throw limited();
    return { channel: { id: 'D1', is_im: true, user: 'U1' } };
  };
  const delivered: string[] = [];
  f.adapter.onMessage(m => delivered.push(m.id));
  const event = { type: 'message', channel: 'D1', user: 'U1', text: 'secret' };
  const burst = Array.from({ length: 20 }, (_, i) => f.emit({ ...event, ts: String(i) }));
  burst.push(f.emit({ ...event, user: 'W1', ts: 'wrong-peer' }));
  release();
  await Promise.all(burst);
  assert.equal(calls, 3);
  assert.deepEqual(time.slept, [1125, 75, 1125, 75]);
  assert.deepEqual(delivered, Array.from({ length: 20 }, (_, i) => String(i)));
  // The settled answer is gone: the next event sees membership revocation.
  f.web.conversations.info = async () => { calls++; return { channel: { ...joined('D1'), is_member: false } }; };
  await f.emit({ ...event, ts: 'revoked' });
  assert.equal(calls, 4);
  assert.equal(delivered.length, 20);
  await f.adapter.stop();
});

test('R2-3: shared exhausted burst makes three calls and counts all lost messages, no negative cache', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(Math, 'random', () => 0.5);
  virtualClock(t);
  const f = accessFixture();
  const delivered: unknown[] = [];
  f.adapter.onMessage(m => delivered.push(m));
  let calls = 0;
  f.web.conversations.info = async () => { calls++; throw limited(); };
  const event = { type: 'message', channel: 'C1', user: 'U1', text: 'secret' };
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.emit({ ...event, ts: String(i) })));
  assert.equal(calls, 3);
  assert.deepEqual(delivered, []);
  f.web.conversations.info = async () => { calls++; return { channel: joined() }; };
  await f.emit({ ...event, ts: 'recovered' });
  assert.equal(calls, 4);
  assert.equal(delivered.length, 1);
  await f.adapter.stop();
  assert.ok(log.mock.calls.some(c => c.arguments.join(' ').includes('message dropped: 20')));
});

test('R2-3: jitter counts toward ten seconds, never retries before Retry-After', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(Math, 'random', () => 0.5);
  const time = virtualClock(t);
  const f = accessFixture();
  f.state.infoError = Object.assign(limited(), { retryAfter: 5 });
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1' });
  assert.deepEqual(time.slept, [5125]);
  assert.equal(f.methods().filter(m => m === 'info').length, 2);
  await f.adapter.stop();
});

test('R3-7 shutdown wakes admission retry and prevents delivery', async t => {
  let entered!: () => void;
  const sleeping = new Promise<void>(resolve => { entered = resolve; });
  let aborted = false;
  t.mock.method(clock, 'sleep', async (_ms: number, options: { signal?: AbortSignal } = {}) => {
    assert.ok(options.signal);
    entered();
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  });
  const logs = t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  let calls = 0;
  f.web.conversations.info = async () => { calls++; throw Object.assign(limited(), { retryAfter: 5 }); };
  const delivered: unknown[] = [];
  f.adapter.onMessage(m => delivered.push(m));
  const event = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: 'stop' });
  await sleeping;
  await f.adapter.stop();
  await event;
  assert.equal(aborted, true);
  const notices = logs.mock.calls.map(call => call.arguments.join(' ')).filter(text => text.includes('shutdown'));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Dropped active event C1 stop: shutdown/);
  assert.equal(calls, 1);
  assert.deepEqual(delivered, []);
});

test('R3-7 shutdown retires prepared addressed events behind a held handler', async t => {
  virtualClock(t);
  const f = accessFixture();
  let release!: () => void, entered!: () => void, userPrepared!: () => void;
  const prior = new Promise<void>(resolve => release = resolve);
  const firstReady = new Promise<void>(resolve => entered = resolve);
  const prepared = new Promise<void>(resolve => userPrepared = resolve);
  const delivered: string[] = [];
  f.adapter.onMessage(async m => { delivered.push(m.id); if (m.id === 'first') { entered(); await prior; } });
  const first = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: 'first', text: '<@UBOT> hi' });
  await firstReady;
  f.web.users.info = async () => { userPrepared(); return { user: { name: 'second' } }; };
  const pending = f.emit({ type: 'message', channel: 'C1', user: 'U2', ts: 'queued', text: '<@UBOT> hi' });
  await prepared;
  await f.adapter.stop();
  release();
  await Promise.all([first, pending]);
  assert.deepEqual(delivered, ['first']);
});

test('HTTP-200 ratelimited preserves Retry-After before generic failure handling', async () => {
  const { waitToAskAgain } = await import('../src/slack-adapter.js');
  const error = Object.assign(new Error('limited'), { code: ErrorCode.PlatformError,
    data: { error: 'ratelimited', response_metadata: { retryAfter: 8 } } });
  assert.deepEqual(waitToAskAgain(error, 'conversations.info', true), { method: 'conversations.info', seconds: 8, why: 'limited' });
});

test('post-stop bot and non-content events do not count as shutdown losses', async t => {
  const f = accessFixture();
  await f.adapter.stop();
  const logs = t.mock.method(console, 'error', () => {});
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1', bot_id: 'B1' });
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '2', subtype: 'message_deleted' });
  assert.equal(logs.mock.callCount(), 0);
});

test('shutdown wakes the pacing timer before a second admission starts', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(clock, 'monotonic', () => 0);
  let entered!: () => void;
  const sleeping = new Promise<void>(resolve => entered = resolve);
  let aborted = false;
  t.mock.method(clock, 'sleep', async (_ms: number, options: { signal?: AbortSignal } = {}) => {
    assert.ok(options.signal);
    entered();
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  });
  const f = accessFixture();
  const delivered: string[] = [];
  f.adapter.onMessage(msg => delivered.push(msg.id));
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: 'first', text: '<@UBOT> hi' });
  const pending = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: 'second', text: '<@UBOT> hi' });
  await sleeping;
  assert.equal(f.methods().filter(method => method === 'info').length, 1);
  await f.adapter.stop();
  await pending;
  assert.equal(aborted, true);
  assert.equal(f.methods().filter(method => method === 'info').length, 1);
  assert.deepEqual(delivered, ['first']);
});

test('different random samples produce different retry backoffs', async t => {
  t.mock.method(console, 'error', () => {});
  const time = virtualClock(t);
  let samples = 0;
  t.mock.method(Math, 'random', () => samples++ === 0 ? 0 : 0.5);
  const f = accessFixture();
  let attempts = 0;
  f.web.conversations.info = async () => { if (++attempts < 3) throw limited(); return { channel: joined() }; };
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1', text: '<@UBOT> hi' });
  assert.equal(attempts, 3);
  assert.deepEqual(time.slept.filter(ms => ms >= 1000), [1000, 1125]);
  await f.adapter.stop();
});

for (const retired of [false, true]) test(`real registration announces healthy candidates with incomplete diagnostic: retired=${retired}`, async t => {
  virtualClock(t);
  const log = t.mock.method(console, 'error', () => {});
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.state.listed = Array.from({ length: 10 }, (_, i) => joined(`C${i}`));
  let failures = 0;
  f.web.conversations.info = async ({ channel }) => {
    if (channel === 'C5') { failures++; throw limited(); }
    return { channel: joined(channel) };
  };
  if (retired) {
    const internal = f.adapter as any;
    const pace = internal.paceEventAdmission.bind(internal);
    t.mock.method(internal, 'paceEventAdmission', async (id: string, priority: { addressed: boolean }) => id === 'C5' ? false : pace(id, priority));
  }
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'healthy registration');
  const announced = h.hostSaw.filter(r => r.method === method.CHANNELS_REGISTER).flatMap(r => (r.params as any).channels);
  assert.deepEqual(announced.map(c => c.id), ['slack:C0', 'slack:C1', 'slack:C2', 'slack:C3', 'slack:C4', 'slack:C6', 'slack:C7', 'slack:C8', 'slack:C9']);
  assert.equal(failures, retired ? 0 : 5);
  assert.ok(log.mock.calls.some(c => /registration incomplete: 1 candidate\(s\) skipped/.test(c.arguments.join(' '))));
});
