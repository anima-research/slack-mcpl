import test from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture } from './adapterAccessFixture.js';
import { fakeSlack } from './harness.js';
import { virtualClock, elapse } from './virtualClock.js';

async function fixture(options = {}) {
  const f = accessFixture(options);
  const effects: unknown[] = [];
  f.web.assistant = { threads: { async setStatus(args: unknown) { effects.push(args); } } };
  return { ...f, effects };
}

for (const denial of ['revoked membership', 'missing chat scope', 'missing read scope', 'non-write channel', 'lookup failure']) {
  test(`policy composition: thread status denies ${denial} without an effect`, async t => {
    t.mock.method(console, 'error', () => {});
    const f = await fixture(denial === 'missing chat scope' ? { scopes: ['channels:read', 'reactions:write'] }
      : denial === 'missing read scope' ? { scopes: ['chat:write'] }
      : denial === 'non-write channel' ? { config: { readJoinedChannels: true, writeChannels: [], dmUsers: [] } } : {});
    t.after(() => f.adapter.stop());
    if (denial === 'revoked membership') f.state.conversation!.is_member = false;
    if (denial === 'lookup failure') f.state.infoError = new Error('offline');
    await f.adapter.setThreadStatus('C1', '1.0');
    assert.deepEqual(f.effects, []);
    // Each denial is reached at admission, not by an earlier silent drop.
    assert.deepEqual(f.methods(), denial === 'non-write channel' ? [] : ['info']);
  });
}

test('policy composition: status start, refresh, switch and clear are freshly authorized', async t => {
  virtualClock(t);
  const f = await fixture({ scopes: ['channels:read', 'chat:write'] });
  t.after(() => f.adapter.stop());
  await f.adapter.setThreadStatus('C1', '1.0');
  elapse(60000);
  await f.adapter.setThreadStatus('C1', '1.0');
  await f.adapter.setThreadStatus('C1', '2.0');
  await f.adapter.setThreadStatus('C1', undefined);
  assert.equal(f.effects.length, 5);
  assert.deepEqual(f.methods(), ['info', 'info', 'info', 'info', 'info']);
});

for (const operation of ['clear', 'switch', 'refresh'] as const) {
  test(`policy composition: revocation blocks status ${operation} too`, async t => {
    t.mock.method(console, 'error', () => {});
    virtualClock(t);
    const f = await fixture();
    t.after(() => f.adapter.stop());
    await f.adapter.setThreadStatus('C1', '1.0');
    f.state.conversation!.is_member = false;
    const lookups = f.methods().filter(m => m === 'info').length;
    elapse(60000);
    await f.adapter.setThreadStatus('C1', operation === 'clear' ? undefined : operation === 'switch' ? '2.0' : '1.0');
    assert.ok(f.methods().filter(m => m === 'info').length > lookups, 'fresh admission reached');
    assert.equal(f.effects.length, 1, 'no new Slack effect after revocation');
    f.state.conversation!.is_member = true;
    await f.adapter.setThreadStatus('C1', undefined);
    assert.deepEqual(f.effects.map((x: any) => [x.thread_ts, x.status]), [['1.0', 'is thinking…'], ['1.0', '']], 'failed refresh admission retains ownership for a later clear');
  });
}

test('legacy thread status effect bytes remain unchanged', async t => {
  const f = fakeSlack();
  t.after(() => f.slack.stop());
  await f.slack.setThreadStatus('C1', '1.0');
  await f.slack.setThreadStatus('C1', '2.0');
  await f.slack.setThreadStatus('C1', undefined);
  assert.equal(JSON.stringify(f.statuses), '["C1:1.0:is thinking…","C1:1.0:","C1:2.0:is thinking…","C1:2.0:"]');
  assert.deepEqual(f.reads, []);
});

// Fresh policy lookup introduces a new await: a clear during it must still
// invalidate the queued start, just as it does before any legacy status call.
test('policy composition: clearing during authorization retires the held start', async t => {
  const f = await fixture();
  t.after(() => f.adapter.stop());
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const info = f.web.conversations.info;
  f.web.conversations.info = async (args: { channel: string }) => { entered(); await held; return info(args); };
  const starting = f.adapter.setThreadStatus('C1', '1.0');
  await reading;
  const clearing = f.adapter.clearThreadStatuses();
  release();
  await Promise.all([starting, clearing]);
  assert.ok(f.effects.every((effect: any) => effect.status === ''), 'no late start after clear');
});


