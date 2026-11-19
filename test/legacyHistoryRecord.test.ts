import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRecord } from '../src/history-read.js';

test('the exported history renderer keeps a URL-less legacy attachment with extra channelId metadata legacy', () => {
  const m = { id: '1.0', authorName: 'Ann', timestamp: new Date(0), content: 'hi', rootTs: '1.0',
    attachments: [{ name: 'notes.txt', channelId: 'C123' }] } as any;
  assert.deepEqual(historyRecord(m).attachments, ['notes.txt']);
  assert.match(historyRecord(m, true).attachments![0], /not downloadable/);
});
