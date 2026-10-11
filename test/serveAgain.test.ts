/**
 * One server serving one connection after another, as the TCP transport has
 * it do: each Slack message reaches the client being served once, whatever
 * clients came before, and a client that leaves before initialize ends only
 * its own connection.
 *
 * Run: node --import tsx --test test/serveAgain.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection, method } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import { FULL_GRANT, MENTION_EVENT, connectHost, fakeSlack, initialize, until } from './harness.js';

test('each Slack message reaches the client being served once, however many were served before', async () => {
  const { slack, socket } = fakeSlack();
  const server = new SlackMcplServer(slack);
  for (let n = 1; n <= 3; n++) {
    const h = connectHost(server);
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), `client ${n}'s channels/register`);
    await socket.emitMessage({ ...MENTION_EVENT, ts: `11${n}.1` });
    await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), `client ${n}'s push`);
    // Time for a second copy to arrive, were there one.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.hostSaw.filter((r) => r.method === method.PUSH_EVENT).length, 1, `client ${n} gets the message once`);
    await h.close();
  }
});

test('a client that leaves before initialize ends only its own connection', async () => {
  const { slack } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const served = server.serve(McplConnection.fromStreams(toServer, toHost));
  toServer.end(); // gone before it sent anything
  await served; // resolves: the caller (the TCP transport) goes on to the next client

  // And the next client is served as usual.
  const h = connectHost(server);
  const result = await initialize(h, true);
  assert.ok(result.capabilities);
  await h.close();
});

test("a line that isn't JSON costs only itself", async () => {
  const { slack } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const host = McplConnection.fromStreams(toHost, toServer);
  const served = server.serve(McplConnection.fromStreams(toServer, toHost));
  toServer.write('this is not JSON\n');
  // Were the connection's 'error' unheard, the write above would have thrown
  // out of the stream's callback and ended the process; it is still served.
  const result = (await host.sendRequest(method.INITIALIZE, {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-host', version: '0' },
  })) as { capabilities: Record<string, unknown> };
  assert.ok(result.capabilities);
  toServer.end();
  await served;
  host.close();
});