test('membership denial from fresh metadata latches like Slack\'s not_in_channel until the peer changes', async t => {
  t.mock.method(console, 'error', () => {});
  virtualClock(t);
  const f = await fixture();
  t.after(() => f.adapter.stop());
  f.state.conversation!.is_member = false;
  await f.adapter.setThreadStatus('C1', '1.0');
  elapse(60000);
  await f.adapter.setThreadStatus('C1', '1.0');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.deepEqual(f.methods(), ['info'], 'one admission attempt, then the lasting refusal is latched');
  assert.deepEqual(f.effects, []);
  f.state.conversation!.is_member = true;
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.equal(f.effects.length, 0);
  await f.adapter.resetThreadStatuses();
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.equal(f.effects.length, 1, 'a peer change asks again');
});

test('a missing-grant status latch ends when Slack reports a changed grant set', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture();
  t.after(() => f.adapter.stop());
  (f.adapter as any).scopes = (f.adapter as any).scopes.filter((s: string) => s !== 'chat:write');
  await f.adapter.setThreadStatus('C1', '1.0');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.deepEqual(f.methods(), ['info'], 'the grant denial is latched');
  f.state.infoScopes = [...(f.adapter as any).scopes, 'chat:write'];
  await f.adapter.getConversationMeta('C1');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.equal(f.effects.length, 1, 'restored chat:write releases the latch without a peer change');
});

test("a Slack missing_scope from setStatus joins the grant latch, so a changed grant report releases it", async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture();
  t.after(() => f.adapter.stop());
  let refuse = true;
  f.web.assistant = { threads: { async setStatus(args: unknown) {
    f.effects.push(args);
    if (refuse) { refuse = false; throw Object.assign(new Error('missing_scope'), { code: 'slack_webapi_platform_error', data: { ok: false, error: 'missing_scope', needed: 'chat:write' } }); }
  } } };
  await f.adapter.setThreadStatus('C1', '1.0');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.equal(f.effects.length, 1, 'the refusal is latched');
  f.state.infoScopes = [...new Set([...(f.adapter as any).scopes, 'chat:write', 'users:read.email'])];
  await f.adapter.getConversationMeta('C1');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.equal(f.effects.length, 2, 'a changed grant report releases it without a peer change');
});

for (const terminal of [false, true]) test(`status admission failure cannot become a setStatus outcome: terminal=${terminal}`, async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture();
  f.state.infoError = Object.assign(new Error('admission failed'), terminal
    ? { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } }
    : { code: 'slack_webapi_http_error', statusCode: 503 });
  await f.adapter.setThreadStatus('C1', '1.0');
  const attempts = f.methods().length;
  assert.deepEqual(f.methods(), ['info'], 'the start reached its failing admission');
  await f.adapter.clearThreadStatuses();
  assert.equal(f.methods().length, attempts, 'no clear of a status never attempted');
  f.state.infoError = undefined;
  await f.adapter.setThreadStatus('C1', '1.0');
  assert.equal(f.effects.length, terminal ? 0 : 1, 'only lasting Slack admission refusals latch');
  if (terminal) {
    await f.adapter.resetThreadStatuses();
    await f.adapter.setThreadStatus('C1', '1.0');
    assert.equal(f.effects.length, 1, 'reset releases the admission refusal');
  }
  f.state.infoError = new Error('offline');
  await f.adapter.clearThreadStatuses();
  assert.equal(f.effects.length, 1);
  f.state.infoError = undefined;
  await f.adapter.clearThreadStatuses();
  assert.equal(f.effects.length, 2, 'failed admission did not forget an owned status');
});

test('cleared old status is not restored when new thread admission fails', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture();
  t.after(() => f.adapter.stop());
  await f.adapter.setThreadStatus('C1', '1.0');
  const original = f.web.conversations.info;
  let calls = 0;
  f.web.conversations.info = async (args: { channel: string }) => {
    if (++calls === 2) throw new Error('temporary metadata failure');
    return original(args);
  };
  await f.adapter.setThreadStatus('C1', '2.0');
  await f.adapter.setThreadStatus('C1', '1.0');
  assert.deepEqual(f.effects.map((x: any) => x.status), ['is thinking…', '', 'is thinking…']);
});


test('lasting metadata refusal latches starts but explicit clears can recover', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture();
  await f.adapter.setThreadStatus('C1', '1.0');
  f.state.infoError = Object.assign(new Error('gone'), { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } });
  await f.adapter.setThreadStatus('C1', '2.0');
  const attempts = f.methods().length;
  await f.adapter.setThreadStatus('C1', '3.0');
  await f.adapter.clearThreadStatuses();
  assert.ok(f.methods().length > attempts, 'clear repeats fresh admission, even with the start latch');
  assert.equal(f.effects.length, 1);
  f.state.infoError = undefined;
  await f.adapter.clearThreadStatuses();
  assert.equal(f.effects.length, 2, 'explicit clear retries owned status without reset');
  await f.adapter.stop();
});

