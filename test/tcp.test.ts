/**
 * The TCP transport (`serveTcp`): one client served at a time, until its
 * serving ends, a client that connects meanwhile refused, the server's
 * errors logged in every state, and a client whose serving fails, or who
 * leaves, ending only its own connection.
 *
 * Run: node --import tsx --test test/tcp.test.ts
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { serveTcp } from '../src/tcp.js';
import { until } from './harness.js';

/** A listening server on a free loopback port, and a way to connect clients
 *  to it. When the test ends, the clients are closed, and then the server,
 *  whose close waits for its connections to end. */
async function listening(t: TestContext) {
  const tcpServer = net.createServer();
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
  const port = (tcpServer.address() as net.AddressInfo).port;
  const clients: McplConnection[] = [];
  t.after(async () => {
    for (const conn of clients) conn.close();
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
  });
  const client = async (): Promise<{ socket: net.Socket; conn: McplConnection }> => {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    socket.on('error', () => {});
    const conn = McplConnection.fromTcp(socket);
    clients.push(conn);
    return { socket, conn };
  };
  return { tcpServer, port, client };
}

/** A serve function that answers each request with the number of the client
 *  it serves (0 for the first it was given), until that client leaves or the
 *  test stops it. */
function server() {
  const stops: Array<() => void> = [];
  let count = 0;
  const serve = async (conn: McplConnection): Promise<void> => {
    const number = count++;
    const stopped = new Promise<null>((resolve) => stops.push(() => resolve(null)));
    try {
      for (;;) {
        const next = conn.nextMessage();
        // When the stop wins, the closing connection rejects this one.
        next.catch(() => {});
        const msg = await Promise.race([next, stopped]);
        if (!msg) return;
        if (msg.type === 'request') conn.sendResponse(msg.request.id, { client: number });
      }
    } catch (err) {
      if ((err as Error).name !== 'ConnectionClosedError') throw err;
    }
  };
  return { serve, stops, served: () => count };
}

/** The number of the client a request on `conn` reaches. */
async function servedAs(conn: McplConnection): Promise<number> {
  return ((await conn.sendRequest('ping', {}, 2000)) as { client: number }).client;
}

/** Wait for a socket to close, failing after `ms`, so a socket left open
 *  fails the test rather than hanging it. */
const closed = (socket: net.Socket, ms = 2000) => new Promise<void>((resolve, reject) => {
  if (socket.destroyed) return resolve();
  const timer = setTimeout(() => reject(new Error('timed out waiting for the socket to close')), ms);
  socket.once('close', () => {
    clearTimeout(timer);
    resolve();
  });
});

const lines = (logged: unknown[][], first: string) => logged.filter((args) => args[0] === first);

test("needs a listening server, so a failure to listen stays the caller's", () => {
  const unlistened = net.createServer();
  assert.throws(
    () => serveTcp(unlistened, async () => {}, () => {}),
    /serveTcp needs a listening server/,
  );
  assert.throws(() => unlistened.emit('error', new Error('listen EADDRINUSE')), /listen EADDRINUSE/);
});

test('serves one client at a time: one that connects meanwhile is refused at once, and the first is still served', async (t) => {
  const { tcpServer, client } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  serveTcp(tcpServer, s.serve, (...args) => logged.push(args));

  const first = await client();
  assert.equal(await servedAs(first.conn), 0);
  assert.equal(lines(logged, '[slack-mcpl] Client connected').length, 1);

  // Refused, not left open and unread.
  const second = await client();
  await closed(second.socket);
  assert.equal(lines(logged, '[slack-mcpl] Refused a client: one client is served at a time').length, 1);
  assert.equal(await servedAs(first.conn), 0, 'the first client is still served');

  // Once the first is done, the next client is served.
  s.stops[0]!();
  await until(() => lines(logged, '[slack-mcpl] Client disconnected, waiting for next...').length === 1, 'the first client to be let go');
  await closed(first.socket);
  const third = await client();
  assert.equal(await servedAs(third.conn), 1, 'the refused client was never served');
});

test('two clients arriving in the same tick while none is served: one is served, one refused', async (t) => {
  const { tcpServer } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  serveTcp(tcpServer, s.serve, (...args) => logged.push(args));
  // Two connections accepted elsewhere, handed to this server in one tick:
  // nothing awaits between them, so only a flag set at once tells them apart.
  const relay = await listening(t);
  const arrived: net.Socket[] = [];
  relay.tcpServer.on('connection', (socket) => arrived.push(socket));
  const [a, b] = await Promise.all([relay.client(), relay.client()]);
  await until(() => arrived.length === 2, 'both connections');
  tcpServer.emit('connection', arrived[0]);
  tcpServer.emit('connection', arrived[1]);
  await new Promise((resolve) => setImmediate(resolve)); // serving starts a tick later
  assert.equal(s.served(), 1);
  assert.equal(lines(logged, '[slack-mcpl] Refused a client: one client is served at a time').length, 1);
  // The refused one is closed, and the other answers.
  await Promise.race([closed(a.socket), closed(b.socket)]);
  const open = a.socket.destroyed ? b : a;
  assert.equal(await servedAs(open.conn), 0);
});

