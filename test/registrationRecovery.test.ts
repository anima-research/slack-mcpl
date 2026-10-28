import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  McplConnection, RpcError, method, type JsonRpcRequest, type JsonRpcNotification,
  type ChannelsRegisterParams, type ChannelsListResult,
} from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import { GaveUp } from '../src/slack-adapter.js';
import type { SlackAdapter, SlackConversationInfo, SlackWait, SlackWaitOut } from '../src/slack-adapter.js';
import { FULL_GRANT, until } from './harness.js';
import { clock } from '../src/clock.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const conversation = (id = 'C1', name = 'general'): SlackConversationInfo => ({
  id, name, kind: 'channel', isMember: true,
});

function fakeSlack(list = async () => [conversation()]) {
  const deleted: string[] = [];
  let sent = 0;
  const slack = {
    teamName: 'acme',
    dmsWritable: true,
    canWrite: () => true,
    onMessage() {},
    // A listing that left no type out, as a token with every read scope gets.
    async listConversations(...args: unknown[]) {
      return { conversations: await (list as (...given: unknown[]) => Promise<unknown[]>)(...args), leftOut: [] };
    },
    async sendMessage() { return { messageId: String(++sent) }; },
    async deleteMessage(_channel: string, id: string) { deleted.push(id); },
  } as unknown as SlackAdapter;
  return { slack, deleted };
}

function connect(
  server: SlackMcplServer,
  register?: (req: JsonRpcRequest, host: McplConnection) => void,
) {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const serverConn = McplConnection.fromStreams(toServer, toHost);
  const host = McplConnection.fromStreams(toHost, toServer);
  const requests: JsonRpcRequest[] = [];
  const notifications: JsonRpcNotification[] = [];
  host.on('notification', (msg) => notifications.push(msg));
  host.on('request', (req) => {
    requests.push(req);
    assert.equal(req.method, method.CHANNELS_REGISTER);
    if (register) register(req, host);
    else {
      const params = req.params as ChannelsRegisterParams;
      host.sendResponse(req.id, {
        results: params.channels.map((c) => ({ id: c.id, accepted: true })),
      });
    }
  });
  const served = server.serve(serverConn);
  return {
    host, serverConn, requests, notifications,
    async initialize() {
      await host.sendRequest(method.INITIALIZE, {
        capabilities: { experimental: { mcpl: { version: '0.5' } } },
      });
      host.sendNotification('notifications/initialized');
    },
    async grant(capabilities = FULL_GRANT) {
      await host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: capabilities });
    },
    async listed() {
      return (await host.sendRequest(method.CHANNELS_LIST)) as ChannelsListResult;
    },
    async refresh() {
      return host.sendRequest('tools/call', { name: 'refresh_channels', arguments: {} });
    },
    /** Until the server's latest registration has ended, however it ended. */
    async ended() {
      await until(() => (server as unknown as { registering?: unknown }).registering === undefined, 'registration to end');
    },
    async close() {
      toServer.end();
      await served;
      host.close();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// Registration's wait doesn't hold the event loop open, so a test that waits
// for one to end polls with until(), whose timer does. Node 22.12.0's test
// runner cancels a test whose event loop empties while it waits, and every
// test after it in the file. A test that checks a wait's length, or needs a
// registration to still be waiting when a refresh lands, holds time with mock
// timers instead, so the wait lasts until the test moves time past it,
// however slowly the machine runs; it polls with settled(), since until()'s
// timer is held too.

/** Polls with setImmediate until `predicate` holds, for a test whose timers are mocked. */
async function settled(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`never saw ${what}`);
}

/** The server's log lines (console.error) while the test runs. */
function serverLog(t: { after(fn: () => void): void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  return lines;
}

/** Whether a log line is the server's on a channels/register request that
 *  the connection timed out: its failure line, carrying the timeout's own
 *  message. A timeout is an RpcError with code -32000, whose words mcpl-core
 *  may change: 0.3.0 rejects with one, and so does the ConnectionTimeoutError
 *  of anima-research/mcpl-core-ts#16. The hosts here never answer with an
 *  error of that code. Made before the registration is sent, since it watches
 *  the connection's requests from then on. */
function registrationTimeouts(conn: McplConnection): (line: string) => boolean {
  const timedOut: string[] = [];
  const send = conn.sendRequest.bind(conn);
  conn.sendRequest = async (...args: Parameters<typeof send>) => {
    try {
      return await send(...args);
    } catch (err) {
      if (err instanceof RpcError && err.code === -32000) timedOut.push(err.message);
      throw err;
    }
  };
  return (line) => timedOut.some((message) => line === `[slack-mcpl] Failed to register channels: ${message}`);
}

const ids = (listed: ChannelsListResult) => listed.channels.map((d) => d.id);

/** refresh_channels' answer while registration runs. */
const stillRegistering = () =>
  "Nothing was announced to the host: this server is still registering the workspace's conversations. " +
  'Registration announces what it finds, unless it stops early. Once it has ended, refresh_channels lists again and ' +
  "announces anything registration didn't, such as a conversation created since it began; until then it answers " +
  'like this.';

test('a rejected registration is recoverable by refresh under the same grant', async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), (req, host) => host.sendError(req.id, -32002, 'denied'));
  const registrationTimedOut = registrationTimeouts(h.serverConn);
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'rejected registration');
  await settle();
  assert.ok(log.some((line) => line.startsWith('[slack-mcpl] Failed to register channels: ')), 'the refusal is logged');
  assert.ok(!log.some(registrationTimedOut), 'a refusal is not taken for a timeout');
  await h.grant();
  await settle();
  assert.equal(h.requests.length, 1, 'an unchanged grant does not start another registration');
  assert.deepEqual((await h.listed()).channels, []);
  await h.refresh();
  const added = h.notifications.find((n) => n.method === method.CHANNELS_CHANGED)!.params as { added: { id: string }[] };
  assert.deepEqual(added.added.map((d) => d.id), ['slack:C1']);
});

