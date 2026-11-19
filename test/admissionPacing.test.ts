import assert from 'node:assert/strict';
import { clock } from '../src/clock.js';
import { SlackAccessDenied } from '../src/access-policy.js';
import type { SlackAdapter } from '../src/slack-adapter.js';
import { ownedTest as test, accessFixture, joined } from './adapterAccessFixture.js';

// Timers stay pending until explicitly released; time alone cannot start a call.
function controlledClock(t: import('node:test').TestContext) {
  let now = 0;
  const timers: Array<{ due: number; resolve: () => void }> = [];
  t.mock.method(clock, 'monotonic', () => now);
  t.mock.method(clock, 'now', () => -1e12); // wall-clock jumps must be irrelevant
  t.mock.method(clock, 'sleep', (ms: number, { signal }: { signal?: AbortSignal } = {}) => new Promise<void>(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = { due: now + ms, resolve: () => { signal?.removeEventListener('abort', finish); resolve(); } };
    const finish = () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); timer.resolve(); };
    signal?.addEventListener('abort', finish, { once: true });
    timers.push(timer);
  }));
  return {
    get now() { return now; }, timers,
    advance(ms: number) { now += ms; },
    release() {
      for (const timer of [...timers]) if (timer.due <= now) {
        timers.splice(timers.indexOf(timer), 1); timer.resolve();
      }
    },
  };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const event = (channel: string, text = '<@UBOT> hi', ts = '1.0') => ({ type: 'message', channel, user: 'U1', ts, text });

test('actual admission starts await timers, including concurrent channels and fast refusals', async t => {
  const time = controlledClock(t);
  const f = accessFixture();
  const starts: Array<[string, number]> = [];
  f.web.conversations.info = async ({ channel }) => {
    starts.push([channel, time.now]);
    if (channel === 'C2') throw new Error('fast refusal');
    return { channel: joined(channel) };
  };
  const first = f.emit(event('C1'));
  await first;
  const rest = [f.emit(event('C2')), f.emit(event('C3'))];
  await turn();
  assert.deepEqual(starts, [['C1', 0]]);
  time.advance(1199); time.release(); await turn();
  assert.equal(starts.length, 1);
  time.advance(1); await turn(); // reaching the deadline is insufficient without timer resolution
  assert.equal(starts.length, 1);
  time.release(); await turn();
  assert.deepEqual(starts, [['C1', 0], ['C2', 1200]]);
  time.advance(1200); time.release();
  await Promise.all(rest);
  assert.deepEqual(starts, [['C1', 0], ['C2', 1200], ['C3', 2400]]);
  await f.adapter.stop();
});

test('mentions overtake queued ambient admissions and ambient overload drops oldest', async t => {
  const time = controlledClock(t);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  const starts: string[] = [];
  f.web.conversations.info = async ({ channel }) => { starts.push(channel); return { channel: joined(channel) }; };
  await f.emit(event('C0'));
  const pending = Array.from({ length: 34 }, (_, i) => f.emit(event(`C${i + 1}`, 'ambient')));
  await turn();
  const mention = f.emit(event('C99'));
  await turn();
  time.advance(1200); time.release(); await turn();
  assert.deepEqual(starts, ['C0', 'C99']);
  for (let i = 0; i < 32; i++) { time.advance(1200); time.release(); await turn(); }
  await Promise.all([...pending, mention]);
  assert.deepEqual(starts.slice(2), Array.from({ length: 32 }, (_, i) => `C${i + 3}`));
  await f.adapter.stop();
});

test('ambient delivery backlog drops oldest behind a held addressed handler', async t => {
  const { virtualClock } = await import('./virtualClock.js'); virtualClock(t);
  const logs: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args[0]));
  const f = accessFixture();
  const internal = f.adapter as unknown as { settlePolicyEvent: (event: unknown) => Promise<unknown> };
  const prepare = t.mock.method(internal, 'settlePolicyEvent');

  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  const ready = new Promise<void>(resolve => entered = resolve);
  const delivered: string[] = [];
  f.adapter.onMessage(async msg => { delivered.push(msg.id); if (msg.id === '0.0') { entered(); await held; } });
  const first = f.emit(event('C1', '<@UBOT> hi', '0.0'));
  await ready;
  const pending = Array.from({ length: 34 }, (_, i) => f.emit(event('C1', 'ambient', `${i + 1}.0`)));
  assert.equal(prepare.mock.callCount(), 1, 'queued ambient envelopes must not prepare across a held addressed acceptance');
  assert.equal(f.methods().filter(method => method === 'info').length, 1);
  assert.equal(logs.filter(line => String(line).includes('delivery backlog limit 32')).length, 2);
  release(); await Promise.all([first, ...pending]);
  assert.deepEqual(delivered, ['0.0', ...Array.from({ length: 32 }, (_, i) => `${i + 3}.0`)]);
  await f.adapter.stop();
});

