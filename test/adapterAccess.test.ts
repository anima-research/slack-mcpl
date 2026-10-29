import assert from 'node:assert/strict';
import { type SlackAdapter } from '../src/slack-adapter.js';
import { uploadEndpoint } from './harness.js';
import { accessTest as test, accessFixture, accessScopes, joined } from './adapterAccessFixture.js';

const operations: Array<[string, (a: SlackAdapter) => Promise<unknown>]> = [
  ['send_message', (a) => a.sendMessage('C1', 'hi')],
  ['reply', (a) => a.sendMessage('C1', 'hi', { threadTs: '1.0' })],
  ['edit_message', (a) => a.editMessage('C1', '1.0', 'hi')],
  ['delete_message', (a) => a.deleteMessage('C1', '1.0')],
  ['add_reaction', (a) => a.addReaction('C1', '1.0', 'eyes')],
  ['upload_file', (a) => a.uploadFile('C1', { filename: 'x', data: Buffer.from('x') })],
  ['delete_file/rollback', (a) => a.deleteFile('C1', 'F1')],
  ['fetch_history', (a) => a.readHistory('C1', {})],
  ['fetch_thread', (a) => a.readThread('C1', '1.0', {})],
  ['backscroll', (a) => a.fetchHistory('C1')],
  ['conversation_info', (a) => a.getConversationMeta('C1')],
  ['send_dm/open', (a) => a.sendDM('U1', 'hi')],
  ['find_user', (a) => a.findUsers('human')],
];
for (const [name, run] of operations) {
  test(`policy deny matrix: ${name} with unknown scopes makes zero Slack calls`, async () => {
    const f = accessFixture({ scopes: [] });
    await assert.rejects(run(f.adapter), /scope/i);
    assert.deepEqual(f.calls, []);
  });
}

test('policy listing with unknown scopes and ACK with unknown scopes make zero Slack calls', async () => {
  const f = accessFixture({ scopes: [], ack: 'eyes' });
  assert.deepEqual((await f.adapter.listConversations(true)).conversations, []);
  await f.adapter.acknowledge('C1', '1.0');
  await f.adapter.stop();
  assert.deepEqual(f.calls, []);
});

for (const [name, run] of operations.filter(([name]) => !['send_dm/open', 'find_user'].includes(name))) {
  test(`fresh denial: ${name} cannot use cached membership`, async () => {
    const f = accessFixture();
    await f.adapter.getConversationMeta('C1');
    f.calls.length = 0;
    f.state.conversation = { ...joined(), is_member: false };
    await assert.rejects(run(f.adapter), /confirmed joined channel/);
    assert.deepEqual(f.methods(), ['info']);
  });
}

test('metadata identity, incomplete kind, unsupported group and failures all deny history before reading', async () => {
  const f = accessFixture();
  for (const metadata of [joined('C2'), { id: 'C1', is_member: true }, { ...joined(), is_mpim: true }, undefined]) {
    f.state.conversation = metadata;
    await assert.rejects(f.adapter.readHistory('C1', {}));
  }
  f.state.infoError = new Error('metadata failed');
  await assert.rejects(f.adapter.fetchHistory('C1'), /metadata failed/);
  assert.deepEqual(f.methods(), ['info', 'info', 'info', 'info', 'info']);
});

test('scope follows fresh metadata, not C/G prefix; history scope is separate from read scope', async () => {
  const f = accessFixture({ scopes: ['channels:read', 'channels:history', 'chat:write'] });
  f.state.conversation = { ...joined('C1'), is_private: true };
  await assert.rejects(f.adapter.sendMessage('C1', 'hi'), /groups:read/);
  const g = accessFixture({ scopes: ['groups:read', 'channels:history'] });
  g.state.conversation = { ...joined('C1'), is_private: true };
  await assert.rejects(g.adapter.readThread('C1', '1.0', {}), /groups:history/);
  assert.deepEqual(f.methods(), ['info']);
  assert.deepEqual(g.methods(), ['info']);
});

for (const [name, scope, run] of [
  ['send', 'chat:write', (a: SlackAdapter) => a.sendMessage('C1', '')],
  ['edit', 'chat:write', (a: SlackAdapter) => a.editMessage('C1', '1.0', '')],
  ['delete', 'chat:write', (a: SlackAdapter) => a.deleteMessage('C1', '1.0')],
  ['reaction', 'reactions:write', (a: SlackAdapter) => a.addReaction('C1', '1.0', 'eyes')],
  ['upload', 'files:write', (a: SlackAdapter) => a.uploadFile('C1', { filename: 'x', data: Buffer.from('x') })],
  ['file delete', 'files:write', (a: SlackAdapter) => a.deleteFile('C1', 'F1')],
] as const) {
  test(`effect scope: ${name} refuses before effect (and text validation)`, async () => {
    const f = accessFixture({ scopes: accessScopes.filter((s) => s !== scope) });
    await assert.rejects(run(f.adapter), new RegExp(scope));
    assert.deepEqual(f.methods(), ['info']);
  });
}

