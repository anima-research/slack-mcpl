import { ErrorCode } from '@slack/web-api';
import { elapse, virtualClock } from './virtualClock.js';
import { clock } from '../src/clock.js';
import { SlackAccessDenied, SlackAccessInputError } from '../src/access-policy.js';
import assert from 'node:assert/strict';
import {
  CALL_SECONDS, failedAccessAdmission, GaveUp, policyFailureSummary, SLACK_CLIENT_OPTIONS, SlackWebClient, withCallTime, type SlackAdapter,
} from '../src/slack-adapter.js';
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

test('policy listing probes unknown scopes; ACK still makes zero Slack calls', async () => {
  const f = accessFixture({ scopes: [], ack: 'eyes' });
  await assert.rejects(f.adapter.listConversations(true), /scope metadata is unavailable/);
  f.calls.length = 0;
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
    await assert.rejects(run(f.adapter), /a member can invite it/);
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
  await assert.rejects(g.adapter.sendMessage('C1', 'hi'), /writing to C1 is not allowed/);
  assert.deepEqual(g.methods(), []);
});

test('history continuation rechecks admission, not just the first page', async () => {
  const f = accessFixture();
  f.state.messages = [{ ts: '2.0', text: 'one' }, { ts: '1.0', text: 'two' }];
  f.state.more = true;
  const result = await f.adapter.readHistory('C1', { limit: 1 });
  assert.ok(result.pagination.nextCursor);
  f.calls.length = 0;
  f.state.conversation = { ...joined(), is_member: false };
  await assert.rejects(f.adapter.readHistory('C1', { limit: 1, cursor: result.pagination.nextCursor }), /a member can invite it/);
  assert.deepEqual(f.methods(), ['info']);
});

