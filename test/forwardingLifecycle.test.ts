import test from 'node:test';
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

function fixture(history = async (_channel: string) => [historyMessage]) {
  const handlers: Array<(msg: SlackMessageData) => void> = [];
  const posts: Array<{ channel: string; threadTs?: string }> = [];
  const histories: string[] = [];
  const slack = {
    teamName: 'acme', botUserId: 'UBOT', dmsWritable: true,
    canWrite: () => true,
    onMessage(handler: (msg: SlackMessageData) => void) { handlers.push(handler); },
    async listConversations() { return [{ id: 'C1', name: 'general', kind: 'channel', isMember: true }]; },
    async getConversationMeta(id: string) { return { id, name: 'general', kind: 'channel', isMember: true }; },
    async fetchHistory(channel: string) {
      histories.push(channel);
      return { messages: await history(channel), truncated: false };
    },
    async acknowledge() {},
    async clearAck() {},
    async sendMessage(channel: string, _text: string, opts: { threadTs?: string } = {}) {
      posts.push({ channel, ...opts });
      return { messageId: '200.0' };
    },
  } as unknown as SlackAdapter;
  const server = new SlackMcplServer(slack);
  return {
    server, handlers, histories, posts,
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

function connect(server: SlackMcplServer) {
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
      host.sendResponse(req.id, { results: [{ accepted: true }] });
    } else {
      assert.equal(req.method, method.PUSH_EVENT);
      host.sendResponse(req.id, { accepted: true });
    }
  });
  const served = server.serve(conn);
  return {
    host, requests,
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
