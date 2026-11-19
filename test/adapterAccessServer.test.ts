/** Real server + real adapter, only Slack boundaries are stubs. */
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import { MESSAGING_FEATURE_SET } from '../src/feature-sets.js';
import { FULL_GRANT, connectHost, initialize } from './harness.js';
import { accessTest as test, accessFixture, joined } from './adapterAccessFixture.js';

const deniedTools: Array<[string, Record<string, unknown>]> = [
  ['send_message', { channelId: 'C1', content: 'hello' }],
  ['reply_message', { channelId: 'C1', messageId: '1.0', content: 'hello' }],
  ['edit_message', { channelId: 'C1', messageId: '1.0', content: 'new' }],
  ['delete_message', { channelId: 'C1', messageId: '1.0' }],
  ['add_reaction', { channelId: 'C1', messageId: '1.0', emoji: 'eyes' }],
  ['upload_file', { channelId: 'C1', filename: 'file.txt', content: 'hello' }],
  ['send_dm', { userId: 'U1', content: 'hello' }],
  ['fetch_history', { channelId: 'C1' }],
  ['fetch_thread', { channelId: 'C1', threadTs: '1.0' }],
  ['find_user', { query: 'human' }],
];
for (const [name, args] of deniedTools) {
  test(`server deny matrix: ${name} reaches policy without any Slack call`, async (t) => {
    const f = accessFixture({ scopes: [] });
    const h = connectHost(new SlackMcplServer(f.adapter));
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    f.calls.length = 0; // Discard registration's safe auth.test scope probe.
    const result = await h.host.sendRequest('tools/call', { name, arguments: args }) as { isError?: boolean; content?: unknown };
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /scope/i, 'not an unknown tool or argument-validation refusal');
    assert.deepEqual(f.calls, []);
  });
}

test('host publish is admitted afresh; rollback after revocation never deletes', async (t) => {
  const f = accessFixture();
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const first = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'one' } }) as {
    state: { checkpoint: string; parent: string };
  };
  assert.ok(first.state, JSON.stringify(first));
  assert.ok(first.state.parent);
  f.calls.length = 0;
  f.state.conversation = { ...joined(), is_member: false };
  await assert.rejects(h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: 'slack:C1', content: [{ type: 'text', text: 'two' }],
  }), /a member can invite it/);
  assert.deepEqual(f.methods(), ['info']);
  const rolled = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint: first.state.parent,
  }) as { success: boolean; reason?: string };
  // Rollback moves the checkpoint even when best-effort cleanup is denied.
  assert.equal(rolled.success, true);
  assert.match(rolled.reason ?? '', /Cleanup was not attempted for message 1\.0 in C1: [A-Z]/);
  assert.doesNotMatch(rolled.reason ?? '', /Nothing was deleted/, 'the cleanup outcome is stated once');
  assert.match(rolled.reason ?? '', /0\/1 messages deleted.*May remain: message 1\.0 in C1/);
  assert.deepEqual(f.methods(), ['info', 'info']);
  f.state.conversation = joined();
  const sent = await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: 'slack:C1', content: [{ type: 'text', text: 'three' }],
  }) as { delivered: boolean };
  assert.equal(sent.delivered, true);
  assert.deepEqual(f.methods(), ['info', 'info', 'info', 'post']);
});


test('server list/refresh report unavailable scopes and only probe auth.test', async (t) => {
  const f = accessFixture({ scopes: [] });
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  for (const name of ['list_channels', 'refresh_channels']) {
    const result = await h.host.sendRequest('tools/call', { name, arguments: {} }) as { isError?: boolean };
    assert.equal(result.isError, true);
  }
  await assert.rejects(h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: 'slack:C1', content: [{ type: 'text', text: 'hi' }],
  }), /scope/i);
  // Both tools reached the scope probe; nothing else was asked.
  assert.ok(f.calls.length >= 2, 'list and refresh each probed auth.test');
  assert.ok(f.calls.every(c => c.method === 'auth.test'));
});


