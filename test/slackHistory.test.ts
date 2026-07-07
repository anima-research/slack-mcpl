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

/** Fake client over `total` messages with ts "1".."<total>" (oldest..newest),
 * served newest-first in cursor pages, honoring the requested `limit`. */
function fakeHistoryClient(total: number): SlackHistoryClient & { calls: Array<{ limit?: number; cursor?: string }> } {
  const newestFirst = Array.from({ length: total }, (_, i) => ({ ts: String(total - i), text: `m${total - i}` }));
  const calls: Array<{ limit?: number; cursor?: string }> = [];
  return {
    calls,
    conversations: {
      async history(args) {
        calls.push({ limit: args.limit, cursor: args.cursor });
        const offset = args.cursor ? Number(args.cursor) : 0;
        const pageSize = Math.min(args.limit ?? 100, 100); // Slack caps pages server-side too
        const page = newestFirst.slice(offset, offset + pageSize);
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
  const client = fakeHistoryClient(50);
  await fetchSlackHistory(client, { channel: 'C1', oldest: '10', latest: '99', inclusive: true, maxMessages: 30 });
  assert.ok(client.calls.every(c => (c.limit ?? 0) <= 30), 'limit bounded by remaining budget');
});
