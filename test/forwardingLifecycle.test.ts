import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection, method, type JsonRpcRequest } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import type { SlackAdapter, SlackMessageData, HistoryMessage } from '../src/slack-adapter.js';
import { FULL_GRANT, until } from './harness.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const historyMessage: HistoryMessage = {
  id: '100.0', authorId: 'U2', authorName: 'Ann', content: 'older context',
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
    async acknowledge() {},
    async clearAck(channel: string, ts?: string) { cleared.push(`${channel}/${ts}`); },
    async sendMessage(channel: string, _text: string, opts: { threadTs?: string } = {}) {
      posts.push({ channel, ...opts });
      return { messageId: '200.0' };
    },
  } as unknown as SlackAdapter;
  const server = new SlackMcplServer(slack);
  return {
    server, handlers, histories, posts, cleared,
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
function connect(server: SlackMcplServer, accepts: (delivery: JsonRpcRequest) => boolean = () => true) {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const conn = McplConnection.fromStreams(toServer, toHost);
  conn.requestTimeout = 500;
  const host = McplConnection.fromStreams(toHost, toServer);
  const requests: JsonRpcRequest[] = [];
  host.on('request', (req) => {
    requests.push(req);
    if (host.isClosed) return; // An old peer cannot answer a stale delivery.
    if (req.method === method.CHANNELS_REGISTER) {
      const params = req.params as { channels: { id: string }[] };
      host.sendResponse(req.id, { results: params.channels.map((c) => ({ id: c.id, accepted: true })) });
    } else if (req.method === method.CHANNELS_INCOMING) {
      host.sendResponse(req.id, { results: [{ accepted: accepts(req) }] });
    } else {
      assert.equal(req.method, method.PUSH_EVENT);
      host.sendResponse(req.id, { accepted: accepts(req) });
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

test('a message whose peer leaves during a metadata lookup changes nothing for the next peer', async () => {
  // Lookup 1 is the first-interaction one, before the mention auto-subscribes.
  // Lookup 2 is the location header's, before the conversation's thread and
  // watermark are recorded. Each has its own check.
  for (const gated of [1, 2]) {
    const gate = deferred<void>();
    let lookups = 0;
    const f = fixture(undefined, async () => { if (++lookups === gated) await gate.promise; });
    const first = connect(f.server);
    await first.ready();
    f.emit('111.1', 'C1', { threadTs: '110.0' });
    await until(() => lookups === gated, `lookup ${gated} under way`);
    await first.close();

    const next = connect(f.server);
    try {
      await next.ready();
      if (gated === 1) {
        gate.resolve();
        await until(() => f.cleared.length > 0, 'the abandoned mention releases its reaction');
        // The abandoned mention did not subscribe the conversation: an ambient
        // message is dropped, and the mention after it is the one delivery.
        f.emit('112.1', 'C1', { mentionsBot: false, mentionIds: [] });
        f.emit('112.2', 'C1');
        await until(() => next.deliveries().length > 0, 'the mention');
        await settle();
        assert.equal(next.deliveries().length, 1, `lookup ${gated}`);
        assert.match(pushText(next.deliveries()[0]), /id=112.2/);
      } else {
        f.emit('112.1', 'C1', { threadTs: '112.0' });
        await until(() => next.deliveries().length > 0, 'the new peer\'s mention');
        gate.resolve();
        await until(() => f.cleared.length > 0, 'the abandoned mention releases its reaction');
        await next.publish();
        assert.deepEqual(f.posts, [{ channel: 'C1', threadTs: '112.0' }], `lookup ${gated}`);
      }
      assert.deepEqual(f.cleared, ['C1/111.1'], `lookup ${gated}`);
      assert.equal(first.deliveries().length, 0, `lookup ${gated}`);
    } finally {
      gate.resolve();
      await next.close();
    }
  }
});

test('a mention abandoned at its last lookup subscribes nothing, and says so on stderr', async () => {
  const gate = deferred<void>();
  let lookups = 0;
  const f = fixture(undefined, async () => { if (++lookups === 2) await gate.promise; });
  const errors = mock.method(console, 'error', () => {});
  try {
    const first = connect(f.server);
    await first.ready();
    f.emit('111.1');
    await until(() => lookups === 2, 'the location lookup under way');
    await first.close();

    const next = connect(f.server);
    try {
      await next.ready();
      gate.resolve();
      await until(() => f.cleared.length > 0, 'the abandoned mention releases its reaction');
      const dropped = errors.mock.calls.map((c) => c.arguments.join(' ')).filter((l) => l.includes('Dropped addressed message'));
      assert.deepEqual(dropped, ['[slack-mcpl] Dropped addressed message 111.1 in C1: its peer disconnected before delivery']);
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
  const slack = (f.server as unknown as { slack: { onMessage: (h: unknown) => void } }).slack;
  const onMessage = slack.onMessage;
  slack.onMessage = () => { throw new Error('forwarding setup failed'); };
  const errors = mock.method(console, 'error', () => {});
  const first = connect(f.server);
  try {
    await first.served;
    // The peer never closed its side; the server closed the connection, so a
    // TCP client isn't left on a socket nobody serves.
    assert.equal(first.serverSide.destroyed, true);
    assert.ok(errors.mock.calls.some((c) => String(c.arguments[1]).includes('forwarding setup failed')));
  } finally {
    first.host.close();
    errors.mock.restore();
  }
  slack.onMessage = onMessage;
  const next = connect(f.server);
  try {
    await next.ready();
    f.emit('111.1');
    await until(() => next.deliveries().length === 1, 'the next peer is served');
  } finally {
    await next.close();
  }
});