test('policy exposes conversation-bound fetch_attachment and refuses URL-only invocation', async (t) => {
  const f = accessFixture();
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, false);
  const listed = await h.host.sendRequest('tools/list', {}) as { tools: Array<{ name: string }> };
  assert.equal(listed.tools.some(tool => tool.name === 'fetch_attachment'), true);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  const result = await h.host.sendRequest('tools/call', {
    name: 'fetch_attachment', arguments: { url: 'https://files.slack.com/secret' },
  }) as { isError?: boolean; content: unknown };
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /channelId|fileId|url/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('rollback admission refusal is not described as Slack refusing the delete', async t => {
  const f = accessFixture();
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const posted = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'one' } }) as { state: { parent: string } };
  f.calls.length = 0;
  f.state.infoError = Object.assign(new Error('admission failed'), { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } });
  const result = await h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: MESSAGING_FEATURE_SET, checkpoint: posted.state.parent }) as { reason: string };
  assert.deepEqual(f.methods(), ['info']);
  assert.match(result.reason, /Cleanup was not attempted/);
  assert.doesNotMatch(result.reason, /Slack refused to delete/);
});


test('metadata membership refusal does not recommend bypass posting permissions', async () => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  const f = accessFixture();
  f.state.infoError = Object.assign(new Error('not a member'), {
    code: 'slack_webapi_platform_error', data: { error: 'not_in_channel' },
  });
  await assert.rejects(f.adapter.sendMessage('C1', 'no'), err => {
    const message = explainSlackError(err, { tool: 'send_message', args: { channelId: 'C1' } });
    assert.match(message, /^Nothing was posted: [\s\S]*re-invite/);
    assert.equal(message.split('Nothing was posted').length, 2, 'one outcome, then cause and remedy');
    assert.doesNotMatch(message, /chat:write.public/);
    return true;
  });
  assert.deepEqual(f.methods(), ['info']);
});

test('rollback metadata rate limit preserves wait advice without permanent denial', async t => {
  const f = accessFixture();
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const posted = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'one' } }) as { state: { parent: string } };
  f.state.infoError = Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 7 });
  const result = await h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: MESSAGING_FEATURE_SET, checkpoint: posted.state.parent }) as { reason: string };
  assert.match(result.reason, /wait 7 seconds/);
  assert.doesNotMatch(result.reason, /must restore access|retrying unchanged will not help/i);
  assert.match(result.reason, /Once the reported cause is resolved/);
});


for (const memberMode of [false, true]) test(`policy ambient prefilter avoids quota use, member mode=${memberMode}`, async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  const h = connectHost(new SlackMcplServer(f.adapter, { subscribeMemberChannels: memberMode }));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  if (memberMode) for (const channelId of ['C1', 'G1']) {
    await h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId } });
  }
  f.calls.length = 0;
  for (const channel of ['C1', 'G1']) {
    assert.equal(await f.emit({ type: 'message', channel, user: 'U1', ts: '1.0', text: 'ambient' }), true);
  }
  assert.deepEqual(f.calls, [], 'no admission, membership or name requests');
  // A mention bypasses only the subscription veto, not revoked membership.
  f.state.conversation = { ...joined(), is_member: false };
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '2.0', text: '<@UBOT> hello' });
  assert.deepEqual(f.methods(), ['info']);
  f.calls.length = 0;
  f.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  await f.emit({ type: 'message', channel: 'D1', user: 'U1', ts: '3.0', text: 'hello' });
  assert.ok(f.methods().includes('info'), 'DM also requires admission');
  // Subscribing restores eligibility, never authority.
  await h.host.sendRequest('tools/call', { name: 'subscribe_channel', arguments: { channelId: 'C1' } });
  f.calls.length = 0;
  f.state.conversation = { ...joined(), is_member: false };
  await f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '4.0', text: 'ambient' });
  assert.deepEqual(f.methods(), ['info']);
});