test('only individually accepted descriptors become known after a pending batch', async (t) => {
  const { slack } = fakeSlack(async () => [conversation('C1'), conversation('C2'), conversation('C3')]);
  const h = connect(new SlackMcplServer(slack), () => {});
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'pending registration');
  assert.deepEqual((await h.listed()).channels, [], 'pending is not accepted');
  h.host.sendResponse(h.requests[0].id, { results: [
    { id: 'slack:C1', accepted: true },
    { id: 'slack:C2', accepted: false },
    { id: 'slack:foreign', accepted: true },
  ] });
  await settle();
  assert.deepEqual((await h.listed()).channels.map((d) => d.id), ['slack:C1']);
  await h.refresh();
  const changed = h.notifications.find((n) => n.method === method.CHANNELS_CHANGED)!.params as { added: { id: string }[] };
  assert.deepEqual(changed.added.map((d) => d.id), ['slack:C2', 'slack:C3']);
});

for (const accepted of [false, true]) {
  // A refresh held back by the pending answer would wait for nothing here,
  // so a timeout fails the test instead of hanging the run.
  test(`a pending registration's ${accepted ? 'acceptance' : 'refusal'} applies before a refresh lists, and a refresh meanwhile answers at once`, { timeout: 5000 }, async (t) => {
    let calls = 0;
    const { slack } = fakeSlack(async () => [conversation('C1', ++calls === 1 ? 'stale' : 'fresh')]);
    const h = connect(new SlackMcplServer(slack), () => {});
    t.after(() => h.close());
    await h.initialize();
    await h.grant();
    await until(() => h.requests.length === 1, 'pending registration');

    const meanwhile = (await h.refresh()) as ToolResult;
    assert.equal(meanwhile.isError, true);
    assert.equal(meanwhile.content[0].text, stillRegistering());
    assert.equal(calls, 1, 'a refresh lists nothing while the answer is pending');
    h.host.sendResponse(h.requests[0].id, { results: [{ id: 'slack:C1', accepted }] });
    await h.ended();
    await h.refresh();
    assert.equal(calls, 2);
    const announced = h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED)
      .flatMap((n) => (n.params as { added: { id: string }[] }).added.map((d) => d.id));
    // An accepted channel is known before refresh lists, so it isn't announced
    // again; a refused one is unknown again, so refresh announces it.
    assert.deepEqual(announced, accepted ? [] : ['slack:C1']);
    const listed = await h.listed();
    assert.deepEqual(ids(listed), ['slack:C1']);
    assert.equal(listed.channels[0].label, '#fresh (acme)', "the registry holds refresh's newer listing");
  });
}

test("a pending refusal of a known, open channel applies before a refresh lists, which announces the channel again", { timeout: 5000 }, async (t) => {
  let answer: (sent: string[]) => unknown = (sent) => ({ results: sent.map((id) => ({ id, accepted: true })) });
  const h = connect(new SlackMcplServer(fakeSlack().slack), (req, host) => {
    const result = answer((req.params as ChannelsRegisterParams).channels.map((c) => c.id));
    if (result !== undefined) host.sendResponse(req.id, result);
  });
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'first registration');
  await settle();
  await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1', type: 'slack', address: { channelId: 'C1' } });

  answer = () => undefined; // the re-grant's answer is sent below
  await h.grant(['tools']);
  await h.grant();
  await until(() => h.requests.length === 2, "the re-grant's registration");
  assert.equal(((await h.refresh()) as ToolResult).isError, true, 'a refresh meanwhile answers at once');
  h.host.sendResponse(h.requests[1].id, { results: [{ id: 'slack:C1', accepted: false }] });
  await h.ended();
  await h.refresh();
  const announced = h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED)
    .flatMap((n) => (n.params as { added: { id: string }[] }).added.map((d) => d.id));
  assert.deepEqual(announced, ['slack:C1'], 'the refusal forgot C1 before the refresh listed it');
  const closing = await h.host.sendRequest(method.CHANNELS_CLOSE, { channelId: 'slack:C1' }) as { closed: boolean };
  assert.equal(closing.closed, false, 'the refusal closed C1');
});

