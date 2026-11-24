import test from 'node:test';
import assert from 'node:assert/strict';
import { backscrollBlock } from '../src/server.js';

// Give each config case a first read without disturbing the regular module's cache.
let serverModuleInstance = 0;
function freshServerModule(): Promise<typeof import('../src/server.js')> {
  return import(`../src/server.js?backscroll-limit-test=${serverModuleInstance++}`);
}

const message = (id: number, content: string) => ({id: `${id}.000001`, timestamp: new Date(id * 1000), authorName: 'Ann', content, attachments: []});
test('oversized backscroll message has an in-position omission placeholder', () => {
  const rows = [message(1, 'old one'), message(2, 'old two'), message(3, 'x'.repeat(33000)), message(4, 'newest')];
  const block = backscrollBlock(rows, {isDM: false}, true);
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /\[backscroll notice: message omitted \(\d+ bytes\); timestamp=1970-01-01T00:00:03\.000Z id=3\.000001; author="Ann"; try fetch_history; follow nextCursor until this id is reached\]/);
  assert.equal(block.split('\n').length, 6, 'four row positions plus opening and closing frame');
  assert.ok(block.includes('old one'));
  assert.ok(block.indexOf('old one') < block.indexOf('old two'));
  assert.ok(block.includes('old two'));
  assert.ok(block.indexOf('old two') < block.indexOf('message omitted'));
  assert.ok(block.indexOf('message omitted') < block.indexOf('newest'));
  assert.match(block, /count="4"/);
  assert.doesNotMatch(block, /1 backscroll messages/);
});
test('thousand-message backscroll keeps a contiguous newest window including placeholders within byte budget', () => {
  const rows = Array.from({length: 1000}, (_, i) => message(i + 1, '😀'.repeat(17000)));
  const block = backscrollBlock(rows, {isDM: false, channelName: 'ops'}, true);
  assert.ok(Buffer.byteLength(block) <= 32768);
  const ids = [...block.matchAll(/id=(\d+)\.000001/g)].map(m => Number(m[1]));
  assert.equal(ids.length, 183, 'maximal retained placeholder window for this fixed frame');
  assert.deepEqual(ids, Array.from({length: ids.length}, (_, i) => 1001 - ids.length + i));
  assert.match(block.split('\n')[1], new RegExp(`^\\[${1000 - ids.length} older backscroll messages not shown; try fetch_history latest=${ids[0]}\\.000001\\]$`));
  assert.equal((block.match(/bytes\).*; try fetch_history/g) || []).length, ids.length);
});
test('older backscroll summary uses singular when one message is outside the window', () => {
  // Large names also count against both placeholder and framing budgets.
  const rows = Array.from({length: 3}, (_, i) => ({...message(i + 1, 'x'.repeat(40000)), authorName: 'A'.repeat(12000)}));
  const block = backscrollBlock(rows, {isDM: true}, true);
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /1 older backscroll message not shown; try fetch_history latest=2\.000001/);
});

test('configured thousand-message backscroll is bounded on first-interaction delivery', async (t) => {
  const { method } = await import('@animalabs/mcpl-core');
  const { connectHost, fakeSlack, initialize, FULL_GRANT, until } = await import('./harness.js');
  const previous = process.env.SLACK_BACKSCROLL_LIMIT;
  process.env.SLACK_BACKSCROLL_LIMIT = '1000';
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_BACKSCROLL_LIMIT;
    else process.env.SLACK_BACKSCROLL_LIMIT = previous;
  });
  const { SlackMcplServer } = await freshServerModule();
  const { slack, socket } = fakeSlack({historyMessages: Array.from({length: 1000}, (_, i) => ({
    ts: `${1000 - i}.000001`, user: 'U2', text: 'x'.repeat(33000),
  }))});
  const h = connectHost(new SlackMcplServer(slack));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: FULL_GRANT});
  await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
  await socket.emitMessage({type: 'message', channel: 'C1', user: 'U1', ts: '2000.000001', text: '<@UBOT> hi'});
  await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'delivery');
  const push = h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params as {payload: {content: Array<{text: string}>}};
  const block = push.payload.content.map(c => c.text).join('\n').match(/<backscroll [\s\S]*?<\/backscroll>/)![0];
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /\[\d+ older backscroll messages not shown/);
  const older = Number(block.match(/\[(\d+) older backscroll messages not shown/)![1]);
  const ids = [...block.matchAll(/id=(\d+)\.000001/g)].map(m => Number(m[1]));
  assert.equal(ids.length, 184, 'retain the full fixed-fixture placeholder window');
  assert.equal(older + ids.length, 1000, 'configured fetch limit reaches the production frame');
  assert.deepEqual(ids, Array.from({length: ids.length}, (_, i) => older + i + 1));
  assert.equal((block.match(/bytes\).*; try fetch_history/g) || []).length, ids.length);
});

test('backscroll placeholders also preserve positions of messages that fit the full budget individually', () => {
  const rows = Array.from({length: 50}, (_, i) => message(i + 1, 'x'.repeat(1000)));
  for (const row of rows) {
    assert.doesNotMatch(backscrollBlock([row], {isDM: false}), /message omitted/);
  }
  const block = backscrollBlock(rows, {isDM: false}, true);
  assert.ok(Buffer.byteLength(block) <= 32768);
  assert.match(block, /message omitted/);
  assert.match(block, /older backscroll messages not shown; try fetch_history latest=/);
  const ids = [...block.matchAll(/id=(\d+)\.000001/g)].map(m => Number(m[1]));
  assert.equal(ids.length, 32, 'retain every row position that fits this fixed frame');
  assert.equal(ids.at(-1), 50, 'retain the newest message position');
  assert.deepEqual(ids, Array.from({length: ids.length}, (_, i) => 51 - ids.length + i));
});

