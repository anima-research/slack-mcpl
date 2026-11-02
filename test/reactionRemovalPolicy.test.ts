import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fakeSlack } from './harness.js';

// #57 remains independently buildable; policy cases activate on composition.
const policyPresent = existsSync(new URL('./adapterAccessFixture.ts', import.meta.url));
async function fixture(options = {}) {
  const module = './adapterAccessFixture.js';
  return (await import(module)).accessFixture(options);
}

for (const denial of ['revoked membership', 'missing reaction scope', 'missing read scope', 'non-write channel', 'lookup failure']) {
  test(`policy composition: reaction removal denies ${denial} without an effect`, { skip: !policyPresent }, async t => {
    const f = await fixture(denial === 'missing reaction scope' ? { scopes: ['channels:read', 'chat:write'] }
      : denial === 'missing read scope' ? { scopes: ['reactions:write'] }
      : denial === 'non-write channel' ? { config: { readJoinedChannels: true, writeChannels: [], dmUsers: [] } } : {});
    t.after(() => f.adapter.stop());
    if (denial === 'revoked membership') f.state.conversation.is_member = false;
    if (denial === 'lookup failure') f.state.infoError = new Error('offline');
    await assert.rejects(f.adapter.removeReaction('C1', '1.0', ':eyes:'));
    assert.ok(!f.methods().includes('unreact'));
  });
}

test('policy composition: allowed reaction removal uses fresh info and reactions:write, not chat:write', { skip: !policyPresent }, async t => {
  const f = await fixture({ scopes: ['channels:read', 'reactions:write'] });
  t.after(() => f.adapter.stop());
  assert.equal(await f.adapter.removeReaction('C1', '1.0', ':eyes:'), true);
  assert.deepEqual(f.calls, [
    { method: 'info', args: { channel: 'C1' } },
    { method: 'unreact', args: { channel: 'C1', timestamp: '1.0', name: 'eyes' } },
  ]);
  f.state.conversation.is_member = false;
  await assert.rejects(f.adapter.removeReaction('C1', '1.0', ':eyes:'));
  assert.deepEqual(f.methods(), ['info', 'unreact', 'info']);
});

test('policy composition: reaction removal rechecks after a pending ACK add', { skip: !policyPresent }, async t => {
  const f = await fixture({ ack: 'eyes' });
  t.after(() => f.adapter.stop());
  let release!: () => void;
  f.web.reactions.add = async () => new Promise<void>(resolve => { release = resolve; });
  const adding = f.adapter.acknowledge('C1', '1.0');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const removing = f.adapter.removeReaction('C1', '1.0', 'eyes');
  // Let removal reach its wait for the add before revoking membership.
  await new Promise(resolve => setImmediate(resolve));
  f.state.conversation.is_member = false;
  release();
  await adding;
  await assert.rejects(removing);
  assert.ok(!f.methods().includes('unreact'));
});

test('legacy reaction removal effect and result bytes remain unchanged', async t => {
  const f = fakeSlack();
  t.after(() => f.slack.stop());
  const result = await f.slack.removeReaction('C1', '1.0', ':eyes:');
  assert.equal(JSON.stringify({ result, effects: f.reactions, reads: f.reads }),
    '{"result":true,"effects":["remove:C1:1.0:eyes"],"reads":[]}');
});