test('listing vetoes unjoined public channels and unnamed group DMs, even with includeNonMember', async () => {
  const f = accessFixture();
  f.state.listed = [{ ...joined('C2'), is_member: false }, joined('C1'), { id: 'G2', is_mpim: true }];
  const info = f.web.conversations.info;
  f.web.conversations.info = async args => args.channel === 'G2'
    ? (f.calls.push({ method: 'info', args }), { channel: { id: 'G2', is_mpim: true } }) : info(args);
  const listed = await f.adapter.listConversations(true);
  assert.deepEqual(listed.conversations.map((c) => c.id), ['C1']);
  // Unnamed MPIMs cannot be admitted, so only C1 needs fresh metadata (R1-2).
  assert.deepEqual(f.methods(), ['list', 'info']);
  assert.deepEqual(f.calls[1].args, { channel: 'C1' });
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
  await assert.rejects(f.adapter.sendDM('U1', 'hi'), /direct-message writes are not allowed/);
  assert.deepEqual(f.calls, []);
  const g = accessFixture({ sendChannels: ['D2'] });
  g.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  await assert.rejects(g.adapter.sendDM('U1', 'hi'), /writing to D1 is not allowed/);
  assert.deepEqual(g.methods(), ['open']);
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

for (const user of ['U1', 'W1']) {
  for (const policyAllows of [false, true]) {
    for (const disableDms of [false, true]) {
      for (const dmUsers of [undefined, [], [user], ['UOTHER']]) {
        test(`DM intersection: ${JSON.stringify({ user, policyAllows, disableDms, dmUsers })}`, async (t) => {
          t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
          const f = accessFixture({ disableDms, dmUsers,
            config: { readJoinedChannels: true, writeChannels: ['C1'], dmUsers: policyAllows ? [user] : [] } });
          const allowed = policyAllows && !disableDms && (dmUsers === undefined || dmUsers.includes(user));
          f.state.conversation = { id: 'D1', is_im: true, user };
          f.state.listed = [f.state.conversation];
          assert.equal(f.adapter.dmsDisabled, !allowed);
          assert.equal(f.adapter.dmsWritable, allowed);
          const operations = [
            () => f.adapter.sendDM(user, 'hi'),
            () => f.adapter.getConversationMeta('D1'),
            () => f.adapter.fetchHistory('D1'),
            () => f.adapter.sendMessage('D1', 'hi'),
            () => f.adapter.editMessage('D1', '1.0', 'hi'),
            () => f.adapter.deleteMessage('D1', '1.0'),
            async () => { if (allowed) await f.adapter.uploadFile('D1', { filename: 'x', data: Buffer.from('x') }); await f.adapter.deleteFile('D1', 'F1'); },
            () => f.adapter.addReaction('D1', '1.0', 'eyes'),
          ];
          for (const operation of operations) {
            f.calls.length = 0;
            if (allowed) await operation();
            else {
              await assert.rejects(operation(), SlackAccessDenied);
              assert.ok(f.methods().every((method) => method === 'info'), 'no open, read or effect on refusal');
            }
          }
          f.calls.length = 0;
          const listed = await f.adapter.listConversations();
          assert.equal(listed.conversations.length, allowed ? 1 : 0);
          const listCall = f.calls.find((call) => call.method === 'list')!;
          assert.equal((listCall.args as { types: string }).types.split(',').includes('im'), allowed);
          const delivered: unknown[] = [];
          f.adapter.onMessage((message) => delivered.push(message));
          f.calls.length = 0;
          assert.equal(await f.emit({ type: 'message', channel: 'D1', user, ts: '1.0', channel_type: 'im', text: 'hi' }), true);
          assert.equal(delivered.length, allowed ? 1 : 0);
          if (!allowed) assert.ok(!f.methods().includes('user'));
          // DM guards never narrow joined-channel admission.
          f.state.conversation = joined();
          await f.adapter.sendMessage('C1', 'hi');
        });
      }
    }
  }
}

test('inbound admission precedes all user lookups and delivery, while socket envelope is acknowledged', async () => {
  const f = accessFixture();
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

test('inbound unknown scopes and unnamed group DMs are no-ops before sender lookup', async () => {
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

test('ACK removal rechecks membership after a successful add', async () => {
  const f = accessFixture({ ack: 'eyes' });
  await f.adapter.acknowledge('C1', '1.0');
  f.state.conversation = { ...joined(), is_member: false };
  await f.adapter.clearAck('C1');
  await f.adapter.stop();
  assert.deepEqual(f.methods(), ['info', 'react', 'info']);
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

test('policy attachment references carry conversation and file identifiers, but legacy URLs remain unchanged', async () => {
  const file = { id: 'F1', mode: 'hosted', name: 'note', mimetype: 'text/plain', url_private: 'https://files.slack.com/note' };
  for (const legacy of [false, true]) {
    const f = accessFixture({ legacy });
    f.state.messages = [{ ts: '1.0', text: 'file', files: [file] }];
    const history = await f.adapter.fetchHistory('C1');
    assert.deepEqual(history.messages[0].attachments, legacy ? [{ name: 'note', mimeType: 'text/plain', url: file.url_private }] : [{ channelId: 'C1', fileId: 'F1', name: 'note', mimeType: 'text/plain', isImage: false }]);
    const delivered: Array<{ attachments: unknown[] }> = [];
    f.adapter.onMessage((m) => delivered.push(m));
    await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: 'file', files: [file] });
    assert.equal(delivered[0].attachments.length, 1);
    if (!legacy) assert.deepEqual(delivered[0].attachments[0], { channelId: 'C1', fileId: 'F1', name: 'note', mimeType: 'text/plain', isImage: false });
  }
});

for (const [name, run] of operations.filter(([name]) => !['send_dm/open', 'find_user'].includes(name))) {
  test(`group DM refusal: ${name} has no data or write effect`, async () => {
    const f = accessFixture();
    f.state.conversation = { ...joined(), is_mpim: true, is_private: true };
    await assert.rejects(run(f.adapter), /group direct message is not admitted/);
    assert.deepEqual(f.methods(), ['info']);
  });
}

test('invalid conversation IDs refuse before metadata; readJoinedChannels=false denies ordinary admission', async () => {
  const f = accessFixture();
  for (const id of ['U1', '', 'c1', '#general']) {
    await assert.rejects(f.adapter.sendMessage(id, 'hi'), /Invalid Slack conversation ID/);
  }
  assert.deepEqual(f.calls, []);
  const g = accessFixture({ config: { readJoinedChannels: false, writeChannels: [], dmUsers: ['U1'] } });
  await assert.rejects(g.adapter.getConversationMeta('C1'), /excluded/);
  g.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  await g.adapter.readThread('D1', '1.0', {});
  assert.deepEqual(g.methods(), ['info', 'replies']);
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
  assert.deepEqual(await g.adapter.listConversations(), { conversations: [], leftOut: ['public_channel', 'private_channel'] });
  assert.deepEqual(g.methods(), ['auth.test']);
});


test('dmsDisabled intersects policy peers and legacy disable, but not the write-only send list', async () => {
  for (const disableDms of [false, true]) {
    for (const dmUsers of [[], ['U1']]) {
      const f = accessFixture({ disableDms, config: { readJoinedChannels: true, writeChannels: [], dmUsers } });
      assert.equal(f.adapter.dmsDisabled, disableDms || dmUsers.length === 0);
      assert.equal(f.adapter.dmsWritable, !disableDms && dmUsers.length > 0);
      assert.deepEqual(f.calls, []);
    }
    assert.equal(accessFixture({ legacy: true, disableDms }).adapter.dmsDisabled, disableDms);
  }
  const f = accessFixture({ sendChannels: ['C1'] });
  assert.equal(f.adapter.dmsWritable, false);
  assert.equal(f.adapter.dmsDisabled, false, 'allowed DM peers remain readable/listable despite the send-list veto');
});


test('foreground rate limits retain partial rows; background retries can recover', async (t) => {
  virtualClock(t);
  const f = accessFixture();
  f.state.listed = [joined('C0'), joined()];
  const error = Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 2 });
  // C0 is admitted before C1's check is rate-limited.
  const info = f.web.conversations.info;
  f.web.conversations.info = async (args: any) => args.channel === 'C0' ? { channel: joined('C0') } : info(args);
  f.state.infoError = error;
  const partial = await f.adapter.listConversations();
  assert.deepEqual(partial.conversations.map(c => c.id), ['C0']);
  assert.equal(partial.admissionFailures, 1);
  assert.deepEqual(partial.admissionStop, { reason: 'rate_limited', retryAfterSeconds: 2 });
  f.web.conversations.info = info;
  const waits: unknown[] = [];
  const result = await f.adapter.listConversations(false, async (wait, attempt) => {
    waits.push([wait, attempt]);
    f.state.infoError = undefined;
  });
  assert.equal(result.conversations.length, 1);
  assert.deepEqual(waits, [[{ method: 'conversations.info', seconds: 2, why: 'limited', attempts: 5 }, 1]]);
});


test('a foreground scan that runs out of call time for its next paced candidate returns its admitted rows', async (t) => {
  virtualClock(t);
  const { withCallTime } = await import('../src/slack-adapter.js');
  const { clock } = await import('../src/clock.js');
  const f = accessFixture();
  const ids = Array.from({ length: 30 }, (_, i) => `C${i + 10}`);
  f.state.listed = ids.map(id => joined(id));
  let infos = 0;
  f.web.conversations.info = async (args: any) => { infos++; return { channel: joined(args.channel) }; };
  const listed = await withCallTime(clock.now(), () => f.adapter.listConversations());
  // Slots are released 1.2 s apart; a 10-second request must start by 15 s
  // into the 25-second call, so 13 candidates (0 … 14.4 s) fit.
  assert.deepEqual(listed.conversations.map(c => c.id), ids.slice(0, 13));
  assert.deepEqual(listed.admissionStop, { reason: 'call_deadline' });
  assert.equal(listed.admissionFailures, 1);
  assert.equal(infos, 13, 'no request was sent past the deadline');
  assert.equal((f.adapter as any).eventAdmissionQueue.length, 0, 'the late slot left the queue');
});
test('inbound rate limit retries in order, and exhausted retries log the dropped message', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const { slept } = virtualClock(t);
  const f = accessFixture();
  const event = { type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' };
  const delivered: string[] = [];
  f.adapter.onMessage(m => delivered.push(m.id));
  const error = Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 2 });
  let attempts = 0;
  f.web.conversations.info = async () => {
    if (++attempts === 1) throw error;
    return { channel: joined() };
  };
  await Promise.all([f.emit(event), f.emit({ ...event, ts: '2.0' })]);
  assert.deepEqual(delivered, ['1.0', '2.0']);
  assert.deepEqual(slept, [2125]);
  f.web.conversations.info = async () => { throw error; };
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  assert.equal(await f.emit({ ...event, ts: '3.0' }), true);
  assert.deepEqual(slept, [2125, 1200, 2125, 2125]);
  await f.adapter.stop();
  assert.equal(logs.length, 1);
  assert.match(String(logs[0][0]), /message dropped: 1/);
  assert.equal(delivered.length, 2);
});

test('cheap write veto avoids calls while DM listing uses fresh peer metadata', async () => {
  const f = accessFixture({ ack: 'eyes' });
  await assert.rejects(f.adapter.sendMessage('C2', 'hi'), SlackAccessDenied);
  await f.adapter.acknowledge('C2', '1.0');
  assert.deepEqual(f.calls, []);
  f.state.listed = [{ id: 'D2', is_im: true, user: 'U1' }];
  f.state.conversation = { id: 'D2', is_im: true, user: 'UOTHER' };
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
  assert.deepEqual(f.methods(), ['list', 'info']);
  await f.adapter.stop();
});

test('policy refusals preserve operation lead and permanent refusal advice', async () => {
  const f = accessFixture();
  await assert.rejects(f.adapter.sendMessage('C2', 'hi'), /^SlackAccessDenied: Nothing was posted:.*Retrying unchanged/);
  await assert.rejects(f.adapter.sendDM('UOTHER', 'hi'), /^SlackAccessDenied: Nothing was sent:.*Retrying unchanged/);
  f.state.conversation = { ...joined(), is_member: false };
  await assert.rejects(f.adapter.readHistory('C1', {}), /^SlackAccessUnverified: No messages were returned:.*Retrying unchanged/);
});

test('policy listing refreshes scopes via auth.test before listing', async () => {
  const f = accessFixture({ scopes: [] });
  f.web.auth.test = async () => ({ response_metadata: { scopes: ['channels:read'] } });
  f.state.listed = [joined()];
  assert.equal((await f.adapter.listConversations()).conversations.length, 1);
  assert.deepEqual(f.methods(), ['list', 'info']);
});

test('fresh DM peer metadata must also pass the legacy list after a cheap listing check', async () => {
  const f = accessFixture({ dmUsers: ['U1'] });
  f.state.listed = [{ id: 'D1', is_im: true, user: 'U1' }];
  f.state.conversation = { id: 'D1', is_im: true, user: 'W1' };
  assert.equal((await f.adapter.listConversations()).conversations.length, 0);
  assert.deepEqual(f.methods(), ['list', 'info']);
  await assert.rejects(f.adapter.sendDM('U1', 'hi'), /not an admitted direct message/);
  assert.ok(!f.methods().includes('post'));
});

test('R2-1 concurrent admission shares one pending retry schedule', async t => {
  virtualClock(t);
  const f = accessFixture();
  let calls = 0;
  f.web.conversations.info = async () => {
    calls++;
    throw Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 2 });
  };
  t.mock.method(console, 'error', () => {});
  await Promise.all(Array.from({ length: 10 }, (_, i) => f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: `${i}.0` })));
  assert.equal(calls, 3);
});

