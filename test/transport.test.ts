import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { McplConnection, method } from '@animalabs/mcpl-core';
import { FULL_GRANT, answerAsHost, fakeSlack, initialize, until, type HarnessOptions } from './harness.js';
import { SlackMcplServer } from '../src/server.js';
import { serveTcp } from '../src/tcp.js';

/** The server over a stream pair, granted everything, with what it writes to the host kept as text. */
async function served(t: TestContext, opts: HarnessOptions = {}) {
  const { slack, socket, posts } = fakeSlack(opts);
  const server = new SlackMcplServer(slack, {});
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const decoder = new StringDecoder('utf8');
  let written = '';
  toHost.on('data', (chunk: Buffer) => { written += decoder.write(chunk); });
  const host = McplConnection.fromStreams(toHost, toServer);
  const hostSaw = answerAsHost(host, opts);
  const serving = server.serve(McplConnection.fromStreams(toServer, toHost));
  t.after(async () => {
    toServer.end();
    await serving;
    host.close();
  });
  await initialize({ host }, true);
  await host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
  return { socket, posts, toServer, hostSaw, written: () => written };
}

test('a call a host writes with a raw U+2028 or U+2029 in a string reaches the server whole and is answered', async (t) => {
  const h = await served(t);
  const content = 'a\u2028b\u2029c';
  const line = JSON.stringify({ jsonrpc: '2.0', id: 'raw-1', method: 'tools/call', params: { name: 'send_message', arguments: { channelId: 'C1', content } } });
  assert.match(line, /\u2028.*\u2029/, 'the line holds both characters raw');
  h.toServer.write(`${line}\n`);
  const answer = () => h.written().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 'raw-1');
  await until(() => answer() !== undefined, 'the answer to the raw call');
  assert.ok(answer().result !== undefined && answer().result.isError !== true, JSON.stringify(answer()));
  assert.deepEqual(h.posts.map((p) => (p as { text: string }).text), [content]);
});

test('no line the server writes holds a raw U+2028 or U+2029, and a name holding both arrives as it was', async (t) => {
  const name = 'eve\u2028bob\u2029';
  const h = await served(t, { displayNames: { U2: name } });
  await h.socket.emitMessage({ type: 'message', channel: 'C1', user: 'U2', text: '<@UBOT> hi', ts: '300.1' });
  await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push/event');
  const push = h.hostSaw.find((r) => r.method === method.PUSH_EVENT)!;
  assert.equal((push.params as { origin: { authorName: string } }).origin.authorName, name);
  assert.doesNotMatch(h.written(), /[\u2028\u2029]/);
});

test('a served TCP client whose socket fails ends only its own serving, and the next client is served', async (t) => {
  const server = new SlackMcplServer(fakeSlack().slack, {});
  const tcpServer = net.createServer();
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
  const port = (tcpServer.address() as net.AddressInfo).port;
  const accepted: net.Socket[] = [];
  tcpServer.on('connection', (socket) => accepted.push(socket));
  let servingsEnded = 0;
  serveTcp(tcpServer, (conn) => server.serve(conn).finally(() => { servingsEnded++; }), () => {});
  const clients: McplConnection[] = [];
  t.after(async () => {
    for (const conn of clients) conn.close();
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
  });
  const connect = async (): Promise<McplConnection> => {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    socket.on('error', () => {});
    const conn = McplConnection.fromTcp(socket);
    conn.on('error', () => {});
    clients.push(conn);
    return conn;
  };

  await connect();
  await until(() => accepted.length === 1, 'the first client accepted');
  accepted[0]!.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  await until(() => servingsEnded === 1, "the first client's serving to end");

  const next = await connect();
  const answer = (await next.sendRequest(method.INITIALIZE, {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-host', version: '0' },
  })) as { serverInfo: { name: string } };
  assert.equal(answer.serverInfo.name, 'slack-mcpl');
});

test("a connection whose input fails, as stdio's stdin can, ends its serving, and nothing goes uncaught", async () => {
  const server = new SlackMcplServer(fakeSlack().slack, {});
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  let ended = false;
  void server.serve(McplConnection.fromStreams(input, output)).then(() => { ended = true; });
  input.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-host', version: '0' } },
  })}\n`);
  await until(() => written.includes('"id":1'), 'the answer to initialize');
  input.destroy(Object.assign(new Error('read EIO'), { code: 'EIO' }));
  await until(() => ended, 'serving to end');
});
