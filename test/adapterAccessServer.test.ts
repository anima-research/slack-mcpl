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
  }), /confirmed joined channel/);
  assert.deepEqual(f.methods(), ['info']);
  const rolled = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint: first.state.parent,
  }) as { success: boolean; reason?: string };
  // Rollback moves the checkpoint even when best-effort cleanup is denied.
  assert.equal(rolled.success, true);
  assert.match(rolled.reason ?? '', /0\/1 messages deleted.*May remain: message 1\.0 in C1/);
  assert.deepEqual(f.methods(), ['info', 'info']);
  f.state.conversation = joined();
  const sent = await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: 'slack:C1', content: [{ type: 'text', text: 'three' }],
  }) as { delivered: boolean };
  assert.equal(sent.delivered, true);
  assert.deepEqual(f.methods(), ['info', 'info', 'info', 'post']);
});


test('server list/refresh and host publish with unknown scopes make zero Slack calls', async (t) => {
  const f = accessFixture({ scopes: [] });
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  for (const name of ['list_channels', 'refresh_channels']) {
    const result = await h.host.sendRequest('tools/call', { name, arguments: {} }) as { isError?: boolean };
    assert.notEqual(result.isError, true);
  }
  await assert.rejects(h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: 'slack:C1', content: [{ type: 'text', text: 'hi' }],
  }), /scope/i);
  assert.deepEqual(f.calls, []);
});
