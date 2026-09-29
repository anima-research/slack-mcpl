/**
 * SlackMcplServer — the MCPL 0.5 policy handshake (SPEC §5.3, §5.4, §6.7).
 *
 * Drives the real `SlackMcplServer` over an in-memory stream pair through the
 * actual `initialize` handshake and `featureSets/update` exchange, the same
 * way a host would: the fastest way to see the wire behaviour, mirroring
 * zulip-mcp's test/server.test.ts harness.
 *
 * Run: node --import tsx --test test/handshake.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection, method, type JsonRpcRequest } from '@animalabs/mcpl-core';
import { SlackAdapter, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';

/** The full capability set slack-mcpl's manifest declares (§6.2 paths). */
const FULL_GRANT = [
  'tools',
  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'channels.streaming',
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

function fakeWeb(): SlackWebLike {
  return {
    conversations: {
      async list() {
        return { channels: [{ id: 'C1', name: 'general', is_member: true }] };
      },
      async info({ channel }) {
        return { channel: { id: channel, name: 'general', is_member: true } };
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
      async postMessage() {
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
      async add() {
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

interface Harness {
  server: SlackMcplServer;
  socket: FakeSocket;
  host: McplConnection;
  hostSaw: JsonRpcRequest[];
  served: Promise<void>;
  close(): Promise<void>;
}

function harness(): Harness {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const serverConn = McplConnection.fromStreams(toServer, toHost);
  const host = McplConnection.fromStreams(toHost, toServer);

  const socket = fakeSocket();
  const slack = new SlackAdapter(fakeWeb(), socket, 'UBOT', 'acme');
  const server = new SlackMcplServer(slack);

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
        host.sendResponse(req.id, { accepted: true });
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
    served,
    async close() {
      toServer.end();
      await served;
      host.close();
    },
  };
}

async function initialize(h: Harness, mcpl: boolean) {
  const result = (await h.host.sendRequest(method.INITIALIZE, {
    protocolVersion: '2024-11-05',
    capabilities: mcpl ? { experimental: { mcpl: { version: '0.5' } } } : {},
    clientInfo: { name: 'test-host', version: '0' },
  })) as { capabilities: Record<string, unknown> };
  h.host.sendNotification('notifications/initialized');
  return result;
}

/** Poll until `predicate` holds — registration/delivery is real async work. */
async function until(predicate: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const MENTION_EVENT = {
  type: 'message',
  channel: 'C1',
  user: 'U2',
  text: '<@UBOT> hello',
  ts: '111.1',
};

// --- plain MCP ---------------------------------------------------------------

test('a plain-MCP client gets no MCPL manifest, and tool calls are ungated', async () => {
  const h = harness();
  const init = await initialize(h, false);
  assert.deepEqual(Object.keys(init.capabilities).sort(), ['tools']);

  const tools = (await h.host.sendRequest('tools/list')) as { tools: { name: string }[] };
  assert.ok(tools.tools.some((t) => t.name === 'send_message'));

  const called = (await h.host.sendRequest('tools/call', {
    name: 'list_channels',
    arguments: {},
  })) as { isError?: boolean };
  assert.notEqual(called.isError, true);

  // MCPL-only methods are not on offer to a client that never negotiated MCPL.
  await assert.rejects(h.host.sendRequest(method.CHANNELS_LIST), /-32601/);

  // No push events for a client that never negotiated MCPL, even on a mention.
  await h.socket.emitMessage(MENTION_EVENT);
  assert.equal(h.hostSaw.length, 0);

  await h.close();
});

// --- MCPL handshake -----------------------------------------------------------

test('featureSets/update is answered with a full-grant receipt, and registration follows it', async () => {
  const h = harness();
  await initialize(h, true);

  // Fail closed before the policy exchange: tools are gated on the `tools`
  // capability, which isn't granted until the grant is ready (§5.3).
  await assert.rejects(
    h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }),
    (err: Error & { code?: number }) => err.code === -32002,
  );
  assert.equal(h.hostSaw.length, 0, 'no channels/register before policy');

  const receipt = (await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
    effectiveCapabilities: FULL_GRANT,
  })) as { accepted: boolean; mode: string; unavailableFeatures: unknown[] };
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, 'full');
  assert.deepEqual(receipt.unavailableFeatures, []);

  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
  const registered = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!.params as {
    channels: { id: string }[];
  };
  assert.deepEqual(registered.channels.map((c) => c.id), ['slack:C1']);

  const listed = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as {
    isError?: boolean;
  };
  assert.notEqual(listed.isError, true);

  await h.close();
});

test('push events are suppressed before the grant and flow after it (§5.3)', async () => {
  const h = harness();
  await initialize(h, true);

  // Before any featureSets/update, an addressed message must not reach the host.
  await h.socket.emitMessage(MENTION_EVENT);
  assert.equal(h.hostSaw.some((r) => r.method === method.PUSH_EVENT), false);

  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');

  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '222.2' });
  await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push/event');
  const pushed = h.hostSaw.find((r) => r.method === method.PUSH_EVENT)!.params as { tags: string[] };
  assert.ok(pushed.tags.includes('chat:mention'));
  assert.ok(pushed.tags.includes('chat:addressed'));

  await h.close();
});

test('a grant missing a capability degrades the feature set and suppresses its delivery (§6.4, §6.7)', async () => {
  const h = harness();
  await initialize(h, true);

  // channels.incoming is part of slack.messaging's `uses`; omitting it
  // disables the whole feature set (§6.4 derivation: one missing capability
  // disables the feature set that needs it).
  const receipt = (await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
    effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'channels.incoming'),
  })) as { mode: string; unavailableFeatures: { featureSet: string; missingCapabilities: string[] }[] };
  assert.equal(receipt.mode, 'degraded');
  const messaging = receipt.unavailableFeatures.find((f) => f.featureSet === 'slack.messaging');
  assert.ok(messaging, 'slack.messaging reported unavailable');
  assert.ok(messaging!.missingCapabilities.includes('channels.incoming'));

  // A messaging tool is unavailable with its feature set (a soft tool error,
  // not an RPC error — §6.7 distinguishes "never granted" from "disabled").
  const send = (await h.host.sendRequest('tools/call', {
    name: 'send_message',
    arguments: { channelId: 'C1', content: 'hi' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(send.isError, true);
  assert.match(send.content[0].text, /slack\.messaging/);

  // And no delivery reaches the host for an addressed message either.
  await h.socket.emitMessage(MENTION_EVENT);
  assert.equal(h.hostSaw.some((r) => r.method === method.PUSH_EVENT), false);
  assert.equal(h.hostSaw.some((r) => r.method === method.CHANNELS_INCOMING), false);

  await h.close();
});

test('a malformed policy (overlapping effective/denied capabilities) is rejected and fails closed (§5.4)', async () => {
  const h = harness();
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });

  await assert.rejects(
    h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
      effectiveCapabilities: ['tools'],
      deniedCapabilities: ['tools'],
    }),
    (err: Error & { code?: number }) => err.code === -32602,
  );

  // The malformed Request leaves the grant empty, not the previous full one.
  await assert.rejects(
    h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }),
    (err: Error & { code?: number }) => err.code === -32002,
  );

  await h.close();
});

test('a featureSets/update Notification never establishes readiness (§6.7)', async () => {
  const h = harness();
  await initialize(h, true);

  h.host.sendNotification(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  // Give the (synchronous) notification handler a tick, then confirm it did
  // not establish a grant: tools/call still fails closed.
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(
    h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }),
    (err: Error & { code?: number }) => err.code === -32002,
  );

  await h.close();
});