for (const mode of ['auto-subscribe', 'subscribe', 'unmute']) test(`queued ambient follows delivery-turn ${mode}`, async t => {
  const f = accessFixture();
  const h = connectHost(new SlackMcplServer(f.adapter, { subscribeMemberChannels: mode === 'unmute' }));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  if (mode === 'unmute') await h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  f.web.users.info = async () => { entered(); await held; return { user: { name: 'human' } }; };
  const first = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: '<@UBOT> hello' });
  await started;
  const ambient = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '2.0', text: 'ambient' });
  if (mode !== 'auto-subscribe') await h.host.sendRequest('tools/call', { name: 'subscribe_channel', arguments: { channelId: 'C1' } });
  release(); await Promise.all([first, ambient]);
  assert.equal(h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 2);
});

test('unset policy does not call a same-named legacy filter hook', async t => {
  const f = accessFixture({ legacy: true });
  let calls = 0;
  f.adapter.setAmbientMessageFilter = () => { calls++; };
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, false);
  assert.equal(calls, 0);
});

test('forwarding handler returns acceptance only with policy installed', async t => {
  for (const legacy of [true, false]) {
    const f = accessFixture({ legacy });
    const server = new SlackMcplServer(f.adapter);
    const h = connectHost(server);
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    const internal = server as unknown as { handleSlackMessage: () => Promise<void> };
    t.mock.method(internal, 'handleSlackMessage', async () => {});
    const callback = (f.adapter as unknown as { messageHandlers: Array<(msg: never) => unknown> }).messageHandlers[0]!;
    const result = callback({ channelId: 'C1', mentionsBot: false, isDM: false } as never);
    assert.equal(result instanceof Promise, !legacy);
    await result;
    h.close();
    await f.adapter.stop();
  }
});


test('unset policy keeps the original two-argument registration call without a candidate hook', async t => {
  const f = accessFixture({ legacy: true });
  const lengths: number[] = [];
  const original = f.adapter.listConversations.bind(f.adapter);
  t.mock.method(f.adapter, 'listConversations', async (...args: Parameters<typeof f.adapter.listConversations>) => {
    lengths.push(args.length);
    return original(...args);
  });
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close()); t.after(() => f.adapter.stop());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  assert.ok(lengths.length > 0);
  assert.ok(lengths.every(n => n === 2), 'no policy-only candidate cancellation hook in legacy registration');
});

for (const destination of ['allowed', 'blocked', 'wrong peer', 'blocked user'] as const) {
  test(`send_dm reports the DM-open side effect only after opening: ${destination}`, async t => {
    const f = accessFixture({ sendChannels: [destination === 'blocked' ? 'D2' : 'D1'] });
    t.after(() => f.adapter.stop());
    f.state.conversation = { id: 'D1', is_im: true, user: destination === 'wrong peer' ? 'W1' : 'U1' };
    const h = connectHost(new SlackMcplServer(f.adapter));
    t.after(() => h.close());
    await initialize(h, false);
    f.calls.length = 0;
    const result = await h.host.sendRequest('tools/call', { name: 'send_dm', arguments: {
      userId: destination === 'blocked user' ? 'UOTHER' : 'U1', content: 'hello',
    } }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError === true, destination !== 'allowed');
    assert.equal(f.methods().filter(m => m === 'open').length, destination === 'blocked user' ? 0 : 1);
    assert.equal(f.methods().filter(m => m === 'post').length, destination === 'allowed' ? 1 : 0);
    const text = result.content.map(c => c.text).join('\n');
    if (destination === 'blocked' || destination === 'wrong peer') {
      assert.match(text, /DM D1 was opened, but nothing was posted/);
      assert.match(text, /Retrying unchanged will not help/);
    } else if (destination === 'blocked user') {
      assert.match(text, /Nothing was sent/);
      assert.doesNotMatch(text, /was opened/);
    } else {
      assert.match(text, /1\.0/);
    }
  });
}

