/**
 * Tests for the location header in front of incoming messages.
 *
 * Run: node --import tsx --test test/locationHeader.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backscrollBlock, backscrollLine, locationHeader } from '../src/server.js';
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

test('backscroll block: what the agent sees on first interaction names the parent thread', () => {
  const base = { authorName: 'Ann', attachments: [], timestamp: new Date(0) };
  const block = backscrollBlock(
    [{ ...base, id: '1.0', content: 'parent' }, { ...base, id: '1.5', threadTs: '1.0', content: 'reply' }],
    { channelName: 'support', isDM: false },
  );
  assert.equal(
    block,
    [
      '<backscroll channel="#support" count="2">',
      '[1970-01-01T00:00:00.000Z id=1.0] Ann: parent',
      '[1970-01-01T00:00:00.000Z thread=1.0 id=1.5] Ann: reply',
      '</backscroll>',
    ].join('\n'),
  );
  assert.match(backscrollBlock([], { isDM: true }), /^<backscroll dm="true" count="0">/);
});

test('every header names the conversation by channelId, the DM included', () => {
  assert.equal(locationHeader({ channelId: 'D2', messageId: '2.0' }), '[channelId=D2 id=2.0] ');
  assert.equal(
    locationHeader({ conversation: 'DM', teamName: 'acme', channelId: 'D2', messageId: '2.0' }),
    '[DM (acme) channelId=D2 id=2.0] ',
  );
  assert.equal(locationHeader({ channelId: 'C1', threadTs: '1.0', messageId: '2.0' }), '[channelId=C1 thread=1.0 id=2.0] ');
  assert.equal(
    locationHeader({ conversation: '#support', teamName: 'acme', channelId: 'C1', threadTs: '1.0', messageId: '2.0' }),
    '[#support (acme) channelId=C1 thread=1.0 id=2.0] ',
  );
});

test("a DM's message names its channelId, and a write to another DM names who it went to when that DM has a label", async (t) => {
  const { FULL_GRANT, harness, initialize, until } = await import('./harness.js');
  const { method } = await import('@animalabs/mcpl-core');
  const h = harness({ dms: [{ id: 'D1', user: 'UVASYL' }, { id: 'D2', user: 'UDENIS' }] });
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
  await h.socket.emitMessage({ type: 'message', channel: 'D2', channel_type: 'im', user: 'UDENIS', text: 'what is refprice?', ts: '5.0' });
  await until(() => JSON.stringify(h.hostSaw).includes('what is refprice?'), "Denis's DM reaches the host");
  const delivered = JSON.stringify(h.hostSaw.filter((r) => JSON.stringify(r).includes('what is refprice?')));
  assert.match(delivered, /\[DM \(acme\) channelId=D2 id=5\.0\]/, 'the header gives the id to reply with');
  // A reply in that DM's thread, in the same context, gives the DM's id, the
  // thread and its own id.
  await h.socket.emitMessage({ type: 'message', channel: 'D2', channel_type: 'im', user: 'UDENIS', text: 'and in its thread', ts: '6.0', thread_ts: '5.0' });
  await until(() => JSON.stringify(h.hostSaw).includes('and in its thread'), 'the thread reply reaches the host');
  assert.match(JSON.stringify(h.hostSaw.filter((r) => JSON.stringify(r).includes('and in its thread'))), /\[channelId=D2 thread=5\.0 id=6\.0\]/);
  const sent = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'D1', content: 'the answer' } }) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(sent.content[0].text), { messageId: '100.1', to: 'DM: @UVASYL (acme)' }, 'the wrong recipient shows in the same turn');
  const replied = await h.host.sendRequest('tools/call', { name: 'reply_message', arguments: { channelId: 'D1', messageId: '5.0', content: 'the answer' } }) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(replied.content[0].text), { messageId: '100.2', threadTs: '5.0', to: 'DM: @UVASYL (acme)' });
  // The fake opens D1 for any user.
  const dm = await h.host.sendRequest('tools/call', { name: 'send_dm', arguments: { userId: 'UVASYL', content: 'the answer' } }) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(dm.content[0].text), { messageId: '100.3', channelId: 'D1', to: 'DM: @UVASYL (acme)' });
  // A DM no listing had has no label, so its answer has no `to`.
  const slack = (h.server as unknown as { slack: SlackAdapter }).slack;
  (slack as unknown as { web: { conversations: { open(): Promise<unknown> } } }).web.conversations.open =
    async () => ({ channel: { id: 'D7' } });
  const opened = await h.host.sendRequest('tools/call', { name: 'send_dm', arguments: { userId: 'UNEW', content: 'hello' } }) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(opened.content[0].text), { messageId: '100.4', channelId: 'D7' });
});

test('a plain MCP client registers no conversation, so its writes answer without `to`', async (t) => {
  const { harness, initialize } = await import('./harness.js');
  const h = harness();
  t.after(() => h.close());
  await initialize(h, false);
  const sent = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'hi' } }) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(sent.content[0].text), { messageId: '100.1' });
});