test('R2-2 vanished listing candidate is skipped, not token-wide failures', async t => {
  t.mock.method(console, 'error', () => {});
  const f = accessFixture();
  f.state.listed = [joined()];
  f.state.infoError = Object.assign(new Error('gone'), { code: ErrorCode.PlatformError, data: { error: 'channel_not_found' } });
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
  f.state.infoError = Object.assign(new Error('token'), { code: ErrorCode.PlatformError, data: { error: 'invalid_auth' } });
  await assert.rejects(f.adapter.listConversations(), e => e instanceof Error && e.cause === f.state.infoError);
});

test('R2-3 disabled DM hints and reads refuse without metadata; R2-4 hides peer', async () => {
  const f = accessFixture({ disableDms: true });
  assert.equal(f.adapter.canWrite('D1'), false);
  await assert.rejects(f.adapter.readHistory('D1', {}), SlackAccessDenied);
  assert.deepEqual(f.methods(), []);
  const g = accessFixture();
  g.state.conversation = { id: 'D1', is_im: true, user: 'USECRET' };
  await assert.rejects(g.adapter.readHistory('D1', {}), e => e instanceof SlackAccessDenied && !e.message.includes('USECRET'));
});

test('joined-channel-disabled policy vetoes metadata before spending Slack quota', async () => {
  const f = accessFixture({ config: { readJoinedChannels: false, writeChannels: [], dmUsers: ['U1'] }, ack: 'eyes' });
  await assert.rejects(f.adapter.readHistory('C1', {}), /excluded/);
  await assert.rejects(f.adapter.sendMessage('C1', 'hi'), /not allowed/);
  await f.adapter.acknowledge('C1', '1.0');
  assert.deepEqual(f.calls, []);
});

