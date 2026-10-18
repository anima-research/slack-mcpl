import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McplConnection, method, type JsonRpcRequest } from '@animalabs/mcpl-core';
import { ErrorCode } from '@slack/web-api';
import { SlackMcplServer } from '../src/server.js';
import type { SlackAdapter, SlackMessageData, HistoryMessage } from '../src/slack-adapter.js';
import { FULL_GRANT, until } from './harness.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const historyMessage: HistoryMessage = {
  id: '100.0', authorId: 'U2', authorName: 'Ann', content: 'older context', rootTs: '100.0',
  timestamp: new Date(100000), attachments: [],
};

function fixture(
  history = async (_channel: string) => [historyMessage],
  beforeMeta = async () => {},
  canWrite: (channel: string) => boolean = () => true,
) {
  const handlers: Array<(msg: SlackMessageData) => void> = [];
  const posts: Array<{ channel: string; threadTs?: string }> = [];
  const histories: string[] = [];
  const cleared: string[] = [];
  const acknowledged: string[] = [];
  const slack = {
    teamName: 'acme', botUserId: 'UBOT', dmsWritable: true,
    canWrite,
    onMessage(handler: (msg: SlackMessageData) => void) { handlers.push(handler); },
    async listConversations() { return [{ id: 'C1', name: 'general', kind: 'channel', isMember: true }]; },
    async getConversationMeta(id: string) {
      await beforeMeta();
      return { id, name: 'general', kind: 'channel', isMember: true };
    },
    async fetchHistory(channel: string) {
      histories.push(channel);
      return { messages: await history(channel), truncated: false };
    },
    async acknowledge(channel: string, ts: string) { acknowledged.push(`${channel}/${ts}`); },
    async clearAck(channel: string, ts?: string) { cleared.push(`${channel}/${ts}`); },
    async sendMessage(channel: string, _text: string, opts: { threadTs?: string } = {}) {
      posts.push({ channel, ...opts });
      return { messageId: '200.0' };
    },
  } as unknown as SlackAdapter;
  const server = new SlackMcplServer(slack);
  return {
    server, slack, handlers, histories, posts, cleared, acknowledged,
    emit(id: string, channelId = 'C1', overrides: Partial<SlackMessageData> = {}) {
      const msg: SlackMessageData = {
        channelId, id, authorId: 'U2', authorName: 'Ann', content: 'hello', cleanContent: 'hello',
        mentionIds: ['UBOT'], mentionsBot: true, isDM: false, timestamp: new Date(Number(id) * 1000),
        attachments: [], ...overrides,
      };
      for (const handler of handlers) handler(msg);
    },
  };
}

/** `accepts` decides the host's answer to each delivery (default: taken). */
function connect(server: SlackMcplServer, accepts: (delivery: JsonRpcRequest) => boolean | Promise<boolean> = () => true) {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const conn = McplConnection.fromStreams(toServer, toHost);
  conn.requestTimeout = 500;
  const host = McplConnection.fromStreams(toHost, toServer);
  const requests: JsonRpcRequest[] = [];
  host.on('request', async (req) => {
    requests.push(req);
    if (host.isClosed) return; // An old peer cannot answer a stale delivery.
    if (req.method === method.CHANNELS_REGISTER) {
      const params = req.params as { channels: { id: string }[] };
      host.sendResponse(req.id, { results: params.channels.map((c) => ({ id: c.id, accepted: true })) });
    } else {
      assert.ok(req.method === method.CHANNELS_INCOMING || req.method === method.PUSH_EVENT);
      try {
        const accepted = await accepts(req);
        if (host.isClosed) return;
        host.sendResponse(req.id, req.method === method.CHANNELS_INCOMING
          ? { results: [{ accepted }] }
          : { accepted });
      } catch (err) {
        if (!host.isClosed) host.sendError(req.id, -32001, (err as Error).message);
      }
    }
  });
  const served = server.serve(conn);
  return {
    host, requests, served,
    /** The server's side of the stream pair: its writer, which closing the connection destroys. */
    serverSide: toHost,
    deliveries: () => requests.filter((r) => r.method === method.PUSH_EVENT || r.method === method.CHANNELS_INCOMING),
    async ready() {
      await host.sendRequest(method.INITIALIZE, {
        capabilities: { experimental: { mcpl: { version: '0.5' } } },
      });
      host.sendNotification('notifications/initialized');
      await host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
      await until(() => requests.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
    },
    async open() {
      await host.sendRequest(method.CHANNELS_OPEN, { type: 'slack', address: { channelId: 'C1' } });
    },
    async publish() {
      await host.sendRequest(method.CHANNELS_PUBLISH, {
        channelId: 'slack:C1', content: [{ type: 'text', text: 'answer' }],
      });
    },
    async close() {
      toServer.end();
      try { await served; } finally { host.close(); }
    },
  };
}

const settle = () => new Promise<void>((r) => setImmediate(r));
const pushText = (request: JsonRpcRequest) =>
  (request.params as { payload: { content: { text: string }[] } }).payload.content.map((c) => c.text).join('\n');

test('successive peers receive each Slack event once, with one lifetime callback', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    const peer = connect(f.server);
    try {
      await peer.ready();
      await peer.open();
      f.emit(String(111 + i));
      await until(() => peer.deliveries().length > 0, 'incoming event');
      await settle();
      assert.equal(peer.deliveries().length, 1);
      assert.equal(f.handlers.length, 1);
    } finally {
      await peer.close();
    }
  }
});

