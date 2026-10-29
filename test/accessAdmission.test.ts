import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { connectSlack, OutOfCallTime, SlackAdapter, withCallTime, CALL_SECONDS } from '../src/slack-adapter.js';
import { SlackAccessPolicy } from '../src/access-policy.js';
import { fakeSlackApi } from './slackApi.js';
import { accessTest as test, accessFixture, accessScopes, joined } from './adapterAccessFixture.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize, FULL_GRANT } from './harness.js';
import { method } from '@animalabs/mcpl-core';
import { virtualClock } from './virtualClock.js';

const config = { readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] };
const scopes = [...accessScopes, 'mpim:read', 'mpim:history', 'mpim:write'];
function groupFixture() {
  const f = accessFixture({ config, scopes });
  f.state.conversation = { id: 'G1', is_mpim: true };
  return f;
}

test('MPIM absent membership uses fresh paginated bot evidence, never a cached success', async () => {
  const f = groupFixture();
  let present = true;
  f.web.conversations.members = async (args) => {
    f.calls.push({ method: 'members', args });
    return args.cursor ? { members: present ? ['UBOT'] : [], response_metadata: { next_cursor: '' } }
      : { members: ['W1'], response_metadata: { next_cursor: 'page2' } };
  };
  await f.adapter.sendMessage('G1', 'hello');
  assert.deepEqual(f.methods(), ['info', 'members', 'members', 'post']);
  assert.deepEqual(f.calls[2].args, { channel: 'G1', limit: 200, cursor: 'page2' });
  present = false;
  await assert.rejects(f.adapter.sendMessage('G1', 'again'));
  assert.equal(f.methods().filter((m) => m === 'post').length, 1);
});
for (const metadata of [{ is_member: false }, { is_member: null }, { is_member: 'true' }, { id: 'G2' }, { is_im: true }, { is_mpim: false }]) {
  test(`MPIM conflicting metadata never consults membership: ${JSON.stringify(metadata)}`, async () => {
    const f = groupFixture();
    f.state.conversation = { ...f.state.conversation, ...metadata } as never;
    f.web.conversations.members = async () => { assert.fail('must not override info'); };
    await assert.rejects(f.adapter.sendMessage('G1', 'no'));
    assert.deepEqual(f.methods(), ['info']);
  });
}
for (const response of [{}, { members: null }, { members: ['UBOT', 1] }, { members: ['U1'], response_metadata: { next_cursor: 1 } },
  { members: ['U1'], response_metadata: { next_cursor: ' ' } }, { members: [] }]) {
  test(`malformed or absent MPIM proof refuses ${JSON.stringify(response)}`, async () => {
    const f = groupFixture();
    f.web.conversations.members = async () => response;
    await assert.rejects(f.adapter.readHistory('G1', {}));
    assert.ok(!f.methods().includes('history'));
  });
}
for (const cyclic of [false, true]) test(`members pagination is bounded, cyclic=${cyclic}`, async () => {
  const f = groupFixture(); let pages = 0;
  f.web.conversations.members = async () => {
    if (++pages > 6) throw new Error('test safety ceiling');
    return { members: ['U1'], response_metadata: { next_cursor: cyclic ? 'same' : String(pages) } };
  };
  await assert.rejects(f.adapter.sendMessage('G1', 'no'));
  assert.equal(pages, cyclic ? 2 : 5);
});
test('MPIM direct true membership needs no members request; no identity or scope cannot fall back', async () => {
  const f = groupFixture();
  f.state.conversation = { ...f.state.conversation, is_member: true };
  f.web.conversations.members = async () => { assert.fail('unneeded fallback'); };
  await f.adapter.sendMessage('G1', 'yes');
  f.state.conversation = { id: 'G1', is_mpim: true };
  const socket = { on() {}, async start() {}, async disconnect() {} };
  for (const [identity, grants] of [[null, scopes], ['UBOT', accessScopes]] as const) {
    const a = new SlackAdapter(f.web, socket, identity, 'test', undefined, undefined, false, undefined, [...grants], new SlackAccessPolicy(config));
    await assert.rejects(a.sendMessage('G1', 'no'));
  }
});
const rateLimit = () => Object.assign(new Error('private detail'), { code: ErrorCode.RateLimitedError, retryAfter: 60 });
test('listing skips 200 nonmembers, deduplicates candidates and checks fresh metadata', async () => {
  const f = accessFixture();
  f.state.listed = [...Array.from({ length: 200 }, (_, i) => ({ ...joined(`C${i}`), is_member: false })), joined('CONE'), joined('CTWO'), joined('CONE')];
  f.web.conversations.info = async ({ channel }) => { f.calls.push({ method: 'info', args: channel }); return { channel: joined(channel) }; };
  assert.deepEqual((await f.adapter.listConversations(true)).conversations.map((c) => c.id), ['CONE', 'CTWO']);
  assert.equal(f.methods().filter((m) => m === 'info').length, 2);
  f.web.conversations.info = async () => ({ channel: { ...joined(), is_member: false } });
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
});
for (const error of [rateLimit(), Object.assign(new Error('offline'), { code: ErrorCode.RequestError }), new OutOfCallTime('conversations.info', 25)]) {
  test(`transient listing admission never becomes complete empty listing: ${error.message}`, async () => {
    const f = accessFixture(); f.state.listed = [joined()]; f.state.infoError = error;
    await assert.rejects(f.adapter.listConversations(), (err) => err === error);
    let waits = 0;
    assert.equal((await f.adapter.listConversations(false, async () => { waits++; f.state.infoError = undefined; })).conversations.length, 1);
    assert.equal(waits, 1);
  });
}
test('stale candidate cannot end listing; event failures ack, drop and aggregate without private details', async (t) => {
  const f = accessFixture(); f.state.listed = [joined('CSTALE'), joined()];
  f.web.conversations.info = async ({ channel }) => { if (channel === 'CSTALE') throw new Error('private detail'); return { channel: joined(channel) }; };
  assert.deepEqual((await f.adapter.listConversations()).conversations.map((c) => c.id), ['C1']);
  const log = t.mock.method(console, 'error', () => {});
  const g = groupFixture(); g.web.conversations.members = async () => { throw rateLimit(); };
  const delivered: unknown[] = []; g.adapter.onMessage((event) => delivered.push(event));
  for (let i = 0; i < 10; i++) assert.equal(await g.emit({ type: 'message', channel: 'G1', user: 'U1', ts: '1.0', text: 'private text' }), true);
  assert.deepEqual(delivered, []);
  assert.equal(log.mock.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /private/);
});
test('members requests share the real client call deadline', async (t) => {
  virtualClock(t);
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('auth.test', { headers: { 'x-oauth-scopes': scopes.join(',') }, body: { ok: true, user_id: 'UBOT', team: 'test' } });
  api.answerFor('conversations.info', { body: { ok: true, channel: { id: 'G1', is_mpim: true } }, elapseMs: 16_000 });
  const adapter = await connectSlack({ botToken: 'xoxb-test', appToken: 'xapp-test', accessPolicy: config }, api.url);
  await assert.rejects(withCallTime(Date.now(), () => adapter.sendMessage('G1', 'no')), /out of this call/);
  assert.deepEqual(api.calls, ['auth.test', 'conversations.info']);
});
test('invalid embedded policy refuses before auth; unknown scope metadata refuses startup', async (t) => {
  const api = await fakeSlackApi(); t.after(() => api.close());
  await assert.rejects(connectSlack({ botToken: 'x', appToken: 'x', accessPolicy: {} as never }, api.url));
  assert.deepEqual(api.calls, []);
  await assert.rejects(connectSlack({ botToken: 'x', appToken: 'x', accessPolicy: config }, api.url), /scope metadata/);
  assert.deepEqual(api.calls, ['auth.test']);
});
test('DM file writes need peers, not pins; rollback needs files:read and ignores legacy controls', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  for (const filesRead of [true, false]) {
    const f = accessFixture({ config: { readJoinedChannels: false, writeChannels: [], dmUsers: ['W1'] },
      scopes: accessScopes.filter((s) => filesRead || s !== 'files:read'), disableDms: true, sendChannels: ['COTHER'] });
    f.state.conversation = { id: 'D1', is_im: true, user: 'W1' };
    f.web.files.info = async () => { f.calls.push({ method: 'fileInfo', args: {} }); return { file: { mode: 'hosted', id: 'F1', ims: ['D1'] } }; };
    f.state.uploadUrl = 'https://files.slack.com/upload';
    const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
    await initialize(h, true); await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    const upload = await h.host.sendRequest('tools/call', { name: 'upload_file', arguments: { channelId: 'D1', filename: 'x', content: 'x' } }) as { isError?: boolean; state: { parent: string } };
    assert.notEqual(upload.isError, true);
    await h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint: upload.state.parent });
    assert.equal(f.methods().includes('deleteFile'), filesRead);
    f.state.conversation = { id: 'D1', is_im: true, user: 'UOTHER' };
    await assert.rejects(f.adapter.uploadFile('D1', { filename: 'x', data: Buffer.from('x') }));
  }
});

test('persistent transient admission is bounded even when waitOut immediately resolves', async () => {
  const f = accessFixture(); f.state.listed = [joined()]; f.state.infoError = rateLimit();
  let waits = 0;
  await assert.rejects(f.adapter.listConversations(false, async () => { if (++waits > 6) throw new Error('test safety ceiling'); }), /private detail/);
  assert.equal(waits, 4);
  assert.equal(f.methods().filter((m) => m === 'info').length, 5);
});