test('admitted event channel type comes from verified metadata', async () => {
  const f = accessFixture();
  f.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  let channelType: string | undefined;
  f.adapter.onMessage(msg => { channelType = msg.channelType; });
  await f.emit({ type: 'message', channel: 'D1', channel_type: 'channel', user: 'U1', ts: '1.0' });
  assert.equal(channelType, 'im');
});

test('stop retires a policy event held in name resolution', async () => {
  const f = accessFixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.web.users.info = async () => { entered(); await held; return { user: { name: 'human' } }; };
  let delivered = false;
  f.adapter.onMessage(() => { delivered = true; });
  const emission = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0' });
  await started;
  await f.adapter.stop();
  release();
  await emission;
  assert.equal(delivered, false);
});

test('policy scope observations replace withdrawn grants instead of growing forever', async () => {
  const f = accessFixture();
  f.web.conversations.list = async () => ({ channels: [], response_metadata: { scopes: accessScopes.filter(s => s !== 'chat:write') } });
  await f.adapter.listConversations();
  f.calls.length = 0;
  await assert.rejects(f.adapter.sendMessage('C1', 'no'), /chat:write/);
  assert.deepEqual(f.methods(), ['info']);
});


test('info response can withdraw a write grant after a complete listing snapshot', async () => {
  const f = accessFixture();
  f.web.conversations.list = async () => ({ channels: [], response_metadata: { scopes: accessScopes } });
  await f.adapter.listConversations();
  f.state.infoScopes = accessScopes.filter(scope => scope !== 'chat:write');
  f.calls.length = 0;
  await assert.rejects(f.adapter.sendMessage('C1', 'no'), /chat:write/);
  assert.deepEqual(f.methods(), ['info']);
});

test('invalid policy write IDs name the input and outcome without Slack calls', async () => {
  const f = accessFixture();
  await assert.rejects(f.adapter.sendMessage('bad', 'hi'), err => { assert.ok(err instanceof SlackAccessInputError); assert.match(err.message, /Nothing was posted: Invalid Slack conversation ID/); return true; });
  await assert.rejects(f.adapter.sendDM('bad', 'hi'), /Nothing was sent: Invalid Slack user ID 'bad'/);
  assert.deepEqual(f.calls, []);
});

test('ACK removal retires lasting pre-effect admission refusals', async () => {
  for (const code of ['missing_scope', 'not_in_channel']) {
    const f = accessFixture({ ack: 'eyes' });
    await f.adapter.acknowledge('C1', '1.0');
    f.state.infoError = Object.assign(new Error(code), { code: 'slack_webapi_platform_error', data: { error: code } });
    await f.adapter.clearAck('C1');
    await f.adapter.clearAck('C1');
    await f.adapter.stop();
    assert.deepEqual(f.methods(), ['info', 'react', 'info']);
  }
});

test('policy ambient eligibility waits for the earlier delivery commit without admission quota', async () => {
  const f = accessFixture();
  let subscribed = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  const delivered: string[] = [];
  f.adapter.setAmbientMessageFilter(() => subscribed);
  f.adapter.onMessage(async msg => {
    delivered.push(msg.id);
    if (msg.id === '1.0') { entered(); await held; subscribed = true; }
  });
  const first = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: '<@UBOT> hello' });
  await started;
  const second = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '2.0', text: 'ambient' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.methods().filter(m => m === 'info').length, 1, 'queued ambient spends no admission quota');
  release(); await Promise.all([first, second]);
  assert.deepEqual(delivered, ['1.0', '2.0']);
  subscribed = false;
  f.calls.length = 0;
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '3.0', text: 'ambient' });
  assert.deepEqual(f.calls, []);
  await f.adapter.stop();
});

test('ACK held in admission cannot add a reaction after stop', async () => {
  const f = accessFixture({ ack: 'eyes' });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  f.web.conversations.info = async () => { entered(); await held; return { channel: joined() }; };
  const ack = f.adapter.acknowledge('C1', '1.0');
  await started;
  const stopped = f.adapter.stop();
  release(); await Promise.all([ack, stopped]);
  assert.equal(f.methods().includes('react'), false);
});


const platformFailure = (error: string) => () =>
  Object.assign(new Error(error), { code: ErrorCode.PlatformError, data: { ok: false, error } });
for (const [cause, failure] of [
  ['HTTP 503', () => Object.assign(new Error('HTTP 503'), { code: ErrorCode.HTTPError, statusCode: 503 })],
  ...['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'].map((code) => [code, platformFailure(code)] as const),
] as const) test(`a transient post-transfer admission failure (${cause}) asks for residue removal, not an immediate retry`, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  const f = accessFixture();
  f.state.uploadUrl = 'https://files.slack.com/transient-policy-upload';
  const { explainSlackError } = await import('../src/slack-errors.js');
  let admissions = 0;
  f.web.conversations.info = async () => {
    if (++admissions === 1) return { channel: joined() };
    throw failure();
  };
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('bytes') }), (asyncError: unknown) => {
    const text = explainSlackError(asyncError, { tool: 'upload_file', args: { channelId: 'C1' } });
    assert.match(text, /File "F1" may remain but was not shared/);
    assert.match(text, /inspect and remove that file by ID/);
    assert.doesNotMatch(text, /Try again shortly/);
    return true;
  });
  assert.equal(admissions, 2);
  assert.equal(f.methods().includes('complete'), false);
});