test('a new peer opens its own channels and receives fresh history and headers', async () => {
  const f = fixture();
  const first = connect(f.server);
  await first.ready();
  await first.open();
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  await until(() => first.deliveries().length > 0, 'first event');
  await first.close();

  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('112.1');
    await until(() => next.deliveries().length > 0, 'new peer event');
    assert.equal(next.deliveries()[0].method, method.PUSH_EVENT, 'channel starts closed');
    assert.equal(f.histories.length, 2, 'new peer receives its own backscroll');
    assert.match(pushText(next.deliveries()[0]), /<backscroll/);
    assert.match(pushText(next.deliveries()[0]), /#general \(acme\)/);
  } finally {
    await next.close();
  }
});

test('ambient subscriptions survive reconnects', async () => {
  const f = fixture();
  const first = connect(f.server);
  await first.ready();
  f.emit('111.1');
  await until(() => first.deliveries().length > 0, 'mention auto-subscription');
  await first.close();
  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('112.1', 'C1', { mentionsBot: false, mentionIds: [] });
    await until(() => next.deliveries().length > 0, 'subscribed ambient event');
    assert.equal(next.deliveries().length, 1);
  } finally {
    await next.close();
  }
});

test('concurrent first mentions fetch and embed backscroll once, in arrival order', async () => {
  const gate = deferred<HistoryMessage[]>();
  const f = fixture(() => gate.promise);
  const peer = connect(f.server);
  try {
    await peer.ready();
    f.emit('111.1');
    f.emit('111.2');
    await until(() => f.histories.length > 0, 'history fetch');
    await settle();
    const fetches = f.histories.length;
    gate.resolve([historyMessage]);
    await until(() => peer.deliveries().length === 2, 'both events');
    assert.equal(fetches, 1);
    const texts = peer.deliveries().map(pushText);
    assert.match(texts[0], /<backscroll/);
    assert.doesNotMatch(texts[1], /<backscroll/);
    assert.match(texts[0], /id=111.1/);
    assert.match(texts[1], /id=111.2/);
  } finally {
    gate.resolve([]);
    await peer.close();
  }
});

test('a slow conversation does not block delivery in another conversation', async () => {
  const gate = deferred<HistoryMessage[]>();
  const f = fixture((channel) => channel === 'C1' ? gate.promise : Promise.resolve([]));
  const peer = connect(f.server);
  try {
    await peer.ready();
    f.emit('111.1', 'C1');
    f.emit('111.2', 'C2');
    await until(() => peer.deliveries().length > 0, 'independent C2 delivery');
    assert.match(pushText(peer.deliveries()[0]), /id=111.2/);
    gate.resolve([]);
    await until(() => peer.deliveries().length === 2, 'C1 delivery');
  } finally {
    gate.resolve([]);
    await peer.close();
  }
});

test('old queued and in-flight messages cannot change a new peer or hold up its queue', async () => {
  const gate = deferred<HistoryMessage[]>();
  let historyCalls = 0;
  const f = fixture(() => ++historyCalls === 1 ? gate.promise : Promise.resolve([historyMessage]));
  const first = connect(f.server);
  await first.ready();
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  f.emit('111.2', 'C1', { threadTs: '110.0' });
  await until(() => f.histories.length > 0, 'old history fetch');
  await first.close();

  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('112.1', 'C1', { threadTs: '112.0' });
    await until(() => next.deliveries().length > 0, 'new peer bypasses old queue');
    gate.resolve([historyMessage]);
    await settle();
    await settle();
    await next.publish();
    assert.deepEqual(f.posts, [{ channel: 'C1', threadTs: '112.0' }]);
    assert.equal(next.deliveries().length, 1);
    assert.match(pushText(next.deliveries()[0]), /<backscroll/);
    assert.equal(first.deliveries().length, 0);
  } finally {
    gate.resolve([]);
    await next.close();
  }
});

test('a DM whose peer leaves during its backscroll fetch changes nothing for the next peer', async (t) => {
  // A DM looks up no name, so the check after its backscroll fetch is the
  // last one before it would be sent.
  const gate = deferred<HistoryMessage[]>();
  let historyCalls = 0;
  const errors = t.mock.method(console, 'error', () => {});
  const f = fixture(() => ++historyCalls === 1 ? gate.promise : Promise.resolve([historyMessage]));
  const dm = { isDM: true, mentionsBot: false, mentionIds: [] };
  const first = connect(f.server);
  await first.ready();
  f.emit('111.1', 'D1', dm);
  await until(() => f.histories.length > 0, "the first DM's backscroll fetch");
  await first.close();

  const next = connect(f.server);
  try {
    await next.ready();
    gate.resolve([historyMessage]);
    await until(() => f.cleared.length > 0, 'the abandoned DM releases its reaction');
    f.emit('112.1', 'D1', dm);
    await until(() => next.deliveries().length > 0, "the new peer's DM");
    assert.match(pushText(next.deliveries()[0]), /\[DM \(acme\) id=112\.1\] /, 'the abandoned DM left the new peer no context');
    assert.ok(errors.mock.calls.map((c) => c.arguments.join(' ')).includes(
      '[slack-mcpl] Dropped addressed message 111.1 in D1 before delivery: its peer disconnected',
    ));
    assert.equal(first.deliveries().length, 0);
  } finally {
    gate.resolve([]);
    await next.close();
  }
});

