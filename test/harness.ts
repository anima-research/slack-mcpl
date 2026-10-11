/**
 * Shared test harness: the real `SlackMcplServer` over an in-memory stream pair
 * with a fake Slack, driven the way an MCPL host would drive it.
 */

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

/** Replace parts of the fake Slack client (a test's own platform stub). */
export interface WebOverrides {
  postMessage?: SlackWebLike['chat']['postMessage'];
  replies?: SlackWebLike['conversations']['replies'];
}

function fakeWeb(posts: unknown[], reactions: string[], overrides: WebOverrides = {}): SlackWebLike {
  const web: SlackWebLike = {
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
        return { ts: '100.1' };
      },
      async update() {
        return {};
      },
      async delete() {
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
    users: {
      async info({ user }) {
        return { user: { profile: { display_name: user }, real_name: user, name: user } };
      },
      async list() {
        return { members: [] };
      },
    },
  };
  if (overrides.replies) web.conversations.replies = overrides.replies;
  if (overrides.postMessage) {
    const post = overrides.postMessage;
    web.chat.postMessage = async (args) => {
      posts.push(args);
      return post(args);
    };
  }
  return web;
}

export interface HarnessOptions {
  sendChannels?: string[];
  disableDms?: boolean;
  ackReaction?: string;
  subscribeMemberChannels?: boolean;
  /** What the host answers to push/event (default true). */
  pushAccepted?: boolean;
  /** Platform-stub replacements for parts of the fake Slack client. */
  web?: WebOverrides;
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
  served: Promise<void>;
  close(): Promise<void>;
}

export function harness(opts: HarnessOptions = {}): Harness {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const serverConn = McplConnection.fromStreams(toServer, toHost);
  const host = McplConnection.fromStreams(toHost, toServer);

  const socket = fakeSocket();
  const posts: unknown[] = [];
  const reactions: string[] = [];
  const slack = new SlackAdapter(
    fakeWeb(posts, reactions, opts.web), socket, 'UBOT', 'acme',
    undefined, opts.sendChannels, opts.disableDms, opts.ackReaction,
  );
  const server = new SlackMcplServer(slack, { subscribeMemberChannels: opts.subscribeMemberChannels });

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

  const served = server.serve(serverConn);
  return {
    server,
    socket,
    host,
    hostSaw,
    posts,
    reactions,
    served,
    async close() {
      toServer.end();
      await served;
      host.close();
    },
  };
}

export async function initialize(h: Harness, mcpl: boolean) {
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

