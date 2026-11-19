import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { connectSlack, OutOfCallTime, SlackAdapter, withCallTime, CALL_SECONDS } from '../src/slack-adapter.js';
import { SlackAccessPolicy, SlackAccessUnverified } from '../src/access-policy.js';
import { fakeSlackApi } from './slackApi.js';
import { accessTest as test, accessFixture, accessScopes, joined, ownAdapter } from './adapterAccessFixture.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize, FULL_GRANT } from './harness.js';
import { method } from '@animalabs/mcpl-core';
import { virtualClock } from './virtualClock.js';

const config = { readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] };
const scopes = [...accessScopes, 'mpim:read', 'mpim:history'];
// Policy adapters this file builds without accessFixture, each owned (and
// stopped) by the test that builds it; the last test checks them.
const directlyBuilt: SlackAdapter[] = [];
const direct = <T extends SlackAdapter>(adapter: T): T => { directlyBuilt.push(adapter); return ownAdapter(adapter); };
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
    let membersCalled = false;
    f.web.conversations.members = async () => { membersCalled = true; return {}; };
    await assert.rejects(f.adapter.sendMessage('G1', 'no'));
    assert.deepEqual(f.methods(), ['info']);
    assert.equal(membersCalled, false);
  });
}
for (const response of [{}, { members: null }, { members: ['UBOT', 1] }, { members: ['U1'], response_metadata: { next_cursor: 1 } },
  { members: ['U1'], response_metadata: { next_cursor: ' ' } }, { members: [] }]) {
  test(`malformed or absent MPIM proof refuses ${JSON.stringify(response)}`, async () => {
    const f = groupFixture();
    let calls = 0;
    f.web.conversations.members = async () => { calls++; return response; };
    await assert.rejects(f.adapter.readHistory('G1', {}));
    assert.equal(calls, 1);
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
  let membersCalled = false;
  f.web.conversations.members = async () => { membersCalled = true; return {}; };
  await f.adapter.sendMessage('G1', 'yes');
  f.state.conversation = { id: 'G1', is_mpim: true };
  const socket = { on() {}, async start() {}, async disconnect() {} };
  for (const [identity, grants] of [[null, scopes], ['UBOT', accessScopes]] as const) {
    const a = direct(new SlackAdapter(f.web, socket, identity, 'test', undefined, undefined, false, undefined, [...grants], new SlackAccessPolicy(config)));
    await assert.rejects(a.sendMessage('G1', 'no'));
    assert.equal(membersCalled, false);
  }
});
const rateLimit = () => Object.assign(new Error('private detail'), { code: ErrorCode.RateLimitedError, retryAfter: 60 });
test('listing skips 200 nonmembers, deduplicates candidates and checks fresh metadata', async () => {
  const f = accessFixture();
  f.state.listed = [...Array.from({ length: 200 }, (_, i) => ({ ...joined(`C${i}`), is_member: false })), joined('CONE'), joined('CTWO'), joined('CONE')];
  f.web.conversations.info = async ({ channel }) => { f.calls.push({ method: 'info', args: channel }); return { channel: joined(channel) }; };
  assert.deepEqual((await f.adapter.listConversations(true)).conversations.map((c) => c.id), ['CONE', 'CTWO']);
  assert.equal(f.methods().filter((m) => m === 'info').length, 2);
  f.web.conversations.info = async ({ channel }) => ({ channel: { ...joined(channel), is_member: false } });
  assert.deepEqual((await f.adapter.listConversations()).conversations, []);
});
for (const error of [rateLimit(), Object.assign(new Error('offline'), { code: ErrorCode.RequestError }), new OutOfCallTime('conversations.info', 25)]) {
  test(`transient listing admission never becomes complete empty listing: ${error.message}`, async t => {
    virtualClock(t);
    const f = accessFixture(); f.state.listed = [joined()]; f.state.infoError = error;
    // A rate limit or the call's deadline returns an explicitly incomplete
    // listing (here with no admitted rows), never a complete empty one.
    if ((error as { code?: string }).code === ErrorCode.RateLimitedError || error instanceof OutOfCallTime) {
      const partial = await f.adapter.listConversations();
      assert.deepEqual(partial.conversations, []); assert.equal(partial.admissionFailures, 1);
      assert.equal(partial.admissionStop?.reason, error instanceof OutOfCallTime ? 'call_deadline' : 'rate_limited');
    } else await assert.rejects(f.adapter.listConversations(), (err) => err instanceof Error && err.cause === error);
    let waits = 0;
    assert.equal((await f.adapter.listConversations(false, async () => { waits++; f.state.infoError = undefined; })).conversations.length, 1);
    assert.equal(waits, 1);
  });
}
test('unknown background candidate failures are skipped and counted; event failures ack, drop and aggregate without private details', async (t) => {
  virtualClock(t);
  const f = accessFixture(); f.state.listed = [joined('CSTALE'), joined()];
  f.web.conversations.info = async ({ channel }) => { if (channel === 'CSTALE') throw new Error('private detail'); return { channel: joined(channel) }; };
  const listing = await f.adapter.listConversations(false, async () => {});
  assert.deepEqual(listing.conversations.map(c => c.id), ['C1']);
  assert.equal(listing.admissionFailures, 1);
  const log = t.mock.method(console, 'error', () => {});
  const g = groupFixture(); g.web.conversations.members = async () => { throw rateLimit(); };
  const delivered: unknown[] = []; g.adapter.onMessage((event) => delivered.push(event));
  for (let i = 0; i < 10; i++) assert.equal(await g.emit({ type: 'message', channel: 'G1', user: 'U1', ts: '1.0', text: 'private text' }), true);
  assert.deepEqual(delivered, []);
  await g.adapter.stop();
  assert.equal(log.mock.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /private/);
});
test('members requests share the real client call deadline', async (t) => {
  virtualClock(t);
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('auth.test', { headers: { 'x-oauth-scopes': scopes.join(',') }, body: { ok: true, user_id: 'UBOT', team: 'test' } });
  api.answerFor('conversations.info', { body: { ok: true, channel: { id: 'G1', is_mpim: true } }, elapseMs: 16_000 });
  const adapter = direct(await connectSlack({ botToken: 'xoxb-test', appToken: 'xapp-test', accessPolicy: config }, api.url));
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
test('policy startup normalizes reported grants like every later report', async (t) => {
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('auth.test', { headers: { 'x-oauth-scopes': '   ' }, body: { ok: true, user_id: 'UBOT', team: 'test' } });
  await assert.rejects(connectSlack({ botToken: 'x', appToken: 'x', accessPolicy: config }, api.url), /scope metadata/);
  const { SlackAccessPolicy } = await import('../src/access-policy.js');
  const socket = { on() {}, async start() {}, async disconnect() {} };
  const adapter = direct(new SlackAdapter({} as never, socket, 'UBOT', 'test', undefined, undefined, false, undefined,
    [' channels:read ', 'channels:history', ''], new SlackAccessPolicy(config)));
  assert.deepEqual((adapter as any).scopes, ['channels:read', 'channels:history']);
});
test('DM file writes need peers, not pins; rollback needs files:read and obeys legacy controls', async (t) => {
  const bytes = t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  for (const filesRead of [true, false]) {
    const f = accessFixture({ config: { readJoinedChannels: false, writeChannels: [], dmUsers: ['W1'] },
      scopes: accessScopes.filter((s) => filesRead || s !== 'files:read'), disableDms: false, sendChannels: ['D1'] });
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
    f.calls.length = 0;
    const sentBytes = bytes.mock.callCount();
    await assert.rejects(f.adapter.uploadFile('D1', { filename: 'x', data: Buffer.from('x') }), /not an admitted direct message/);
    assert.deepEqual(f.methods(), ['info'], 'no upload ticket or completion after peer revocation');
    assert.equal(bytes.mock.callCount(), sentBytes, 'no byte transfer after peer revocation');
  }
});

test('persistent transient admission is bounded even when waitOut immediately resolves', async t => {
  virtualClock(t);
  const f = accessFixture(); f.state.listed = [joined()]; f.state.infoError = rateLimit();
  let waits = 0;
  const listing = await f.adapter.listConversations(false, async () => { if (++waits > 6) throw new Error('test safety ceiling'); });
  assert.deepEqual(listing.conversations, []);
  assert.equal(listing.admissionFailures, 1);
  assert.equal(waits, 4);
  assert.equal(f.methods().filter((m) => m === 'info').length, 5);
});

for (const error of [new TypeError('decode failure'), Object.assign(new Error('revoked'), { code: ErrorCode.PlatformError, data: { error: 'token_revoked' } })]) {
  test(`R3-2 foreground listing propagates ${error.message}`, async () => {
    const f = accessFixture(); f.state.listed = [joined()]; f.state.infoError = error;
    await assert.rejects(f.adapter.listConversations(), err => err instanceof Error && err.cause === error);
  });
}

test('R3-9 local DM peer intersection avoids listing and inbound metadata calls', async () => {
  const f = accessFixture({ config: { readJoinedChannels: true, writeChannels: ['C1'], dmUsers: ['U1', 'UOTHER'] }, dmUsers: ['UOTHER'] });
  assert.equal(f.adapter.dmsDisabled, false, 'overlapping peer remains enabled; this exercises only the per-peer veto');
  f.state.listed = [{ id: 'D1', is_im: true, user: 'U1' }];
  await f.adapter.listConversations();
  assert.deepEqual(f.methods(), ['list']);
  f.calls.length = 0;
  await f.emit({ type: 'message', channel: 'D1', user: 'U1', ts: '1.0' });
  assert.deepEqual(f.methods(), []);
  await f.adapter.stop();
});

test('A13 empty known readable types refreshes grants before returning', async () => {
  const f = accessFixture({ scopes: ['chat:write'] });
  f.web.auth.test = async () => ({ response_metadata: { scopes: ['channels:read'] } });
  f.state.listed = [joined()];
  assert.deepEqual((await f.adapter.listConversations()).conversations.map(c => c.id), ['C1']);
});

test('incomplete DM listing peer is checked against fresh metadata', async () => {
  const f = accessFixture();
  f.state.listed = [{ id: 'D1', is_im: true }];
  f.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  assert.deepEqual((await f.adapter.listConversations()).conversations.map(c => c.id), ['D1']);
  assert.ok(f.methods().includes('info'));
});

test('events arriving after stop are acknowledged without admission or name lookups', async () => {
  const f = accessFixture();
  await f.adapter.stop();
  assert.equal(await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0' }), true);
  assert.deepEqual(f.methods(), []);
});

test('empty readable-type scope probe honors background retry handling', async () => {
  const f = accessFixture({ scopes: ['users:read'] });
  let attempts = 0;
  let waits = 0;
  f.web.auth.test = async () => {
    if (++attempts === 1) throw Object.assign(new Error('limited'), { code: ErrorCode.RateLimitedError, retryAfter: 1 });
    return { response_metadata: { scopes: accessScopes } };
  };
  await f.adapter.listConversations(false, async () => { waits++; });
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test('missing inbound history grants produce an operator scope diagnostic', async t => {
  const f = accessFixture({ scopes: accessScopes.filter(s => s !== 'channels:history') });
  const log = t.mock.method(console, 'error', () => {});
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0' });
  await f.adapter.stop();
  assert.match(JSON.stringify(log.mock.calls.map(c => c.arguments)), /required scope unavailable.*channels:history/);
});

test('disabled DMs veto confirmed MPIM kind before membership fallback', async () => {
  const f = accessFixture({ config, scopes, disableDms: true });
  f.state.conversation = { id: 'G1', is_mpim: true };
  let members = 0;
  f.web.conversations.members = async () => { members++; return { members: ['UBOT'] }; };
  await assert.rejects(f.adapter.sendMessage('G1', 'no'), /turned off/);
  assert.equal(members, 0);
  assert.deepEqual(f.methods(), ['info']);
});


test('scope evidence on a refused policy auth probe is consumed', async () => {
 const f=accessFixture({scopes:['chat:write']});
 let probes=0;
 const refusal=Object.assign(new Error('scope probe refused'), {code:ErrorCode.PlatformError,
  data:{error:'missing_scope',response_metadata:{scopes:['channels:read']}}});
 f.web.auth.test=async()=>{probes++;throw refusal;};
 await assert.rejects(f.adapter.listConversations(), err => err instanceof Error && err.cause === refusal);
 assert.deepEqual((f.adapter as unknown as {scopes:string[]}).scopes,['channels:read']);
 await f.adapter.listConversations();
 assert.equal(probes,1);
});

test('a cursor repeated within one type scan is a cycle on arrival, before a candidate can restart the scan', async () => {
 const f=accessFixture({scopes:['im:read','users:read']});
 let pages=0;
 f.web.conversations.list=async()=>{
  pages++;
  if(pages===1)return {channels:[],response_metadata:{next_cursor:'same'}};
  return {channels:[{id:'D1',is_im:true,user:'U1'}],response_metadata:{next_cursor:'same'}};
 };
 f.web.conversations.info=async()=>({channel:{id:'D1',is_im:true,user:'U1'},
  response_metadata:{scopes:['im:read','users:read','channels:read']}});
 await assert.rejects(f.adapter.listConversations(),/cursor cycle/);
 assert.equal(pages,2);
});

test('a scope restart before a cursor repeats discards the old cursor', async () => {
 const f=accessFixture({scopes:['im:read','users:read']});
 let pages=0;
 f.web.conversations.list=async(args)=>{
  pages++;
  if(pages===1)return {channels:[],response_metadata:{next_cursor:'same',scopes:['im:read','users:read','channels:read']}};
  if(pages===2){assert.equal(args.cursor,undefined);return {channels:[],response_metadata:{next_cursor:'same'}};}
  assert.equal(args.cursor,'same');
  return {channels:[]};
 };
 const result=await f.adapter.listConversations();
 assert.deepEqual(result.conversations,[]);
 assert.equal(pages,3);
});

test('complete absent membership is authoritative while member reports withdraw history grants', async () => {
  const f = accessFixture({ config: { readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] },
    scopes: ['mpim:read', 'mpim:history', 'chat:write'] });
  f.state.conversation = { id: 'G1', is_mpim: true, is_im: false };
  f.web.conversations.members = async () => ({ members: [] });
  await assert.rejects(f.adapter.getConversationMeta('G1'), (err: unknown) => err instanceof SlackAccessUnverified && err.authoritative);
  f.web.conversations.members = async () => ({ members: ['UBOT'], response_metadata: { scopes: ['mpim:read'] } });
  await assert.rejects(f.adapter.getConversationMeta('G1', true), /mpim:history/);
  await f.adapter.stop();
});
test('every policy adapter built directly above was stopped by its own test, leaving no admission-log flush pending', () => {
  assert.equal(directlyBuilt.length, 4);
  for (const adapter of directlyBuilt) {
    const internal = adapter as unknown as { stopping: boolean; admissionLogTimer?: unknown };
    assert.equal(internal.stopping, true);
    assert.equal(internal.admissionLogTimer, undefined);
  }
});
