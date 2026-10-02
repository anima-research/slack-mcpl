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

test('a rejected registration is recoverable by refresh under the same grant', async (t) => {
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), (req, host) => host.sendError(req.id, -32002, 'denied'));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'rejected registration');
  await settle();
  await h.grant();
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
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), () => {});
  h.serverConn.requestTimeout = 20;
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await h.listed()).channels, []);
  await h.refresh();
  assert.equal(h.notifications.filter((n) => n.method === method.CHANNELS_CHANGED).length, 1);
});

test('a response without itemized acceptance leaves the inventory unknown', async (t) => {
  const { slack } = fakeSlack();
  const h = connect(new SlackMcplServer(slack), (req, host) => host.sendResponse(req.id, {}));
  t.after(() => h.close());
  await h.initialize();
  await h.grant();
  await until(() => h.requests.length === 1, 'registration');
  await settle();
  assert.deepEqual((await h.listed()).channels, []);
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

test('a reused server refuses rollback until the new peer establishes its initial policy', async (t) => {
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
  const rollback = { featureSet: 'slack.messaging', checkpoint: sent.state.checkpoint };
  await assert.rejects(next.host.sendRequest(method.STATE_ROLLBACK, rollback), /initial policy/i);
  assert.deepEqual(deleted, []);
  // Rollback has no capability path: even an empty initial grant establishes readiness.
  await next.grant([]);
  const result = await next.host.sendRequest(method.STATE_ROLLBACK, rollback) as { success: boolean };
  assert.equal(result.success, true);
  assert.deepEqual(deleted, ['2']);
});