test('write pin and legacy send-list are intersections, while reads need no write pin', async () => {
  const f = accessFixture({ config: { readJoinedChannels: true, writeChannels: [], dmUsers: [] } });
  await f.adapter.readHistory('C1', {});
  await assert.rejects(f.adapter.sendMessage('C1', 'hi'), /not allowed/);
  assert.equal(f.adapter.canWrite('C1'), false);
  const g = accessFixture({ sendChannels: ['C2'] });
  await assert.rejects(g.adapter.sendMessage('C1', 'hi'), /may write only to C2/);
  assert.deepEqual(g.methods(), ['info']);
});

test('history continuation rechecks admission, not just the first page', async () => {
  const f = accessFixture();
  f.state.messages = [{ ts: '2.0', text: 'one' }, { ts: '1.0', text: 'two' }];
  f.state.more = true;
  const result = await f.adapter.readHistory('C1', { limit: 1 });
  assert.ok(result.pagination.nextCursor);
  f.calls.length = 0;
  f.state.conversation = { ...joined(), is_member: false };
  await assert.rejects(f.adapter.readHistory('C1', { limit: 1, cursor: result.pagination.nextCursor }), /confirmed joined/);
  assert.deepEqual(f.methods(), ['info']);
});

test('listing ignores nonmembers before info, then uses only freshly admitted metadata, even with includeNonMember', async () => {
  const f = accessFixture();
  f.state.listed = [{ ...joined('C2'), is_member: false }, joined('C1'), { id: 'G2', is_mpim: true }];
  const listed = await f.adapter.listConversations(true);
  assert.deepEqual(listed.conversations.map((c) => c.id), ['C1']);
  assert.deepEqual(f.methods(), ['list', 'info', 'info']);
  assert.deepEqual(f.calls[0].args, { types: 'public_channel,private_channel,im', exclude_archived: true, limit: 200, cursor: undefined });
  f.state.conversation = { ...joined(), is_member: false };
  assert.deepEqual((await f.adapter.listConversations(true)).conversations, []);
});

test('DM preflight: peer and all three scopes precede text and open', async () => {
  for (const scopes of [accessScopes, ...['im:read', 'im:write', 'chat:write'].map((s) => accessScopes.filter((v) => v !== s))]) {
    const f = accessFixture({ scopes });
    await assert.rejects(f.adapter.sendDM(scopes === accessScopes ? 'UOTHER' : 'U1', ''), /not allowed|requires granted scope/);
    assert.deepEqual(f.calls, []);
  }
  const f = accessFixture();
  await assert.rejects(f.adapter.sendDM('U1', '\ud800'));
  assert.deepEqual(f.calls, []);
});

test('DM early no-D-ID veto is retained under policy; exact returned D ID is also intersected', async () => {
  const f = accessFixture({ sendChannels: ['C1'] });
  assert.equal(f.adapter.dmsWritable, false);
  await assert.rejects(f.adapter.sendDM('U1', 'hi'), /none of them a direct message/);
  assert.deepEqual(f.calls, []);
  const g = accessFixture({ sendChannels: ['D2'] });
  g.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  await assert.rejects(g.adapter.sendDM('U1', 'hi'), /may write only to D2/);
  assert.deepEqual(g.methods(), ['open', 'info']);
});

test('DM fresh exact peer check rejects another allowed peer and an ordinary channel returned by open', async () => {
  const f = accessFixture();
  f.state.conversation = { id: 'D1', is_im: true, user: 'W1' };
  await assert.rejects(f.adapter.sendDM('U1', 'hi'), /does not match/);
  f.state.openId = 'C1';
  f.state.conversation = joined();
  await assert.rejects(f.adapter.sendDM('U1', 'hi'), /does not match/);
  assert.deepEqual(f.methods(), ['open', 'info', 'open', 'info']);
});

test('policy overrides legacy DM switches and allows exact U/W peers', async () => {
  for (const user of ['U1', 'W1']) {
    const f = accessFixture({ disableDms: true, dmUsers: ['UOTHER'] });
    assert.equal(f.adapter.dmsDisabled, false);
    assert.equal(f.adapter.dmsWritable, true);
    f.state.conversation = { id: 'D1', is_im: true, user };
    assert.deepEqual(await f.adapter.sendDM(user, 'hi'), { channelId: 'D1', messageId: '1.0' });
    assert.deepEqual(f.methods(), ['open', 'info', 'post']);
  }
});

