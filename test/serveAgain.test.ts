/**
 * One server serving one connection after another, as the TCP transport has
 * it do: each Slack message reaches the client being served once, whatever
 * clients came before, one that arrives between clients reaches none, and a
 * client that leaves before initialize ends only its own connection. Serving
 * writes nothing to stdout, the protocol channel on stdio.
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

test("a line that isn't JSON costs only itself, and is logged", { timeout: 5000 }, async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { slack } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const host = McplConnection.fromStreams(toHost, toServer);
  const served = server.serve(McplConnection.fromStreams(toServer, toHost));
  const lone = new PassThrough();
  const parsing = McplConnection.fromStreams(lone, new PassThrough());
  const parseError = new Promise<Error>((resolve) => parsing.on('error', resolve));
  lone.write('this is not JSON\n');
  const expected = (await parseError).message;
  parsing.close();
  toServer.write('this is not JSON\n');
  // Were the connection's 'error' unheard, the write above would have thrown
  // out of the stream's callback and ended the process; it is still served.
  const result = (await host.sendRequest(method.INITIALIZE, {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-host', version: '0' },
  })) as { capabilities: Record<string, unknown> };
  assert.ok(result.capabilities);
  assert.ok(errors.mock.calls.some((call) => call.arguments[0] === '[slack-mcpl] Connection error:'
    && call.arguments[1] instanceof Error && call.arguments[1].message === expected));
  toServer.end();
  await served;
  host.close();
});

test('serving a client writes nothing to stdout, which on stdio is the protocol channel', async (t) => {
  const stdout = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const { slack } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const h = connectHost(server);
  await initialize(h, true);
  await h.close();
  assert.deepEqual(stdout.mock.calls.map((call) => call.arguments), []);
});

test('a Slack message that arrives between clients is dropped, not sent on the connection that ended', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { slack, socket } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const first = connectHost(server);
  await initialize(first, true);
  await first.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  // Its start-up work done, so the host isn't left answering on a closed stream.
  await until(() => first.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), "the first client's channels/register");
  await first.close();

  await socket.emitMessage({ ...MENTION_EVENT, ts: '120.1' });
  const failures = errors.mock.calls.filter((call) => /failed:|Error forwarding/.test(String(call.arguments[0])));
  assert.deepEqual(failures.map((call) => call.arguments[0]), []);

  const next = connectHost(server);
  await initialize(next, true);
  await next.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => next.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), "the next client's channels/register");
  assert.equal(next.hostSaw.filter((r) => r.method === method.PUSH_EVENT).length, 0, 'nor does the next client get it');
  await next.close();
});
