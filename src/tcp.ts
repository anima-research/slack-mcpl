/**
 * The TCP transport: serving MCPL clients on a listening server, apart from
 * the CLI so it can be tested.
 */

import type * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';

/**
 * Serve MCPL clients on a listening TCP server, one at a time, for as long as
 * the process runs. It owns the server's 'connection' and 'error' events for
 * the server's life, which a one-at-a-time server needs: mcpl-core's
 * `acceptTcp` takes a single connection, and leaves no listener that logs
 * the server's errors.
 *
 * - A client that connects while none is served is served: `serve` runs with
 *   its connection, and once `serve` settles, whether it resolves, rejects
 *   or throws, the connection is closed and the next client can be served.
 *   A rejection or a throw is logged. A client counts as served until then,
 *   after its socket has closed too.
 * - A client that connects while another is served is refused: its socket
 *   is destroyed at once, and the refusal logged. Its 'error' listener goes
 *   on first, so nothing that socket reports can go unheard.
 * - An 'error' the server emits (an accept that fails, say) is logged
 *   whenever it comes, and serving goes on: Node's server keeps listening.
 *
 * A read error on the served client's own socket (a reset, say) closes its
 * connection, and SlackMcplServer.serve logs it and settles, so the next
 * client can be served.
 *
 * The server must be listening already, or this throws: a failure to listen
 * (a port already taken) belongs to the caller, and with the 'error'
 * listener added here it would only be logged, and the caller would wait for
 * a 'listening' that never comes.
 */
export function serveTcp(
  tcpServer: net.Server,
  serve: (conn: McplConnection) => Promise<void>,
  log: (...args: unknown[]) => void = console.error,
): void {
  if (!tcpServer.listening) {
    throw new Error("serveTcp needs a listening server: call it once the server has emitted 'listening'");
  }
  tcpServer.on('error', (err) => log('[slack-mcpl] TCP server error:', err));
  // Set before anything awaits, so two clients connecting in the same tick
  // can't both be served.
  let serving = false;
  tcpServer.on('connection', (socket) => {
    if (serving) {
      socket.on('error', (err) => log('[slack-mcpl] Refused client socket error:', err));
      socket.destroy();
      log('[slack-mcpl] Refused a client: one client is served at a time');
      return;
    }
    serving = true;
    // fromTcp listens for the socket's errors before this handler returns.
    const conn = McplConnection.fromTcp(socket);
    log('[slack-mcpl] Client connected');
    void Promise.resolve()
      .then(() => serve(conn))
      .catch((err) => log('[slack-mcpl] Serving a client failed:', err))
      .finally(() => {
        conn.close();
        serving = false;
        log('[slack-mcpl] Client disconnected, waiting for next...');
      });
  });
}