test('closing during initialization releases the peer and allows another handshake', async () => {
  const f = fixture();
  const first = connect(f.server);
  await first.close();
  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('111.1');
    await until(() => next.deliveries().length === 1, 'delivery after interrupted handshake');
  } finally {
    await next.close();
  }
});

test('a new peer does not publish into the previous peer\x27s last thread', async () => {
  const f = fixture();
  const first = connect(f.server);
  await first.ready();
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  await until(() => first.deliveries().length > 0, 'first event');
  await first.close();
  const next = connect(f.server);
  try {
    await next.ready();
    await next.publish();
    assert.deepEqual(f.posts, [{ channel: 'C1' }]);
  } finally {
    await next.close();
  }
});

test('a message whose peer leaves during its metadata lookup changes nothing for the next peer', async () => {
  const gate = deferred<void>();
  let lookups = 0;
  const f = fixture(undefined, async () => { if (++lookups === 1) await gate.promise; });
  const first = connect(f.server);
  await first.ready();
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  await until(() => lookups === 1, 'the metadata lookup under way');
  await first.close();

  const next = connect(f.server);
  try {
    await next.ready();
    gate.resolve();
    await until(() => f.cleared.length > 0, 'the abandoned mention releases its reaction');
    // The abandoned mention did not subscribe the conversation: an ambient
    // message is dropped, and the mention after it is the one delivery.
    f.emit('112.1', 'C1', { mentionsBot: false, mentionIds: [] });
    f.emit('112.2', 'C1');
    await until(() => next.deliveries().length > 0, 'the mention');
    await settle();
    assert.equal(next.deliveries().length, 1);
    assert.match(pushText(next.deliveries()[0]), /id=112.2/);
    assert.deepEqual(f.cleared, ['C1/111.1']);
    assert.equal(first.deliveries().length, 0);
  } finally {
    gate.resolve();
    await next.close();
  }
});

test('a message whose peer leaves during its location lookup changes nothing for the next peer', async () => {
  // C1's first interaction, then C2's: C1's next message is no first
  // interaction but changes context, so its one lookup is the location's.
  const gate = deferred<void>();
  let lookups = 0;
  const f = fixture(undefined, async () => { if (++lookups === 3) await gate.promise; });
  const first = connect(f.server);
  await first.ready();
  f.emit('110.1', 'C1');
  await until(() => first.deliveries().length === 1, "C1's first interaction");
  f.emit('110.2', 'C2');
  await until(() => first.deliveries().length === 2, "C2's first interaction");
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  await until(() => lookups === 3, 'the location lookup under way');
  await first.close();

  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('112.1', 'C1', { threadTs: '112.0' });
    await until(() => next.deliveries().length > 0, "the new peer's mention");
    gate.resolve();
    await until(() => f.cleared.length > 0, 'the abandoned mention releases its reaction');
    await next.publish();
    assert.deepEqual(f.posts, [{ channel: 'C1', threadTs: '112.0' }]);
    assert.deepEqual(f.cleared, ['C1/111.1']);
    assert.equal(first.deliveries().length, 2, 'the first peer got nothing after its lookup');
  } finally {
    gate.resolve();
    await next.close();
  }
});