test("the server's errors are logged whenever they come, and serving goes on", async (t) => {
  const { tcpServer, client } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  serveTcp(tcpServer, s.serve, (...args) => logged.push(args));
  // What an accept that fails emits, here forced. Unheard, emit would throw:
  // in the server, the process would end.
  const failure = (n: number) => Object.assign(new Error(`accept EMFILE ${n}`), { code: 'EMFILE', syscall: 'accept' });
  const errorsLogged = () => lines(logged, '[slack-mcpl] TCP server error:').map((args) => (args[1] as Error).message);

  tcpServer.emit('error', failure(1)); // while no client is served
  const first = await client();
  assert.equal(await servedAs(first.conn), 0);
  tcpServer.emit('error', failure(2)); // twice while one is
  tcpServer.emit('error', failure(3));
  assert.equal(await servedAs(first.conn), 0, 'the client being served is still served');

  s.stops[0]!();
  await until(() => lines(logged, '[slack-mcpl] Client disconnected, waiting for next...').length === 1, 'the first client to be let go');
  tcpServer.emit('error', failure(4)); // between clients
  const next = await client();
  assert.equal(await servedAs(next.conn), 1);

  assert.deepEqual(errorsLogged(), ['accept EMFILE 1', 'accept EMFILE 2', 'accept EMFILE 3', 'accept EMFILE 4']);
  // One listener of each for the server's life, however many clients came.
  assert.equal(tcpServer.listenerCount('error'), 1);
  assert.equal(tcpServer.listenerCount('connection'), 1);
});

test('a client whose serving fails ends only its own connection, and the next client is served', async (t) => {
  const { tcpServer, client } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  let calls = 0;
  serveTcp(tcpServer, (conn) => (calls++ === 0 ? Promise.reject(new Error('serving broke')) : s.serve(conn)), (...args) => logged.push(args));

  const first = await client();
  await closed(first.socket);
  const failed = lines(logged, '[slack-mcpl] Serving a client failed:');
  assert.equal(failed.length, 1);
  assert.equal((failed[0]![1] as Error).message, 'serving broke');

  const next = await client();
  assert.equal(await servedAs(next.conn), 0);
});

test('a serve function that throws at once is logged, and the next client is served', async (t) => {
  const { tcpServer, client } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  let calls = 0;
  serveTcp(tcpServer, (conn) => {
    if (calls++ === 0) throw new Error('threw at once');
    return s.serve(conn);
  }, (...args) => logged.push(args));

  const first = await client();
  await closed(first.socket);
  assert.deepEqual(lines(logged, '[slack-mcpl] Serving a client failed:').map((args) => (args[1] as Error).message), ['threw at once']);

  const next = await client();
  assert.equal(await servedAs(next.conn), 0);
});

test('a served client that leaves on its own is let go, and the next client is served', async (t) => {
  const { tcpServer, client } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  serveTcp(tcpServer, s.serve, (...args) => logged.push(args));

  const first = await client();
  assert.equal(await servedAs(first.conn), 0);
  first.socket.end(); // its FIN
  await until(() => lines(logged, '[slack-mcpl] Client disconnected, waiting for next...').length === 1, 'the first client to be let go');

  const next = await client();
  assert.equal(await servedAs(next.conn), 1);
});

test('a client counts as served until its serving ends, after its socket has closed too', async (t) => {
  const { tcpServer, client } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  serveTcp(tcpServer, async (conn) => {
    if (calls++ > 0) return s.serve(conn);
    // The first client's serving outlives its socket, as a request still
    // being answered would.
    await conn.nextMessage().catch(() => {});
    await finishing;
  }, (...args) => logged.push(args));

  const first = await client();
  first.socket.end();
  await closed(first.socket);
  const meanwhile = await client();
  await closed(meanwhile.socket);
  assert.equal(lines(logged, '[slack-mcpl] Refused a client: one client is served at a time').length, 1);

  finish();
  await until(() => lines(logged, '[slack-mcpl] Client disconnected, waiting for next...').length === 1, 'the first serving to end');
  const next = await client();
  assert.equal(await servedAs(next.conn), 0);
});

test("a refused client's socket is heard, so what it reports can't end the process", async (t) => {
  const { tcpServer, client } = await listening(t);
  const logged: unknown[][] = [];
  const s = server();
  serveTcp(tcpServer, s.serve, (...args) => logged.push(args));
  const sockets: net.Socket[] = [];
  // Runs after serveTcp's own listener: the socket is already handled.
  tcpServer.on('connection', (socket) => sockets.push(socket));

  const first = await client();
  assert.equal(await servedAs(first.conn), 0);
  const refused = await client();
  await closed(refused.socket);
  await until(() => sockets.length === 2, 'the refused socket');
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.doesNotThrow(() => sockets[1]!.emit('error', reset));
  assert.deepEqual(lines(logged, '[slack-mcpl] Refused client socket error:').map((args) => args[1]), [reset]);
  assert.equal(await servedAs(first.conn), 0);
});

test('logs to stderr unless told otherwise', async (t) => {
  const { tcpServer } = await listening(t);
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    serveTcp(tcpServer, async () => {});
    tcpServer.emit('error', new Error('accept EMFILE'));
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged.map((args) => [args[0], (args[1] as Error).message]), [['[slack-mcpl] TCP server error:', 'accept EMFILE']]);
});
