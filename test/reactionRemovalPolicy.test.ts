import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { connectHost, fakeSlack, initialize } from './harness.js';
import { SlackMcplServer } from '../src/server.js';

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
    { method: 'info', args: { channel: 'C1' } },
    { method: 'unreact', args: { channel: 'C1', timestamp: '1.0', name: 'eyes' } },
  ]);
  f.state.conversation.is_member = false;
  await assert.rejects(f.adapter.removeReaction('C1', '1.0', ':eyes:'));
  assert.deepEqual(f.methods(), ['info', 'info', 'unreact', 'info']);
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

// Exercise the optional composition surface even before #56's fixture lands.
test('policy composition: revoked membership denies joining successful ACK cleanup', async t => {
  const f = fakeSlack({ ackReaction: 'eyes' });
  const policy = f.slack as unknown as {
    hasAccessPolicy: boolean;
    requireWritableConversation(id: string, scope: string, notDone: string): Promise<void>;
    web: { reactions: { remove(): Promise<void> } };
  };
  let admitted = true;
  const checks: unknown[] = [];
  Object.defineProperty(policy, 'hasAccessPolicy', { value: true });
  policy.requireWritableConversation = async (id, scope, notDone) => {
    checks.push({ id, scope, notDone });
    if (!admitted) throw new Error('No reaction was removed: membership revoked');
  };
  let release!: () => void;
  let effects = 0;
  policy.web.reactions.remove = async () => { effects++; await new Promise<void>(r => { release = r; }); };
  t.after(async () => { release?.(); await f.slack.stop(); });
  await f.slack.acknowledge('C1', '1.0');
  const clearing = f.slack.clearAck('C1');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  admitted = false;
  const denied = assert.rejects(f.slack.removeReaction('C1', '1.0', 'eyes'), /membership revoked/);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([clearing, denied]);
  assert.deepEqual(checks, [{ id: 'C1', scope: 'reactions:write', notDone: 'No reaction was removed' }]);
  assert.equal(effects, 1, 'only the already-running automatic cleanup reaches Slack');
});

test('policy composition: server refuses revocation while joined ACK cleanup is in flight', async t => {
  const f = fakeSlack({ ackReaction: 'eyes' });
  const policy = f.slack as unknown as {
    requireWritableConversation(id: string, scope: string, notDone: string): Promise<void>;
    web: { reactions: { remove(): Promise<void> } };
  };
  let admitted = true;
  const checks: unknown[] = [];
  Object.defineProperty(policy, 'hasAccessPolicy', { value: true });
  policy.requireWritableConversation = async (id, scope, notDone) => {
    checks.push({ id, scope, notDone });
    if (!admitted) throw new Error(`${notDone}: membership revoked`);
  };
  let release!: () => void;
  let effects = 0;
  policy.web.reactions.remove = async () => { effects++; await new Promise<void>(r => { release = r; }); };
  const h = connectHost(new SlackMcplServer(f.slack));
  t.after(async () => { release?.(); await h.close(); await f.slack.stop(); });
  await initialize(h, false);
  await f.slack.acknowledge('C1', '1.0');
  const clearing = f.slack.clearAck('C1');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(release);
  const removing = h.host.sendRequest('tools/call', {
    name: 'remove_reaction', arguments: { channelId: 'C1', messageId: '1.0', emoji: 'eyes' },
  });
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks.length, 1, 'the call passed initial admission and is joining cleanup');
  admitted = false;
  release();
  await clearing;
  const result = await removing as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /No reaction was removed: membership revoked/);
  assert.deepEqual(checks, Array(2).fill({ id: 'C1', scope: 'reactions:write', notDone: 'No reaction was removed' }));
  assert.equal(effects, 1, 'only the already-running automatic cleanup reaches Slack');
});
