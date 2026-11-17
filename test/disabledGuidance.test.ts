import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
import { buildFeatureSets } from '../src/feature-sets.js';
import { explainSlackError } from '../src/slack-errors.js';
import { FULL_GRANT, MENTION_EVENT, connectHost, fakeSlack, initialize, until } from './harness.js';

const call = async (host: ReturnType<typeof connectHost>['host'], name: string, args = {}) => {
  const result = await host.sendRequest('tools/call', { name, arguments: args }) as { content: { text: string }[] };
  return result.content[0].text;
};

test('manifest and grant omit empty tool-only sets but retain messaging protocol paths', async t => {
  const disabledTools = toolDefinitions.map(tool => tool.name);
  const h = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools }));
  t.after(() => h.close());
  const result = await initialize(h, true);
  const experimental = result.capabilities.experimental as { mcpl: { featureSets: object } };
  assert.deepEqual(Object.keys(experimental.mcpl.featureSets), ['slack.messaging']);
  const receipt = await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: [] });
  assert.doesNotMatch(JSON.stringify(receipt), /slack.history|slack.subscriptions/);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  assert.match(await call(h.host, 'not_a_tool'), /This server's tools are: none\./);
  assert.ok(buildFeatureSets(['fetch_history', 'fetch_thread'])['slack.history'], 'one surviving tool keeps the set');
  assert.ok(buildFeatureSets(['subscribe_channel', 'unsubscribe_channel'])['slack.subscriptions']);
});

test('argument, member-unsubscribe and channel-open guidance omit disabled tools', async t => {
  const fake = fakeSlack();
  const disabledTools = ['find_user', 'fetch_history', 'fetch_thread', 'list_channels', 'subscribe_channel', 'refresh_channels'];
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools, subscribeMemberChannels: true }));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  for (const [name, args] of [['send_dm', {}], ['send_message', {}], ['reply_message', { channelId: 'C1' }], ['unsubscribe_channel', { channelId: 'C1' }]] as const) {
    const text = await call(h.host, name, args);
    for (const disabled of disabledTools) assert.ok(!text.includes(disabled), text);
  }
  await assert.rejects(h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:missing' }), err => {
    assert.doesNotMatch(String(err), /refresh_channels/);
    assert.match(String(err), /operator has disabled manual refresh/);
    return true;
  });
});

test('mention attachment and history attachment guidance preserve URLs without advertising a disabled fetcher', async t => {
  const files = [{ url_private: 'https://files.slack.com/files-pri/T1-F1/shot.png', name: 'shot.png', mimetype: 'image/png' }];
  const fake = fakeSlack({ historyMessages: [{ ts: '100.1', user: 'U2', text: 'fetch_attachment is user content', files }] });
  // Subscription semantics and their auto-subscribe note remain R1-1's owner decision.
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: ['fetch_attachment', 'subscribe_channel', 'unsubscribe_channel'] }));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await fake.socket.emitMessage({ ...MENTION_EVENT, files });
  await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'mention with attachment');
  const push = JSON.stringify(h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params);
  assert.doesNotMatch(push, /fetchable via fetch_attachment/);
  assert.match(push, /attachment URL/);
  assert.match(push, /shot.png/);
  const history = await call(h.host, 'fetch_history', { channelId: 'C1' });
  assert.doesNotMatch(history, /fetchable via fetch_attachment/);
  assert.match(history, /attachment URL/);
  assert.match(history, /fetch_attachment is user content/);
});

test('Slack error hints omit disabled alternatives without losing unknown-write warnings', () => {
  const toolEnabled = () => false;
  for (const code of ['channel_not_found', 'restricted_action_thread_only_channel', 'restricted_action_non_threadable_channel', 'user_not_found', 'internal_error']) {
    const error = { message: code, code: 'slack_webapi_platform_error', data: { error: code } };
    const text = explainSlackError(error, { tool: 'send_message', args: { channelId: 'C1' }, toolEnabled });
    assert.doesNotMatch(text, /list_channels|reply_message|send_message|find_user|fetch_history|fetch_thread/);
    if (code === 'internal_error') {
      assert.match(text, /whether the message was posted is unknown/);
      assert.match(text, /before posting again/);
      assert.match(text, /ask someone with access/);
    }
  }
});

test('adapter restriction hints and read validation honor server tool availability', async t => {
  const fake = fakeSlack({ disableDms: true });
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: ['send_message', 'list_channels', 'fetch_thread'] }));
  t.after(() => h.close());
  await initialize(h, false);
  const dm = await call(h.host, 'send_dm', { userId: 'U1', content: 'hi' });
  assert.match(dm, /Nothing was sent/);
  assert.doesNotMatch(dm, /send_message|list_channels/);
  const read = await call(h.host, 'fetch_history', { channelId: 'invalid' });
  assert.match(read, /Copy channelId=/);
  assert.doesNotMatch(read, /list_channels/);
});