test('a post-transfer admission out of call time asks for residue removal, not a safe retry', async (t) => {
  virtualClock(t);
  let transferred = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { transferred = Buffer.from(init!.body as Buffer).toString(); return new Response('OK'); });
  const f = accessFixture();
  f.state.uploadUrl = 'https://files.slack.com/deadline-policy-upload';
  const { explainSlackError } = await import('../src/slack-errors.js');
  // The real client refuses before sending, so this address is never reached.
  const client = new SlackWebClient(undefined, { ...SLACK_CLIENT_OPTIONS, slackApiUrl: 'http://127.0.0.1:1/' });
  let admissions = 0;
  f.web.conversations.info = async (args: { channel: string }) => {
    if (++admissions === 1) return { channel: joined() };
    elapse(CALL_SECONDS * 1000);
    return client.conversations.info(args);
  };
  await assert.rejects(withCallTime(clock.now(), () => f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('bytes') })), (err: unknown) => {
    const text = explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } });
    assert.match(text, /File "F1" may remain but was not shared/);
    assert.match(text, /too few were left to send this request to Slack\. It wasn't sent\./);
    assert.match(text, /inspect and remove that file by ID/);
    assert.doesNotMatch(text, /calling again is safe/);
    return true;
  });
  assert.equal(admissions, 2);
  assert.equal(transferred, 'bytes');
  assert.equal(f.methods().includes('complete'), false);
  await f.adapter.stop();
});

test('upload revocation after bytes prevents sharing', async (t) => {
  let transferred = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { transferred = Buffer.from(init!.body as Buffer).toString(); return new Response('OK'); });
  const f = accessFixture();
  f.state.uploadUrl = 'https://files.slack.com/revoked-policy-upload';
  const { explainSlackError } = await import('../src/slack-errors.js');
  let admissions = 0;
  f.web.conversations.info = async () => {
    admissions++;
    return { channel: { ...joined(), is_member: admissions === 1 } };
  };
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('revoked bytes') }), asyncError => {
    assert.ok(asyncError instanceof SlackAccessDenied);
    const text = explainSlackError(asyncError, { tool: 'upload_file', args: { channelId: 'C1' } });
    assert.match(text, /not in conversation 'C1'/, 'the real admission failure is kept');
    assert.match(text, /File "F1" may remain but was not shared/);
    return true;
  });
  assert.equal(admissions, 2);
  assert.equal(transferred, 'revoked bytes');
  assert.equal(f.methods().includes('complete'), false);
  f.web.conversations.info = async () => {
    if (++admissions === 4) throw Object.assign(new Error('http'), { code: ErrorCode.HTTPError, statusCode: 503 });
    return { channel: joined() };
  };
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('again') }), err => {
    const text = explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } });
    assert.match(text, /File "F1" may remain but was not shared/);
    assert.match(text, /503/, 'the transient cause is not replaced by cleanup advice');
    return true;
  });
  f.web.conversations.info = async () => {
    if (++admissions === 6) throw Object.assign(new Error('access_denied'), {
      code: ErrorCode.PlatformError, data: { ok: false, error: 'access_denied' },
    });
    return { channel: joined() };
  };
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('unknown refusal') }), err => {
    assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }), /File "F1" may remain but was not shared/);
    return true;
  });
  assert.equal(f.methods().includes('complete'), false);

});

test('ambient admissions overlap behind an earlier addressed delivery', async (t) => {
  const f = accessFixture();
  f.adapter.setAmbientMessageFilter(() => true);
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const delivered: string[] = [];
  f.adapter.onMessage(async msg => {
    delivered.push(msg.id);
    if (msg.id === '1.0') { entered(); await held; }
  });
  const first = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: '<@UBOT> hi' });
  await started;
  const events = ['2.0', '3.0'].map(ts => f.emit({ type: 'message', channel: 'C1', user: 'U1', ts, text: 'ambient' }));
  release();
  await Promise.all([first, ...events]);
  // Both preparations share one in-flight admission, rather than serial calls.
  assert.equal(f.methods().filter(m => m === 'info').length, 2);
  assert.deepEqual(delivered, ['1.0', '2.0', '3.0']);
});


test('retryable ACK admission is retired after the initial failure and four timer retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = accessFixture({ ack: 'eyes' });
  await f.adapter.acknowledge('C1', '1.0');
  f.state.infoError = Object.assign(new Error('temporary'), { code: ErrorCode.HTTPError, statusCode: 503 });
  await f.adapter.clearAck('C1');
  for (let attempt = 1; attempt < 5; attempt++) {
    t.mock.timers.tick(60_000);
    await (f.adapter as any).ackPending.get('C1')?.get('1.0')?.removing;
  }
  assert.equal(f.methods().filter(m => m === 'info').length, 6);
  t.mock.timers.tick(600_000);
  await (f.adapter as any).ackPending.get('C1')?.get('1.0')?.removing;
  await f.adapter.clearAck('C1');
  assert.equal(f.methods().filter(m => m === 'info').length, 6);
  await f.adapter.stop();
});


test('failed info response_metadata.scopes withdraws write grants', async () => {
  const f = accessFixture();
  f.state.infoError = Object.assign(new Error('gone'), { code: 'slack_webapi_platform_error',
    data: { error: 'channel_not_found', response_metadata: { scopes: accessScopes.filter(scope => scope !== 'chat:write'), acceptedScopes: ['channels:read'] } } });
  await assert.rejects(f.adapter.sendMessage('C1', 'first'), /gone/);
  f.state.infoError = undefined;
  await assert.rejects(f.adapter.sendMessage('C1', 'second'), /chat:write/);
  assert.deepEqual(f.methods(), ['info', 'info']);
  await f.adapter.stop();
});


test('listing vetoes excluded listed DM peers before metadata, but verifies allowed hints', async () => {
  for (const dmUsers of [undefined, ['U1']]) {
    const f = accessFixture({ dmUsers });
    f.state.listed = [{ id: 'D2', is_im: true, user: 'UOTHER' }];
    assert.deepEqual((await f.adapter.listConversations()).conversations, []);
    assert.deepEqual(f.methods(), ['list']);
  }
  const f = accessFixture({ dmUsers: ['W1'] });
  f.state.listed = [{ id: 'D2', is_im: true, user: 'U1' }];
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
  assert.deepEqual(f.methods(), ['list']);
  const g = accessFixture();
  g.state.listed = [{ id: 'D2', is_im: true, user: 'U1' }];
  g.state.conversation = { id: 'D2', is_im: true, user: 'UOTHER' };
  assert.deepEqual((await g.adapter.listConversations()).conversations, []);
  assert.deepEqual(g.methods(), ['list', 'info']);
});

