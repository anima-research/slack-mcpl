/**
 * Tests for the location header in front of incoming messages.
 *
 * Run: node --import tsx --test test/locationHeader.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backscrollLine, locationHeader } from '../src/server.js';
import { SlackAdapter } from '../src/slack-adapter.js';

test('same conversation, top level: message ID only', () => {
  assert.equal(locationHeader({ messageId: '2.0' }), '[id=2.0] ');
});

test('same conversation, in a thread: the thread is named every time', () => {
  assert.equal(locationHeader({ threadTs: '1.0', messageId: '2.0' }), '[thread=1.0 id=2.0] ');
});

test('conversation changed: channel and workspace lead', () => {
  assert.equal(
    locationHeader({ conversation: '#support', teamName: 'acme', threadTs: '1.0', messageId: '2.0' }),
    '[#support (acme) thread=1.0 id=2.0] ',
  );
});

test('backscroll: a thread reply names its parent, a top-level message does not', () => {
  const base = { authorName: 'Ann', content: 'hi', attachments: [], timestamp: new Date(0) };
  assert.equal(
    backscrollLine({ ...base, id: '1.5', threadTs: '1.0' }),
    '[1970-01-01T00:00:00.000Z thread=1.0 id=1.5] Ann: hi',
  );
  assert.equal(backscrollLine({ ...base, id: '1.6' }), '[1970-01-01T00:00:00.000Z id=1.6] Ann: hi');
});

test('backscroll: threadTs survives from Slack history through the adapter into the line', async () => {
  const web = {
    conversations: {
      async history() {
        return {
          messages: [
            { ts: '1718000000.000150', thread_ts: '1718000000.000100', user: 'U1', text: 'old broadcast' },
            { ts: '1718000000.000100', thread_ts: '1718000000.000100', user: 'U1', text: 'parent' },
          ],
        };
      },
    },
    users: { async info({ user }: { user: string }) { return { user: { name: user } }; } },
  } as any;
  const adapter = new SlackAdapter(web, { on() {}, async start() {}, async disconnect() {} } as any, 'UBOT', 'acme');
  const { messages } = await adapter.fetchHistory('C1');
  const lines = messages.map(backscrollLine);
  assert.match(lines.find((l) => l.includes('old broadcast'))!, / thread=1718000000\.000100 id=1718000000\.000150\]/);
  assert.doesNotMatch(lines.find((l) => l.includes('parent'))!, /thread=/, 'the thread root is not its own reply');
});
