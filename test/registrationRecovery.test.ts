import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  McplConnection, method, type JsonRpcRequest, type JsonRpcNotification,
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

const registrationTimedOut = (line: string) =>
  line.startsWith('[slack-mcpl] Failed to register channels:') && line.includes('Request timed out');

const ids = (listed: ChannelsListResult) => listed.channels.map((d) => d.id);

test('a rejected registration is recoverable by refresh under the same grant', async (t) => {
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), (req, host) => host.sendError(req.id, -32002, 'denied'));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'rejected registration');
  await settle();
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

test('a registration timeout leaves descriptors available to refresh', async (t) => {
  const log = serverLog(t);
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), () => {});
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