for (const code of ['invalid_thread_ts', 'not_in_channel']) test(`refused policy status start is not owned: ${code}`, async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(); t.after(() => f.adapter.stop());
  const effects: any[] = [];
  f.web.assistant!.threads.setStatus = async args => {
    effects.push(args);
    if (effects.length === 1) throw Object.assign(new Error(code), { code: 'slack_webapi_platform_error', data: { error: code } });
  };
  await f.adapter.setThreadStatus('C1', '1.0');
  await f.adapter.clearThreadStatuses();
  assert.equal(effects.length, 1, 'no cleanup of a refused start');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.equal(effects.length, code === 'invalid_thread_ts' ? 2 : 1);
  if (code === 'invalid_thread_ts') assert.equal(effects[1].thread_ts, '2.0');
});

for (const terminal of [false, true]) test(`attempted policy clear releases ownership even on failure: terminal=${terminal}`, async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(); t.after(() => f.adapter.stop());
  const effects: any[] = [];
  f.web.assistant!.threads.setStatus = async args => {
    effects.push(args);
    if (args.status === '') throw terminal
      ? Object.assign(new Error('invalid thread'), { code: 'slack_webapi_platform_error', data: { error: 'invalid_thread_ts' } })
      : new Error('timeout');
  };
  await f.adapter.setThreadStatus('C1', '1.0');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.deepEqual(effects.map(x => [x.thread_ts, x.status]), [['1.0', 'is thinking…'], ['1.0', ''], ['2.0', 'is thinking…']]);
});

for (const code of ['invalid_thread_ts', 'not_in_channel']) test(`refused refresh retains old ownership until reset: ${code}`, async t => {
  t.mock.method(console, 'error', () => {}); virtualClock(t);
  const f = await fixture(); t.after(() => f.adapter.stop());
  const effects: any[] = [];
  let refuse = false;
  f.web.assistant!.threads.setStatus = async args => {
    effects.push(args);
    if (refuse) throw Object.assign(new Error(code), { code: 'slack_webapi_platform_error', data: { error: code } });
  };
  await f.adapter.setThreadStatus('C1', '1.0');
  refuse = true; elapse(60000); await f.adapter.setThreadStatus('C1', '1.0');
  refuse = false; await f.adapter.resetThreadStatuses();
  assert.deepEqual(effects.map(x => [x.thread_ts, x.status]), [['1.0', 'is thinking…'], ['1.0', 'is thinking…'], ['1.0', '']]);
});

test('missing reported chat grant latches status starts until reset', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture({ scopes: ['channels:read'] }); t.after(() => f.adapter.stop());
  await f.adapter.setThreadStatus('C1', '1.0');
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.deepEqual(f.methods(), ['info']);
  f.state.infoScopes = ['channels:read', 'chat:write'];
  await f.adapter.resetThreadStatuses();
  await f.adapter.setThreadStatus('C1', '1.0');
  assert.equal(f.effects.length, 1);
});


test('lasting status admission refusal suppresses a later start before any cleanup', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(); t.after(() => f.adapter.stop());
  f.state.infoError = Object.assign(new Error('gone'), { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } });
  await f.adapter.setThreadStatus('C1', '1.0');
  const attempts = f.methods().length;
  assert.equal(attempts, 1);
  f.state.infoError = undefined;
  await f.adapter.setThreadStatus('C1', '2.0');
  assert.equal(f.methods().length, attempts);
  assert.deepEqual(f.effects, []);
});

test('lasting status refresh refusal suppresses a later refresh before reset', async t => {
  t.mock.method(console, 'error', () => {}); virtualClock(t);
  const f = await fixture(); t.after(() => f.adapter.stop());
  await f.adapter.setThreadStatus('C1', '1.0');
  f.state.infoError = Object.assign(new Error('gone'), { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } });
  elapse(60000); await f.adapter.setThreadStatus('C1', '1.0');
  const attempts = f.methods().length;
  assert.equal(attempts, 2);
  f.state.infoError = undefined;
  elapse(60000); await f.adapter.setThreadStatus('C1', '1.0');
  assert.equal(f.methods().length, attempts);
  assert.equal(f.effects.length, 1);
});

for (const terminal of [false, true]) test(`attempted clear retires ownership before any replacement: ${terminal}`, async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(); t.after(() => f.adapter.stop());
  await f.adapter.setThreadStatus('C1', '1.0');
  f.web.assistant!.threads.setStatus = async args => {
    f.effects.push(args);
    throw terminal ? Object.assign(new Error('invalid thread'), { code: 'slack_webapi_platform_error', data: { error: 'invalid_thread_ts' } }) : new Error('timeout');
  };
  await f.adapter.setThreadStatus('C1', undefined);
  assert.equal(f.effects.length, 2);
  const attempts = f.methods().length;
  await f.adapter.setThreadStatus('C1', undefined);
  assert.equal(f.methods().length, attempts);
  assert.equal(f.effects.length, 2);
});