test('a refresh during an unanswered registration answers at once, and lists once that request times out', async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), () => {});
  const registrationTimedOut = registrationTimeouts(h.serverConn);
  h.serverConn.requestTimeout = 1000;
  t.after(() => h.close());
  await h.initialize();
  // The request's timer is held, so the registration still waits for its
  // answer when the refresh lands, however slowly the machine runs.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.grant();
  await settled(() => h.requests.length === 1, 'registration');
  assert.equal(((await h.refresh()) as ToolResult).isError, true, 'answered at once, while registration waits for its answer');
  t.mock.timers.tick(1000);
  await settled(() => log.some(registrationTimedOut), 'the timeout');
  await h.refresh();
  assert.equal(h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED).length, 1, 'then a refresh lists and announces');
});

test("a refresh whose listing fails leaves registration's accepted channels known", async (t) => {
  let calls = 0;
  const { slack } = fakeSlack(async () => {
    if (++calls === 2) throw new Error('the Slack listing failed');
    return [conversation('C1')];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  serverLog(t);
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await h.ended();
  const result = (await h.refresh()) as ToolResult;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /the Slack listing failed/);
  assert.deepEqual(ids(await h.listed()), ['slack:C1'], 'the accepted answer stands');
});

test('a registration that throws is logged, and refresh_channels still works', async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const internal = server as unknown as { applyRegistrationAnswer(...args: unknown[]): void };
  t.mock.method(internal, 'applyRegistrationAnswer', () => { throw new Error('applying the answer failed'); });
  const h = connect(server);
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => log.some((l) => l.includes('Channel registration failed') && l.includes('applying the answer failed')), 'the logged failure');
  const result = await h.refresh() as { isError?: boolean };
  assert.notEqual(result.isError, true, "refresh doesn't rethrow the registration's failure");
  const changed = h.notifications.find((n) => n.method === method.CHANNELS_CHANGED)!.params as { added: { id: string }[] };
  assert.deepEqual(changed.added.map((d) => d.id), ['slack:C1']);
});

test('a registration still listing when refresh starts sends its whole batch first', { timeout: 5000 }, async (t) => {
  const listing = deferred<SlackConversationInfo[]>();
  let calls = 0;
  const { slack } = fakeSlack(() => ++calls === 2 ? listing.promise : Promise.resolve([conversation('C1')]));
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'first registration');
  await settle();
  assert.deepEqual(ids(await h.listed()), ['slack:C1']);
  await h.grant(['tools']);
  await h.grant();
  await until(() => calls === 2, "the re-grant's listing");

  const meanwhile = (await h.refresh()) as ToolResult;
  assert.equal(meanwhile.isError, true, 'a refresh answers at once while the re-grant lists');
  assert.equal(calls, 2, 'and lists nothing itself');
  listing.resolve([conversation('C1'), conversation('C2')]);
  await until(() => h.requests.length === 2, 'the re-grant registers');
  await h.ended();
  await h.refresh();
  assert.deepEqual(
    (h.requests[1].params as ChannelsRegisterParams).channels.map((d) => d.id),
    ['slack:C1', 'slack:C2'],
    'its batch includes the channel known before the revoke',
  );
  assert.equal(h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED).length, 0, 'refresh then finds nothing new');
  assert.deepEqual(ids(await h.listed()), ['slack:C1', 'slack:C2'], "the re-grant's answer made both known");
});

test('a registration timeout leaves descriptors available to refresh', async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), () => {});
  const registrationTimedOut = registrationTimeouts(h.serverConn);
  h.serverConn.requestTimeout = 20;
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await until(() => log.some(registrationTimedOut), 'the registration timeout');
  assert.deepEqual((await h.listed()).channels, []);
  await h.refresh();
  assert.equal(h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED).length, 1);
});

test('a response without itemized acceptance leaves the inventory unknown, and says so', async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), (req, host) => host.sendResponse(req.id, {}));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await settle();
  assert.deepEqual((await h.listed()).channels, []);
  assert.deepEqual(log.filter((l) => l.includes('channels/register')), [
    '[slack-mcpl] The host answered channels/register without itemized results, so no channel was accepted',
  ]);
});

test('only accepted === true accepts, and a malformed entry costs the others nothing', async (t) => {
  const { slack } = fakeSlack(async () => ['C1', 'C2', 'C3', 'C4', 'C5'].map((id) => conversation(id)));
  const h = connect(new SlackMcplServer(slack), (req, host) => host.sendResponse(req.id, { results: [
    null,
    { accepted: true },
    { id: 'slack:C1', accepted: true },
    { id: 'slack:C2', accepted: 'true' },
    { id: 'slack:C3', accepted: 1 },
    { id: 'slack:C4' },
    { id: 'slack:C5', accepted: true },
  ] }));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await settle();
  assert.deepEqual(ids(await h.listed()), ['slack:C1', 'slack:C5']);
});

