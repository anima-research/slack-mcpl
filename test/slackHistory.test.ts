/**
 * Regression tests for fetchSlackHistory — the cursor-draining wrapper around
 * conversations.history. The Slack API returns newest-first pages of at most
 * `limit` messages and pages toward OLDER messages via next_cursor; before
 * this helper existed the tool layer read a single page, silently dropping
 * everything past it and (in the unread path) advancing the read cursor over
 * the dropped messages.
 *
 * Run: node --import tsx --test test/slackHistory.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSlackHistory, type SlackHistoryClient } from '../src/content.js';

type HistoryCall = { limit?: number; cursor?: string; oldest?: string; latest?: string; inclusive?: boolean; served: number };

/** Fake client over `total` messages with ts "1".."<total>" (oldest..newest),
 * served newest-first in cursor pages, honoring the requested `limit`. */
function fakeHistoryClient(total: number): SlackHistoryClient & { calls: HistoryCall[] } {
  const newestFirst = Array.from({ length: total }, (_, i) => ({ ts: String(total - i), text: `m${total - i}` }));
  const calls: HistoryCall[] = [];
  return {
    calls,
    conversations: {
      async history(args) {
        const offset = args.cursor ? Number(args.cursor) : 0;
        const pageSize = Math.min(args.limit ?? 100, 100); // Slack caps pages server-side too
        const page = newestFirst.slice(offset, offset + pageSize);
        calls.push({ limit: args.limit, cursor: args.cursor, oldest: args.oldest, latest: args.latest, inclusive: args.inclusive, served: page.length });
        const nextOffset = offset + page.length;
        return {
          messages: page,
          response_metadata: nextOffset < total ? { next_cursor: String(nextOffset) } : {},
        };
      },
    },
  };
}

test('drains the cursor across pages and returns oldest-first', async () => {
  const client = fakeHistoryClient(250);
  const { messages, truncated } = await fetchSlackHistory(client, { channel: 'C1', maxMessages: 1000 });

  assert.equal(messages.length, 250, 'all pages collected, nothing dropped at page boundaries');
  assert.equal(truncated, false);
  assert.equal(messages[0]!.ts, '1', 'oldest first');
  assert.equal(messages[249]!.ts, '250', 'newest last');
  assert.ok(client.calls.length >= 3, 'paginated rather than single-page');
});

test('single page without cursor is returned as-is (reversed)', async () => {
  const client = fakeHistoryClient(7);
  const { messages, truncated } = await fetchSlackHistory(client, { channel: 'C1', maxMessages: 100 });
  assert.deepEqual(messages.map(m => m.ts), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(truncated, false);
});

test('reports truncated=true when the backstop stops the drain', async () => {
  const client = fakeHistoryClient(250);
  const { messages, truncated } = await fetchSlackHistory(client, { channel: 'C1', maxMessages: 100 });

  assert.equal(truncated, true, 'caller must know messages were dropped');
  assert.equal(messages.length, 100);
  // Pages are newest-first, so truncation drops the OLDEST — this is why the
  // unread path must not advance lastReadTs when truncated.
  assert.equal(messages[messages.length - 1]!.ts, '250', 'newest message retained');
  assert.equal(messages[0]!.ts, '151', 'oldest in range dropped');
});

test('passes oldest/latest/inclusive through and never asks for more than needed', async () => {
  for (const [total, maxMessages] of [[50, 30], [250, 250]] as const) {
    const client = fakeHistoryClient(total);
    const { messages } = await fetchSlackHistory(client, { channel: 'C1', oldest: '10', latest: '99', inclusive: true, maxMessages });
    assert.equal(messages.length, maxMessages);
    let left = maxMessages;
    for (const c of client.calls) {
      assert.deepEqual([c.oldest, c.latest, c.inclusive], ['10', '99', true]);
      assert.ok(c.limit !== undefined && c.limit <= left, `asked for ${c.limit} with ${left} to go`);
      left -= c.served;
    }
  }
});
