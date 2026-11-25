/** Public tools/call regressions: only the supported Slack client boundary is stubbed. */
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import { accessContextMessage, withAccessContext } from '../src/access-policy.js';
import { failedAccessAdmission, postLeftBy } from '../src/slack-adapter.js';
import { FULL_GRANT, connectHost, initialize } from './harness.js';
import { accessTest as test, accessFixture, joined, ownedTest } from './adapterAccessFixture.js';

for (const kind of ['fresh', 'reused', 'frozen', 'rethrown'] as const) {
  test(`public DM ${kind} client error isolates admission/context and uncertain-post provenance`, async t => {
    const f = accessFixture();
    t.after(() => f.adapter.stop());
    const h = connectHost(new SlackMcplServer(f.adapter));
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    const call = (name: string, args: Record<string, unknown>) => h.host.sendRequest('tools/call', {
      name, arguments: args,
    }) as Promise<any>;
    const base = await call('send_message', { channelId: 'C1', content: 'positive witness' });
    assert.equal(base.isError, undefined);
    assert.ok(base.state?.checkpoint);
    const source = Object.assign(new Error('client timeout'), { code: 'slack_webapi_request_error' });
    if (kind === 'frozen') Object.freeze(source);
    // For the rethrow case the embedded client captures and later rethrows the
    // actual contextual occurrence, not just the original raw Error.
    let captured: unknown;
    const info = f.web.conversations.info;
    f.web.conversations.info = async args => {
      if (f.state.infoError) throw captured ?? f.state.infoError;
      return info(args);
    };
    if (kind !== 'fresh') {
      f.state.infoError = source;
      const denied = await call('send_message', { channelId: 'C1', content: 'admission denied' });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /Nothing was posted/);
      if (kind === 'rethrown') {
        // Capture through a public adapter operation as an embedding host can.
        try { await f.adapter.sendMessage('C1', 'capture'); } catch (err) { captured = err; }
        assert.ok(captured);
      }
      f.state.infoError = undefined;
    }
    f.state.conversation = { id: 'D1', is_im: true, is_mpim: false, user: 'U1' };
    let posts = 0;
    f.web.chat.postMessage = async () => { posts++; throw captured ?? source; };
    const uncertain = await call('send_dm', { userId: 'U1', content: 'possibly delivered' });
    assert.equal(posts, 1, 'the post really started');
    assert.equal(uncertain.isError, true);
    assert.match(uncertain.content[0].text, /DM D1 was opened/);
    assert.match(uncertain.content[0].text, /may have been sent/);
    // The default fixture grants im:history, so the agent can check the DM itself.
    assert.match(uncertain.content[0].text, /check with fetch_history on D1/);
    // A host can withhold the history tools whatever the token's grants.
    assert.match(uncertain.content[0].text, /If this host does not offer fetch_history, ask the recipient or whoever runs this host to inspect Slack instead/);
    assert.doesNotMatch(uncertain.content[0].text, /[Nn]othing was (?:sent|posted)|no write was attempted/);
    assert.equal(source.message, 'client timeout', 'never mutate the reusable source error');
    assert.equal(accessContextMessage(source), undefined);
    assert.equal(failedAccessAdmission(source), false);
    assert.equal(postLeftBy(source), undefined);
    // No stale uncertain-post marker may leak into a later admission refusal.
    f.state.conversation = joined();
    f.state.infoError = source;
    const refused = await call('send_message', { channelId: 'C1', content: 'not attempted' });
    assert.equal(refused.isError, true);
    assert.doesNotMatch(refused.content[0].text, /DM D1|may have been sent/);
    f.state.infoError = undefined;
    const rolled = await h.host.sendRequest(method.STATE_ROLLBACK, {
      featureSet: 'slack.messaging', checkpoint: base.state.checkpoint,
    }) as any;
    assert.match(rolled.reason, /message in D1 whose id this server doesn't know/);
  });
}

