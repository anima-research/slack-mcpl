import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { policyFileRefs, policyFileNote } from '../src/file-access.js';
import { SlackMcplServer } from '../src/server.js';
import { FULL_GRANT, connectHost, initialize, until } from './harness.js';
import { accessTest as test, accessFixture, accessScopes, joined } from './adapterAccessFixture.js';

const files = [
  { mode: 'hosted', id: 'F1', name: 'note.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/do-not-use' },
  { mode: 'hosted', id: 'FSTUB', file_access: 'check_file_info' },
  { name: 'FINVENTED.txt', url_private: 'https://files.slack.com/no-id' },
  { mode: 'hosted', id: 'FIMAGE', name: 'picture.png', mimetype: 'image/png' },
];
const message = { ts: '1.0', user: 'U1', text: 'prior', files };

for (const kind of ['history', 'thread', 'backscroll'] as const) {
  test(`policy ${kind} references are usable ID hints, not URLs or file lookups`, async (t) => {
    const f = accessFixture();
    f.state.messages = [message];
    const h = connectHost(new SlackMcplServer(f.adapter));
    t.after(() => h.close());
    await initialize(h, false);
    let text: string;
    if (kind === 'backscroll') {
      const result = await f.adapter.fetchHistory('C1');
      assert.deepEqual(result.messages[0].attachments[1], { channelId: 'C1', name: 'attachment', isImage: false });
      text = JSON.stringify(result);
    } else {
      const result = await h.host.sendRequest('tools/call', { name: kind === 'history' ? 'fetch_history' : 'fetch_thread',
        arguments: { channelId: 'C1', ...(kind === 'thread' ? { threadTs: '1.0' } : {}) } }) as { content: { text: string }[]; isError?: boolean };
      assert.notEqual(result.isError, true);
      text = JSON.parse(result.content[0].text).messages[0].attachments.join('\n');
      assert.match(text, /fetch_attachment\(\{"channelId":"C1","fileId":"F1"\}\)/);
      assert.match(text, /FINVENTED.txt.*not downloadable/);
    }
    assert.ok(!text.includes('FSTUB'));
    assert.ok(!text.includes('https://'));
    assert.ok(!text.includes('"fileId":"FINVENTED"'));
    assert.ok(!f.methods().includes('fileInfo'));
  });
}

for (const open of [false, true]) {
  test(`protected refs survive backscroll and ${open ? 'channels/incoming' : 'push/event'} text/metadata`, async (t) => {
    const f = accessFixture();
    f.state.messages = [message];
    f.state.listed = [joined()];
    const h = connectHost(new SlackMcplServer(f.adapter));
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
    if (open) await h.host.sendRequest(method.CHANNELS_OPEN, { type: 'slack', address: { channelId: 'C1' } });
    await f.emit({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '2.0', text: '<@UBOT> files', files });
    const route = open ? method.CHANNELS_INCOMING : method.PUSH_EVENT;
    await until(() => h.hostSaw.some((r) => r.method === route), 'file delivery');
    const params = h.hostSaw.find((r) => r.method === route)!.params as any;
    const delivered = open ? params.messages[0] : params.payload;
    const text = delivered.content.map((c: { text: string }) => c.text).join('\n');
    assert.match(text, /<backscroll[\s\S]*fetch_attachment\(\{"channelId":"C1","fileId":"F1"\}\)[\s\S]*<\/backscroll>/);
    assert.ok(!text.includes('FSTUB'));
    assert.match(text, /attachment.*not downloadable/);
    assert.match(text, /FINVENTED.txt.*not downloadable/);
    assert.equal(delivered.metadata.attachments[0].fileId, 'F1');
    assert.equal(delivered.metadata.attachments[0].path, undefined);
    assert.ok(!JSON.stringify(params).includes('https://'));
    assert.ok((open ? delivered.tags : params.tags).includes('chat:has-image'));
    assert.ok(!f.methods().includes('fileInfo'));
  });
}

test('missing files:read withholds refs without withholding admitted text', async () => {
  const f = accessFixture({ scopes: accessScopes.filter((scope) => scope !== 'files:read') });
  f.state.messages = [message];
  assert.deepEqual((await f.adapter.fetchHistory('C1')).messages[0].attachments, []);
  const received: unknown[] = [];
  f.adapter.onMessage((msg) => { received.push(msg.attachments); assert.equal(msg.content, 'text'); });
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '2.0', text: 'text', files });
  assert.deepEqual(received, [[]]);
});

test('file hints participate in bounded history accounting and continuation rechecks', async () => {
  const f = accessFixture();
  f.state.messages = Array.from({ length: 12 }, (_, i) => ({ ts: `${20 - i}.0`, text: 'x', files }));
  f.state.more = true;
  const result = await f.adapter.readHistory('C1', { maxBytes: 2048 });
  assert.equal(result.pagination.stopReason, 'byte_limit');
  assert.ok(result.messages.length < 12);
  assert.ok(result.pagination.nextCursor);
  f.state.conversation = { ...joined(), is_member: false };
  await assert.rejects(f.adapter.readHistory('C1', { maxBytes: 2048, cursor: result.pagination.nextCursor }));
});

test('legacy references retain URLs and no new file metadata requests', async () => {
  const f = accessFixture({ legacy: true });
  f.state.messages = [message];
  const result = await f.adapter.fetchHistory('C1');
  assert.deepEqual(result.messages[0].attachments[0], { name: 'note.txt', mimeType: 'text/plain', url: files[0].url_private });
  assert.deepEqual(f.methods(), ['history', 'user']);
});


test('explicit non-visible file access never offers a download ID or lookup', () => {
  for (const file_access of ['check_file_info', 'hidden', '', null, false]) {
    const [ref] = policyFileRefs([{ mode: 'hosted', id: 'F1', file_access }], 'C1');
    assert.equal(ref.fileId, undefined);
    assert.match(policyFileNote(ref), /not downloadable/);
    assert.ok(!policyFileNote(ref).includes('fetch_attachment'));
  }
  for (const file of [{ mode: 'hosted', id: 'F1' }, { mode: 'hosted', id: 'F1', file_access: 'visible' }]) {
    assert.equal(policyFileRefs([file], 'C1')[0].fileId, 'F1');
  }
});