test('second upload admission explains the existing unshared file', async (t) => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  for (const code of ['not_in_channel', 'http']) {
    const f = accessFixture();
    f.state.uploadUrl = `https://files.slack.com/phase-${code}`;
    let count = 0;
    f.web.conversations.info = async () => {
      if (++count === 2) throw code === 'http'
        ? Object.assign(new Error('http'), { code: ErrorCode.HTTPError, statusCode: 503 })
        : Object.assign(new Error(code), { code: ErrorCode.PlatformError, data: { error: code } });
      return { channel: joined() };
    };
    await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from(code) }), err => {
      const explanation = explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } });
      assert.match(explanation ?? '', /(?:Nothing was shared; unshared file F1 may remain|File \"F1\" may remain but was not shared)/);
      assert.doesNotMatch(explanation ?? '', /Nothing was uploaded/);
      return true;
    });
    assert.equal(count, 2);
    assert.equal(f.methods().includes('complete'), false);
  }
});


test('sequential inbound admission attempts are paced without caching evidence', async t => {
  const { virtualClock } = await import('./virtualClock.js');
  const time = virtualClock(t);
  const f = accessFixture();
  for (const ts of ['1.0', '2.0', '3.0']) {
    await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts, text: '<@UBOT> hello' });
  }
  assert.equal(f.methods().filter(m => m === 'info').length, 3, 'every settled event rechecks');
  assert.deepEqual(time.slept, [1200, 1200]);
  f.state.infoError = new Error('fast refusal');
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '4.0', text: '<@UBOT> hello' });
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '5.0', text: '<@UBOT> hello' });
  assert.deepEqual(time.slept, [1200, 1200, 1200, 1200]);
  assert.equal(f.methods().filter(m => m === 'info').length, 5);
  await f.adapter.stop();
});

test('malformed legacy send targets cannot enable policy DM opening', async () => {
  for (const id of ['D', 'D…', 'Dnot-an-id', 'd1', 'D1 ', 'D1\n']) {
    const f = accessFixture({ sendChannels: [id] });
    assert.equal(f.adapter.dmsWritable, false);
    await assert.rejects(f.adapter.sendDM('U1', 'hello'), SlackAccessDenied);
    assert.deepEqual(f.methods(), []);
  }
});

test('listing vetoes a disallowed listed IM peer before metadata', async () => {
  for (const legacy of [false, true]) {
    const f = accessFixture(legacy ? { dmUsers: ['U2'] } : {});
    f.state.listed = [{ id: 'D1', is_im: true, user: 'UOTHER' }];
    assert.deepEqual((await f.adapter.listConversations()).conversations, []);
    assert.deepEqual(f.methods(), ['list']);
  }
  const f = accessFixture();
  f.state.listed = [{ id: 'D1', is_im: true, user: 'U1' }];
  f.state.conversation = { id: 'D1', is_im: true, user: 'UOTHER' };
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
  assert.deepEqual(f.methods(), ['list', 'info'], 'listed permission never grants admission');
});


test('legacy DM peer listing veto is independent of policy peers and disabled DM mode', async () => {
  const f = accessFixture({ dmUsers: ['U1'], config: { readJoinedChannels: true, writeChannels: ['C1'], dmUsers: ['U1', 'U2'] } });
  assert.equal(f.adapter.dmsWritable, true);
  f.state.listed = [{ id: 'D2', is_im: true, user: 'U2' }];
  f.state.conversation = { id: 'D2', is_im: true, user: 'U2' };
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
  assert.deepEqual(f.methods(), ['list'], 'legacy peer veto avoids info despite policy permission');
  await f.adapter.stop();
});

test('delivery recheck requires history grants even when metadata stays readable', async () => {
  const f = accessFixture();
  await f.adapter.getConversationMeta('C1');
  f.state.infoScopes = ['channels:read'];
  await assert.rejects(f.adapter.getConversationMeta('C1', true), /channels:history/);
  assert.deepEqual(f.methods(), ['info', 'info']);
});

test('background listing skips an exhausted candidate and counts the incomplete result', async () => {
  const f = accessFixture();
  f.state.listed = [joined('C1'), joined('C2'), joined('C3')];
  f.web.conversations.info = async ({ channel }) => {
    if (channel === 'C2') throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 0 });
    return { channel: joined(channel) };
  };
  const listing = await f.adapter.listConversations(false, async () => { throw new Error('retry budget exhausted'); });
  assert.deepEqual(listing.conversations.map(c => c.id), ['C1', 'C3']);
  assert.equal(listing.admissionFailures, 1);
});

test('superseded successful background scan stops before its next candidate', async () => {
  const f = accessFixture();
  f.state.listed = [joined('C1'), joined('C2')];
  let current = true, calls = 0;
  f.web.conversations.info = async ({ channel }) => { calls++; current = false; return { channel: joined(channel) }; };
  await assert.rejects(f.adapter.listConversations(false, async () => {}, () => current), /superseded/);
  assert.equal(calls, 1);
});

for (const failure of ['platform', 'network', 'policy']) test(`post-open DM ${failure} admission reports opening once and preserves provenance`, async () => {
  const f = accessFixture();
  f.state.conversation = { id: 'D1', is_im: true, user: 'UOTHER' };
  if (failure !== 'policy') f.state.infoError = Object.assign(new Error('failed'), failure === 'platform'
    ? { code: ErrorCode.PlatformError, data: { error: 'channel_not_found' } }
    : { code: ErrorCode.RequestError });
  await assert.rejects(f.adapter.sendDM('U1', 'hi'), err => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /DM D1 was opened, but nothing was posted/);
    assert.equal((err.message.match(/Retrying unchanged/g) ?? []).length, failure === 'policy' ? 1 : 0);
    assert.equal(failedAccessAdmission(err), true);
    if (failure !== 'policy') assert.equal((err as any).code, (f.state.infoError as any).code);
    return true;
  });
  assert.deepEqual(f.methods(), ['open', 'info']);
});