test('a mention abandoned at its last lookup subscribes nothing, and says so on stderr', async () => {
  const gate = deferred<void>();
  let lookups = 0;
  const f = fixture(undefined, async () => { if (++lookups === 1) await gate.promise; });
  const errors = mock.method(console, 'error', () => {});
  try {
    const first = connect(f.server);
    await first.ready();
    f.emit('111.1');
    await until(() => lookups === 1, 'the metadata lookup under way');
    await first.close();

    const next = connect(f.server);
    try {
      await next.ready();
      gate.resolve();
      await until(() => f.cleared.length > 0, 'the abandoned mention releases its reaction');
      const dropped = errors.mock.calls.map((c) => c.arguments.join(' ')).filter((l) => l.includes('Dropped addressed message'));
      assert.deepEqual(dropped, ['[slack-mcpl] Dropped addressed message 111.1 in C1 before delivery: its peer disconnected']);
      // Its auto-subscribe note never reached a host, so neither did the
      // subscription: the ambient message is dropped, and the next mention
      // brings the note.
      f.emit('112.1', 'C1', { mentionsBot: false, mentionIds: [] });
      f.emit('112.2');
      await until(() => next.deliveries().length > 0, 'the mention');
      await settle();
      assert.equal(next.deliveries().length, 1);
      assert.match(pushText(next.deliveries()[0]), /id=112.2/);
      assert.match(pushText(next.deliveries()[0]), /Auto-subscribed to #general/);
    } finally {
      gate.resolve();
      await next.close();
    }
  } finally {
    errors.mock.restore();
  }
});

test('a first mention the host refuses commits nothing: the next one is still a first interaction', async () => {
  const f = fixture();
  let refused = 0;
  const peer = connect(f.server, () => ++refused > 1);
  try {
    await peer.ready();
    f.emit('111.1');
    await until(() => f.cleared.length > 0, 'the refused mention releases its reaction');
    assert.match(pushText(peer.deliveries()[0]), /Auto-subscribed to #general/);
    // Not subscribed, so the ambient message is dropped; the next mention
    // brings the backscroll and the note again, and this time it's taken.
    f.emit('111.2', 'C1', { mentionsBot: false, mentionIds: [] });
    f.emit('111.3');
    await until(() => peer.deliveries().length === 2, 'the next mention');
    const text = pushText(peer.deliveries()[1]);
    assert.match(text, /id=111.3/);
    assert.match(text, /<backscroll/);
    assert.match(text, /Auto-subscribed to #general/);
    assert.equal(f.histories.length, 2);
    // Taken: the conversation is subscribed now, and its first interaction done.
    f.emit('111.4', 'C1', { mentionsBot: false, mentionIds: [] });
    await until(() => peer.deliveries().length === 3, 'the subscribed ambient message');
    assert.doesNotMatch(pushText(peer.deliveries()[2]), /<backscroll|Auto-subscribed/);
  } finally {
    await peer.close();
  }
});

test("an agent's unsubscribe holds across reconnects: a new peer's first mention brings backscroll, not a new subscription", async () => {
  const f = fixture();
  const first = connect(f.server);
  await first.ready();
  f.emit('111.1');
  await until(() => first.deliveries().length > 0, 'the auto-subscribing mention');
  assert.match(pushText(first.deliveries()[0]), /Auto-subscribed to #general/);
  await first.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  await first.close();

  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('112.1');
    f.emit('112.2', 'C1', { mentionsBot: false, mentionIds: [] });
    await until(() => next.deliveries().length > 0, 'the new peer\'s mention');
    await settle();
    assert.equal(next.deliveries().length, 1, 'the ambient message is still dropped');
    const text = pushText(next.deliveries()[0]);
    assert.match(text, /<backscroll/, 'the new peer\'s own first interaction');
    assert.doesNotMatch(text, /Auto-subscribed/);
  } finally {
    await next.close();
  }
});

test('a read-only conversation is noted once to each peer, once the host has taken the note', async () => {
  const f = fixture(undefined, undefined, (channel) => channel !== 'C1');
  const readOnly = /You cannot write to conversation C1/;
  let deliveries = 0;
  const first = connect(f.server, () => ++deliveries > 1); // refuses the first delivery
  await first.ready();
  f.emit('111.1');
  f.emit('111.2');
  f.emit('111.3');
  await until(() => first.deliveries().length === 3, 'three deliveries');
  const texts = first.deliveries().map(pushText);
  assert.match(texts[0], readOnly);
  assert.match(texts[1], readOnly, 'the refused note is told again');
  assert.doesNotMatch(texts[2], readOnly, 'and only until it is taken');
  await first.close();

  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('112.1');
    await until(() => next.deliveries().length > 0, 'the new peer\'s delivery');
    assert.match(pushText(next.deliveries()[0]), readOnly, 'a new peer is told again');
  } finally {
    await next.close();
  }
});

test("a message whose handling throws doesn't stop its conversation's later messages", async () => {
  let failOnce = false;
  const f = fixture(undefined, undefined, () => {
    if (!failOnce) return true;
    failOnce = false;
    throw new Error('canWrite failed');
  });
  const errors = mock.method(console, 'error', () => {});
  const peer = connect(f.server);
  try {
    await peer.ready();
    failOnce = true;
    f.emit('111.1');
    f.emit('111.2');
    await until(() => peer.deliveries().length > 0, 'the later message');
    await settle();
    assert.equal(peer.deliveries().length, 1);
    assert.match(pushText(peer.deliveries()[0]), /id=111.2/);
    assert.ok(errors.mock.calls.some((c) => c.arguments.join(' ').includes('Error forwarding Slack message')));
  } finally {
    await peer.close();
    errors.mock.restore();
  }
});

test('a connection whose serving fails while its peer is still there is closed, and the next peer is served', async () => {
  const f = fixture();
  // Forwarding is installed once, with the server, so the failure is made in
  // the handshake, the first thing serve() does for a connection.
  const server = f.server as unknown as { handleInitialize: () => Promise<void> };
  const handleInitialize = server.handleInitialize;
  server.handleInitialize = async () => { throw new Error('handshake failed'); };
  const errors = mock.method(console, 'error', () => {});
  const first = connect(f.server);
  try {
    await first.served;
    // The peer never closed its side; the server closed the connection, so a
    // TCP client isn't left on a socket nobody serves.
    assert.equal(first.serverSide.destroyed, true);
    assert.ok(errors.mock.calls.some((c) => String(c.arguments[1]).includes('handshake failed')));
  } finally {
    first.host.close();
    errors.mock.restore();
  }
  server.handleInitialize = handleInitialize;
  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('111.1');
    await until(() => next.deliveries().length === 1, 'the next peer is served');
  } finally {
    await next.close();
  }
});

const logLines = (errors: ReturnType<typeof mock.method>) =>
  errors.mock.calls.map((c) => c.arguments.join(' '));
const subscriptions = async (peer: ReturnType<typeof connect>) => {
  const result = await peer.host.sendRequest('tools/call', { name: 'list_subscriptions', arguments: {} });
  return JSON.stringify(result);
};

test('arrival drops name addressed messages with no peer or messaging off, but stay quiet for plain MCP', async (t) => {
  const f = fixture();
  const errors = t.mock.method(console, 'error', () => {});
  f.emit('111.1');
  f.emit('111.2', 'C1', { mentionsBot: false });
  assert.deepEqual(logLines(errors).filter((l) => l.includes('Dropped addressed message')), [
    '[slack-mcpl] Dropped addressed message 111.1 in C1 before delivery: no peer is connected',
  ]);

  const plain = connect(f.server);
  await plain.host.sendRequest(method.INITIALIZE, { capabilities: {} });
  plain.host.sendNotification('notifications/initialized');
  f.emit('112.1');
  await settle();
  await plain.close();

  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  await peer.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: ['tools'] });
  f.emit('113.1');
  await settle();
  assert.deepEqual(logLines(errors).filter((l) => l.includes('Dropped addressed message')), [
    '[slack-mcpl] Dropped addressed message 111.1 in C1 before delivery: no peer is connected',
    '[slack-mcpl] Dropped addressed message 113.1 in C1 before delivery: slack.messaging is not active',
  ]);
  assert.deepEqual(f.acknowledged, []);
  assert.equal(peer.deliveries().length, 0);
});

