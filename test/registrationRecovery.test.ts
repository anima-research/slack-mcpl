import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  McplConnection, RpcError, method, type JsonRpcRequest, type JsonRpcNotification,
  type ChannelsRegisterParams, type ChannelsListResult,
} from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import type { SlackAdapter, SlackConversationInfo } from '../src/slack-adapter.js';
import { FULL_GRANT, until } from './harness.js';

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
    listConversations: list,
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
    async close() {
      toServer.end();
      await served;
      host.close();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  test(`refresh_channels waits for a pending registration's ${accepted ? 'acceptance' : 'refusal'}, which applies first`, async (t) => {
    let calls = 0;
    const { slack } = fakeSlack(async () => [conversation('C1', ++calls === 1 ? 'stale' : 'fresh')]);
    const h = connect(new SlackMcplServer(slack), () => {});
    t.after(() => h.close());
    await h.initialize();
    await h.grant();
    await until(() => h.requests.length === 1, 'pending registration');

    const refreshed = h.refresh();
    await settle();
    await settle();
    assert.equal(calls, 1, 'refresh lists only once the pending answer is in');
    h.host.sendResponse(h.requests[0].id, { results: [{ id: 'slack:C1', accepted }] });
    await refreshed;
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

test("a pending refusal of a known, open channel applies before the refresh waiting on it, which announces the channel again", async (t) => {
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
  const refreshed = h.refresh();
  await settle();
  await settle();
  h.host.sendResponse(h.requests[1].id, { results: [{ id: 'slack:C1', accepted: false }] });
  await refreshed;
  const announced = h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED)
    .flatMap((n) => (n.params as { added: { id: string }[] }).added.map((d) => d.id));
  assert.deepEqual(announced, ['slack:C1'], 'the refusal forgot C1 before the refresh listed it');
  const closing = await h.host.sendRequest(method.CHANNELS_CLOSE, { channelId: 'slack:C1' }) as { closed: boolean };
  assert.equal(closing.closed, false, 'the refusal closed C1');
});

test("a refresh waiting on an unanswered registration lists once that request times out", async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), () => {});
  const registrationTimedOut = registrationTimeouts(h.serverConn);
  h.serverConn.requestTimeout = 200;
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await h.refresh();
  assert.ok(log.some(registrationTimedOut), 'the refresh waited for the timeout');
  assert.equal(h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED).length, 1, 'then it listed and announced');
});

test("a refresh whose listing fails leaves a pending registration's accepted channels known", async (t) => {
  let calls = 0;
  const { slack } = fakeSlack(async () => {
    if (++calls === 2) throw new Error('the Slack listing failed');
    return [conversation('C1')];
  });
  const h = connect(new SlackMcplServer(slack), () => {});
  t.after(() => h.close());
  serverLog(t);
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'pending registration');

  const refreshed = h.refresh() as Promise<{ isError?: boolean; content: { text: string }[] }>;
  await settle();
  await settle();
  h.host.sendResponse(h.requests[0].id, { results: [{ id: 'slack:C1', accepted: true }] });
  const result = await refreshed;
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

test('a refresh whose host leaves while it waits for a registration lists nothing more', async () => {
  const listing = deferred<SlackConversationInfo[]>();
  let calls = 0;
  const { slack } = fakeSlack(() => { calls++; return listing.promise; });
  const h = connect(new SlackMcplServer(slack));
  await h.initialize();
  await h.grant();
  await until(() => calls === 1, "the registration's listing");
  const refreshed = h.refresh().catch(() => undefined); // its answer can't arrive: the host leaves
  await settle();
  const leaving = h.close();
  await until(() => h.serverConn.isClosed, 'the host leaving');
  listing.resolve([conversation('C1')]);
  await leaving;
  await refreshed;
  assert.equal(calls, 1, 'nothing is listed for a host that has gone');
  assert.equal(h.requests.length, 0, 'nor registered');
});

test('a registration still listing when refresh starts sends its whole batch first', async (t) => {
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

  const refreshed = h.refresh();
  await settle();
  await settle();
  assert.equal(calls, 2, 'refresh waits for the registration in flight');
  listing.resolve([conversation('C1'), conversation('C2')]);
  await refreshed;
  assert.equal(h.requests.length, 2, 'the re-grant registers');
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

test('a refresh whose host leaves during its listing writes nothing for the next host', async (t) => {
  const listing = deferred<SlackConversationInfo[]>();
  let calls = 0;
  const { slack } = fakeSlack(() => ++calls === 2 ? listing.promise : Promise.resolve([conversation('C1')]));
  const server = new SlackMcplServer(slack);
  const first = connect(server);
  await first.initialize();
  await first.grant();
  await until(() => first.requests.length === 1, 'first registration');
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