for (const failure of ['http', 'type', 'unclassified', 'service unavailable', 'no timestamp', 'null', 'undefined'] as const) test(`public DM ${failure} explicitly reports possible send and destination`, async t => {
  const f = accessFixture({ scopes: ['im:read', 'im:write', 'chat:write'] }); t.after(() => f.adapter.stop());
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  f.state.conversation = { id: 'D1', is_im: true, is_mpim: false, user: 'U1' };
  f.web.chat.postMessage = async () => {
    if (failure === 'null') return null as never;
    if (failure === 'undefined') return undefined as never;
    if (failure === 'no timestamp') return {};
    if (failure === 'type') throw new TypeError('unreadable answer');
    if (failure === 'unclassified') throw new Error('embedded client lost the answer');
    if (failure === 'service unavailable') throw Object.assign(new Error('unavailable'), { code: 'slack_webapi_platform_error', data: { error: 'service_unavailable' } });
    throw Object.assign(new Error('bad gateway'), { code: 'slack_webapi_http_error', statusCode: 502 });
  };
  const result = await h.host.sendRequest('tools/call', { name: 'send_dm', arguments: { userId: 'U1', content: 'hi' } }) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DM D1 was opened.*may have been sent/);
  assert.match(result.content[0].text, /No check available with send_dm's scopes.*ask the recipient or whoever runs this host to inspect Slack/);
  assert.doesNotMatch(result.content[0].text, /[Nn]othing was (?:sent|posted)/);
});

for (const failure of ['refusal', 'rate limit', 'connection never made'] as const) test(`public DM confirmed ${failure} does not claim a possible send`, async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  f.state.conversation = { id: 'D1', is_im: true, is_mpim: false, user: 'U1' };
  f.web.chat.postMessage = async () => {
    throw Object.assign(new Error('post refused'), failure === 'refusal'
      ? { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } }
      : failure === 'rate limit' ? { code: 'slack_webapi_rate_limited_error', retryAfter: 20 }
      : { code: 'slack_webapi_request_error', original: { code: 'ECONNREFUSED' } });
  };
  const result = await h.host.sendRequest('tools/call', { name: 'send_dm', arguments: { userId: 'U1', content: 'hi' } }) as any;
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /may have been sent|outcome is unknown/);
  assert.match(result.content[0].text, /Nothing was sent/);
});

test('public tools discard old operation context when a client rethrows a contextualized error', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const source = Object.assign(new Error('lost answer'), { code: 'slack_webapi_request_error' });
  // An embedder may rethrow an error contextualized outside the client view.
  await assert.rejects(withAccessContext('Nothing was fetched', async () => { throw source; }));
  const previous = source.message;
  f.state.infoError = source;
  const result = await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'not attempted' },
  }) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Nothing was posted: lost answer/);
  assert.equal(result.content[0].text.match(/Nothing was posted/g)?.length, 1, 'the outcome is stated once');
  assert.doesNotMatch(result.content[0].text, /Nothing was fetched/);
  assert.equal(source.message, previous, 'a later call must not mutate the earlier occurrence');
});

ownedTest('failedRequest walks causes only through a policy occurrence; legacy lookup stays direct as on main', async t => {
  const { fakeSlackApi } = await import('./slackApi.js');
  const { SlackWebClient, SLACK_CLIENT_OPTIONS, failedRequest } = await import('../src/slack-adapter.js');
  const api = await fakeSlackApi(); t.after(() => api.close());
  api.answerFor('conversations.info', { status: 500, body: { ok: false } });
  const legacy = await new SlackWebClient('xoxb', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url }).conversations.info({ channel: 'C1' }).catch(e => e);
  assert.equal(failedRequest(legacy), 'conversations.info');
  assert.equal(failedRequest(new Error('later post', { cause: legacy })), undefined, 'main did not attribute a wrapper to its cause');
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.state.infoError = Object.assign(new Error('down'), { code: 'slack_webapi_http_error', statusCode: 503 });
  const occurrence = await f.adapter.getConversationMeta('C1').catch(e => e);
  assert.equal(failedRequest(new Error('embedder wrapper', { cause: occurrence })), 'conversations.info');
});