test('omission markers do not promise history access or whole oversized messages', async (t) => {
  const { method } = await import('@animalabs/mcpl-core');
  const { harness, initialize, FULL_GRANT, until } = await import('./harness.js');
  for (const granted of [false, true]) {
    const h = harness({historyMessages: [{ts: '100.000001', user: 'U2', text: 'x'.repeat(1_100_000)}]});
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
      effectiveCapabilities: FULL_GRANT, disabled: granted ? [] : ['slack.history'],
    });
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
    await h.socket.emitMessage({type: 'message', channel: 'C1', user: 'U1', ts: '2000.000001', text: '<@UBOT> hi'});
    await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'delivery');
    const push = h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params as {payload: {content: Array<{text: string}>}};
    const block = push.payload.content.map(c => c.text).join('\n').match(/<backscroll [\s\S]*?<\/backscroll>/)![0];
    assert.match(block, /message omitted/);
    if (granted) {
      assert.match(block, /try fetch_history/);
      assert.doesNotMatch(block, /has it/);
    } else {
      assert.doesNotMatch(block, /fetch_history|missing host grant/);
      assert.match(block, /history unavailable: host has not selected feature set slack\.history/);
    }
  }
  const rows = Array.from({length: 1000}, (_, i) => message(i, 'x'.repeat(33000)));
  const defaultBlock = backscrollBlock(rows, {isDM: false});
  assert.doesNotMatch(defaultBlock, /fetch_history/);
  assert.match(defaultBlock, /backscroll notice: message omitted/);
  assert.match(defaultBlock, /history unavailable: host has not selected feature set slack\.history/);
});

test('inactive history omission notices explicitly name the host-selected feature set', () => {
  const rows = Array.from({length: 1000}, (_, i) => message(i + 1, 'x'.repeat(33000)));
  const block = backscrollBlock(rows, {isDM: false}, false);
  assert.match(block, /older backscroll messages not shown; history unavailable: host has not selected feature set slack\.history/);
  assert.match(block, /backscroll notice: message omitted.*history unavailable: host has not selected feature set slack\.history/);
  assert.doesNotMatch(block, /Ann: message omitted|try fetch_history/);
  assert.ok(Buffer.byteLength(block) <= 32768);
});

test('an empty retained window still gives pagination instructions', () => {
  const block = backscrollBlock([{...message(1, 'x'), authorName: 'A'.repeat(40000)}], {isDM: false}, true);
  assert.match(block, /count="0"/);
  assert.match(block, /follow nextCursor until the omitted window is reached/);
  assert.ok(Buffer.byteLength(block) <= 32768);
});


test('backscroll limit is read once, warning only for a rejected value', async (t) => {
  const previous = process.env.SLACK_BACKSCROLL_LIMIT;
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_BACKSCROLL_LIMIT;
    else process.env.SLACK_BACKSCROLL_LIMIT = previous;
  });
  const loadServerPrototype = async () =>
    (await freshServerModule()).SlackMcplServer.prototype;
  const errors = t.mock.method(console, 'error', () => {});
  for (const raw of ['1000.9', '12oops', '0', '1001', '-1', 'NaN', '', '0x10', '0b10', '1e2', '12.0', '+ 12', '++12', ' 1 2 ', ' +1001 ', '  ', '9'.repeat(2000)]) {
    process.env.SLACK_BACKSCROLL_LIMIT = raw;
    const prototype = await loadServerPrototype();
    const server = Object.create(prototype);
    assert.equal(server.backscrollLimit, 50, raw);
    assert.equal(server.backscrollLimit, 50, raw);
    assert.equal(Object.create(prototype).backscrollLimit, 50, raw);
    process.env.SLACK_BACKSCROLL_LIMIT = '12';
    assert.equal(server.backscrollLimit, 50, 'keep the first result');
    assert.equal(errors.mock.callCount(), 1);
    assert.deepEqual(errors.mock.calls[0].arguments, [
      '[slack-mcpl] Invalid SLACK_BACKSCROLL_LIMIT: expected a decimal integer from 1 to 1000; using 50',
    ]);
    errors.mock.resetCalls();
  }
  delete process.env.SLACK_BACKSCROLL_LIMIT;
  assert.equal(Object.create(await loadServerPrototype()).backscrollLimit, 50);
  for (const raw of ['1', '0001', '0050', '50', '1000', '+12', ' 12', '12 ', ' +0012 ']) {
    process.env.SLACK_BACKSCROLL_LIMIT = raw;
    assert.equal(Object.create(await loadServerPrototype()).backscrollLimit, Number(raw), raw);
  }
  assert.equal(errors.mock.callCount(), 0, 'unset and valid values do not warn');
});


test('omission author is quoted once, matching normal name framing', () => {
  const row = {...message(1, 'x'.repeat(33000)), authorName: 'Alice 😀'};
  assert.equal(backscrollBlock([row], {isDM: true}, true),
    '<backscroll dm="true" count="1">\n' +
    '[backscroll notice: message omitted (33053 bytes); timestamp=1970-01-01T00:00:01.000Z id=1.000001; author="Alice 😀"; try fetch_history; follow nextCursor until this id is reached]\n' +
    '</backscroll>');
});
