/**
 * The TCP transport's accept loop (`serveTcp`): an 'error' the server emits
 * while a client is being served is logged, and the next client is served.
 *
 * Run: node --import tsx --test test/tcp.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { serveTcp } from '../src/tcp.js';
import { until } from './harness.js';

test("the server's error while a client is served is logged, and the next client is served", async () => {
  const tcpServer = net.createServer();
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
  const { port } = tcpServer.address() as net.AddressInfo;
  const accepted: net.Socket[] = [];
  tcpServer.on('connection', (socket) => accepted.push(socket));

  const logged: unknown[][] = [];
  const finishServing: Array<() => void> = [];
  void serveTcp(
    tcpServer,
    () => new Promise<void>((resolve) => finishServing.push(resolve)),
    (...args) => logged.push(args),
  );
  const clients: net.Socket[] = [];
  try {
    clients.push(net.connect(port, '127.0.0.1'));
    await until(() => finishServing.length === 1, 'the first client to be served');

    // What an accept that fails for a second client emits meanwhile. Were
    // nothing listening, emit would throw: in the server, the process ends.
    const err = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE', syscall: 'accept' });
    tcpServer.emit('error', err);
    assert.ok(logged.some((args) => args.includes(err)), 'the error is logged');

    finishServing[0]!();
    // A client that connects while one is served isn't accepted, so the next
    // one waits until the loop does.
    await until(
      () => logged.some((args) => args[0] === '[slack-mcpl] Client disconnected, waiting for next...'),
      'the loop to wait for the next client',
    );
    clients.push(net.connect(port, '127.0.0.1'));
    await until(() => finishServing.length === 2, 'the next client to be served');
  } finally {
    for (const finish of finishServing) finish();
    for (const socket of [...clients, ...accepted]) socket.destroy();
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
  }
});