for (const result of ['success', 'failure']) test(`background stop ends held candidate ${result} without skip or extra page`, async t => {
  const f = accessFixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  let pages = 0, waits = 0;
  f.web.conversations.list = async () => { pages++; return { channels: [joined()], response_metadata: { next_cursor: 'next' } }; };
  f.web.conversations.info = async () => { entered(); await held; if (result === 'failure') throw new Error('shutdown'); return { channel: joined() }; };
  const logs: string[] = []; t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
  const listing = f.adapter.listConversations(false, async () => { waits++; });
  const rejected = assert.rejects(listing, /stopped/);
  await started; await f.adapter.stop(); release(); await rejected;
  assert.equal(pages, 1); assert.equal(waits, 0); assert.ok(!logs.some(line => line.includes('candidate C1 skipped')));
});

test('background malformed candidates skip and count; foreground unverified metadata fails visibly', async () => {
  const f = accessFixture(); f.state.listed = [{ id: 'invalid' }];
  const listing = await f.adapter.listConversations(false, async () => {});
  assert.equal(listing.admissionFailures, 1);
  f.state.listed = [joined()]; f.state.conversation = undefined;
  await assert.rejects(f.adapter.listConversations(), (err: unknown) => err instanceof SlackAccessDenied && !err.authoritative);
});

test('acceptedScopes-only error metadata never replaces granted scope evidence', async () => {
  const f = accessFixture();
  f.state.infoError = Object.assign(new Error('gone'), { code: ErrorCode.PlatformError,
    data: { error: 'channel_not_found', response_metadata: { acceptedScopes: ['channels:read'] } } });
  await assert.rejects(f.adapter.sendMessage('C1', 'first'));
  f.state.infoError = undefined;
  await f.adapter.sendMessage('C1', 'second');
  assert.ok(f.methods().includes('post'));
});

test('policy contexts retain structural Slack error codes and error identity', async () => {
  const { withAccessContext } = await import('../src/access-policy.js');
  const original = { code: ErrorCode.PlatformError, data: { error: 'missing_scope' } };
  await assert.rejects(withAccessContext('Nothing was posted', async () => { throw original; }), err => {
    assert.equal(err, original);
    assert.equal((err as any).code, ErrorCode.PlatformError);
    assert.equal((err as any).data.error, 'missing_scope');

    return true;
  });
});

for (const outcome of ['timeout', 'frozen timeout', 'no timestamp'] as const) test(`policy DM ${outcome} preserves post occurrence and opened destination`, async t => {
  const { postLeftBy } = await import('../src/slack-adapter.js');
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.state.conversation = { id: 'D1', is_im: true, is_mpim: false, user: 'U1' };
  const original = Object.assign(new Error('post timeout'), { code: ErrorCode.RequestError });
  if (outcome === 'frozen timeout') Object.freeze(original);
  f.web.chat.postMessage = async () => { if (outcome !== 'no timestamp') throw original; return {}; };
  const { explainSlackError } = await import('../src/slack-errors.js');
  await assert.rejects(f.adapter.sendDM('U1', 'hi'), err => {
    if (outcome !== 'no timestamp') {
      assert.notEqual(err, original);
      assert.equal((err as Error).cause, original);
      assert.equal(original.message, 'post timeout');
    }
    const text = explainSlackError(err, { tool: 'send_dm', args: { userId: 'U1' } });
    assert.match(text, /^DM D1 was opened:/);
    assert.doesNotMatch(text, /Nothing was sent/);
    assert.deepEqual(postLeftBy(err), { channelId: 'D1', policy: true, historyReadable: true });
    return true;
  });
});

for (const phase of ['admission', 'names'] as const) {
  test(`an event stopped during ${phase} is logged with its thread root`, async (t) => {
    const f = accessFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const method = phase === 'admission' ? f.web.conversations.info : f.web.users!.info;
    const original = method.bind(null);
    const target = phase === 'admission' ? f.web.conversations : f.web.users!;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    (target as { info: unknown }).info = async (args: unknown) => { entered(); await held; return original(args as never); };
    const delivered: unknown[] = [];
    f.adapter.onMessage((msg) => { delivered.push(msg); });
    const emitted = f.emit({ type: 'message', subtype: 'thread_broadcast', channel: 'C1', user: 'U1', ts: '2.0',
      root: { thread_ts: '1.0' }, text: '<@UBOT> hi' });
    await reached;
    await f.adapter.stop();
    release();
    await emitted;
    const logged = (console.error as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls
      .map((call) => String(call.arguments[0])).filter((line) => line.includes('Dropped message'));
    assert.deepEqual(logged, ['[slack-mcpl] Dropped message 2.0 in C1 (thread 1.0): at shutdown. '
      + 'Slack will not replay it; after restart, recover it with fetch_thread for thread 1.0.'], 'named once');
    assert.deepEqual(delivered, []);
  });
}

// A lookup that stop() cuts short by its rejection, or a retry sleep stop()
// outlasts, still names the thread to recover, not an admission failure.
for (const ending of ['rejected lookup', 'retry sleep'] as const) {
  test(`an event whose ${ending} outlasts stop is logged with its thread root`, async (t) => {
    const f = accessFixture();
    const limited = () => Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 1 });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    if (ending === 'rejected lookup') {
      f.web.conversations.info = async () => { entered(); await held; throw limited(); };
    } else {
      f.state.infoError = limited();
      t.mock.method(clock, 'sleep', async () => { entered(); await held; });
    }
    const delivered: unknown[] = [];
    f.adapter.onMessage((msg) => { delivered.push(msg); });
    const emitted = f.emit({ type: 'message', subtype: 'thread_broadcast', channel: 'C1', user: 'U1', ts: '2.0',
      root: { thread_ts: '1.0' }, text: '<@UBOT> hi' });
    await reached;
    await f.adapter.stop();
    release();
    await emitted;
    const logged = (console.error as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls
      .map((call) => String(call.arguments[0])).filter((line) => /dropped message/i.test(line));
    assert.equal(logged.length, 1, logged.join('\n'));
    assert.match(logged[0]!, /Dropped message 2\.0 in C1 \(thread 1\.0\).* at shutdown.*recover it with fetch_thread for thread 1\.0\./);
    assert.doesNotMatch(logged[0]!, /admission failed/);
    assert.deepEqual(delivered, []);
  });
}