test("each answer's refusals are logged once, with the host's reasons", async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack(async () => ['C1', 'C2', 'C3', 'C4'].map((id) => conversation(id)));
  const h = connect(new SlackMcplServer(slack), (req, host) => host.sendResponse(req.id, { results: [
    { id: 'slack:C1', accepted: true },
    { id: 'slack:C2', accepted: false, reason: 'not on the allowlist' },
    { id: 'slack:C3', accepted: false },
  ] }));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await settle();
  assert.deepEqual(ids(await h.listed()), ['slack:C1']);
  assert.deepEqual(log.filter((l) => l.includes('channels/register')), [
    '[slack-mcpl] Of 4 channels sent to channels/register, the host refused 2: ' +
      'slack:C2 (not on the allowlist), slack:C3; it left 1 unanswered: slack:C4',
  ]);
});

test('a later answer that refuses a known channel forgets and closes it, and silence forgets nothing', async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack(async () => ['C1', 'C2', 'C3'].map((id) => conversation(id)));
  let answer: (sent: string[]) => unknown = (sent) => ({ results: sent.map((id) => ({ id, accepted: true })) });
  const h = connect(new SlackMcplServer(slack), (req, host) => {
    const result = answer((req.params as ChannelsRegisterParams).channels.map((c) => c.id));
    if (result !== undefined) host.sendResponse(req.id, result);
  });
  const registrationTimedOut = registrationTimeouts(h.serverConn);
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'first registration');
  await settle();
  assert.deepEqual(ids(await h.listed()), ['slack:C1', 'slack:C2', 'slack:C3']);
  await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C2', type: 'slack', address: { channelId: 'C2' } });

  // A re-grant registers again. This answer refuses C2 and leaves C3 out.
  answer = () => ({ results: [{ id: 'slack:C1', accepted: true }, { id: 'slack:C2', accepted: false, reason: 'archived' }] });
  await h.grant(['tools']);
  await h.grant();
  await until(() => h.requests.length === 2, 'second registration');
  await settle();
  assert.deepEqual(ids(await h.listed()), ['slack:C1', 'slack:C3'], 'the refused channel is forgotten, the omitted one kept');
  const closing = await h.host.sendRequest(method.CHANNELS_CLOSE, { channelId: 'slack:C2' }) as { closed: boolean };
  assert.equal(closing.closed, false, 'the refused channel is no longer open');

  // A registration that times out forgets nothing either.
  answer = () => undefined;
  h.serverConn.requestTimeout = 20;
  await h.grant(['tools']);
  await h.grant();
  await until(() => h.requests.length === 3, 'third registration');
  await until(() => log.some(registrationTimedOut), 'the third registration timing out');
  assert.deepEqual(ids(await h.listed()), ['slack:C1', 'slack:C3']);
});

test('channels/open that names an unregistered channel fails rather than opening another', async (t) => {
  const { slack } = fakeSlack(async () => [conversation('C1'), conversation('C2')]);
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await settle();
  assert.deepEqual(ids(await h.listed()), ['slack:C1', 'slack:C2']);
  const open = async (params: Record<string, unknown>) =>
    ((await h.host.sendRequest(method.CHANNELS_OPEN, params)) as { channel: { id: string } }).channel.id;
  // channels/close answers whether the channel was open.
  const wasOpen = async (channelId: string) =>
    ((await h.host.sendRequest(method.CHANNELS_CLOSE, { channelId })) as { closed: boolean }).closed;

  await assert.rejects(open({ type: 'slack', address: { channelId: 'C9' } }), /No matching channel found/);
  await assert.rejects(open({ channelId: 'slack:C9', type: 'slack', address: {} }), /No matching channel found/);
  assert.equal(await wasOpen('slack:C1'), false, 'a failed open opens nothing');
  assert.equal(await wasOpen('slack:C2'), false, 'a failed open opens nothing');

  // A channel named by its exact id opens, rather than the type's first.
  assert.equal(await open({ channelId: 'slack:C2', type: 'slack', address: {} }), 'slack:C2');
  assert.equal(await wasOpen('slack:C1'), false);
  // A request that names no channel still opens the type's first.
  assert.equal(await open({ type: 'slack', address: {} }), 'slack:C1');
});

for (const [name, params, expected] of [
  ['an address naming only a user fails', { type: 'slack', address: { userId: 'U2' } }, undefined],
  ['an address channelId opens that channel', { type: 'slack', address: { channelId: 'C2' } }, 'slack:C2'],
  ['an empty channelId leaves the address usable', { channelId: '', type: 'slack', address: { channelId: 'C2' } }, 'slack:C2'],
  ['an exact channelId outranks a different address', { channelId: 'slack:C1', type: 'slack', address: { channelId: 'C2' } }, 'slack:C1'],
  ['an address with an empty channelId fails', { type: 'slack', address: { channelId: '' } }, undefined],
  ['another type does not read address.channelId', { type: 'other', address: { channelId: 'C2' } }, undefined],
] as const) {
  test(`channels/open: ${name}`, async (t) => {
    const { slack } = fakeSlack(async () => [conversation('C1'), conversation('C2')]);
    const h = connect(new SlackMcplServer(slack));
    t.after(() => h.close());
    await h.initialize();
    await h.grant();
    await until(() => h.requests.length === 1, 'registration');
    await settle();
    assert.deepEqual(ids(await h.listed()), ['slack:C1', 'slack:C2']);

    const opened = h.host.sendRequest(method.CHANNELS_OPEN, params);
    if (expected === undefined) {
      await assert.rejects(opened, /No matching channel found/);
    } else {
      assert.equal(((await opened) as { channel: { id: string } }).channel.id, expected);
    }
    for (const channelId of ['slack:C1', 'slack:C2']) {
      const result = await h.host.sendRequest(method.CHANNELS_CLOSE, { channelId }) as { closed: boolean };
      assert.equal(result.closed, channelId === expected, 'only the named channel may have opened');
    }
  });
}

