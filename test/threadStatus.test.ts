/** Optional typing, delivery ownership and best-effort Slack status lifecycle. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { McplConnection, method } from '@animalabs/mcpl-core';
import * as net from 'node:net';
import { spawnSync } from 'node:child_process';
import { serveTcp } from '../src/tcp.js';
import { SlackAdapter, SlackWebClient, SLACK_CLIENT_OPTIONS } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { FULL_GRANT, MENTION_EVENT, answerAsHost, connectHost, fakeSlack, harness, initialize, until, type HarnessOptions } from './harness.js';
import { fakeSlackApi } from './slackApi.js';
import { virtualClock, elapse } from './virtualClock.js';

const GRANT = [...FULL_GRANT, 'channels.typing'];
const typing = (h: { host: ReturnType<typeof harness>['host'] }, op = 'start', name: string = method.CHANNELS_TYPING) =>
  h.host.sendNotification(name, { channelId: 'slack:C1', op });
const publish = (h: ReturnType<typeof harness>) => h.host.sendRequest(method.CHANNELS_PUBLISH,
  { channelId: 'slack:C1', content: [{ type: 'text', text: 'answer' }] });
const delivered = (h: ReturnType<typeof harness>) => h.hostSaw.filter((r) => r.method === method.PUSH_EVENT || r.method === method.CHANNELS_INCOMING).length;
async function ready(h: Pick<ReturnType<typeof harness>, 'host' | 'hostSaw'>, grant = GRANT) {
  await initialize(h, true);
  return h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: grant });
}
async function connected(t: TestContext, opts: HarnessOptions = {}, grant = GRANT) {
  const h = harness(opts);
  t.after(() => h.close());
  const receipt = await ready(h, grant);
  return { h, receipt };
}
// A tools/list request is processed after preceding notifications; then join their queued
// status work. No fixed delay is needed to prove an absent status call.
async function settled(h: Pick<ReturnType<typeof harness>, 'host' | 'server'>) {
  await h.host.sendRequest('tools/list');
  await Promise.all(h.server['slack']['statusQueue'].values());
}

async function mention(h: ReturnType<typeof harness>, extra = {}) {
  const before = delivered(h);
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '5.0', thread_ts: '4.0', ...extra });
  await until(() => delivered(h) > before, 'message delivered');
  await Promise.all(h.server['forwarding'].values()); // Wait for taken()/notTaken().
}

test('R1-1/R1-6: original harness grant keeps push and publish, with no status', async (t) => {
  const { h, receipt } = await connected(t, {}, FULL_GRANT);
  assert.ok(!(receipt as any).unavailableFeatures.some((f: any) => f.featureSet === 'slack.messaging'));
  await mention(h);
  typing(h);
  await settled(h);
  assert.deepEqual(h.statuses, []);
  assert.equal((await publish(h) as any).delivered, true);
  assert.equal(h.posts.length, 1);
});

test('R1-2: ambient delivery does not move a pending addressed thread', async (t) => {
  const { h } = await connected(t);
  await mention(h);
  typing(h);
  await until(() => h.statuses.length === 1, 'status');
  await mention(h, { ts: '6.0', thread_ts: '6.0', text: 'lunch?', user: 'U3' });
  typing(h);
  await settled(h);
  assert.deepEqual(h.statuses, ['C1:4.0:is thinking…']);
});

test('R1-2: a refused addressed message gets no status', async (t) => {
  const { h } = await connected(t, { pushAccepted: false });
  await mention(h);
  typing(h);
  await settled(h);
  assert.deepEqual(h.statuses, []);
});

for (const end of ['stop', 'publish', 'tool'] as const) {
  test(`R1-2: ${end} forgets the pending thread; a later turn does not revive it`, async (t) => {
    const { h } = await connected(t);
    await mention(h);
    typing(h);
    await until(() => h.statuses.length === 1, 'status');
    if (end === 'publish') {
      await publish(h);
      assert.equal((h.posts.at(-1) as any).thread_ts, '4.0');
    }
    else if (end === 'tool') await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'answer' } });
    else typing(h, 'stop');
    await until(() => h.statuses.length === 2, 'clear');
    typing(h);
    await settled(h);
    assert.deepEqual(h.statuses, ['C1:4.0:is thinking…', 'C1:4.0:']);
  });
}

test('R1-3: top-level mention stays top-level through publish, without a status', async (t) => {
  const { h } = await connected(t);
  await mention(h, { thread_ts: undefined });
  typing(h);
  await settled(h);
  await publish(h);
  assert.deepEqual(h.statuses, []);
  assert.equal((h.posts.at(-1) as any).thread_ts, undefined);
});

test('R1-6: notifications/typing alias sets and clears; idle typing is silent', async (t) => {
  const { h } = await connected(t);
  typing(h);
  await settled(h);
  assert.deepEqual(h.statuses, []);
  await mention(h);
  typing(h, 'start', 'notifications/typing');
  await until(() => h.statuses.length === 1, 'alias status');
  typing(h, 'stop', 'notifications/typing');
  await until(() => h.statuses.length === 2, 'alias clear');
});

test('R1-1: explicitly disabled typing set cannot set status', async (t) => {
  const { h } = await connected(t);
  await mention(h);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: GRANT, disabled: ['slack.typing'] });
  typing(h);
  await settled(h);
  assert.deepEqual(h.statuses, []);
});

test('R1-5: peer close clears status and a new peer has no pending thread', async (t) => {
  const f = fakeSlack();
  const server = new SlackMcplServer(f.slack);
  const a = connectHost(server);
  t.after(() => a.close());
  await ready(a);
  await f.socket.emitMessage({ ...MENTION_EVENT, thread_ts: '4.0' });
  await until(() => a.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'first delivery');
  await Promise.all(server['forwarding'].values());
  typing(a);
  await until(() => f.statuses.length === 1, 'first status');
  await a.close();
  await Promise.all(f.slack['statusQueue'].values());
  assert.deepEqual(f.statuses, ['C1:4.0:is thinking…', 'C1:4.0:'], 'clear before another peer types');
  const b = connectHost(server);
  t.after(() => b.close());
  await ready(b);
  typing(b);
  await b.host.sendRequest('tools/list');
  await Promise.all(f.slack['statusQueue'].values());
  assert.deepEqual(f.statuses, ['C1:4.0:is thinking…', 'C1:4.0:']);
});

type Status = { channel_id: string; thread_ts: string; status: string };
function adapter(opts: { sendChannels?: string[]; disableDms?: boolean; absent?: boolean; set?: (a: Status) => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const web = {
    chat: { postMessage: async () => ({ ts: '9.0' }) },
    conversations: { info: async () => ({ channel: { is_mpim: true } }) },
    assistant: opts.absent ? undefined : { threads: { setStatus: async (a: Status) => {
      calls.push(`${a.channel_id}:${a.thread_ts}:${a.status}`);
      return opts.set?.(a);
    } } },
  } as any;
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  return { a: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, opts.sendChannels, opts.disableDms), calls };
}

test('status refreshes after sixty seconds, and moving threads clears first', async (t) => {
  virtualClock(t);
  const { a, calls } = adapter();
  await a.setThreadStatus('C1', '1.0');
  await a.setThreadStatus('C1', '1.0');
  elapse(60000);
  await a.setThreadStatus('C1', '1.0');
  await a.setThreadStatus('C1', '2.0');
  await a.setThreadStatus('C1', undefined);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:is thinking…', 'C1:1.0:', 'C1:2.0:is thinking…', 'C1:2.0:']);
});

for (const opts of [{ sendChannels: ['C9'] }, { disableDms: true }, { absent: true }]) {
  test(`R1-6: no status when ${JSON.stringify(opts)}`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const { a, calls } = adapter(opts);
    await a.setThreadStatus('C1', '1.0');
    await a.setThreadStatus('D1', '1.0');
    assert.deepEqual(calls, []);
  });
}

for (const code of ['method_deprecated', 'method_not_supported_for_channel_type', 'internal_error']) {
  test(`R1-4: real WebClient ${code} is ${code === 'internal_error' ? 'retryable' : 'suppressed'}`, async (t) => {
    const api = await fakeSlackApi();
    t.after(() => api.close());
    const log = t.mock.method(console, 'error', () => {});
    api.answerFor('assistant.threads.setStatus', { body: { ok: false, error: code } });
    const web = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
    const socket = { on() {}, async start() {}, async disconnect() {} } as any;
    const a = new SlackAdapter(web as any, socket, 'UBOT', 'acme');
    for (let i = 0; i < 3; i++) await a.setThreadStatus('C1', '1.0');
    const expected = code === 'internal_error' ? 3 : 1;
    assert.equal(api.calls.length, expected);
    assert.equal(log.mock.callCount(), expected);
  });
}

test('R1-5: shutdown clears and refuses new starts', async () => {
  const { a, calls } = adapter();
  await a.setThreadStatus('C1', '1.0');
  await a.stop();
  await a.setThreadStatus('C1', '2.0');
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

for (const fail of [false, true]) {
  test(`R1-5: slow set (${fail ? 'failure' : 'success'}) is ordered before move and stop`, async (t) => {
    t.mock.method(console, 'error', () => {});
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { a, calls } = adapter({ set: async ({ thread_ts, status }) => {
      if (thread_ts === '1.0' && status) { await held; if (fail) throw new Error('transient'); }
    } });
    const first = a.setThreadStatus('C1', '1.0');
    await until(() => calls.length === 1, 'in flight');
    const next = a.setThreadStatus('C1', '2.0');
    const stop = a.setThreadStatus('C1', undefined);
    await nextTurn();
    const beforeRelease = [...calls];
    release();
    await Promise.all([first, next, stop]);
    assert.deepEqual(beforeRelease, ['C1:1.0:is thinking…']);
    assert.equal(calls.at(-1), 'C1:2.0:');
  });
}

test('R1-4: a permanent refusal lasts only for this peer, with no pointless stop call', async (t) => {
  t.mock.method(console, 'error', () => {});
  let refuse = true;
  const { a, calls } = adapter({ set: async () => {
    if (refuse) throw Object.assign(new Error('no_permission'), {
      code: 'slack_webapi_platform_error', data: { error: 'no_permission' },
    });
  } });
  await a.setThreadStatus('C1', '1.0');
  await a.setThreadStatus('C1', undefined);
  refuse = false;
  await a.setThreadStatus('C1', '2.0');
  assert.equal(calls.length, 1);
  await a.resetThreadStatuses();
  await a.setThreadStatus('C1', '2.0');
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:2.0:is thinking…']);
});

test('R1-5: shutdown waits for in-flight set, skips queued start, then clears', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const { a, calls } = adapter({ set: async ({ status }) => { if (status) await held; } });
  const first = a.setThreadStatus('C1', '1.0');
  await until(() => calls.length === 1, 'in flight');
  const queued = a.setThreadStatus('C1', '2.0');
  const stopping = a.stop();
  await nextTurn();
  release();
  await Promise.all([first, queued, stopping]);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

test('an unconfirmed post retains pending context, but a confirmed post ends it', async (t) => {
  const f = fakeSlack();
  const server = new SlackMcplServer(f.slack);
  const h = { ...f, server, ...connectHost(server) };
  t.after(() => h.close());
  await ready(h);
  await mention(h);
  typing(h);
  await until(() => h.statuses.length === 1, 'status');
  const original = f.slack.sendMessage.bind(f.slack);
  let fail = true;
  t.mock.method(f.slack, 'sendMessage', async (...args: Parameters<typeof original>) => {
    if (fail) throw new Error('post not confirmed');
    return original(...args);
  });
  await assert.rejects(publish(h));
  typing(h);
  await settled(h);
  assert.deepEqual(h.statuses, ['C1:4.0:is thinking…']);
  fail = false;
  await publish(h);
  await until(() => h.statuses.length === 2, 'clear');
  typing(h);
  await settled(h);
  assert.deepEqual(h.statuses, ['C1:4.0:is thinking…', 'C1:4.0:']);
});

/** A completed event-loop turn, not an elapsed-time guess. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function holdClear(t: TestContext, slack: SlackAdapter) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const threads = slack['web'].assistant!.threads;
  const original = threads.setStatus.bind(threads);
  let clearing = false;
  t.mock.method(threads, 'setStatus', async (args: Status) => {
    if (!args.status) { clearing = true; await held; }
    return original(args);
  });
  return { release, clearing: () => clearing };
}

test('R2-M1: no acknowledgement for messages arriving during a held disconnect clear', async (t) => {
  const f = fakeSlack({ ackReaction: 'eyes' });
  const server = new SlackMcplServer(f.slack);
  const h = { ...f, server, ...connectHost(server) };
  await ready(h);
  await mention(h);
  typing(h);
  await until(() => f.statuses.length === 1, 'status');
  const held = holdClear(t, f.slack);
  const closing = h.close();
  t.after(async () => { held.release(); await closing; await f.slack.stop(); });
  await until(held.clearing, 'held clear');
  await f.socket.emitMessage({ ...MENTION_EVENT, ts: '7.0', thread_ts: '7.0' });
  await nextTurn();
  assert.ok(!f.reactions.some((r) => r.startsWith('add:C1:7.0:')), 'no false received reaction');
  assert.equal(server['conn'], null, 'peer forgotten before cleanup');
});

test('R2-M2: TCP reconnect is accepted while the previous peer clear is held', async (t) => {
  const f = fakeSlack();
  const server = new SlackMcplServer(f.slack);
  const tcp = net.createServer();
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const logs: string[] = [];
  serveTcp(tcp, (c) => server.serve(c), (...args) => logs.push(args.join(' ')));
  const sockets: net.Socket[] = [];
  const held = holdClear(t, f.slack);
  t.after(async () => {
    held.release();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    await f.slack.stop();
  });
  const connect = async () => {
    const socket = net.connect((tcp.address() as net.AddressInfo).port, '127.0.0.1');
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const host = McplConnection.fromTcp(socket);
    const hostSaw = answerAsHost(host);
    await ready({ host, hostSaw });
    return { host, hostSaw, socket };
  };
  const first = await connect();
  await f.socket.emitMessage({ ...MENTION_EVENT, ts: '5.0', thread_ts: '4.0' });
  await until(() => server['forwardedWatermark'].get('C1') === '5.0', 'accepted first message');
  typing(first);
  await until(() => f.statuses.length === 1, 'first status');
  first.socket.destroy();
  await until(held.clearing, 'old peer clear');
  await nextTurn();
  const second = await connect();
  assert.ok(!logs.some((l) => l.includes('Refused a client')));
  await f.socket.emitMessage({ ...MENTION_EVENT, ts: '8.0', thread_ts: '8.0' });
  await until(() => server['forwardedWatermark'].get('C1') === '8.0', 'accepted second message');
  typing(second);
  await second.host.sendRequest('tools/list');
  assert.deepEqual(f.statuses, ['C1:4.0:is thinking…'], 'new status waits behind the old clear');
  held.release();
  await until(() => f.statuses.length === 3, 'old clear then new set');
  assert.deepEqual(f.statuses, ['C1:4.0:is thinking…', 'C1:4.0:', 'C1:8.0:is thinking…']);
});

for (const where of ['Slack rejection', 'unexpected turn failure']) {
  test(`R2-M3: ${where} cannot crash or poison the queue`, () => {
    // Isolate the original process-exiting failure, including fire-and-forget
    // calls exactly as the server makes them. The child must exit normally.
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { SlackAdapter } from ${JSON.stringify(new URL('../src/slack-adapter.ts', import.meta.url).href)};
      const calls = [];
      let bad = true;
      const web = { assistant: { threads: { setStatus: async (args) => {
        calls.push(args.status);
        if (bad && ${JSON.stringify(where)} === 'Slack rejection') throw null;
      } } } };
      const a = new SlackAdapter(web, { on() {}, async disconnect() {} }, 'UBOT', 'acme');
      if (${JSON.stringify(where)} === 'unexpected turn failure') {
        a.canWrite = () => { if (bad) throw undefined; return true; };
      }
      void a.setThreadStatus('C1', '1.0');
      await new Promise(setImmediate);
      assert.equal(a.statusQueue.size, 0, 'failed turn was removed');
      bad = false;
      await a.setThreadStatus('C1', '2.0');
      await a.setThreadStatus('C1', undefined);
      assert.equal(calls.at(-1), '');
      assert.ok(calls.includes('is thinking…'), 'later set reached Slack');
      assert.equal(a.statusQueue.size, 0, 'queue drained');
      assert.equal(a.statusOn.size, 0, 'clear removed ownership');
      console.log('alive, later set and clear completed, maps empty');
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /alive, later set and clear completed, maps empty/);
  });
}

test('a late old-peer refusal cannot disable the new peer status', async (t) => {
  t.mock.method(console, 'error', () => {});
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { a, calls } = adapter({ set: async ({ thread_ts, status }) => {
    if (thread_ts === '1.0') {
      if (status) await held;
      throw Object.assign(new Error('no_permission'), {
        code: 'slack_webapi_platform_error', data: { error: 'no_permission' },
      });
    }
  } });
  const first = a.setThreadStatus('C1', '1.0');
  await until(() => calls.length === 1, 'old set in flight');
  const reset = a.resetThreadStatuses();
  const second = a.setThreadStatus('C1', '2.0');
  release();
  await Promise.all([first, reset, second]);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:2.0:is thinking…'],
    'a definitively refused set needs no teardown clear, and cannot suppress the new peer');
  await a.setThreadStatus('C1', undefined);
  assert.equal(calls.at(-1), 'C1:2.0:');
});

test('R3-P2: a refused teardown clear does not suppress the next peer set', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { a, calls } = adapter({ set: async ({ status }) => {
    if (!status) throw Object.assign(new Error('method_deprecated'), {
      code: 'slack_webapi_platform_error', data: { error: 'method_deprecated' },
    });
  } });
  await a.setThreadStatus('C1', '1.0');
  await a.resetThreadStatuses();
  assert.equal(a['statusRefused'].has('C1'), false, 'a clear is not a refused set');
  await a.setThreadStatus('C1', '2.0');
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:', 'C1:2.0:is thinking…']);
  await a.setThreadStatus('C1', undefined);
  assert.equal(a['statusQueue'].size, 0);
  assert.equal(a['statusOn'].size, 0);
});

test('R3-P1: a non-Error rejection permits an immediate same-thread refresh retry', async (t) => {
  virtualClock(t);
  t.mock.method(console, 'error', () => {});
  let bad = true;
  const { a, calls } = adapter({ set: async () => { if (bad) throw null; } });
  await a.setThreadStatus('C1', '1.0');
  bad = false;
  await a.setThreadStatus('C1', '1.0'); // No clock advance: still inside the throttle window.
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:is thinking…']);
  await a.setThreadStatus('C1', undefined);
});

test('an uncertain set failure keeps ownership for the teardown clear', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { a, calls } = adapter({ set: async ({ status }) => {
    if (status) throw Object.assign(new Error('ratelimited'), {
      code: 'slack_webapi_platform_error', data: { error: 'ratelimited' },
    });
  } });
  await a.setThreadStatus('C1', '1.0');
  assert.equal(a['statusOn'].get('C1')?.ts, '1.0', 'an uncertain set may have landed');
  assert.equal(a['statusRefused'].has('C1'), false);
  await a.resetThreadStatuses();
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
  assert.equal(a['statusOn'].size, 0);
  assert.equal(a['statusQueue'].size, 0);
});

test('a refused old-peer set cannot suppress a new peer while another clear is pending', async (t) => {
  t.mock.method(console, 'error', () => {});
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const { a, calls } = adapter({ set: async ({ channel_id, status }) => {
    if (channel_id === 'C1' && status) throw Object.assign(new Error('no_permission'), {
      code: 'slack_webapi_platform_error', data: { error: 'no_permission' },
    });
    if (channel_id === 'C2' && !status) await held;
  } });
  await a.setThreadStatus('C1', '1.0');
  await a.setThreadStatus('C2', '1.0');
  assert.equal(a['statusRefused'].has('C1'), true, 'the old set armed suppression');
  const reset = a.resetThreadStatuses();
  const second = a.setThreadStatus('C1', '2.0');
  // Wait for the new peer's turn while C2's clear is still held open.
  await second;
  const attempted = calls.includes('C1:2.0:is thinking…');
  release();
  await reset;
  assert.ok(attempted, 'reset must retire old suppression before any new turn runs');
  assert.equal(a['statusQueue'].size, 0);
});