test('retry attempts start only after their backoff timer settles', async t => {
  const time = controlledClock(t);
  t.mock.method(Math, 'random', () => 0);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  const starts: number[] = [];
  f.web.conversations.info = async () => {
    starts.push(time.now);
    if (starts.length < 3) throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 2 });
    return { channel: joined() };
  };
  const pending = f.emit(event('C1'));
  await turn();
  assert.deepEqual(starts, [0]);
  for (let attempt = 1; attempt <= 2; attempt++) {
    time.advance(1999); time.release(); await turn();
    assert.equal(starts.length, attempt);
    time.advance(1); await turn();
    assert.equal(starts.length, attempt);
    time.release(); await turn();
    assert.equal(starts.length, attempt + 1);
  }
  await pending;
  assert.deepEqual(starts, [0, 2000, 4000]);
  await f.adapter.stop();
});

test('mention joining ambient backoff keeps priority on every retry and survives ambient overflow', async t => {
  const time = controlledClock(t);
  t.mock.method(Math, 'random', () => 0);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  const starts: Array<[string, number]> = [];
  let attempts = 0;
  f.web.conversations.info = async ({ channel }) => {
    starts.push([channel, time.now]);
    if (channel === 'C1' && ++attempts < 3) {
      throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 1 });
    }
    return { channel: joined(channel) };
  };
  const delivered: string[] = [];
  f.adapter.onMessage(msg => delivered.push(msg.id));
  const ambient = f.emit(event('C1', 'ambient'));
  await turn(); // first attempt is now in retry backoff, with no queued slot
  assert.deepEqual(starts, [['C1', 0]]);
  const mention = f.emit(event('C1', '<@UBOT> hi', '2.0'));
  const older = f.emit(event('C2', 'ambient'));
  await turn();
  time.advance(1000); time.release(); await turn(); // retry queues behind C2
  time.advance(200); time.release(); await turn();
  assert.deepEqual(starts, [['C1', 0], ['C1', 1200]], 'promoted retry overtakes older ambient');
  time.advance(1000); time.release(); await turn(); // second retry queues during pacing
  const flood = Array.from({ length: 34 }, (_, i) => f.emit(event(`C${i + 3}`, 'ambient')));
  await turn();
  time.advance(200); time.release(); await turn();
  assert.deepEqual(starts, [['C1', 0], ['C1', 1200], ['C1', 2400]], 'later retry retains priority and is not evicted');
  for (let i = 0; i < 32; i++) { time.advance(1200); time.release(); await turn(); }
  await Promise.all([ambient, mention, older, ...flood]);
  assert.ok(delivered.includes('2.0'), 'shared admission delivers the mention');
  assert.deepEqual(starts.slice(3).map(([channel]) => channel), Array.from({ length: 32 }, (_, i) => `C${i + 5}`));
  await f.adapter.stop();
});

test('eviction detaches ambient evidence before a synchronous mention joins', async t => {
  const time = controlledClock(t);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  const internal = f.adapter as unknown as { sharedEventAdmission(channel: string, addressed: boolean): Promise<unknown> };
  f.web.conversations.info = async ({ channel }) => ({ channel: joined(channel) });
  await internal.sharedEventAdmission('C0', true);
  const oldest = internal.sharedEventAdmission('C1', false);
  const flood = Array.from({ length: 32 }, (_, i) => internal.sharedEventAdmission(`C${i + 2}`, false));
  const mention = internal.sharedEventAdmission('C1', true);
  assert.notEqual(mention, oldest, 'an evicted admission must no longer be shareable');
  await turn();
  assert.equal(internal.sharedEventAdmission('C1', true), mention, 'old finally must not delete the replacement');
  for (let i = 0; i < 33; i++) { time.advance(1200); time.release(); await turn(); }
  assert.ok(await mention, 'the addressed replacement is admitted');
  await Promise.all([oldest, ...flood]);
  await f.adapter.stop();
});