test('a later policy dropping slack.messaging refuses rollback and preserves its checkpoint', async (t) => {
  const { slack, deleted } = fakeSlack();
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  const sent = await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'first' },
  }) as { state: { checkpoint: string } };
  await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'second' },
  });
  const rollback = () => h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: 'slack.messaging', checkpoint: sent.state.checkpoint,
  }) as Promise<{ checkpoint: string; success: boolean; reason?: string }>;

  await h.grant([]);
  assert.deepEqual(await rollback(), {
    checkpoint: sent.state.checkpoint,
    success: false,
    reason: "Feature set 'slack.messaging' is not active on this connection",
  });
  assert.deepEqual(deleted, [], 'the withdrawn grant permits no deletion');

  await h.grant();
  assert.equal((await rollback()).success, true, 'the refusal left the checkpoint usable');
  assert.deepEqual(deleted, ['2']);
});

test("a rollback counts the deletes Slack confirmed, and logs each message it couldn't delete", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const { slack, deleted } = fakeSlack();
  (slack as unknown as { deleteMessage(channel: string, id: string): Promise<void> }).deleteMessage = async (_channel, id) => {
    if (id === '2') throw new Error("chat.delete: out of this call's time");
    deleted.push(id);
  };
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  const sent = await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'first' },
  }) as { state: { checkpoint: string } };
  for (const content of ['second', 'third']) {
    await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content } });
  }
  const rolledBack = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: 'slack.messaging', checkpoint: sent.state.checkpoint,
  }) as { checkpoint: string; success: boolean; reason?: string };
  assert.deepEqual(rolledBack, {
    checkpoint: sent.state.checkpoint, success: true, reason: 'Rolled back (1/2 messages deleted). May remain: message 2 in C1. ' +
      'No rollback tries these again: delete_message can try a message among them again, by its id',
  });
  assert.deepEqual(deleted, ['3']);
  assert.deepEqual(
    lines.filter((line) => line.includes('Rollback')),
    ["[slack-mcpl] Rollback couldn't delete message 2 in C1: chat.delete: out of this call's time"],
  );
});

test('a refresh whose host leaves during its listing writes nothing for the next host', async (t) => {
  const listing = deferred<SlackConversationInfo[]>();
  let calls = 0;
  const { slack } = fakeSlack(() => ++calls === 2 ? listing.promise : Promise.resolve([conversation('C1')]));
  const server = new SlackMcplServer(slack);
  const first = connect(server);
  await first.initialize();
  await first.grant();
  await until(() => first.requests.length === 1, 'first registration');
  // The refresh lists only once that registration has ended; while it runs, a
  // refresh answers at once without listing.
  await first.ended();
  const refreshed = first.refresh().catch(() => undefined); // its answer can't arrive: the host leaves
  await until(() => calls === 2, "the refresh's listing");
  const leaving = first.close();
  await until(() => first.serverConn.isClosed, 'the first host leaving');
  listing.resolve([conversation('C1'), conversation('C2')]);
  await leaving;
  await refreshed;

  const next = connect(server, () => {}); // its own registration stays unanswered
  t.after(() => next.close());
  await next.initialize();
  await next.grant();
  await until(() => next.requests.length === 1, 'next registration');
  assert.ok(!ids(await next.listed()).includes('slack:C2'), 'the stale refresh registered nothing');
});

test('a re-grant discards an older Slack enumeration that finishes last', async (t) => {
  const old = deferred<SlackConversationInfo[]>();
  let calls = 0;
  const { slack } = fakeSlack(() => ++calls === 1 ? old.promise : Promise.resolve([conversation('C1', 'fresh')]));
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => calls === 1, 'first listing');
  await h.grant(['tools']);
  await h.grant();
  await until(() => h.requests.length === 1, 'fresh registration');
  old.resolve([conversation('C1', 'stale')]);
  await settle();
  assert.equal(h.requests.length, 1, 'stale enumeration must not reach the host');
  assert.equal((await h.listed()).channels[0].label, '#fresh (acme)');
});

test('an older host acceptance cannot overwrite a registration from a re-grant', async (t) => {
  let calls = 0;
  const { slack } = fakeSlack(async () => [conversation('C1', ++calls === 1 ? 'stale' : 'fresh')]);
  const h = connect(new SlackMcplServer(slack), () => {});
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'old registration');
  await h.grant(['tools']);
  await h.grant();
  await until(() => h.requests.length === 2, 'new registration');
  const accepted = { results: [{ id: 'slack:C1', accepted: true }] };
  h.host.sendResponse(h.requests[1].id, accepted);
  await settle();
  h.host.sendResponse(h.requests[0].id, accepted);
  await settle();
  assert.equal((await h.listed()).channels[0].label, '#fresh (acme)');
});

