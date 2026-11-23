import assert from 'node:assert/strict';
import { accessTest as test, accessFixture, accessScopes, joined, ownedTest } from './adapterAccessFixture.js';
import { postLeftBy, failedRequest, SlackWebClient, SLACK_CLIENT_OPTIONS, withCallTime } from '../src/slack-adapter.js';
import { clock } from '../src/clock.js';
import { withAccessContext } from '../src/access-policy.js';
import { setImmediate } from 'node:timers/promises';
import { WebClient } from '@slack/web-api';
import { fakeSlackApi } from './slackApi.js';

for (const negative of ['membership', 'metadata grant'] as const) ownedTest(`A/B/C: an old success cannot postpone recovery after ${negative} restoration`, { timeout: 5000 }, async t => {
  const api = await fakeSlackApi();
  const f = accessFixture();
  let releaseA!: () => void, releaseC!: () => void;
  const heldA = new Promise<void>(resolve => { releaseA = resolve; });
  const heldC = new Promise<void>(resolve => { releaseC = resolve; });
  t.after(async () => { releaseA(); releaseC(); await f.adapter.stop(); await api.close(); });
  const client = new WebClient('xoxb-test', { slackApiUrl: api.url, retryConfig: { retries: 0 } });
  f.web.conversations.info = args => client.conversations.info(args);
  const member = { ok: true, channel: joined(), response_metadata: { scopes: accessScopes } };
  api.answerFor('conversations.info',
    { body: member, after: heldA },
    { body: negative === 'membership'
      ? { ...member, channel: { ...joined(), is_member: false } }
      : { ...member, response_metadata: { scopes: accessScopes.filter(scope => scope !== 'channels:read') } } },
    { body: member, after: heldC });
  const seen = async (count: number) => {
    while (api.calls.length < count) await setImmediate();
    assert.deepEqual(api.calls, Array(count).fill('conversations.info'));
  };

  // A starts before B observes non-membership; C starts after B's refusal,
  // but before A's valid member answer meets that already-known veto.
  const a = f.adapter.getConversationMeta('C1').then(() => undefined, err => err);
  await seen(1);
  const refusal = await f.adapter.getConversationMeta('C1').then(() => assert.fail('B must refuse'), err => err);
  assert.match(refusal.message, negative === 'membership' ? /bot is not in conversation 'C1'/ : /requires granted scope 'channels:read'/);
  const c = f.adapter.getConversationMeta('C1');
  // Handle a regression's rejection immediately, before awaiting it below.
  const recovered = c.then(value => ({ value }), error => ({ error }));
  await seen(3);
  releaseA();
  const stale = await a;
  if (negative === 'membership') {
    assert.equal(stale.message, refusal.message, 'A reports B\'s original veto');
    assert.notEqual(stale, refusal, 'each operation gets its own carrier');
  }
  else assert.match(stale.message, /requires granted scope 'channels:read'/, 'A may reconstruct a refusal but cannot observe it');
  assert.throws(() => f.adapter.assertKnownDeliveryAdmission('C1'), negative === 'membership'
    ? (err: unknown) => err !== refusal && (err as Error).message === refusal.message : /requires granted scope 'channels:read'/);
  releaseC();
  const result = await recovered;
  if ('error' in result) throw result.error;
  assert.equal(result.value?.id, 'C1', 'C can recover without a fourth request');
  assert.doesNotThrow(() => f.adapter.assertKnownDeliveryAdmission('C1'));
  assert.equal(api.calls.length, 3);
});