test('inbound admission precedes all user lookups and delivery, while socket envelope is acknowledged', async () => {
  const f = accessFixture({ disableDms: true, dmUsers: ['UOTHER'] });
  const delivered: unknown[] = [];
  f.adapter.onMessage((m) => delivered.push(m));
  const event = { type: 'message', channel: 'D1', user: 'U1', ts: '1.0', channel_type: 'im', text: '<@UOTHER>' };
  f.state.conversation = { id: 'D1', is_im: true, user: 'W1' };
  assert.equal(await f.emit(event), true);
  assert.deepEqual(delivered, []);
  assert.deepEqual(f.methods(), ['info']);
  f.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  await f.emit(event);
  assert.equal(delivered.length, 1);
  assert.deepEqual(f.methods(), ['info', 'info', 'user', 'user']);
});

test('inbound unknown scopes and group DMs are no-ops before sender lookup', async () => {
  for (const scopes of [[], accessScopes]) {
    const f = accessFixture({ scopes });
    f.state.conversation = { id: 'G1', is_mpim: true, is_member: true };
    const delivered: unknown[] = [];
    f.adapter.onMessage((m) => delivered.push(m));
    assert.equal(await f.emit({ type: 'message', channel: 'G1', user: 'U1', ts: '1.0', text: 'hi' }), true);
    assert.deepEqual(delivered, []);
    assert.deepEqual(f.methods(), scopes.length ? ['info'] : []);
  }
});

test('ACK removal rechecks admission and effect scope after a successful add', async () => {
  const f = accessFixture({ ack: 'eyes' });
  await f.adapter.acknowledge('C1', '1.0');
  f.state.conversation = { ...joined(), is_member: false };
  await f.adapter.clearAck('C1');
  await f.adapter.stop();
  assert.deepEqual(f.methods(), ['info', 'react', 'info', 'info']);
});

test('legacy mode preserves calls, payloads, outputs and exact refusal text', async () => {
  const f = accessFixture({ legacy: true });
  await f.adapter.sendMessage('C1', 'hi', { threadTs: '1.0' });
  await f.adapter.editMessage('C1', '1.0', 'new');
  await f.adapter.deleteMessage('C1', '1.0');
  await f.adapter.addReaction('C1', '1.0', ':eyes:');
  assert.deepEqual(await f.adapter.sendDM('U1', 'dm'), { messageId: '1.0', channelId: 'D1' });
  await f.adapter.readHistory('C1', {});
  await f.adapter.readThread('C1', '1.0', {});
  assert.deepEqual(f.methods(), ['post', 'edit', 'delete', 'react', 'open', 'post', 'history', 'replies']);
  assert.deepEqual(f.calls.slice(0, 6).map((c) => c.args), [
    { channel: 'C1', text: 'hi', thread_ts: '1.0' }, { channel: 'C1', ts: '1.0', text: 'new' },
    { channel: 'C1', ts: '1.0' }, { channel: 'C1', timestamp: '1.0', name: 'eyes' },
    { users: 'U1' }, { channel: 'D1', text: 'dm' },
  ]);
  const g = accessFixture({ legacy: true, sendChannels: ['C2'] });
  await assert.rejects(g.adapter.sendMessage('C1', ''), { message: "Nothing was posted: this bot may write only to C2, and C1 isn't one of them. list_channels marks the conversations it may write to with writable: true. Calling again won't change that; whoever runs this host decides where it may write." });
  assert.deepEqual(g.calls, []);
  const h = accessFixture({ legacy: true, disableDms: true });
  await assert.rejects(h.adapter.readHistory('D1', {}), { message: 'No messages were returned: D1 is a direct message or group DM, and this bot works only in channels here, since direct messages are turned off. list_channels shows the ones it can use.' });
  assert.deepEqual(h.calls, []);
});

test('policy attachment references carry message provenance, but legacy URLs remain unchanged', async () => {
  const file = { name: 'note', mimetype: 'text/plain', url_private: 'https://files.slack.com/note' };
  for (const legacy of [false, true]) {
    const f = accessFixture({ legacy });
    f.state.messages = [{ ts: '1.0', text: 'file', files: [file] }];
    const history = await f.adapter.fetchHistory('C1');
    assert.deepEqual(history.messages[0].attachments, legacy ? [{ name: 'note', mimeType: 'text/plain', url: file.url_private }] : [{ channelId: 'C1', name: 'note', mimeType: 'text/plain', isImage: false }]);
    const delivered: Array<{ attachments: unknown[] }> = [];
    f.adapter.onMessage((m) => delivered.push(m));
    await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: 'file', files: [file] });
    assert.equal(delivered[0].attachments.length, 1);
  }
});