test('revocation while awaiting host acceptance prevents caching that batch', async (t) => {
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), () => {});
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await h.grant(['tools']);
  h.host.sendResponse(h.requests[0].id, { results: [{ id: 'slack:C1', accepted: true }] });
  await settle();
  await h.grant();
  await until(() => h.requests.length === 2, 'new pending registration');
  assert.deepEqual((await h.listed()).channels, []);
});

test('a reused server refuses rollback until slack.messaging is active for the new peer', async (t) => {
  const { slack, deleted } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const first = connect(server);
  await first.initialize();
  await first.grant();
  const sent = await first.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'first' },
  }) as { state: { checkpoint: string } };
  await first.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'second' },
  });
  await first.close();
  const next = connect(server);
  t.after(() => next.close());
  await next.initialize();
  type Rollback = { checkpoint: string; success: boolean; reason?: string };
  const rollBack = async (featureSet = 'slack.messaging') =>
    (await next.host.sendRequest(method.STATE_ROLLBACK, { featureSet, checkpoint: sent.state.checkpoint })) as Rollback;
  const refused = {
    checkpoint: sent.state.checkpoint,
    success: false,
    reason: "Feature set 'slack.messaging' is not active on this connection",
  };
  // Before the initial policy, the handler refuses in its own result.
  assert.deepEqual(await rollBack(), refused);
  // A feature set without rollback still hears so.
  assert.equal((await rollBack('slack.history')).reason, "Feature set 'slack.history' does not support rollback");
  // An initial policy that grants nothing leaves slack.messaging inactive.
  await next.grant([]);
  assert.deepEqual(await rollBack(), refused);
  assert.deepEqual(deleted, []);
  // Granted slack.messaging, the same checkpoint rolls back: the refusals left it in place.
  await next.grant();
  assert.equal((await rollBack()).success, true);
  assert.deepEqual(deleted, ['2']);
});

/** The wait the adapter asks for after Slack rate-limits a request, or after one fails. */
const limited = (seconds: number): SlackWait => ({ method: 'conversations.list', seconds, why: 'limited' });
const failed = (seconds: number): SlackWait => ({ method: 'conversations.list', seconds, why: 'failed' });
type ToolResult = { isError?: boolean; content: { text: string }[] };

test('registration waits out a rate-limited page for as long as Slack asks, then registers', async (t) => {
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    lists++;
    await waitOut!(limited(1), 1);
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.grant();
  await settled(() => lists === 1, 'the listing');
  t.mock.timers.tick(999);
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(h.requests.length, 0, 'still waiting just short of the second Slack asked for');
  t.mock.timers.tick(1);
  await settled(() => h.requests.length === 1, 'registration after the wait');
  t.mock.timers.reset();
  assert.deepEqual(ids(await h.listed()), ['slack:C1']);
});

test('registration gives up on a request tried ten times in a row, after nine waits, and says so', async (t) => {
  const log = serverLog(t);
  let waited = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    for (let inARow = 1; ; inARow++) {
      await waitOut!(limited(0), inARow);
      waited = inARow;
    }
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => log.some((l) => l.includes('Failed to enumerate conversations')), 'the give-up');
  assert.equal(waited, 9);
  assert.deepEqual(log.filter((l) => l.includes('conversations.list') || l.includes('Failed to enumerate conversations')), [
    ...Array.from({ length: 9 }, (_, i) =>
      `[slack-mcpl] Slack rate-limited conversations.list (try ${i + 1} of 10); registration asks again in 0 s`),
    '[slack-mcpl] Failed to enumerate conversations: Slack rate-limited or failed the same request 10 times in a ' +
      'row, so registration stopped; refresh_channels can announce the conversations later',
  ], 'each wait is logged, and the give-up ends the series');
  assert.equal(h.requests.length, 0);
});

test('refresh_channels answers at once while registration runs, whether it lists or waits', { timeout: 5000 }, async (t) => {
  const listing = deferred<void>();
  const resumed = deferred<void>();
  let waiting = false;
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    // Registration's listing: pages before a rate limit, its wait, and pages
    // after it. The refresh's own listing, later, doesn't wait.
    if (lists++ === 0) {
      await listing.promise;
      waiting = true;
      await waitOut!(limited(1), 1);
      waiting = false;
      await resumed.promise;
    }
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  const answer = async () => {
    const result = (await h.refresh()) as ToolResult;
    assert.equal(result.isError, true);
    return result.content[0].text;
  };
  assert.equal(await answer(), stillRegistering(), 'while it lists, before any wait');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  listing.resolve();
  await settled(() => waiting, 'the wait');
  assert.equal(await answer(), stillRegistering(), 'while it waits');
  t.mock.timers.tick(1000);
  await settled(() => !waiting, 'the end of the wait');
  t.mock.timers.reset();
  assert.equal(await answer(), stillRegistering(), 'listing again after its wait');
  assert.equal(h.requests.length, 0, 'answered before registration finished');
  resumed.resolve();
  await until(() => h.requests.length === 1, 'registration');
  await h.ended();
  const again = (await h.refresh()) as ToolResult;
  assert.notEqual(again.isError, true, 'once registration has ended, a refresh lists again');
});

