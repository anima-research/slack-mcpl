/**
 * A local endpoint that answers as Slack's Web API does, for tests that drive
 * a real @slack/web-api WebClient, so they read the client's own errors and
 * its own handling of what Slack answers.
 */

import http from 'node:http';
import { elapse } from './virtualClock.js';

export interface SlackApiAnswer {
  status?: number;
  headers?: Record<string, string>;
  /** Sent as JSON. null sends the JSON body null, as a broken proxy might.
   *  A function answers from the parameters the request sent. */
  body: Record<string, unknown> | null | ((sent: URLSearchParams) => Record<string, unknown> | null);
  /** How long to take before answering, in ms. */
  delayMs?: number;
  elapseMs?: number;
  /** Answer only once this settles, then after delayMs: for a test that
   *  orders an answer after an event rather than after a length of time. */
  after?: Promise<unknown>;
}

export interface FakeSlackApi {
  /** The client's `slackApiUrl`. */
  url: string;
  /** The methods called, in order. */
  calls: string[];
  /** The parameters the client sent each of them, in the same order. */
  sent: URLSearchParams[];
  /** What every method answerFor hasn't been given answers from now on: each
   *  answer in turn, and the last to every request after it. */
  answer(...answers: [SlackApiAnswer, ...SlackApiAnswer[]]): void;
  /** What `method` alone answers from now on, in the same way. With no
   *  answers, it answers as it did at the start again. conversations.list
   *  starts out listing no conversations. */
  answerFor(method: string, ...answers: SlackApiAnswer[]): void;
  close(): Promise<void>;
}

export async function fakeSlackApi(): Promise<FakeSlackApi> {
  let answers: SlackApiAnswer[] = [{ body: { ok: true } }];
  const atStart: Record<string, SlackApiAnswer[]> = { 'conversations.list': [{ body: { ok: true, channels: [] } }] };
  const answersFor = new Map(Object.entries(atStart));
  const calls: string[] = [];
  const sent: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    let received = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { received += chunk; });
    req.on('end', () => {
      const called = (req.url ?? '').split('/').pop() ?? '';
      calls.push(called);
      const params = new URLSearchParams(received);
      sent.push(params);
      const queue = answersFor.get(called) ?? answers;
      const { status = 200, headers = {}, body, delayMs = 0, elapseMs, after } = queue.length > 1 ? queue.shift()! : queue[0];
      const send = () => setTimeout(() => {
        if (elapseMs !== undefined) elapse(elapseMs);
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(typeof body === 'function' ? body(params) : body));
      }, delayMs);
      if (after) void after.then(send, send);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/api/`,
    calls,
    sent,
    answer(...given) {
      answers = given;
    },
    answerFor(method, ...given) {
      const answers = given.length ? given : atStart[method];
      if (answers) answersFor.set(method, [...answers]);
      else answersFor.delete(method);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A `slackApiUrl` that takes each request and never answers it. */
export async function silentSlackApi(): Promise<{ url: string; requests(): number; connections(): number; end(): void; close(): Promise<void> }> {
  let requests = 0;
  let connections = 0;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((_req, res) => { requests++; held.push(res); });
  server.on('connection', () => { connections++; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/api/`,
    requests: () => requests,
    connections: () => connections,
    end() {
      for (const res of held.splice(0)) res.socket?.destroy();
    },
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