// Both directions matter: stale positive evidence cannot clear a refusal, and
// stale negative evidence cannot replace a later-issued successful response.
for (const negative of ['membership', 'metadata grant', 'history page'] as const) test(`later-issued success supersedes an older held ${negative} refusal`, async t => {
  const f = accessFixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.after(async () => { release(); await f.adapter.stop(); });
  const success = Object.freeze({ channel: joined(), response_metadata: Object.freeze({ scopes: accessScopes }) });
  // Reusing a frozen client result must not overwrite another occurrence's serial.
  f.web.conversations.info = async () => success;
  await f.adapter.getConversationMeta('C1');
  let calls = 0;
  f.web.conversations.info = async () => {
    if (++calls !== 1 || negative === 'history page') return success;
    entered(); await held;
    return { channel: negative === 'membership' ? { ...joined(), is_member: false } : joined(),
      response_metadata: { scopes: negative === 'metadata grant' ? accessScopes.filter(s => s !== 'channels:read') : accessScopes } };
  };
  f.web.conversations.history = async () => {
    entered(); await held;
    throw Object.assign(new Error('removed'), { code: 'slack_webapi_platform_error', data: { error: 'not_in_channel' } });
  };
  const old = (negative === 'history page' ? f.adapter.readHistory('C1', {}) : f.adapter.getConversationMeta('C1'))
    .then(() => undefined, error => error);
  await started;
  await f.adapter.getConversationMeta('C1');
  release();
  if (negative !== 'metadata grant') assert.ok(await old, 'the old operation still reports its own real refusal');
  else await old;
  assert.doesNotThrow(() => f.adapter.assertKnownDeliveryAdmission('C1'), 'the old refusal cannot replace newer positive evidence');
});

for (const negative of ['membership', 'metadata grant'] as const) test(`a real later-issued ${negative} refusal still defeats an already-issued restoration`, async t => {
  const f = accessFixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  t.after(async () => { release(); await f.adapter.stop(); });
  let calls = 0;
  f.web.conversations.info = async () => {
    if (++calls === 1) { entered(); await held; return { channel: joined(), response_metadata: { scopes: accessScopes } }; }
    return { channel: negative === 'membership' ? { ...joined(), is_member: false } : joined(),
      response_metadata: { scopes: negative === 'metadata grant' ? accessScopes.filter(s => s !== 'channels:read') : accessScopes } };
  };
  const older = f.adapter.getConversationMeta('C1').then(() => undefined, error => error);
  await started;
  await assert.rejects(f.adapter.getConversationMeta('C1'));
  release();
  assert.ok(await older);
  assert.throws(() => f.adapter.assertKnownDeliveryAdmission('C1'));
});

for (const negative of ['refusal', 'withdrawal'] as const) test(`older in-flight metadata cannot undo a later ${negative}`, async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  await f.adapter.getConversationMeta('C1');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  let calls = 0;
  f.web.conversations.info = async () => {
    if (++calls === 1) { entered(); await held; return { channel: joined(), response_metadata: { scopes: accessScopes } }; }
    return { channel: negative === 'refusal' ? { ...joined(), is_member: false } : joined(),
      response_metadata: { scopes: negative === 'withdrawal' ? accessScopes.filter(s => s !== 'channels:history') : accessScopes } };
  };
  const older = f.adapter.getConversationMeta('C1').then(() => true, () => false);
  await started;
  if (negative === 'refusal') await assert.rejects(f.adapter.getConversationMeta('C1'));
  else await f.adapter.getConversationMeta('C1');
  release();
  assert.equal(await older, negative !== 'refusal');
  assert.throws(() => f.adapter.assertKnownDeliveryAdmission('C1'));
  f.web.conversations.info = async () => ({ channel: joined(), response_metadata: { scopes: accessScopes } });
  await f.adapter.getConversationMeta('C1');
  assert.doesNotThrow(() => f.adapter.assertKnownDeliveryAdmission('C1'), 'a newly issued request can recover');
});

