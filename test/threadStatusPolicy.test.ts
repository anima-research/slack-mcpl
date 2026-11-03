import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fakeSlack } from './harness.js';
import { virtualClock, elapse } from './virtualClock.js';

// These are composition tests: #12 alone has no policy module or fixture.
const policyPresent = existsSync(new URL('./adapterAccessFixture.ts', import.meta.url));
async function fixture(options = {}) {
  const module = './adapterAccessFixture.js';
  const { accessFixture } = await import(module);
  const f = accessFixture(options);
  const effects: unknown[] = [];
  f.web.assistant = { threads: { async setStatus(args: unknown) { effects.push(args); } } };
  return { ...f, effects };
}

for (const denial of ['revoked membership', 'missing chat scope', 'missing read scope', 'non-write channel', 'lookup failure']) {
  test(`policy composition: thread status denies ${denial} without an effect`, { skip: !policyPresent }, async t => {
    t.mock.method(console, 'error', () => {});
    const f = await fixture(denial === 'missing chat scope' ? { scopes: ['channels:read', 'reactions:write'] }
      : denial === 'missing read scope' ? { scopes: ['chat:write'] }
      : denial === 'non-write channel' ? { config: { readJoinedChannels: true, writeChannels: [], dmUsers: [] } } : {});
    t.after(() => f.adapter.stop());
    if (denial === 'revoked membership') f.state.conversation.is_member = false;
    if (denial === 'lookup failure') f.state.infoError = new Error('offline');
    await f.adapter.setThreadStatus('C1', '1.0');
    assert.deepEqual(f.effects, []);
  });
}

test('policy composition: status start, refresh, switch and clear are freshly authorized', { skip: !policyPresent }, async t => {
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
  test(`policy composition: revocation blocks status ${operation} too`, { skip: !policyPresent }, async t => {
    t.mock.method(console, 'error', () => {});
    virtualClock(t);
    const f = await fixture();
    t.after(() => f.adapter.stop());
    await f.adapter.setThreadStatus('C1', '1.0');
    f.state.conversation.is_member = false;
    elapse(60000);
    await f.adapter.setThreadStatus('C1', operation === 'clear' ? undefined : operation === 'switch' ? '2.0' : '1.0');
    assert.equal(f.effects.length, 1, 'no new Slack effect after revocation');
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
test('policy composition: clearing during authorization retires the held start', { skip: !policyPresent }, async t => {
  const f = await fixture();
  t.after(() => f.adapter.stop());
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const info = f.web.conversations.info;
  f.web.conversations.info = async (args: unknown) => { entered(); await held; return info(args); };
  const starting = f.adapter.setThreadStatus('C1', '1.0');
  await reading;
  const clearing = f.adapter.clearThreadStatuses();
  release();
  await Promise.all([starting, clearing]);
  assert.ok(f.effects.every((effect: any) => effect.status === ''), 'no late start after clear');
});
