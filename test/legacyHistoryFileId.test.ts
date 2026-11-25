import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSlackHistory, type SlackHistoryMessage } from '../src/content.js';

// Main before the policy stack allowed extra file metadata, including null IDs.
// Keep this assignment checked by tsc: runtime-only tests miss source regressions.
const message = {
  ts: '1.0',
  text: 'legacy attachment',
  files: [{ id: null, name: 'note.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/legacy' }],
};
const legacyMessage: SlackHistoryMessage = message;

test('unset history accepts main-compatible null file IDs without changing metadata', async () => {
  const result = await fetchSlackHistory({ conversations: {
    history: async () => ({ messages: [legacyMessage] }),
  } }, { channel: 'C1', maxMessages: 10 });
  assert.deepEqual(result.messages, [message]);
  assert.equal(result.truncated, false);
});