test('list_channels and refresh_channels return admitted rows with an explicit incomplete notice when a candidate is rate-limited', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  f.web.conversations.info = async (args: any) => {
    if (args.channel === 'C1') throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 60 });
    return { channel: joined(args.channel) };
  };
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const call = (name: string) => h.host.sendRequest('tools/call', { name, arguments: {} }) as Promise<any>;
  await call('refresh_channels'); // background registration has ended
  f.state.listed = [joined('C0'), joined('C1')];
  const listed = await call('list_channels');
  assert.notEqual(listed.isError, true);
  assert.match(listed.content[0].text, /"C0"/);
  assert.match(listed.content.at(-1).text, /^Incomplete: candidate admission was rate-limited; .*Retry after 60 seconds/);
  const refreshed = await call('refresh_channels');
  assert.notEqual(refreshed.isError, true);
  // Slack's 60-second Retry-After now holds the shared pacer past this call's
  // request deadline: the scan stops at once and reports that wait, not its deadline.
  assert.match(refreshed.content[0].text, /Incomplete: candidate admission was rate-limited; .*Retry after 60 seconds/);
  assert.doesNotMatch(refreshed.content[0].text, /deadline left no room/);
  assert.doesNotMatch(refreshed.content[0].text, /already has every one/);
});

test('an uncertain policy post without the history grant does not point at fetch_history', async () => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  const { accessScopes } = await import('./adapterAccessFixture.js');
  const f = accessFixture({ scopes: accessScopes.filter(s => s !== 'channels:history') });
  f.web.chat.postMessage = async () => { throw Object.assign(new Error('bad gateway'), { code: 'slack_webapi_http_error', statusCode: 502 }); };
  await assert.rejects(f.adapter.sendMessage('C1', 'maybe'), err => {
    const text = explainSlackError(err, { tool: 'send_message', args: { channelId: 'C1' } });
    assert.match(text, /whether the message was posted is unknown/);
    assert.match(text, /lacks the history grant fetch_history needs/);
    return true;
  });
});

test('the deadline notice states that a new call cannot continue past its stop', async () => {
  const { admissionIncompleteNote } = await import('../src/server.js');
  const note = admissionIncompleteNote({ reason: 'call_deadline' });
  assert.match(note, /conversations found so far are usable/);
  assert.match(note, /may never be listed or registered by calling again; if one you need is missing, ask whoever runs this host for its ID/);
  assert.doesNotMatch(note, /rows above/);
});

test('with a policy, channels/open says refresh_channels registers only admitted conversations', async t => {
  const f = accessFixture(); t.after(() => f.adapter.stop());
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await assert.rejects(h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C9', type: 'slack', address: {} }),
    (err: { message?: string }) => /refresh_channels registers the conversations this bot is in that the access policy admits, within its listing bounds/.test(String(err.message)));
});

test('send_dm states one outcome when post-open admission is rate-limited', async t => {
  const f = accessFixture({ sendChannels: ['D1'] }); t.after(() => f.adapter.stop());
  f.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  const h = connectHost(new SlackMcplServer(f.adapter)); t.after(() => h.close());
  await initialize(h, false);
  f.state.infoError = Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 30 });
  const result = await h.host.sendRequest('tools/call', { name: 'send_dm', arguments: { userId: 'U1', content: 'hello' } }) as { isError?: boolean; content: { text: string }[] };
  const text = result.content.map(c => c.text).join('\n');
  assert.equal(result.isError, true);
  assert.match(text, /DM D1 was opened, but nothing was posted/);
  assert.match(text, /rate-limiting/);
  assert.doesNotMatch(text, /Nothing was sent/);
});

test('a policy host failure summary keeps only the code and says how to recover the message', async () => {
  const { hostFailureSummary } = await import('../src/server.js');
  const text = hostFailureSummary(Object.assign(new Error('agent said: secret text'), { code: -32000 }));
  assert.match(text, /^host request failed \(code -32000\); .*check the host's logs, then recover it with fetch_history or fetch_thread$/);
  assert.doesNotMatch(text, /secret/);
});