test('ambient backlog bounds preparation while an earlier admission is held', async t => {
  const { virtualClock } = await import('./virtualClock.js'); virtualClock(t);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => release = r);
  const ready = new Promise<void>(r => entered = r);
  f.web.conversations.info = async () => { entered(); await held; return { channel: joined() }; };
  const internal = f.adapter as unknown as { settlePolicyEvent: (event: unknown) => Promise<unknown> };
  const prepare = t.mock.method(internal, 'settlePolicyEvent');
  const first = f.emit(event('C1', 'ambient', '0.0'));
  await ready;
  const pending = Array.from({ length: 100 }, (_, i) => f.emit({ ...event('C1', 'ambient', `${i + 1}.0`), user: `U${i + 2}` }));
  assert.ok(prepare.mock.callCount() <= 33, 'overflow must not start preparation for every arrival');
  release();
  await Promise.all([first, ...pending]);
  await f.adapter.stop();
});

test('non-content and locally excluded events never acquire policy delivery turns', async t => {
  const f = accessFixture();
  const internal = f.adapter as unknown as { policyTurns: Map<string, unknown[]> };
  for (const extra of [{ bot_id: 'B1' }, { subtype: 'message_changed' }, { user: 'UBOT' }, { user: '' }]) {
    const pending = f.emit({ ...event('D1'), ...extra });
    assert.equal(internal.policyTurns.size, 0);
    await pending;
  }
  f.adapter.setAmbientMessageFilter(() => false);
  const ambient = f.emit(event('C1', 'ambient'));
  assert.equal(internal.policyTurns.size, 0);
  await ambient;
  await f.adapter.stop();
});

test('background candidate checks share pacing and yield to addressed admission', async t => {
  const time = controlledClock(t);
  const f = accessFixture();
  f.state.listed = [joined('C1'), joined('C2')];
  const starts: string[] = [];
  f.web.conversations.info = async ({ channel }) => { starts.push(channel); return { channel: joined(channel) }; };
  const listing = f.adapter.listConversations(false, async () => {});
  await turn();
  assert.deepEqual(starts, ['C1']);
  const mention = f.emit(event('C99'));
  await turn();
  time.advance(1200); time.release(); await turn();
  assert.deepEqual(starts, ['C1', 'C99']);
  time.advance(1200); time.release(); await Promise.all([listing, mention]);
  assert.deepEqual(starts, ['C1', 'C99', 'C2']);
  await f.adapter.stop();
});

test('background Retry-After defers addressed admission without spending its retry budget', async t => {
  const time = controlledClock(t);
  const f = accessFixture();
  f.state.listed = [joined('C1')];
  let refused = false, waiting!: () => void;
  const ready = new Promise<void>(r => waiting = r);
  const starts: string[] = [];
  f.web.conversations.info = async ({ channel }) => {
    starts.push(channel);
    if (!refused) { refused = true; throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 }); }
    return { channel: joined(channel) };
  };
  const listing = f.adapter.listConversations(false, async () => { waiting(); });
  await ready;
  const mention = f.emit(event('C99'));
  await turn();
  time.advance(19999); time.release(); await turn();
  assert.deepEqual(starts, ['C1']);
  time.advance(1); time.release(); await turn();
  assert.deepEqual(starts, ['C1', 'C99']);
  time.advance(1200); time.release(); await Promise.all([listing, mention]);
  assert.deepEqual(starts, ['C1', 'C99', 'C1']);
  await f.adapter.stop();
});

test('a background cooldown arriving during pacing is rechecked after waking', async t => {
  const time = controlledClock(t);
  const f = accessFixture();
  f.state.listed = [joined('C1')];
  let reject!: (error: unknown) => void, waiting!: () => void;
  const ready = new Promise<void>(r => waiting = r);
  const starts: string[] = [];
  f.web.conversations.info = async ({ channel }) => {
    starts.push(channel);
    if (starts.length === 1) await new Promise((_, no) => reject = no);
    return { channel: joined(channel) };
  };
  const listing = f.adapter.listConversations(false, async () => waiting());
  await turn();
  const mention = f.emit(event('C99'));
  await turn(); // the original 1.2-second pacing sleep is already armed
  reject(Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 }));
  await ready;
  time.advance(1200); time.release(); await turn();
  assert.deepEqual(starts, ['C1']);
  time.advance(18800); time.release(); await turn();
  assert.deepEqual(starts, ['C1', 'C99']);
  time.advance(1200); time.release(); await Promise.all([listing, mention]);
  await f.adapter.stop();
});