for (const lookup of ['history', 'name', 'location'] as const) {
  test(`a stalled ${lookup} lookup gives up after five seconds, says so, and lets its conversation continue`, async (t) => {
    const gate = deferred<void>();
    let metaCalls = 0;
    const errors = t.mock.method(console, 'error', () => {});
    const f = fixture(
      async () => { if (lookup === 'history') await gate.promise; return [historyMessage]; },
      async () => {
        metaCalls++;
        if (lookup === 'name' && metaCalls === 1 || lookup === 'location' && metaCalls === 3) await gate.promise;
      },
    );
    const peer = connect(f.server);
    try {
      await peer.ready();
      let before = 0;
      if (lookup === 'location') {
        // C1's first interaction, then C2's: C1's next message is no first
        // interaction but changes context, so its one lookup is the location's.
        f.emit('110.1', 'C1');
        await until(() => peer.deliveries().length === 1, "C1's first interaction");
        f.emit('110.2', 'C2');
        await until(() => peer.deliveries().length === 2, "C2's first interaction");
        before = 2;
      }
      t.mock.timers.enable({ apis: ['setTimeout'] });
      f.emit('111.1');
      f.emit('111.2');
      await settle();
      t.mock.timers.tick(4999);
      await settle();
      assert.equal(peer.deliveries().length, before, 'still waiting just short of five seconds');
      t.mock.timers.tick(1);
      for (let i = 0; i < 50 && peer.deliveries().length < before + 2; i++) await settle();
      assert.equal(peer.deliveries().length, before + 2, 'optional data cannot hold the conversation indefinitely');
      const [first, second] = peer.deliveries().slice(before).map(pushText);
      assert.equal(/<backscroll/.test(first), lookup === 'name');
      assert.doesNotMatch(second, /<backscroll/);
      // A conversation whose name didn't come in time is named by its ID, and
      // its next message, in the same context, names nothing and looks up
      // nothing.
      assert.match(first, lookup === 'history' ? /\[#general \(acme\) id=111\.1\] / : /\[C1 \(acme\) id=111\.1\] /);
      assert.match(second, /\[id=111\.2\] /);
      assert.deepEqual(logLines(errors).filter((l) => l.includes('Gave up on')), [
        lookup === 'history'
          ? '[slack-mcpl] Gave up on the backscroll for message 111.1 in C1 after 5 s; delivering without it'
          : '[slack-mcpl] Gave up on the name of conversation C1 after 5 s; delivering without it',
      ]);
      assert.equal(metaCalls, { history: 1, name: 1, location: 3 }[lookup], 'one metadata lookup per change of context');
      gate.resolve();
      await settle();
      assert.equal(peer.deliveries().length, before + 2, 'a late result sends nothing more');
    } finally {
      t.mock.timers.reset();
      await peer.close();
      gate.resolve();
    }
  });
}

test('a lookup Slack fails says so on stderr, and the message goes without it', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const limited = 'A rate-limit has been reached, you may retry this request in 30 seconds';
  const f = fixture(
    async () => { throw new Error(limited); },
    async () => { throw new Error(limited); },
  );
  const peer = connect(f.server);
  try {
    await peer.ready();
    f.emit('111.1');
    await until(() => peer.deliveries().length === 1, 'the message, without its lookups');
    const text = pushText(peer.deliveries()[0]);
    assert.doesNotMatch(text, /<backscroll/);
    assert.match(text, /\[C1 \(acme\) id=111\.1\] /);
    assert.deepEqual(logLines(errors).filter((l) => l.includes("Couldn't get")), [
      `[slack-mcpl] Couldn't get the backscroll for message 111.1 in C1 (${limited}); delivering without it`,
      `[slack-mcpl] Couldn't get the name of conversation C1 (${limited}); delivering without it`,
    ]);
  } finally {
    await peer.close();
  }
});

test('a lookup that fails after its give-up is logged once, as given up', async (t) => {
  const gate = deferred<void>();
  const errors = t.mock.method(console, 'error', () => {});
  const f = fixture(async () => {
    await gate.promise;
    throw new Error('A request error occurred: timeout of 10000ms exceeded');
  });
  const peer = connect(f.server);
  try {
    await peer.ready();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.emit('111.1');
    await settle();
    t.mock.timers.tick(5000);
    for (let i = 0; i < 50 && peer.deliveries().length < 1; i++) await settle();
    assert.equal(peer.deliveries().length, 1);
    gate.resolve();
    for (let i = 0; i < 5; i++) await settle();
    assert.deepEqual(logLines(errors).filter((l) => l.includes('backscroll')), [
      '[slack-mcpl] Gave up on the backscroll for message 111.1 in C1 after 5 s; delivering without it',
    ]);
  } finally {
    t.mock.timers.reset();
    await peer.close();
    gate.resolve();
  }
});

test('a header prepared while another conversation awaits the host still names its conversation', async (t) => {
  const gate = deferred<boolean>();
  const f = fixture();
  const peer = connect(f.server, (req) => {
    const text = req.method === method.PUSH_EVENT ? pushText(req) : '';
    return text.includes('id=111.2') ? gate.promise : true;
  });
  t.after(async () => { await peer.close(); gate.resolve(true); });
  await peer.ready();
  f.emit('111.1', 'C1');
  await until(() => peer.deliveries().length === 1, "C1's first message");
  f.emit('111.2', 'C2');
  await until(() => peer.deliveries().length === 2, "C2's message, its acceptance pending");
  f.emit('111.3', 'C1');
  await until(() => peer.deliveries().length === 3, "C1's next message");
  assert.match(pushText(peer.deliveries()[2]), /#general \(acme\)/, 'the host last saw C2, so C1 names itself');
  gate.resolve(true);
  await settle();
  f.emit('111.4', 'C1');
  await until(() => peer.deliveries().length === 4, "C1's message after that");
  assert.doesNotMatch(pushText(peer.deliveries()[3]), /#general/, "C2's late acceptance doesn't change the context");
});

test("a refusal leaves another conversation's context standing", async (t) => {
  const gate = deferred<boolean>();
  const f = fixture();
  const peer = connect(f.server, (req) => pushText(req).includes('id=111.1') ? gate.promise : true);
  t.after(async () => { await peer.close(); gate.resolve(false); });
  await peer.ready();
  f.emit('111.1', 'C1');
  await until(() => peer.deliveries().length === 1, "C1's message, its answer pending");
  f.emit('111.2', 'C2');
  await until(() => peer.deliveries().length === 2, "C2's message");
  gate.resolve(false);
  await until(() => f.cleared.length === 1, "C1's refusal");
  f.emit('111.3', 'C2');
  await until(() => peer.deliveries().length === 3, "C2's next message");
  assert.doesNotMatch(pushText(peer.deliveries()[2]), /#general/, 'the host last saw C2, so its next message needs no name');
});

test('an unsubscribe handled during the last lookup withholds the auto-subscribe note', async (t) => {
  const gate = deferred<void>();
  let lookups = 0;
  const f = fixture(undefined, async () => { if (++lookups === 1) await gate.promise; });
  const peer = connect(f.server);
  t.after(async () => { await peer.close(); gate.resolve(); });
  await peer.ready();
  f.emit('111.1');
  await until(() => lookups === 1, 'the metadata lookup under way');
  await peer.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  gate.resolve();
  await until(() => peer.deliveries().length === 1, 'the mention');
  await settle();
  assert.match(pushText(peer.deliveries()[0]), /<backscroll/);
  assert.doesNotMatch(pushText(peer.deliveries()[0]), /Auto-subscribed/);
  assert.doesNotMatch(await subscriptions(peer), /C1/);
});

test('an explicit unsubscribe before any delivery settles auto-subscription across peers', async (t) => {
  const f = fixture();
  const first = connect(f.server);
  await first.ready();
  await first.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  await first.close();
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  f.emit('111.1');
  await until(() => peer.deliveries().length === 1, 'mention');
  await settle();
  assert.doesNotMatch(pushText(peer.deliveries()[0]), /Auto-subscribed/);
  assert.doesNotMatch(await subscriptions(peer), /C1/);
});

test('an unsubscribe during host acceptance wins over the prepared auto-subscribe note', async (t) => {
  const gate = deferred<boolean>();
  const f = fixture();
  const peer = connect(f.server, () => gate.promise);
  t.after(async () => { await peer.close(); gate.resolve(true); });
  await peer.ready();
  f.emit('111.1');
  await until(() => peer.deliveries().length === 1, 'pending acceptance');
  assert.match(pushText(peer.deliveries()[0]), /Auto-subscribed/);
  await peer.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  gate.resolve(true);
  await settle();
  assert.doesNotMatch(await subscriptions(peer), /C1/);
});

for (const opened of [false, true]) {
  test(`a refused ${opened ? 'incoming' : 'push'} message leaves publish routing as it was`, async (t) => {
    const f = fixture();
    let deliveries = 0;
    const peer = connect(f.server, () => ++deliveries > 1);
    t.after(() => peer.close());
    await peer.ready();
    if (opened) await peer.open();
    f.emit('111.1', 'C1', { threadTs: '110.0' });
    await until(() => f.cleared.length === 1, 'refusal');
    await peer.publish();
    assert.deepEqual(f.posts, [{ channel: 'C1' }], 'the refused thread is not a publish destination');
    f.emit('111.2', 'C2');
    await until(() => peer.deliveries().length === 2, 'another conversation');
    await settle();
    f.emit('111.3', 'C1');
    await until(() => peer.deliveries().length === 3, 'return to first conversation');
    const req = peer.deliveries()[2];
    const text = req.method === method.PUSH_EVENT ? pushText(req)
      : (req.params as { messages: { content: { text: string }[] }[] }).messages[0].content[0].text;
    assert.match(text, /#general \(acme\)/);
  });
}

test('a refused first message leaves the next location header complete', async (t) => {
  const f = fixture();
  let deliveries = 0;
  const peer = connect(f.server, () => ++deliveries > 1);
  t.after(() => peer.close());
  await peer.ready();
  f.emit('111.1');
  await until(() => f.cleared.length === 1, 'refusal');
  f.emit('111.2');
  await until(() => peer.deliveries().length === 2, 'next mention');
  assert.match(pushText(peer.deliveries()[1]), /#general \(acme\)/);
});

test('an acceptance after messaging is switched off still records this peer\'s delivery context', async (t) => {
  const gate = deferred<boolean>();
  const f = fixture(undefined, undefined, () => false);
  let first = true;
  const peer = connect(f.server, () => {
    if (first) { first = false; return gate.promise; }
    return true;
  });
  t.after(async () => { await peer.close(); gate.resolve(true); });
  await peer.ready();
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  await until(() => peer.deliveries().length === 1, 'pending acceptance');
  await peer.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: ['tools'] });
  gate.resolve(true);
  await settle();
  await peer.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await peer.publish();
  assert.deepEqual(f.posts, [{ channel: 'C1', threadTs: '110.0' }]);
  f.emit('111.2');
  await until(() => peer.deliveries().length === 2, 'next accepted message');
  assert.equal(f.histories.length, 1, 'the accepted backscroll is recorded despite the changed grant');
  assert.doesNotMatch(pushText(peer.deliveries()[1]), /You cannot write|#general/);
});

test('addressed messages are acknowledged at enqueue and released when messaging switches off at a lookup', async (t) => {
  const gate = deferred<void>();
  let lookups = 0;
  const f = fixture(undefined, async () => { if (++lookups === 1) await gate.promise; });
  const errors = t.mock.method(console, 'error', () => {});
  const peer = connect(f.server);
  t.after(async () => { await peer.close(); gate.resolve(); });
  await peer.ready();
  f.emit('111.1');
  f.emit('111.2');
  await until(() => lookups === 1, 'metadata lookup');
  const acknowledgedAtEnqueue = [...f.acknowledged];
  await peer.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: ['tools'] });
  gate.resolve();
  await until(() => f.cleared.length === 2, 'both reactions released');
  assert.deepEqual(acknowledgedAtEnqueue, ['C1/111.1', 'C1/111.2'], 'the queued mention is already acknowledged');
  assert.equal(peer.deliveries().length, 0);
  assert.deepEqual(logLines(errors).filter((l) => l.includes('Dropped addressed message')), [
    '[slack-mcpl] Dropped addressed message 111.1 in C1 before delivery: slack.messaging is not active',
    '[slack-mcpl] Dropped addressed message 111.2 in C1 before delivery: slack.messaging is not active',
  ]);
});

for (const opened of [false, true]) {
  test(`a failed ${opened ? 'incoming' : 'push'} send logs its message and conversation`, async (t) => {
    const f = fixture();
    const errors = t.mock.method(console, 'error', () => {});
    const peer = connect(f.server, () => { throw new Error('delivery refused by transport'); });
    t.after(() => peer.close());
    await peer.ready();
    if (opened) await peer.open();
    f.emit('111.1');
    await until(() => f.cleared.length === 1, 'failed send releases reaction');
    const methodName = opened ? 'channels/incoming' : 'push/event';
    assert.ok(logLines(errors).some((l) => l.includes(methodName + ' failed') &&
      l.includes('111.1') && l.includes('C1')));
    // Nothing was committed: the next message is still a first interaction,
    // and its header names its conversation again.
    f.emit('111.2');
    await until(() => f.cleared.length === 2, 'the next failed send');
    assert.deepEqual(f.histories, ['C1', 'C1']);
    const second = peer.deliveries()[1];
    const text = second.method === method.PUSH_EVENT ? pushText(second)
      : (second.params as { messages: { content: { text: string }[] }[] }).messages[0].content[0].text;
    assert.match(text, /#general \(acme\)/);
  });

  test(`an error after accepted ${opened ? 'incoming' : 'push'} delivery is not reported as a failed send`, async (t) => {
    const f = fixture();
    const errors = t.mock.method(console, 'error', () => {});
    const peer = connect(f.server);
    t.after(() => peer.close());
    await peer.ready();
    if (opened) await peer.open();
    const internal = f.server as unknown as { subscribe(id: string): boolean };
    t.mock.method(internal, 'subscribe', () => { throw new Error('subscription commit failed'); });
    f.emit('111.1');
    await until(() => logLines(errors).some((l) => l.includes('subscription commit failed')), 'commit error');
    assert.equal(peer.deliveries().length, 1);
    assert.deepEqual(f.cleared, [], 'the received reaction belongs to an accepted delivery');
    assert.ok(logLines(errors).some((l) => l.includes('Error forwarding Slack message')));
    assert.ok(!logLines(errors).some((l) => l.includes(' failed:')));
  });
}

test('a second serve closes its rejected connection and leaves the first usable', async (t) => {
  const f = fixture();
  const first = connect(f.server);
  t.after(() => first.close());
  await first.ready();
  const second = connect(f.server);
  t.after(() => second.host.close());
  await assert.rejects(second.served, /already connected/);
  assert.equal(second.serverSide.destroyed, true);
  f.emit('111.1');
  await until(() => first.deliveries().length === 1, 'first peer still receives messages');
});

test('a first DM has backscroll but neither an auto-subscribe note nor a subscription', async (t) => {
  const f = fixture();
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  f.emit('111.1', 'D1', { isDM: true, mentionsBot: false, mentionIds: [] });
  assert.deepEqual(f.acknowledged, ['D1/111.1'], 'a DM is acknowledged as it enters the queue');
  await until(() => peer.deliveries().length === 1, 'DM');
  await settle();
  const text = pushText(peer.deliveries()[0]);
  assert.match(text, /<backscroll dm="true"/);
  assert.doesNotMatch(text, /Auto-subscribed/);
  assert.doesNotMatch(await subscriptions(peer), /D1/);
});

test('a DM looks up no conversation name, and its header says DM', async (t) => {
  let metaCalls = 0;
  const f = fixture(undefined, async () => { metaCalls++; });
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  const dm = { isDM: true, mentionsBot: false, mentionIds: [] };
  f.emit('111.1', 'D1', dm);
  await until(() => peer.deliveries().length === 1, 'the first DM');
  f.emit('111.2', 'C1');
  await until(() => peer.deliveries().length === 2, "C1's mention");
  f.emit('111.3', 'D1', dm);
  await until(() => peer.deliveries().length === 3, 'a DM after another conversation');
  const texts = peer.deliveries().map(pushText);
  assert.match(texts[0], /\[DM \(acme\) id=111\.1\] /);
  assert.match(texts[2], /\[DM \(acme\) id=111\.3\] /);
  assert.equal(metaCalls, 1, "only C1's name is looked up");
});

test('a first mention in a saved subscription brings no auto-subscribe note', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'slack-subscription-'));
  const file = join(directory, 'subscriptions.json');
  writeFileSync(file, JSON.stringify(['C1']));
  const original = process.env.SLACK_SUBSCRIPTIONS_FILE;
  process.env.SLACK_SUBSCRIPTIONS_FILE = file;
  t.after(() => {
    if (original === undefined) delete process.env.SLACK_SUBSCRIPTIONS_FILE;
    else process.env.SLACK_SUBSCRIPTIONS_FILE = original;
    rmSync(directory, { recursive: true, force: true });
  });
  const f = fixture();
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  f.emit('111.1');
  await until(() => peer.deliveries().length === 1, 'mention in saved subscription');
  assert.match(pushText(peer.deliveries()[0]), /<backscroll/);
  assert.doesNotMatch(pushText(peer.deliveries()[0]), /Auto-subscribed/);
});

test('a first mention in an already-subscribed conversation brings no auto-subscribe note', async (t) => {
  const f = fixture();
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  await peer.host.sendRequest('tools/call', { name: 'subscribe_channel', arguments: { channelId: 'C1' } });
  f.emit('111.1');
  await until(() => peer.deliveries().length === 1, 'mention');
  assert.match(pushText(peer.deliveries()[0]), /<backscroll/);
  assert.doesNotMatch(pushText(peer.deliveries()[0]), /Auto-subscribed/);
});

test('a top-level publish Slack fails is explained for the conversation it named', async (t) => {
  const f = fixture();
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  const slack = f.slack as unknown as { sendMessage: unknown };
  slack.sendMessage = async (channel: string, _text: string, opts: { threadTs?: string } = {}) => {
    f.posts.push({ channel, ...opts });
    throw Object.assign(new Error('An API error occurred: internal_error'), {
      code: ErrorCode.PlatformError,
      data: { ok: false, error: 'internal_error' },
    });
  };
  await assert.rejects(peer.publish(), /Check fetch_history for conversation C1 before posting again/);
  assert.deepEqual(f.posts, [{ channel: 'C1' }]);
});

test("a publish Slack fails is explained for the thread it posted into, though a delivery moved the thread meanwhile", async (t) => {
  const f = fixture();
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  await until(() => peer.deliveries().length === 1, 'the first delivery');
  await settle();
  await settle();
  // Slack's failure arrives after a second delivery, in another thread, is taken.
  const slack = f.slack as unknown as { sendMessage: unknown };
  slack.sendMessage = async (channel: string, _text: string, opts: { threadTs?: string } = {}) => {
    f.posts.push({ channel, ...opts });
    f.emit('113.1', 'C1', { threadTs: '112.0' });
    await until(() => peer.deliveries().length === 2, 'the second delivery');
    await settle();
    await settle();
    // The client's shape for Slack's refusal, as test/slackErrors.test.ts gets it from a real WebClient.
    throw Object.assign(new Error('An API error occurred: internal_error'), {
      code: ErrorCode.PlatformError,
      data: { ok: false, error: 'internal_error' },
    });
  };
  await assert.rejects(
    peer.publish(),
    /Check fetch_thread for the thread under message 110\.0 in conversation C1 before posting again/,
  );
  assert.deepEqual(f.posts, [{ channel: 'C1', threadTs: '110.0' }]);
});

test('a publish Slack refuses leaves the thread where it was, so the next publish to that conversation goes there too', async (t) => {
  const f = fixture();
  const peer = connect(f.server);
  t.after(() => peer.close());
  await peer.ready();
  f.emit('111.1', 'C1', { threadTs: '110.0' });
  await until(() => peer.deliveries().length === 1, 'the delivery');
  await settle();
  await settle();
  const slack = f.slack as unknown as { sendMessage: unknown };
  slack.sendMessage = async (channel: string, _text: string, opts: { threadTs?: string } = {}) => {
    f.posts.push({ channel, ...opts });
    throw Object.assign(new Error('An API error occurred: thread_not_found'), {
      code: ErrorCode.PlatformError,
      data: { ok: false, error: 'thread_not_found' },
    });
  };
  const refused =
    /Here that was the thread under message 110\.0 in conversation C1, and Slack refused it\. Another publish to conversation C1 now would go to the same thread\./;
  await assert.rejects(peer.publish(), refused);
  await assert.rejects(peer.publish(), refused);
  assert.deepEqual(f.posts, [{ channel: 'C1', threadTs: '110.0' }, { channel: 'C1', threadTs: '110.0' }]);
});
