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
    // The capability receipt does not await registration. Wait for its public
    // busy flag to clear; a settled refresh also joins its own scope probes.
    const deadline = AbortSignal.timeout(1000);
    for (;;) {
      assert.equal(deadline.aborted, false, 'registration did not settle');
      const ready = await h.host.sendRequest('tools/call', { name: 'refresh_channels', arguments: {} }) as any;
      if (JSON.stringify(ready).includes('still registering')) continue;
      assert.equal(ready.isError, true);
      assert.match(JSON.stringify(ready), /scope metadata is unavailable/);
      break;
    }
    f.calls.length = 0;
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
  assert.match(rolled.reason ?? '', /Cleanup was not attempted/);
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
    assert.match(message, /Nothing was posted.*re-invite/);
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
  if (mode === 'subscribe') {
    const subscribed = await h.host.sendRequest('tools/call', { name: 'subscribe_channel', arguments: { channelId: 'C1' } }) as { isError?: boolean };
    assert.notEqual(subscribed.isError, true);
    await f.emit({ type: 'message', channel: 'C1', user: 'U2', ts: '0.5', text: 'ambient before mention' });
    assert.equal(h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 1, 'explicit subscription delivers without mention auto-subscription');
  }
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  f.web.users.info = async () => { entered(); await held; return { user: { name: 'human' } }; };
  const first = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '1.0', text: '<@UBOT> hello' });
  await started;
  const ambient = f.emit({ type: 'message', channel: 'C1', user: 'U1', ts: '2.0', text: 'ambient' });
  if (mode === 'unmute') await h.host.sendRequest('tools/call', { name: 'subscribe_channel', arguments: { channelId: 'C1' } });
  release(); await Promise.all([first, ambient]);
  assert.equal(h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, mode === 'subscribe' ? 3 : 2);
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