for (const kind of ['DOMException', 'private getter', 'primitive'] as const) test(`policy client occurrence preserves safe classification: ${kind}`, async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  class PrivateError extends Error { #retry = 5; get retryAfter() { return this.#retry; } get code() { return 'slack_webapi_request_error'; } }
  const source = kind === 'DOMException' ? new DOMException('lost answer') : kind === 'private getter' ? new PrivateError('lost answer') : 'lost answer';
  f.web.chat.postMessage = async () => { throw source; };
  await assert.rejects(f.adapter.sendMessage('C1', 'hello'), err => {
    assert.equal(failedRequest(err), 'chat.postMessage');
    assert.equal(postLeftBy(err)?.channelId, 'C1');
    if (kind === 'private getter') assert.equal((err as PrivateError).retryAfter, 5);
    return true;
  });
});

for (const kind of ['history', 'thread'] as const) test(`a real ${kind} page access refusal vetoes later transient delivery`, async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  await f.adapter.getConversationMeta('C1');
  const refuse = async () => { throw Object.assign(new Error('removed'), { code: 'slack_webapi_platform_error', data: { error: 'not_in_channel' } }); };
  f.web.conversations.history = refuse;
  f.web.conversations.replies = refuse;
  await assert.rejects(kind === 'history' ? f.adapter.readHistory('C1', {}) : f.adapter.readThread('C1', '1.0', {}));
  assert.throws(() => f.adapter.assertKnownDeliveryAdmission('C1'));
});

test('aliased client namespaces retain their actual method path', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  const shared = { ...f.web.conversations, postMessage: async () => { throw new Error('lost post answer'); } };
  f.web.conversations = shared;
  f.web.chat = shared as never;
  await f.adapter.getConversationMeta('C1');
  await assert.rejects(f.adapter.sendMessage('C1', 'hello'), err => {
    assert.equal(failedRequest(err), 'chat.postMessage');
    assert.deepEqual(postLeftBy(err), { channelId: 'C1', policy: true, historyReadable: true });
    return true;
  });
});

test('response and refusal scope reports retain normalized grants; blank or empty reports are missing evidence', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.web.conversations.info = async () => ({ channel: joined(), response_metadata: { scopes: accessScopes.map(s => ` ${s} `) } });
  await f.adapter.getConversationMeta('C1');
  assert.doesNotThrow(() => f.adapter.assertKnownDeliveryAdmission('C1'));
  for (const blank of [[], [''], ['  ']]) {
    f.web.conversations.info = async () => ({ channel: joined(), response_metadata: { scopes: blank } });
    await f.adapter.getConversationMeta('C1');
    assert.deepEqual((f.adapter as any).scopes, accessScopes, `${JSON.stringify(blank)} keeps the last report`);
  }
  // A refusal's padded report is ingested the same way.
  f.web.conversations.info = async () => { throw Object.assign(new Error('refused'), { code: 'slack_webapi_platform_error',
    data: { error: 'internal_error', response_metadata: { scopes: [' channels:read ', 'channels:history '] } } }); };
  await assert.rejects(f.adapter.getConversationMeta('C1'));
  assert.deepEqual((f.adapter as any).scopes, ['channels:read', 'channels:history']);
});

test('a history missing_scope withdraws the grant Slack names, even if a later info success has no scope report', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.web.conversations.history = async () => { throw Object.assign(new Error('missing'), { code: 'slack_webapi_platform_error',
    data: { error: 'missing_scope', needed: 'channels:history' } }); };
  await assert.rejects(f.adapter.fetchHistory('C1'));
  await f.adapter.getConversationMeta('C1');
  assert.throws(() => f.adapter.assertKnownDeliveryAdmission('C1'), /channels:history/);
});

test('each operation rethrowing a stored refusal gets its own carrier', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.state.conversation = { ...joined(), is_member: false };
  await assert.rejects(f.adapter.getConversationMeta('C1'));
  const posted = await withAccessContext('Nothing was posted', async () => f.adapter.assertKnownDeliveryAdmission('C1')).catch(err => err);
  const read = await withAccessContext('No messages were returned', async () => f.adapter.assertKnownDeliveryAdmission('C1')).catch(err => err);
  assert.notEqual(posted, read);
  assert.match(posted.message, /^Nothing was posted: /);
  assert.match(read.message, /^No messages were returned: /);
  assert.doesNotMatch(read.message, /Nothing was posted/);
});

