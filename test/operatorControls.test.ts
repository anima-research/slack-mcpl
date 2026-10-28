/**
 * The operator controls seen from the host: what the server registers, tells
 * the agent, delivers and posts. The real server over the in-memory harness.
 *
 * Run: node --import tsx --test test/operatorControls.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cliInvocation } from './cliHarness.js';
import { SlackMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
import { McplConnection, method } from '@animalabs/mcpl-core';
import { FULL_GRANT, MENTION_EVENT, connectHost, fakeSlack, harness, initialize, until, type Harness } from './harness.js';

const pushes = (h: Harness) => h.hostSaw.filter((r) => r.method === method.PUSH_EVENT);
const pushText = (h: Harness, i: number) =>
  (pushes(h)[i].params as { payload: { content: { text: string }[] } }).payload.content.map((b) => b.text).join('\n');

async function ready(h: Harness) {
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
}

test('a conversation outside the write allow-list is registered inbound, listed as not writable, and the agent is told', async () => {
  const h = harness({ sendChannels: ['C9'] });
  await ready(h);

  const registered = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!.params as {
    channels: { id: string; direction: string }[];
  };
  assert.equal(registered.channels.find((c) => c.id === 'slack:C1')!.direction, 'inbound');

  const listed = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as {
    content: { text: string }[];
  };
  assert.match(listed.content[0].text, /"writable":false/);

  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => pushes(h).length === 1, 'push/event');
  assert.match(pushText(h, 0), /cannot write to conversation C1/);

  await h.close();
});

test('a writable conversation is bidirectional and carries no read-only note', async () => {
  const h = harness({ sendChannels: ['C1'] });
  await ready(h);
  const registered = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!.params as {
    channels: { id: string; direction: string }[];
  };
  assert.equal(registered.channels[0].direction, 'bidirectional');
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => pushes(h).length === 1, 'push/event');
  assert.doesNotMatch(pushText(h, 0), /cannot write/);
  await h.close();
});

test('channels/publish outside the allow-list is refused and posts nothing', async () => {
  const h = harness({ sendChannels: ['C9'] });
  await ready(h);
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'hi' }] }),
  );
  assert.equal(h.posts.length, 0);
  await h.close();
});

test('channels/publish to a DM is refused when DMs are disabled', async () => {
  const h = harness({ disableDms: true });
  await ready(h);
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:D1', content: [{ type: 'text', text: 'hi' }] }),
    /Nothing was posted: D1 is a direct message or group DM, and this bot works only in channels here, since direct messages are turned off\. list_channels shows the ones it can use\.$/,
  );
  assert.equal(h.posts.length, 0);
  await h.close();
});

test('unsubscribe_channel silences a member channel for real', async () => {
  const h = harness({ subscribeMemberChannels: true });
  await ready(h);
  const ambient = (ts: string) => ({ type: 'message', channel: 'C1', user: 'U2', text: 'chatter', ts });

  await h.socket.emitMessage(ambient('1.1'));
  await until(() => pushes(h).length === 1, 'the first ambient message');

  await h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  await h.socket.emitMessage(ambient('1.2'));
  assert.equal(pushes(h).length, 1, 'muted: nothing new arrives');

  // A mention still comes through.
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '1.3' });
  await until(() => pushes(h).length === 2, 'the mention');

  await h.close();
});

test('the reaction is taken off when the host does not accept the message', async () => {
  const h = harness({ ackReaction: 'eyes', pushAccepted: false });
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => h.reactions.length >= 2, 'add then remove');
  assert.deepEqual(h.reactions, ['add:C1:111.1:eyes', 'remove:C1:111.1:eyes']);
  await h.close();
});

test('the reaction stays while the host has the message', async () => {
  const h = harness({ ackReaction: 'eyes' });
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => pushes(h).length === 1, 'push/event');
  await new Promise((r) => setTimeout(r, 50)); // a wrong removal would land here
  assert.deepEqual(h.reactions, ['add:C1:111.1:eyes']);
  await h.close();
});

test('the read-only note comes with the first message, even when that one is ambient', async () => {
  const h = harness({ sendChannels: ['C9'], subscribeMemberChannels: true });
  await ready(h);
  await h.socket.emitMessage({ type: 'message', channel: 'C1', user: 'U2', text: 'chatter', ts: '1.1' });
  await until(() => pushes(h).length === 1, 'the ambient message');
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '1.2' });
  await until(() => pushes(h).length === 2, 'the mention');
  assert.match(pushText(h, 0), /cannot write to conversation C1/);
  assert.doesNotMatch(pushText(h, 1), /cannot write/, 'told once');
  await h.close();
});

test('a mention does not undo a mute', async () => {
  const h = harness({ subscribeMemberChannels: true });
  await ready(h);
  await h.host.sendRequest('tools/call', { name: 'unsubscribe_channel', arguments: { channelId: 'C1' } });
  await h.socket.emitMessage(MENTION_EVENT); // first message from C1: the auto-subscribe path
  await until(() => pushes(h).length === 1, 'the mention');
  await h.socket.emitMessage({ type: 'message', channel: 'C1', user: 'U2', text: 'chatter', ts: '2.1' });
  assert.equal(pushes(h).length, 1, 'still muted');
  await h.close();
});

test('send_dm is not offered when DMs are disabled', async () => {
  const h = harness({ disableDms: true });
  await initialize(h, true);
  const { tools } = (await h.host.sendRequest('tools/list')) as { tools: { name: string }[] };
  assert.equal(tools.some((t) => t.name === 'send_dm'), false);
  assert.equal(tools.some((t) => t.name === 'send_message'), true);
  await h.close();
});

test('the read-only note is given again when the host did not take the message that carried it', async () => {
  const h = harness({ sendChannels: ['C9'], pushAccepted: false });
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '111.2' });
  await until(() => pushes(h).length === 2, 'two pushes');
  assert.match(pushText(h, 0), /cannot write/);
  assert.match(pushText(h, 1), /cannot write/);
  await h.close();
});

test('send_dm is not offered when the write list names no DM', async () => {
  const h = harness({ sendChannels: ['C9'] });
  await initialize(h, true);
  const { tools } = (await h.host.sendRequest('tools/list')) as { tools: { name: string }[] };
  assert.equal(tools.some((t) => t.name === 'send_dm'), false);
  await h.close();
});

for (const mcpl of [false, true]) {
  test(`disabled tools are hidden and refused without changing other tools (${mcpl ? 'MCPL' : 'MCP'})`, async t => {
    const fake = fakeSlack();
    const disabledTools = ['send_message', 'fetch_history', 'subscribe_channel'];
    const server = new SlackMcplServer(fake.slack, { disabledTools });
    const h = connectHost(server);
    t.after(() => h.close());
    await initialize(h, mcpl);
    if (mcpl) await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    const control = connectHost(new SlackMcplServer(fakeSlack().slack));
    t.after(() => control.close());
    await initialize(control, mcpl);
    if (mcpl) await control.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    const baseline = await control.host.sendRequest('tools/list') as { tools: { name: string }[] };
    const listed = await h.host.sendRequest('tools/list') as typeof baseline;
    assert.deepEqual(listed.tools, baseline.tools.filter(tool => !disabledTools.includes(tool.name)));

    for (const name of disabledTools) {
      const result = await h.host.sendRequest('tools/call', {
        name, arguments: { channelId: 'C1', content: 'must not post' },
      }) as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, `Tool '${name}' is disabled by operator configuration`);
    }
    assert.deepEqual(fake.posts, []);
    assert.deepEqual(fake.reads, []);
    const subscriptions = await h.host.sendRequest('tools/call', { name: 'list_subscriptions', arguments: {} });
    assert.deepEqual(subscriptions, await control.host.sendRequest('tools/call', { name: 'list_subscriptions', arguments: {} }));
    const reply = await h.host.sendRequest('tools/call', {
      name: 'reply_message', arguments: { channelId: 'C1', messageId: '1.1', content: 'enabled' },
    }) as { isError?: boolean };
    assert.notEqual(reply.isError, true);
    assert.equal(fake.posts.length, 1);
    if (mcpl) {
      // Disabling a tool is not an operation-wide ban or a new feature-set grant.
      await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'publish' }] });
      assert.equal(fake.posts.length, 2);
      await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: [] });
      await assert.rejects(h.host.sendRequest('tools/call', { name: 'send_message', arguments: {} }), /capability/i);
    }
  });

  test(`every tool can be disabled, including always-available tools (${mcpl ? 'MCPL' : 'MCP'})`, async t => {
    const h = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools: toolDefinitions.map(tool => tool.name) }));
    t.after(() => h.close());
    await initialize(h, mcpl);
    if (mcpl) await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    assert.deepEqual(await h.host.sendRequest('tools/list'), { tools: [] });
    for (const { name } of toolDefinitions) {
      const result = await h.host.sendRequest('tools/call', { name, arguments: {} }) as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, `Tool '${name}' is disabled by operator configuration`);
    }
  });
}

test('disabled-tool options are validated and copied at construction', async t => {
  for (const name of ['misspelled', 'bad\nname']) {
    assert.throws(() => new SlackMcplServer(fakeSlack().slack, { disabledTools: [name] }), {
      message: `Unknown disabled tool: ${JSON.stringify(name)}`,
    });
  }
  const opts = { disabledTools: ['send_message'] };
  const h = connectHost(new SlackMcplServer(fakeSlack().slack, opts));
  t.after(() => h.close());
  opts.disabledTools.splice(0, 1, 'reply_message');
  opts.disabledTools = ['fetch_history'];
  await initialize(h, false);
  const { tools } = await h.host.sendRequest('tools/list') as { tools: { name: string }[] };
  assert.equal(tools.some(tool => tool.name === 'send_message'), false);
  assert.equal(tools.some(tool => tool.name === 'reply_message'), true);
  assert.equal(tools.some(tool => tool.name === 'fetch_history'), true);
  const result = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: {} }) as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /disabled by operator configuration/);
});

test('index wires SLACK_DISABLED_TOOLS through to the stdio server', { timeout: 30_000 }, async t => {
  const { args, options } = cliInvocation({ SLACK_DISABLED_TOOLS: 'send_message, fetch_history,send_message' }, true);
  const child = spawn(process.execPath, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const host = McplConnection.fromStreams(child.stdout, child.stdin);
  t.after(async () => { host.close(); child.kill(); await exited; });
  await initialize({ host }, false);
  const { tools } = await host.sendRequest('tools/list') as { tools: { name: string }[] };
  assert.equal(tools.some(tool => tool.name === 'send_message'), false);
  assert.equal(tools.some(tool => tool.name === 'find_user'), true);
  assert.equal(tools.some(tool => tool.name === 'fetch_history'), false);
  const denied = await host.sendRequest('tools/call', { name: 'send_message', arguments: {} }) as { isError?: boolean; content: { text: string }[] };
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /disabled by operator configuration/);
  const allowed = await host.sendRequest('tools/call', { name: 'find_user', arguments: { query: 'nobody' } }) as { isError?: boolean };
  assert.notEqual(allowed.isError, true);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null], stderr);
  assert.match(stderr, /writes: anywhere; DMs: on; tools off: send_message, fetch_history\n/);
});

test('disabled reaction and deletion tools do not block automatic acknowledgements or host rollback', async t => {
  const fake = fakeSlack({ ackReaction: 'eyes' });
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: ['add_reaction', 'delete_message'] }));
  t.after(async () => { await h.close(); await fake.slack.stop(); });
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  for (const name of ['add_reaction', 'delete_message']) {
    const result = await h.host.sendRequest('tools/call', {
      name, arguments: { channelId: 'C1', messageId: '111.1', emoji: 'eyes' },
    }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `Tool '${name}' is disabled by operator configuration`);
  }
  assert.deepEqual(fake.reactions, []);
  assert.deepEqual(fake.deletedMessages, []);
  await fake.socket.emitMessage(MENTION_EVENT);
  await until(() => fake.reactions.includes('add:C1:111.1:eyes'), 'automatic acknowledgement');
  const sent = await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'to roll back' },
  }) as { state: { parent: string } };
  assert.deepEqual(await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: 'slack.messaging', checkpoint: sent.state.parent,
  }), { checkpoint: sent.state.parent, success: true });
  assert.deepEqual(fake.deletedMessages, [{ channel: 'C1', ts: '100.1' }]);
});