test('a registration superseded during its wait logs that wait, then stops without another line', async (t) => {
  const log = serverLog(t);
  const slept: number[] = [];
  let endWait = () => {};
  t.mock.method(clock, 'sleep', (ms: number) => {
    slept.push(ms);
    return new Promise<void>((resolve) => { endWait = resolve; });
  });
  let waited: 'went on' | 'stopped' | undefined;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    try {
      await waitOut!(limited(1), 1);
    } catch (err) {
      waited = 'stopped';
      throw err;
    }
    waited = 'went on';
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => slept.length === 1, "registration's wait");
  // Revoking channels.register during the wait supersedes the registration.
  await h.grant(['tools']);
  endWait();
  await until(() => waited !== undefined, 'the end of the wait', 3000);
  assert.deepEqual(slept, [1000], "the wait went through the server's clock");
  assert.equal(waited, 'stopped');
  await settle();
  // Every line but the connection's own.
  assert.deepEqual(log.filter((l) => !l.startsWith('[slack-mcpl] Client ')), [
    '[slack-mcpl] Slack rate-limited conversations.list (try 1 of 10); registration asks again in 1 s',
  ], 'its wait, logged while it was current, and nothing once it stops');
  assert.equal(h.requests.length, 0);
});

test('a registration superseded before the tenth try of a request stops, rather than give up on that request', async (t) => {
  // A DM's listing goes on past a give-up on its user's name, so a superseded
  // registration that gave up would go on listing.
  const revoked = deferred<void>();
  const tenth = deferred<'waited' | 'gave up' | 'stopped'>();
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    await revoked.promise;
    try {
      await waitOut!(limited(0), 10);
      tenth.resolve('waited');
    } catch (err) {
      tenth.resolve(err instanceof GaveUp ? 'gave up' : 'stopped');
      throw err;
    }
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await h.grant(['tools']);
  revoked.resolve();
  assert.equal(await tenth.promise, 'stopped');
  assert.equal(h.requests.length, 0);
});

test("a refresh after a re-grant isn't held by the wait of the registration it superseded", { timeout: 5000 }, async (t) => {
  const newer = deferred<void>();
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    // The first registration's listing waits out a rate limit; the newer one
    // is still listing when a refresh comes; the refresh's own doesn't wait.
    lists++;
    if (lists === 1) await waitOut!(limited(2), 1);
    if (lists === 2) await newer.promise;
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => lists === 1, 'the first listing');
  // Revoking channels.register and granting it again starts a newer registration.
  await h.grant(['tools']);
  await h.grant();
  await until(() => lists === 2, 'the newer listing');
  const meanwhile = (await h.refresh()) as ToolResult;
  assert.equal(meanwhile.content[0].text, stillRegistering(), 'it answers for the newer registration, still listing');
  newer.resolve();
  await until(() => h.requests.length === 1, 'the newer registration');
  await h.ended();
  const answer = (await h.refresh()) as ToolResult;
  assert.notEqual(answer.isError, true, answer.content[0].text);
});

test('a registration superseded while listing stops at its next rate limit, rather than wait or log it', async (t) => {
  const log = serverLog(t);
  const gate = deferred<void>();
  let olderEnded = false;
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    // The first registration is still listing when a re-grant supersedes it,
    // and Slack then rate-limits its next page. The newer one waits out a
    // rate limit of its own.
    const older = lists++ === 0;
    if (older) await gate.promise;
    try {
      await waitOut!(limited(3), 1);
    } finally {
      if (older) olderEnded = true;
    }
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => lists === 1, 'the first listing');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.grant(['tools']);
  await h.grant();
  await settled(() => lists === 2, 'the newer listing');
  gate.resolve();
  // Time is held, so it ends only by not waiting.
  await settled(() => olderEnded, 'the superseded registration to stop');
  assert.deepEqual(log.filter((l) => l.includes('registration asks again')), [
    '[slack-mcpl] Slack rate-limited conversations.list (try 1 of 10); registration asks again in 3 s',
  ], "only the newer registration's wait is logged");
  // The newer registration is still running.
  const answer = (await h.refresh()) as ToolResult;
  assert.equal(answer.isError, true);
  assert.equal(answer.content[0].text, stillRegistering());
});

test('a request that failed is asked again after its wait, which is logged', async (t) => {
  const log = serverLog(t);
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    if (lists++ === 0) await waitOut!(failed(1), 1);
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.grant();
  await settled(() => lists === 1, 'the listing');
  assert.deepEqual(log.filter((l) => l.includes('registration asks again')), [
    '[slack-mcpl] conversations.list failed (try 1 of 10); registration asks again in 1 s',
  ]);
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(h.requests.length, 0, 'nothing registered before the wait ends');
  t.mock.timers.tick(1000);
  await settled(() => h.requests.length === 1, 'registration after its wait');
});

