/**
 * Shared test harness: the real `SlackMcplServer` over an in-memory stream pair
 * with a fake Slack, driven the way an MCPL host would drive it.
 */

import http from 'node:http';
import { PassThrough } from 'node:stream';
import { McplConnection, method, type JsonRpcRequest } from '@animalabs/mcpl-core';
import { SlackAdapter, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';

/** The full capability set slack-mcpl's manifest declares (§6.2 paths). */
export const FULL_GRANT = [
  'tools',
  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'pushEvents',
];

interface FakeSocket extends SlackSocketLike {
  /** Simulate an incoming Socket Mode message event and wait for the
   *  adapter's async handler to settle. */
  emitMessage(event: Record<string, unknown>): Promise<void>;
}

function fakeSocket(): FakeSocket {
  let handler: ((args: { event: any; ack: () => Promise<void> }) => void) | null = null;
  return {
    on(evt, h) {
      if (evt === 'message') handler = h as any;
    },
    async start() {},
    async disconnect() {},
    async emitMessage(event) {
      if (!handler) throw new Error('no message handler registered');
      handler({ event, ack: async () => {} });
      // handleMessageEvent runs inside a fire-and-forget async IIFE; give it
      // a couple of ticks to resolve before the caller asserts.
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

/** A local endpoint that takes an upload's bytes, as the upload URL Slack
 *  gives does, for the fake Web API's uploads. It's started on first use and
 *  doesn't hold the process open. `bytes` holds what each file's URL was sent,
 *  by file ID. */
let byteEndpoint: Promise<{ url: string; bytes: Map<string, Buffer> }> | undefined;
export function uploadEndpoint(): Promise<{ url: string; bytes: Map<string, Buffer> }> {
  byteEndpoint ??= new Promise((resolve) => {
    const bytes = new Map<string, Buffer>();
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        bytes.set((req.url ?? '').split('/').pop() ?? '', body);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`OK - ${body.length}`);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/upload`, bytes });
    });
  });
  return byteEndpoint;
}

function fakeWeb(posts: unknown[], reactions: string[], uploads: unknown[], deletedMessages: unknown[], deletedFiles: string[]): SlackWebLike {
  let started = 0;
  return {
    conversations: {
      async list() {
        return { channels: [{ id: 'C1', name: 'general', is_member: true, is_im: false, is_mpim: false }] };
      },
      async info({ channel }) {
        return { channel: { id: channel, name: 'general', is_member: true, is_im: false, is_mpim: false } };
      },
      async open() {
        return { channel: { id: 'D1' } };
      },
      async history() {
        return { messages: [] };
      },
      async replies() {
        return { messages: [] };
      },
    },
    chat: {
      async postMessage(args) {
        posts.push(args);
        return { ts: `100.${posts.length}` };
      },
      async update() {
        return {};
      },
      async delete(args) {
        deletedMessages.push(args);
        return {};
      },
    },
    reactions: {
      async add({ channel, timestamp, name }) {
        reactions.push(`add:${channel}:${timestamp}:${name}`);
        return {};
      },
      async remove({ channel, timestamp, name }) {
        reactions.push(`remove:${channel}:${timestamp}:${name}`);
        return {};
      },
    },
    files: {
      async getUploadURLExternal() {
        const { url } = await uploadEndpoint();
        const id = `F${++started}`;
        return { upload_url: `${url}/${id}`, file_id: id };
      },
      // Each upload is shared by a message of its own, 900.<n>. One titled
      // "refused" is refused, as Slack refuses to share where the bot isn't.
      async completeUploadExternal(args) {
        const [{ id, title }] = args.files as Array<{ id: string; title: string }>;
        if (title === 'refused') {
          throw Object.assign(new Error('An API error occurred: not_in_channel'), {
            code: 'slack_webapi_platform_error', data: { ok: false, error: 'not_in_channel' },
          });
        }
        uploads.push(args);
        return { files: [{ id, shares: { public: { [args.channel_id as string]: [{ ts: `900.${uploads.length}` }] } } }] };
      },
      async delete({ file }: { file: string }) {
        deletedFiles.push(file);
        return {};
      },
    },
    users: {
      async info({ user }) {
        return { user: { profile: { display_name: user }, real_name: user, name: user } };
      },
      async list() {
        return { members: [] };
      },
    },
  };
}

export interface HarnessOptions {
  sendChannels?: string[];
  disableDms?: boolean;
  ackReaction?: string;
  subscribeMemberChannels?: boolean;
  /** What the host answers to push/event (default true). */
  pushAccepted?: boolean;
}

export interface Harness {
  server: SlackMcplServer;
  socket: FakeSocket;
  host: McplConnection;
  hostSaw: JsonRpcRequest[];
  /** chat.postMessage calls that reached Slack. */
  posts: unknown[];
  /** reactions.add / reactions.remove calls, as `add:<channel>:<ts>:<name>`. */
  reactions: string[];
  uploads: unknown[];
  deletedMessages: unknown[];
  deletedFiles: string[];
  served: Promise<void>;
  close(): Promise<void>;
}

/** A Slack adapter over a fake Socket Mode client and a fake Web API. */
export function fakeSlack(opts: HarnessOptions = {}) {
  const socket = fakeSocket();
  const posts: unknown[] = [];
  const reactions: string[] = [];
  const uploads: unknown[] = [];
  const deletedMessages: unknown[] = [];
  const deletedFiles: string[] = [];
  const slack = new SlackAdapter(
    fakeWeb(posts, reactions, uploads, deletedMessages, deletedFiles), socket, 'UBOT', 'acme',
    undefined, opts.sendChannels, opts.disableDms, opts.ackReaction,
  );
  return { slack, socket, posts, reactions, uploads, deletedMessages, deletedFiles };
}

/** Answer the server's requests on `host` as an MCPL host would; returns the
 *  requests it saw. */
export function answerAsHost(host: McplConnection, opts: HarnessOptions = {}): JsonRpcRequest[] {
  const hostSaw: JsonRpcRequest[] = [];
  host.on('request', (req) => {
    hostSaw.push(req);
    switch (req.method) {
      case method.CHANNELS_REGISTER: {
        const p = req.params as { channels: { id: string }[] };
        host.sendResponse(req.id, { results: p.channels.map((c) => ({ id: c.id, accepted: true })) });
        break;
      }
      case method.CHANNELS_INCOMING: {
        const p = req.params as { messages: { messageId: string }[] };
        host.sendResponse(req.id, { results: p.messages.map((m) => ({ messageId: m.messageId, accepted: true })) });
        break;
      }
      case method.PUSH_EVENT:
        host.sendResponse(req.id, { accepted: opts.pushAccepted ?? true });
        break;
      default:
        host.sendError(req.id, -32601, `unexpected ${req.method}`);
    }
  });
  return hostSaw;
}

/** A host connected to `server` over an in-memory stream pair, the server
 *  serving it. */
export function connectHost(server: SlackMcplServer, opts: HarnessOptions = {}) {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const serverConn = McplConnection.fromStreams(toServer, toHost);
  const host = McplConnection.fromStreams(toHost, toServer);
  const hostSaw = answerAsHost(host, opts);
  const served = server.serve(serverConn);
  return {
    host,
    /** The server's end, for a test to hear what reaches it. */
    serverConn,
    hostSaw,
    served,
    async close() {
      toServer.end();
      await served;
      host.close();
    },
  };
}

export function harness(opts: HarnessOptions = {}): Harness {
  const { slack, socket, posts, reactions, uploads, deletedMessages, deletedFiles } = fakeSlack(opts);
  const server = new SlackMcplServer(slack, { subscribeMemberChannels: opts.subscribeMemberChannels });
  const { host, hostSaw, served, close } = connectHost(server, opts);
  return { server, socket, host, hostSaw, posts, reactions, uploads, deletedMessages, deletedFiles, served, close };
}

export async function initialize(h: { host: McplConnection }, mcpl: boolean) {
  const result = (await h.host.sendRequest(method.INITIALIZE, {
    protocolVersion: '2024-11-05',
    capabilities: mcpl ? { experimental: { mcpl: { version: '0.5' } } } : {},
    clientInfo: { name: 'test-host', version: '0' },
  })) as { capabilities: Record<string, unknown> };
  h.host.sendNotification('notifications/initialized');
  return result;
}

/** Poll until `predicate` holds — registration/delivery is real async work. */
export async function until(predicate: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const MENTION_EVENT = {
  type: 'message',
  channel: 'C1',
  user: 'U2',
  text: '<@UBOT> hello',
  ts: '111.1',
};