test('policy summaries keep local failure text and do not blame Slack for unclassified errors', async () => {
  const f = accessFixture();
  (f.adapter as unknown as { scopes: unknown }).scopes = undefined;
  const err = await f.adapter.readHistory('C1', {}).then(() => undefined, (e: unknown) => e);
  assert.match(String((err as Error).message), /scope metadata is unavailable; list_channels can refresh it/);
  assert.equal(policyFailureSummary(err), (err as Error).message);
  assert.equal(policyFailureSummary(new GaveUp('Slack rate-limited or failed the same request 10 times in a row')),
    'Slack rate-limited or failed the same request 10 times in a row');
  assert.equal(policyFailureSummary(new Error('host handler rejected')), 'unclassified failure (details withheld); outcome may be unknown');
});

test('a throwing cause accessor ends cause traversal instead of escaping', async () => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  const { failedRequest } = await import('../src/slack-adapter.js');
  const err = new Error('connection closed');
  Object.defineProperty(err, 'cause', { get() { throw new Error('hostile getter'); } });
  assert.equal(failedRequest(err), undefined);
  assert.equal(failedAccessAdmission(err), false);
  assert.match(explainSlackError(err, { tool: 'send_message', args: { channelId: 'C1' } }), /connection closed/);
});

test('a malformed listed DM peer is not a hint: fresh metadata admits the DM', async () => {
  const f = accessFixture();
  f.state.listed = [{ id: 'D1', is_im: true, user: '' }];
  f.state.conversation = { id: 'D1', is_im: true, is_mpim: false, user: 'U1' };
  const listed = await f.adapter.listConversations();
  assert.deepEqual(listed.conversations.map((c) => c.id), ['D1']);
  assert.ok(f.methods().includes('info'), 'fresh metadata was asked for');
});

test('without a policy, a callable client namespace keeps its methods', async () => {
  const f = accessFixture({ legacy: true });
  const list = f.web.users!.list;
  (f.web as { users: unknown }).users = Object.assign(() => undefined, { list, info: f.web.users!.info });
  assert.deepEqual(await f.adapter.findUsers('human'), []);
  assert.ok(f.methods().includes('users'), 'users.list was called through the callable namespace');
});

test('an admission failure is counted in a summary that says it names no message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = accessFixture();
  f.state.infoError = Object.assign(new Error('not_in_channel'), { code: ErrorCode.PlatformError, data: { ok: false, error: 'not_in_channel' } });
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '2.0', thread_ts: '1.0', text: '<@UBOT> hi' });
  t.mock.timers.tick(60_000);
  const logged = (console.error as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls
    .map((call) => String(call.arguments[0])).filter((line) => line.includes('Access admission'));
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0]!, /verification failed \(event, not_in_channel\): 1; .*this summary names no conversation, message or thread/);
  assert.doesNotMatch(logged[0]!, /original thread root|2\.0|C1/);
  await f.adapter.stop();
});

test('a transient file-cleanup admission failure states its outcome once', async () => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  const f = accessFixture();
  f.state.infoError = Object.assign(new Error('HTTP 503'), { code: ErrorCode.HTTPError, statusCode: 503 });
  const err = await f.adapter.deleteFile('C1', 'F1').then(() => undefined, (e: unknown) => e);
  assert.ok(err);
  const text = explainSlackError(err, { tool: 'delete_file', args: { channelId: 'C1', fileId: 'F1' } });
  assert.equal(text.match(/Nothing was (?:deleted|done)/g)?.length, 1, text);
});

test('background registration names a malformed candidate as a local check, not a Slack failure', async () => {
  const f = accessFixture();
  f.state.listed = [{ id: 'bad' } as never, joined('C1')];
  const listing = await f.adapter.listConversations(false, async () => {});
  assert.deepEqual(listing.conversations.map(c => c.id), ['C1']);
  const logged = (console.error as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls
    .map(call => String(call.arguments[0])).filter(line => line.includes('Registration candidate'));
  assert.deepEqual(logged, ['[slack-mcpl] Registration candidate unknown skipped: admission failed; count is incomplete: '
    + 'No conversations were returned: malformed Slack listing candidate; retry once, then ask whoever runs this host to investigate']);
});

for (const field of ['userId', 'fileId'] as const) test(`caller-controlled ${field} text cannot select channelId advice`, async t => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  const f = accessFixture(); t.after(() => f.adapter.stop());
  const invalid = 'Invalid Slack conversation ID embedded-in-value';
  const pending = field === 'userId' ? f.adapter.sendDM(invalid, 'hi') : f.adapter.resolveFileDownload('C1', invalid);
  await assert.rejects(pending, err => {
    const text = explainSlackError(err, { tool: field === 'userId' ? 'send_dm' : 'fetch_attachment', args: { [field]: invalid } });
    assert.doesNotMatch(text, /Correct channelId/);
    return true;
  });
  assert.deepEqual(f.methods(), []);
});