test("a wait for a DM's name is logged with the method it waits on", async (t) => {
  const log = serverLog(t);
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    if (lists++ === 0) await waitOut!({ method: 'users.info', seconds: 30, why: 'failed' }, 3);
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.grant();
  await settled(() => lists === 1, 'the listing');
  assert.deepEqual(log.filter((l) => l.includes('registration asks again')), [
    '[slack-mcpl] users.info failed (try 3 of 10); registration asks again in 30 s',
  ]);
  t.mock.timers.tick(30_000);
  await settled(() => h.requests.length === 1, 'registration after its wait');
});

// The registration below waits 30 s, past each test's 5 s timeout, so a
// refresh held by that wait fails the test.
test("after a revoke, a refresh is refused at once for the missing grant, not held by the registration the revoke ended", { timeout: 5000 }, async (t) => {
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    if (lists++ === 0) await waitOut!(limited(30), 1);
    return [conversation()];
  });
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => lists === 1, 'the listing');
  // Revoking channels.register with no grant after it starts no newer registration.
  await h.grant(['tools']);
  const answer = (await h.refresh()) as ToolResult;
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /hasn't granted this server channels\.register/, 'it answers at once that it can\'t register');
  assert.equal(h.requests.length, 0, 'nothing was registered');
});

test("on a connection the host hasn't granted yet, or a plain MCP one, a refresh isn't held by an earlier connection's registration", { timeout: 5000 }, async (t) => {
  let lists = 0;
  const { slack } = fakeSlack(async (_all?: boolean, waitOut?: SlackWaitOut) => {
    if (lists++ === 0) await waitOut!(limited(30), 1);
    return [conversation()];
  });
  const server = new SlackMcplServer(slack);
  const first = connect(server);
  await first.initialize();
  await first.grant();
  await until(() => lists === 1, 'the listing');
  await first.close();

  // Granted tools, so it can call refresh_channels, but not channels.register.
  const ungranted = connect(server);
  await ungranted.initialize();
  await ungranted.grant(['tools']);
  const ungrantedAnswer = (await ungranted.refresh()) as ToolResult;
  assert.equal(ungrantedAnswer.isError, true);
  assert.match(ungrantedAnswer.content[0].text, /hasn't granted this server channels\.register/);
  assert.equal(ungranted.requests.length, 0);
  await ungranted.close();

  const plain = connect(server);
  t.after(() => plain.close());
  await plain.host.sendRequest(method.INITIALIZE, { capabilities: {} });
  plain.host.sendNotification('notifications/initialized');
  const plainAnswer = (await plain.refresh()) as ToolResult;
  assert.equal(plainAnswer.isError, true);
  assert.match(plainAnswer.content[0].text, /this connection is plain MCP/);
  assert.equal(plain.requests.length, 0);
});

test("refresh_channels leaves out a new DM whose user's name Slack didn't give, says when to call again, and keeps a known DM's label", { timeout: 5000 }, async (t) => {
  const dm = (id: string, user: string, nameWait?: SlackWait): SlackConversationInfo =>
    ({ id, name: user, kind: 'dm', userId: user, isMember: true, ...(nameWait ? { nameWait } : {}) });
  const listings = [
    [conversation()], // registration's
    [conversation(), dm('D1', 'ann'), dm('D2', 'U2', limited(7))],
    [conversation(), dm('D1', 'U1', failed(30)), dm('D2', 'bob')],
  ];
  const { slack } = fakeSlack(async () => listings.shift()!);
  const h = connect(new SlackMcplServer(slack));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await h.ended();
  const refresh = async () => JSON.parse(((await h.refresh()) as ToolResult).content[0].text) as {
    visible: number; added: Array<{ id: string; label: string }>; note: string;
  };
  const first = await refresh();
  assert.equal(first.visible, 3);
  assert.deepEqual(first.added, [{ id: 'slack:D1', label: 'DM: @ann (acme)' }]);
  assert.equal(
    first.note,
    "Registered 1 newly-visible conversation(s). Left out 1 DM(s) whose user's name this server couldn't get from Slack just now, " +
      'since the host keeps the label a conversation is first announced with: slack:D2 (user U2). Call ' +
      'refresh_channels again in about 7 seconds to announce them by name. This server still sends their messages ' +
      'to the host meanwhile.',
  );
  // The name came; and a DM the host knows keeps its label while its user's name is missing.
  const second = await refresh();
  assert.deepEqual(second.added, [{ id: 'slack:D2', label: 'DM: @bob (acme)' }]);
  assert.equal(second.note, 'Registered 1 newly-visible conversation(s).');
  const labels = (await h.listed()).channels.map((d) => [d.id, d.label]);
  assert.deepEqual(labels, [['slack:C1', '#general (acme)'], ['slack:D1', 'DM: @ann (acme)'], ['slack:D2', 'DM: @bob (acme)']]);
});
