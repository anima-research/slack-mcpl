import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { SlackMcplServer } from '../src/server.js';
import { waitToAskAgain } from '../src/slack-adapter.js';
import { buildFeatureSets, buildServerCapabilities } from '../src/feature-sets.js';
import { accessFixture } from './adapterAccessFixture.js';
import { connectHost, initialize } from './harness.js';

test('platform ratelimited classification preserves legacy behavior', () => {
  const error = Object.assign(new Error('limited'), { code: ErrorCode.PlatformError,
    data: { error: 'ratelimited', response_metadata: { retryAfter: 8 } } });
  assert.equal(waitToAskAgain(error, 'conversations.list')?.why, 'failed');
  assert.deepEqual(waitToAskAgain(error, 'conversations.list', true),
    { method: 'conversations.list', seconds: 8, why: 'limited' });
});

for (const legacy of [true, false]) test(`subscription and malformed-ID tool surface: legacy=${legacy}`, async t => {
  const f = accessFixture({ legacy });
  const h = connectHost(new SlackMcplServer(f.adapter, { subscribeMemberChannels: true }));
  t.after(() => h.close());
  await initialize(h, false);
  const tools = (await h.host.sendRequest('tools/list')) as { tools: { name: string; description: string }[] };
  for (const name of ['subscribe_channel', 'unsubscribe_channel']) {
    const description = tools.tools.find(tool => tool.name === name)!.description;
    assert.equal(description.includes('subject to access admission'), !legacy);
  }
  assert.deepEqual(buildServerCapabilities(!legacy).featureSets, buildFeatureSets(!legacy));
  const feature = buildFeatureSets(!legacy)['slack.subscriptions'].description!;
  assert.equal(feature.includes('subject to access admission'), !legacy);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    await h.host.sendRequest('tools/call', { name, arguments: args }) as { content: { text: string }[] };
  await call('unsubscribe_channel', { channelId: 'C1' });
  const unmute = (await call('subscribe_channel', { channelId: 'C1' })).content[0].text;
  assert.equal(unmute.includes('subject to access admission'), !legacy);
  const listing = (await call('list_subscriptions')).content[0].text;
  assert.equal(listing.includes('subject to access admission'), !legacy);
  if (!legacy) for (const [name, args] of [
    ['send_message', { channelId: 'bad', content: 'hello' }],
    ['upload_file', { channelId: 'bad', content: 'hello', filename: 'hello.txt' }],
  ] as const) {
    f.calls.length = 0;
    const result = (await call(name, args)).content.map(c => c.text).join('\n');
    assert.deepEqual(f.calls, [], 'malformed IDs cannot trigger a lookup or effect');
    assert.match(result, /Invalid Slack conversation ID/);
    assert.match(result, /list_channels/);
    assert.doesNotMatch(result, /Ask whoever runs this host to investigate/);
  }
});