test('retired registration candidates are skipped and counted as incomplete', async t => {
  const f = accessFixture();
  f.web.conversations.list = async () => ({ channels: [joined('C1')] });
  const internal = f.adapter as unknown as { paceEventAdmission: () => Promise<boolean> };
  t.mock.method(internal, 'paceEventAdmission', async () => false);
  const listing = await f.adapter.listConversations(false, async () => {});
  assert.deepEqual(listing.conversations, []);
  assert.equal(listing.admissionFailures, 1);
  await f.adapter.stop();
});


test('long shared cooldowns sleep in representable timer chunks', async t => {
  const time = controlledClock(t);
  const f = accessFixture();
  const internal = f.adapter as unknown as {
    nextEventAdmissionAt: number;
    paceEventAdmission: (channel: string, priority: { addressed: boolean }) => Promise<boolean>;
  };
  internal.nextEventAdmissionAt = 3_000_000_000;
  const slot = internal.paceEventAdmission('C1', { addressed: true });
  assert.equal(time.timers.length, 1);
  assert.equal(time.timers[0]!.due, 2_147_483_647);
  time.advance(2_147_483_647); time.release(); await turn();
  assert.equal(time.timers[0]!.due, 3_000_000_000);
  assert.equal(f.methods().includes('info'), false);
  time.advance(3_000_000_000 - time.now); time.release();
  assert.equal(await slot, true);
  await f.adapter.stop();
});

async function until(check: () => boolean): Promise<void> {
  // A phase barrier, not a timing claim: generous for loaded CI workers.
  const deadline = performance.now() + 10_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, 'expected admission phase was not reached');
    await turn();
  }
}

for (const phase of ['pacing', 'retry'] as const) test(`stop wakes a pending ${phase} sleep and retires queued work`, { timeout: 5000 }, async t => {
  t.mock.method(Math, 'random', () => 0);
  const time = controlledClock(t);
  const errors = t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  const starts: string[] = [];
  const received: string[] = [];
  f.adapter.onMessage(msg => { received.push(msg.id); });
  f.web.conversations.info = async ({ channel }) => {
    starts.push(channel);
    if (phase === 'retry') throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 6 });
    return { channel: joined(channel) };
  };
  if (phase === 'pacing') await f.emit(event('C0'));
  const pending = [f.emit(event('C1')), f.emit(event('C1', '<@UBOT> queued', '2.0'))];
  await until(() => time.timers.some(timer => timer.due === (phase === 'retry' ? 6000 : 1200)));
  assert.deepEqual(starts, phase === 'retry' ? ['C1'] : ['C0']);
  assert.ok((f.adapter as any).policyTurns.get('C1').length > 0, 'second event is queued');
  const before = starts.length;
  await f.adapter.stop();
  await Promise.all(pending);
  assert.equal(time.timers.length, 0, 'abort retires the sleep without advancing time');
  time.advance(120000); time.release();
  assert.equal(starts.length, before, 'no admission starts after stop');
  assert.deepEqual(received, phase === 'pacing' ? ['1.0'] : []);
  assert.equal((f.adapter as any).policyTurns.size, 0);
  assert.equal((f.adapter as any).inbound.size, 0);
  // Each undelivered event is named once: an aborted sleep is not also an admission failure.
  const drops = errors.mock.calls.map(call => String(call.arguments[0])).filter(line => line.startsWith('[slack-mcpl] Dropped message'));
  assert.deepEqual(drops.map(line => line.split(' ').slice(3, 6).join(' ')).sort(), ['1.0 in C1:', '2.0 in C1:']);
  assert.ok(drops.every(line => !line.includes('admission failed')), drops.join('\n'));
});

