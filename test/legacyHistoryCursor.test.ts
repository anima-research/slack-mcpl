import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSlackHistory } from '../src/content.js';

test('legacy repeated cursors retain main completion before the page bound', async () => {
  let pages = 0;
  const client = { conversations: { async history() {
    if (++pages > 3) throw new Error('test safety ceiling');
    return { messages: [{ ts: String(4 - pages) }], response_metadata: { next_cursor: pages < 3 ? 'same' : '' } };
  } } };
  const result = await fetchSlackHistory(client, { channel: 'C1', maxMessages: 10 });
  assert.deepEqual(result, { messages: [{ ts: '1' }, { ts: '2' }, { ts: '3' }], truncated: false });
  assert.equal(pages, 3);
});


test('backscroll detects a non-adjacent cursor cycle with outcome and repair guidance', async () => {
  let pages = 0;
  const client = { conversations: { history: async () => ({ messages: [], response_metadata: { next_cursor: ['a', 'b', 'a'][pages++] } }) } };
  await assert.rejects(fetchSlackHistory(client, { channel: 'C1', maxMessages: 10, rejectCursorCycles: true }), /No backscroll context.*cursor cycle.*Retry once.*investigate/);
  assert.equal(pages, 3);
});