for (const [name, run] of operations.filter(([name]) => !['send_dm/open', 'find_user'].includes(name))) {
  test(`group DM refusal: ${name} has no data or write effect`, async () => {
    const f = accessFixture();
    f.state.conversation = { ...joined(), is_mpim: true };
    await assert.rejects(run(f.adapter), /unsupported membership/);
    assert.deepEqual(f.methods(), ['info']);
  });
}

test('invalid conversation IDs refuse before metadata; readJoinedChannels=false denies ordinary admission', async () => {
  const f = accessFixture();
  for (const id of ['U1', '', 'c1', '#general']) {
    await assert.rejects(f.adapter.sendMessage(id, 'hi'), /Invalid Slack conversation ID/);
  }
  assert.deepEqual(f.calls, []);
  const g = accessFixture({ config: { readJoinedChannels: false, writeChannels: ['C1'], dmUsers: ['U1'] } });
  await assert.rejects(g.adapter.getConversationMeta('C1'), /not a confirmed joined/);
  g.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  await g.adapter.readThread('D1', '1.0', {});
  assert.deepEqual(g.methods(), ['info', 'info', 'replies']);
});

test('positive write/read paths make a fresh info call before each effect, preserving payloads', async () => {
  const f = accessFixture();
  await f.adapter.sendMessage('C1', 'hi', { threadTs: '1.0' });
  await f.adapter.editMessage('C1', '1.0', 'new');
  await f.adapter.deleteMessage('C1', '1.0');
  await f.adapter.addReaction('C1', '1.0', ':eyes:');
  await assert.rejects(f.adapter.deleteFile('C1', 'F1'), /recorded upload/);
  await f.adapter.readHistory('C1', {});
  await f.adapter.readThread('C1', '1.0', {});
  await f.adapter.fetchHistory('C1');
  await f.adapter.findUsers('human');
  assert.deepEqual(f.methods(), ['info', 'post', 'info', 'edit', 'info', 'delete', 'info', 'react', 'info',
    'info', 'history', 'info', 'replies', 'info', 'history', 'users']);
  assert.deepEqual(f.calls[1].args, { channel: 'C1', text: 'hi', thread_ts: '1.0' });
});


test('policy upload gates the real byte transfer and rechecks before sharing', async (t) => {
  const endpoint = await uploadEndpoint();
  const f = accessFixture();
  f.state.uploadUrl = 'https://files.slack.com/upload/policy-upload';
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, f.state.uploadUrl);
    return realFetch(`${endpoint.url}/policy-upload`, init);
  });
  assert.deepEqual(await f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('policy bytes') }), { fileId: 'F1', shareTs: undefined });
  assert.deepEqual(f.methods(), ['info', 'upload', 'info', 'complete']);
  assert.equal(endpoint.bytes.get('policy-upload')?.toString(), 'policy bytes');
});

test('listing never requests DM scopes/types when the policy names no DM peers', async () => {
  const config = { readJoinedChannels: true, writeChannels: [], dmUsers: [] };
  const f = accessFixture({ config });
  await f.adapter.listConversations();
  assert.deepEqual(f.calls, [{ method: 'list', args: {
    types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor: undefined,
  } }]);
  const g = accessFixture({ config, scopes: ['im:read'] });
  assert.deepEqual((await g.adapter.listConversations()).conversations, []);
  assert.deepEqual(g.calls, [], 'a scope for an unadmitted type cannot trigger a listing or auth probe');
});


test('dmsDisabled reflects policy peers, not legacy switches or the write-only send list', async () => {
  for (const disableDms of [false, true]) {
    for (const dmUsers of [[], ['U1']]) {
      const f = accessFixture({ disableDms, config: { readJoinedChannels: true, writeChannels: [], dmUsers } });
      assert.equal(f.adapter.dmsDisabled, dmUsers.length === 0);
      assert.equal(f.adapter.dmsWritable, dmUsers.length > 0);
      assert.deepEqual(f.calls, []);
    }
    assert.equal(accessFixture({ legacy: true, disableDms }).adapter.dmsDisabled, disableDms);
  }
  const f = accessFixture({ sendChannels: ['C1'] });
  assert.equal(f.adapter.dmsWritable, false);
  assert.equal(f.adapter.dmsDisabled, false, 'allowed DM peers remain readable/listable despite the send-list veto');
});
