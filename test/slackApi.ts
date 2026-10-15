/**
 * A local endpoint that answers as Slack's Web API does, for tests that drive
 * a real @slack/web-api WebClient, so they read the client's own errors and
 * its own handling of what Slack answers.
 */

import http from 'node:http';

export interface SlackApiAnswer {
  status?: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FakeSlackApi {
  /** The client's `slackApiUrl`. */
  url: string;
  /** The methods called, in order. */
  calls: string[];
  /** The parameters the client sent each of them, in the same order. */
  sent: URLSearchParams[];
  /** What every method but conversations.list answers from now on.
   *  conversations.list always lists no conversations. */
  answer(answer: SlackApiAnswer): void;
  close(): Promise<void>;
}

export async function fakeSlackApi(): Promise<FakeSlackApi> {
  let next: SlackApiAnswer = { body: { ok: true } };
  const calls: string[] = [];
  const sent: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    let received = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { received += chunk; });
    req.on('end', () => {
      const called = (req.url ?? '').split('/').pop() ?? '';
      calls.push(called);
      sent.push(new URLSearchParams(received));
      const { status = 200, headers = {}, body } =
        called === 'conversations.list' ? { body: { ok: true, channels: [] } } : next;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/api/`,
    calls,
    sent,
    answer(answer) {
      next = answer;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A `slackApiUrl` that takes each request and never answers it. */
export async function silentSlackApi(): Promise<{ url: string; requests(): number; close(): Promise<void> }> {
  let requests = 0;
  const server = http.createServer(() => { requests++; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/api/`,
    requests: () => requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A `slackApiUrl` nothing listens at: port 2, outside the range a server
 *  listening on port 0 is given, so no test's server can take it, as one could
 *  take a port that was free a moment ago. Not port 1, which fetch() refuses
 *  as a bad port before connecting. */
export async function unreachableSlackApiUrl(): Promise<string> {
  return 'http://127.0.0.1:2/api/';
}