ownedTest('a rate-limited request resent after the client wait is ordered at its resend, not its first send', { timeout: 5000 }, async t => {
  t.mock.method(console, 'error', () => {});
  const api = await fakeSlackApi();
  const f = accessFixture();
  t.after(async () => { await f.adapter.stop(); await api.close(); });
  const client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  f.web.conversations.info = args => client.conversations.info(args as never);
  const member = { ok: true, channel: joined(), response_metadata: { scopes: accessScopes } };
  api.answerFor('conversations.info',
    { status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } },
    { body: member },
    { body: { ...member, channel: { ...joined(), is_member: false } } });
  let b: Promise<unknown> | undefined;
  // B is issued and answered while A waits out its rate limit.
  t.mock.method(clock, 'sleep', async () => { b = f.adapter.getConversationMeta('C1'); await b; });
  const a = await withCallTime(clock.now(), () => f.adapter.getConversationMeta('C1')).then(() => undefined, err => err);
  assert.ok(b, 'B ran during the wait');
  assert.match(String(a?.message), /bot is not in conversation 'C1'/);
  assert.deepEqual(api.calls, ['conversations.info', 'conversations.info', 'conversations.info']);
  assert.throws(() => f.adapter.assertKnownDeliveryAdmission('C1'), /bot is not in conversation 'C1'/,
    'the resent refusal is newer than B\'s success');
});

test('unverified context preserves its complete fresh-evidence remedy', async () => {
  const { withAccessContext, SlackAccessDenied } = await import('../src/access-policy.js');
  await assert.rejects(withAccessContext('Nothing was posted', async () => { throw new SlackAccessDenied('reason', undefined, false); }), {
    message: 'Nothing was posted: reason. Retry once for fresh evidence; if it persists, ask whoever runs this host to investigate access.',
  });
});


test('definitive local exclusion precedes missing scope evidence', async t => {
  const f = accessFixture({ config: { readJoinedChannels: false, writeChannels: [], dmUsers: [] } });
  t.after(() => f.adapter.stop());
  (f.adapter as any).scopes = undefined;
  await assert.rejects(f.adapter.getConversationMeta('C1'), /excluded by the Slack access policy/);
  assert.deepEqual(f.calls, []);
});

test('a token-wide refusal on one conversation vetoes fallback for every conversation until a newer success', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.state.conversation = joined('C2');
  await f.adapter.getConversationMeta('C2');
  f.state.infoError = Object.assign(new Error('revoked'), { code: 'slack_webapi_platform_error', data: { error: 'token_revoked' } });
  await assert.rejects(f.adapter.getConversationMeta('C1'));
  assert.throws(() => f.adapter.assertKnownDeliveryAdmission('C2'), /revoked/);
  f.state.infoError = undefined;
  await f.adapter.getConversationMeta('C2');
  assert.doesNotThrow(() => f.adapter.assertKnownDeliveryAdmission('C2'));
});

test('an older token refusal answered after a newer success does not latch', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  let calls = 0;
  f.web.conversations.info = async () => {
    if (++calls === 1) {
      entered(); await held;
      throw Object.assign(new Error('revoked'), { code: 'slack_webapi_platform_error', data: { error: 'invalid_auth' } });
    }
    return { channel: joined(), response_metadata: { scopes: accessScopes } };
  };
  const older = f.adapter.getConversationMeta('C1').then(() => undefined, error => error);
  await started;
  await f.adapter.getConversationMeta('C1');
  release();
  assert.ok(await older, 'the older request was refused');
  assert.doesNotThrow(() => f.adapter.assertKnownDeliveryAdmission('C1'), 'the newer success already proved the token works');
});
