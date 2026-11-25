/**
 * One page validator (pageProblem) runs on every cursor-paged explicit-policy
 * page (history and thread reads continue by timestamp and check their end
 * signal instead) before
 * any early return: a candidate's rate limit, a scope withdrawal, the match
 * limit or the message limit can no longer turn a repeated cursor, a
 * non-string cursor, a malformed row or an unplaceable timestamp into a
 * complete or partial success. Each public case below returned success at
 * the previous #61 layer (4ec3bbc7).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackAccessPolicy } from '../src/access-policy.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize } from './harness.js';
import { isHistoryRow, isSlackTimestamp, pageProblem } from '../src/pagination.js';

const limited = () => Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 50 });
const joinedInfo = { channel: { id: 'C1', is_member: true, is_private: false, is_im: false, is_mpim: false } };

async function served(t: { after(fn: () => unknown): void }, web: object, policy = true) {
  const adapter = new SlackAdapter(web as never, { on() {}, async disconnect() {} } as never, 'UBOT', 'test', undefined, undefined, false, undefined,
    ['channels:read', 'channels:history', 'users:read'], policy ? new SlackAccessPolicy({ readJoinedChannels: true, writeChannels: [], dmUsers: [] }) : undefined);
  const h = connectHost(new SlackMcplServer(adapter));
  t.after(() => h.close());
  t.after(() => adapter.stop());
  await initialize(h, false);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    h.host.sendRequest('tools/call', { name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  return { adapter, call };
}

test('pageProblem: container, every row, non-string and repeated cursors, in that order', () => {
  const seen = new Set<string>();
  const ok = () => true;
  assert.equal(pageProblem(undefined, undefined, seen, ok), 'container');
  assert.equal(pageProblem({ length: 0 }, undefined, seen, ok), 'container');
  assert.equal(pageProblem([1, {}], undefined, seen, (r) => typeof r === 'number'), 'row');
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(pageProblem([1, , 2], undefined, seen, (r) => typeof r === 'number'), 'row');
  for (const cursor of [0, null, {}, false]) assert.equal(pageProblem([], cursor, seen, ok), 'cursor');
  assert.equal(pageProblem([], 'a', seen, ok), undefined);
  assert.equal(pageProblem([], 'a', seen, ok), 'cycle');
  assert.equal(pageProblem([], '', seen, ok), undefined);
  assert.equal(pageProblem([], undefined, seen, ok), undefined);
});

test('history rows need a placeable timestamp, not just its form', () => {
  assert.equal(isSlackTimestamp('1718000000.000100'), true);
  assert.equal(isSlackTimestamp('9999999999999999'), false);
  assert.equal(isHistoryRow({ ts: '9999999999999999' }), false);
  assert.equal(isHistoryRow({ ts: '1.0' }), true);
});

test('public list_channels: a repeated cursor is refused before a candidate rate limit returns partial success', async (t) => {
  let pages = 0;
  const { call } = await served(t, { conversations: {
    list: async () => ({ channels: ++pages === 1 ? [] : [{ id: 'C1' }], response_metadata: { next_cursor: 'same' } }),
    info: async () => { throw limited(); },
  } });
  const r = await call('list_channels');
  assert.equal(r.isError, true, JSON.stringify(r));
  assert.match(r.content[0].text, /cursor cycle/);
  assert.equal(pages, 2);
});

test('public list_channels: a malformed candidate after a rate-limited one is refused', async (t) => {
  const { call } = await served(t, { conversations: {
    list: async () => ({ channels: [{ id: 'C1' }, {}], response_metadata: {} }),
    info: async () => { throw limited(); },
  } });
  const r = await call('list_channels');
  assert.equal(r.isError, true, JSON.stringify(r));
  assert.match(r.content[0].text, /malformed Slack listing candidate/);
});

test('public list_channels: a malformed-only page with the last readable scope withdrawn is not a complete empty list', async (t) => {
  const { call } = await served(t, { conversations: {
    list: async () => ({ channels: [{}], response_metadata: { scopes: ['users:read'] } }),
  } });
  const r = await call('list_channels');
  assert.equal(r.isError, true, JSON.stringify(r));
  assert.notEqual(r.content[0].text, '[]');
  assert.match(r.content[0].text, /malformed Slack listing candidate/);
});

test('public list_channels: a non-string cursor is refused before a candidate rate limit', async (t) => {
  const { call } = await served(t, { conversations: {
    list: async () => ({ channels: [{ id: 'C1' }], response_metadata: { next_cursor: 0 } }),
    info: async () => { throw limited(); },
  } });
  const r = await call('list_channels');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /malformed pagination cursor/);
});

const directory = (n: number, extra: unknown[] = []) => [...Array.from({ length: n }, (_, i) => ({ id: `U${i}`, name: 'ann' })), ...extra];

test('public find_user: the 25th match does not hide a repeated cursor', async (t) => {
  let pages = 0;
  const { call } = await served(t, { users: { list: async () => ({ members: ++pages === 1 ? [] : directory(25), response_metadata: { next_cursor: 'same' } }) } });
  const r = await call('find_user', { query: 'ann' });
  assert.equal(r.isError, true, JSON.stringify(r));
  assert.match(r.content[0].text, /cursor cycle/);
  assert.equal(pages, 2);
});

test('public find_user: the 25th match does not hide a malformed remaining row', async (t) => {
  const { call } = await served(t, { users: { list: async () => ({ members: directory(25, [{}]), response_metadata: {} }) } });
  const r = await call('find_user', { query: 'ann' });
  assert.equal(r.isError, true, JSON.stringify(r));
  assert.match(r.content[0].text, /malformed directory row/);
});

test('backscroll: the message limit does not clear a repeated cursor before it is checked', async (t) => {
  let pages = 0;
  const { adapter } = await served(t, { conversations: {
    info: async () => joinedInfo,
    history: async () => ({ messages: [{ ts: `${++pages}.0` }], response_metadata: { next_cursor: 'same' } }),
  } });
  await assert.rejects(adapter.fetchHistory('C1', { limit: 2 }), /cursor cycle/);
  assert.equal(pages, 2);
});

test('backscroll: an unplaceable timestamp is refused, never an Invalid Date', async (t) => {
  const { adapter } = await served(t, { conversations: {
    info: async () => joinedInfo,
    history: async () => ({ messages: [{ ts: '9999999999999999' }] }),
  } });
  await assert.rejects(adapter.fetchHistory('C1'), /malformed history row/);
});

// fetch_history and fetch_thread continue by timestamp, not by cursor, but a
// policy page's sign of more is still validated before any of its rows is
// taken: a malformed one is refused, never read as the end (scanComplete,
// exhausted). Each returned scanComplete:true at a33d27ee.
const malformedSignals: Array<[string, Record<string, unknown>]> = [
  ['next_cursor 0', { response_metadata: { next_cursor: 0 } }],
  ['next_cursor null', { response_metadata: { next_cursor: null } }],
  ['next_cursor object', { response_metadata: { next_cursor: {} } }],
  ['response_metadata a string', { response_metadata: 'more' }],
  ['response_metadata null', { response_metadata: null }],
  ['has_more "true"', { has_more: 'true' }],
  ['has_more 1', { has_more: 1 }],
];
for (const tool of ['fetch_history', 'fetch_thread'] as const) {
  const list = tool === 'fetch_history' ? 'history' : 'replies';
  for (const [label, signal] of malformedSignals) {
    test(`public ${tool}: a policy page with ${label} is refused, not reported complete`, async (t) => {
      const { call } = await served(t, { conversations: {
        info: async () => joinedInfo,
        [list]: async () => ({ ok: true, messages: [{ ts: '1.0', text: 'hi', user: 'U1' }], ...signal }),
      } });
      const r = await call(tool, { channelId: 'C1', ...(tool === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
      assert.equal(r.isError, true, JSON.stringify(r));
      assert.match(r.content[0].text, /malformed has_more or next_cursor/);
      assert.doesNotMatch(r.content[0].text, /scanComplete|exhausted/);
    });
  }

  test(`public ${tool}: rows already read are not returned once a later policy page is refused`, async (t) => {
    let pages = 0;
    const { call } = await served(t, { conversations: {
      info: async () => joinedInfo,
      [list]: async () => (++pages === 1
        ? { ok: true, messages: [{ ts: tool === 'fetch_history' ? '5.0' : '1.0', text: 'first', user: 'U1' }], has_more: true }
        : { ok: true, messages: [{ ts: tool === 'fetch_history' ? '4.0' : '2.0', text: 'second', user: 'U1' }], response_metadata: { next_cursor: 0 } }),
    } });
    const r = await call(tool, { channelId: 'C1', ...(tool === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
    assert.equal(r.isError, true, JSON.stringify(r));
    assert.equal(pages, 2);
    assert.doesNotMatch(r.content[0].text, /first|second/);
  });

  test(`public ${tool}: well-formed end signals still complete the read`, async (t) => {
    for (const signal of [{}, { has_more: false }, { has_more: false, response_metadata: {} }, { response_metadata: { next_cursor: '' } }]) {
      const { call } = await served(t, { conversations: {
        info: async () => joinedInfo,
        [list]: async () => ({ ok: true, messages: [{ ts: '1.0', text: 'hi', user: 'U1' }], ...signal }),
      } });
      const r = await call(tool, { channelId: 'C1', ...(tool === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
      assert.notEqual(r.isError, true, JSON.stringify(r));
      const body = JSON.parse(r.content[0].text);
      assert.equal(body.pagination.scanComplete, true);
      assert.equal(body.pagination.stopReason, 'exhausted');
    }
  });

  test(`unset ${tool}: main's reading of next_cursor 0 as the end is kept`, async (t) => {
    const { call } = await served(t, { conversations: {
      info: async () => joinedInfo,
      [list]: async () => ({ ok: true, messages: [{ ts: '1.0', text: 'hi', user: 'U1' }], response_metadata: { next_cursor: 0 } }),
    } }, false);
    const r = await call(tool, { channelId: 'C1', ...(tool === 'fetch_thread' ? { threadTs: '1.0' } : {}) });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(JSON.parse(r.content[0].text).pagination.scanComplete, true);
  });
}

test('unset findUsers: a zero match limit uses the first page as on main', async (t) => {
  const next = { next_cursor: 'next' };
  const match = { userId: 'U1', username: 'x', realName: undefined, displayName: undefined };
  for (const [page, expected] of [
    [{ ok: true }, []],
    [{ ok: true, members: null }, []],
    [{ ok: true, members: [], response_metadata: next }, []],
    [{ ok: true, members: [{ id: 'U1', name: 'x' }, { id: 'U2', name: 'x' }], response_metadata: next }, [match]],
  ] as const) {
    const requests: unknown[] = [];
    const { adapter } = await served(t, { users: { list: async (args: unknown) => {
      requests.push(args);
      return page;
    } } }, false);
    assert.deepEqual(await adapter.findUsers('x', 0), expected);
    assert.deepEqual(requests, [{ limit: 200, cursor: undefined }]);
  }
});

test("unset findUsers: a non-iterable container still fails with main's loop error", async (t) => {
  const { adapter } = await served(t, { users: { list: async () => ({ ok: true, members: 5 }) } }, false);
  await assert.rejects(adapter.findUsers('x', 0), (err: Error) => err instanceof TypeError && /is not iterable/.test(err.message));
});
