import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSlackHistory } from '../src/content.js';

test('legacy history helper preserves main repeated-cursor behavior before bounded pagination', async () => {
  let pages = 0;
  const client = { conversations: { async history() {
    if (++pages > 3) throw new Error('test safety ceiling');
    return { messages: [{ ts: String(4 - pages) }], response_metadata: { next_cursor: pages < 3 ? 'same' : '' } };
  } } };
  const result = await fetchSlackHistory(client, { channel: 'C1', maxMessages: 10 });
  assert.equal(pages, 3);
  assert.deepEqual(result, { messages: [{ ts: '1' }, { ts: '2' }, { ts: '3' }], truncated: false });
});
