import test from 'node:test';
import assert from 'node:assert/strict';
import { backscrollBlock } from '../src/server.js';

const message = (id: number, content: string) => ({id: `${id}.000001`, timestamp: new Date(id * 1000), authorName: 'Ann', content, attachments: []});
test('oversized backscroll message has an in-position fetchable placeholder', () => {
  const rows = [message(1, 'old one'), message(2, 'old two'), message(3, 'x'.repeat(33000)), message(4, 'newest')];
  const block = backscrollBlock(rows, {isDM: false});
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /\[1970-01-01T00:00:03.000Z id=3.000001\] Ann: message omitted \(\d+ bytes\); fetch_history has it/);
  assert.ok(block.indexOf('old two') < block.indexOf('message omitted'));
  assert.ok(block.indexOf('message omitted') < block.indexOf('newest'));
  assert.match(block, /count="4"/);
  assert.doesNotMatch(block, /1 backscroll messages/);
});
test('thousand-message backscroll keeps a contiguous newest window including placeholders within byte budget', () => {
  const rows = Array.from({length: 1000}, (_, i) => message(i + 1, '😀'.repeat(17000)));
  const block = backscrollBlock(rows, {isDM: false, channelName: 'ops'});
  assert.ok(Buffer.byteLength(block) <= 32768);
  const ids = [...block.matchAll(/id=(\d+)\.000001/g)].map(m => Number(m[1]));
  assert.ok(ids.length > 0 && ids.length < 1000);
  assert.deepEqual(ids, Array.from({length: ids.length}, (_, i) => 1001 - ids.length + i));
  assert.match(block.split('\n')[1], new RegExp(`^\\[${1000 - ids.length} older backscroll messages not shown; fetch_history latest=${ids[0]}.000001 has them\\]$`));
  assert.equal((block.match(/fetch_history has it/g) || []).length, ids.length);
});
test('older backscroll summary uses singular when one message is outside the window', () => {
  // Large names also count against both placeholder and framing budgets.
  const rows = Array.from({length: 3}, (_, i) => ({...message(i + 1, 'x'.repeat(40000)), authorName: 'A'.repeat(12000)}));
  const block = backscrollBlock(rows, {isDM: true});
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /1 older backscroll message not shown; fetch_history latest=2.000001 has it/);
});

test('configured thousand-message backscroll is bounded on first-interaction delivery', async (t) => {
  const { method } = await import('@animalabs/mcpl-core');
  const { harness, initialize, FULL_GRANT, until } = await import('./harness.js');
  const previous = process.env.SLACK_BACKSCROLL_LIMIT;
  process.env.SLACK_BACKSCROLL_LIMIT = '1000';
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_BACKSCROLL_LIMIT;
    else process.env.SLACK_BACKSCROLL_LIMIT = previous;
  });
  const h = harness({historyMessages: Array.from({length: 1000}, (_, i) => ({
    ts: `${1000 - i}.000001`, user: 'U2', text: 'x'.repeat(33000),
  }))});
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: FULL_GRANT});
  await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
  await h.socket.emitMessage({type: 'message', channel: 'C1', user: 'U1', ts: '2000.000001', text: '<@UBOT> hi'});
  await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'delivery');
  const push = h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params as {payload: {content: Array<{text: string}>}};
  const block = push.payload.content.map(c => c.text).join('\n').match(/<backscroll [\s\S]*?<\/backscroll>/)![0];
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /\[\d+ older backscroll messages not shown/);
  const older = Number(block.match(/\[(\d+) older backscroll messages not shown/)![1]);
  const ids = [...block.matchAll(/id=(\d+)\.000001/g)].map(m => Number(m[1]));
  assert.equal(older + ids.length, 1000, 'configured fetch limit reaches the production frame');
  assert.deepEqual(ids, Array.from({length: ids.length}, (_, i) => older + i + 1));
  assert.equal((block.match(/fetch_history has it/g) || []).length, ids.length);
});

test('backscroll placeholders also preserve positions of messages that fit the full budget individually', () => {
  const rows = Array.from({length: 50}, (_, i) => message(i + 1, 'x'.repeat(1000)));
  for (const row of rows) {
    assert.doesNotMatch(backscrollBlock([row], {isDM: false}), /message omitted/);
  }
  const block = backscrollBlock(rows, {isDM: false});
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /message omitted/);
  assert.match(block, /older backscroll messages not shown; fetch_history latest=/);
  const ids = [...block.matchAll(/id=(\d+)\.000001/g)].map(m => Number(m[1]));
  assert.deepEqual(ids, Array.from({length: ids.length}, (_, i) => 51 - ids.length + i));
});