test('stop drops an event queued behind a running host handler', { timeout: 5000 }, async t => {
  const { virtualClock } = await import('./virtualClock.js'); virtualClock(t);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const received: string[] = [];
  f.adapter.onMessage(async msg => { received.push(msg.id); enter(); await held; });
  const first = f.emit(event('C1')); await entered;
  const queued = f.emit(event('C1', '<@UBOT> queued', '2.0'));
  assert.equal((f.adapter as any).policyTurns.get('C1').length, 1);
  await f.adapter.stop();
  release(); await Promise.all([first, queued]);
  assert.deepEqual(received, ['1.0']);
  assert.equal((f.adapter as any).policyTurns.size, 0);
  assert.equal((f.adapter as any).inbound.size, 0);
});

test('foreground candidate rate limits retain usable progress with an incomplete marker', async t => {
  const time = controlledClock(t);
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.state.listed = [joined('C1'), joined('C2')];
  const starts: number[] = [];
  f.web.conversations.info = async ({ channel }) => {
    starts.push(time.now);
    if (channel === 'C2') throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 30 });
    return { channel: joined(channel) };
  };
  const pending = f.adapter.listConversations();
  await until(() => starts.length === 1 && time.timers.length === 1);
  time.advance(1200); time.release();
  const listing = await pending;
  assert.deepEqual(starts, [0, 1200]);
  assert.deepEqual(listing.conversations.map(row => row.id), ['C1']);
  assert.equal(listing.admissionFailures, 1);
});

test('direct foreground listings outside a host call are not evicted as ambient backlog', async t => {
  const time = controlledClock(t);
  const errors = t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  f.state.listed = [joined('C1')];
  // The first slot is released at once; the other 33 wait behind it.
  const listings = Array.from({ length: 34 }, () => f.adapter.listConversations());
  await until(() => f.methods().filter(m => m === 'list').length === 34 && time.timers.length === 1);
  for (let i = 0; i < 5; i++) await turn();
  assert.equal((f.adapter as any).eventAdmissionQueue.length, 33);
  assert.ok(!errors.mock.calls.some(call => String(call.arguments[0]).includes('dropped oldest ambient admission')));
  await f.adapter.stop();
  time.advance(1e9); time.release();
  await Promise.allSettled(listings);
});

test('activation local veto retires turns before preparation but preserves denial accounting', async t => {
  t.mock.method(console, 'error', () => {});
  const f = accessFixture({ config: { readJoinedChannels: false, writeChannels: [], dmUsers: [] } });
  const internal = f.adapter as unknown as {
    policyTurns: Map<string, unknown[]>;
    admissionFailures: Map<string, { count: number }>;
    settlePolicyEvent: (event: unknown) => Promise<unknown>;
  };
  const prepare = t.mock.method(internal, 'settlePolicyEvent');
  await f.emit(event('C1'));
  await f.emit(event('D1'));
  assert.equal(internal.policyTurns.size, 0);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal([...internal.admissionFailures.values()].reduce((sum, row) => sum + row.count, 0), 2);
  await f.adapter.stop();
});

// The test that builds an adapter stops it: its 60-second admission-log flush
// must not outlive that test or wait for a later accessTest to stop it.
let builtByEarlierTest: SlackAdapter | undefined;
test('a denied listing arms the admission-log flush while its own test runs', async t => {
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  f.state.listed = [joined()];
  f.state.infoError = new SlackAccessDenied('denied');
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
  assert.ok((f.adapter as unknown as { admissionLogTimer?: unknown }).admissionLogTimer, 'the flush is pending while the test runs');
  builtByEarlierTest = f.adapter;
});

test('the owning test stopped its adapter, so no admission-log flush is left pending', () => {
  const adapter = builtByEarlierTest as unknown as { admissionLogTimer?: unknown; stopping: boolean };
  assert.equal(adapter.stopping, true);
  assert.equal(adapter.admissionLogTimer, undefined);
});

test('a Retry-After too large for milliseconds does not hold admission forever', async t => {
  controlledClock(t);
  t.mock.method(console, 'error', () => {});
  const f = accessFixture(); t.after(() => f.adapter.stop());
  (f.adapter as any).holdAdmissions({ seconds: 1e306, why: 'limited' });
  assert.ok(Number.isFinite((f.adapter as any).nextEventAdmissionAt), 'no Infinity deadline');
  (f.adapter as any).holdAdmissions({ seconds: 30, why: 'limited' });
  assert.equal((f.adapter as any).nextEventAdmissionAt, 30_000);
});
