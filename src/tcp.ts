/**
 * The TCP transport's accept loop, apart from the CLI so it can be tested.
 */

import type * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';

/**
 * Accept MCPL connections on a listening TCP server and serve them one at a
 * time, for as long as the process runs.
 *
 * An 'error' the server emits while a client is being served (an accept
 * that fails for the next one, say) is logged, and serving goes on. Without
 * this listener, what became of it would depend on mcpl-core: 0.3.0's
 * `acceptTcp` leaves an 'error' listener behind for each connection it
 * accepts, which swallows it unseen, and once mcpl-core-ts#12 stops that
 * leak nothing would hear it, and an 'error' nobody hears ends the process.
 * An 'error' while an accept is pending still rejects `acceptTcp`, which
 * ends the loop, as before.
 *
 * Call it once the server is listening: before that, the listener added
 * here would also catch a failure to listen (a port already taken), and the
 * caller would wait for a 'listening' that never comes.
 */
export async function serveTcp(
  tcpServer: net.Server,
  serve: (conn: McplConnection) => Promise<void>,
  log: (...args: unknown[]) => void = console.error,
): Promise<never> {
  tcpServer.on('error', (err) => log('[slack-mcpl] TCP server error:', err));
  while (true) {
    const conn = await McplConnection.acceptTcp(tcpServer);
    log('[slack-mcpl] Client connected');
    await serve(conn);
    log('[slack-mcpl] Client disconnected, waiting for next...');
  }
}
