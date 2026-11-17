import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('manifest and grant omit empty tool-only sets but retain messaging and typing protocol paths', async t => {
  const disabledTools = toolDefinitions.map(tool => tool.name);
  const h = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools }));
  t.after(() => h.close());
  const result = await initialize(h, true);
  const experimental = result.capabilities.experimental as { mcpl: { featureSets: object } };
  assert.deepEqual(Object.keys(experimental.mcpl.featureSets), ['slack.messaging', 'slack.typing']);
  const receipt = await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: [] }) as {
    mode: string; unavailableFeatures: { featureSet: string; missingCapabilities: string[] }[];
  };
  assert.equal(receipt.mode, 'degraded');
  assert.deepEqual(receipt.unavailableFeatures.map(item => item.featureSet).sort(), ['slack.messaging', 'slack.typing']);
  assert.ok(receipt.unavailableFeatures.every(item => item.missingCapabilities.length > 0));
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
  for (const [name, args, expected] of [['send_dm', {}, /userId must be a non-empty string/], ['send_message', {}, /channelId must be a non-empty string/], ['reply_message', { channelId: 'C1', content: 'hi' }, /messageId must be a non-empty string/], ['unsubscribe_channel', { channelId: 'C1' }, /Muted ambient messages in conversation C1/]] as const) {
    const text = await call(h.host, name, args);
    assert.match(text, expected);
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
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: ['fetch_attachment', 'subscribe_channel', 'unsubscribe_channel'] }));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await fake.socket.emitMessage({ ...MENTION_EVENT, files });
  await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'mention with attachment');
  const push = JSON.stringify(h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params);
  assert.doesNotMatch(push, /Auto-subscribed|unsubscribe_channel/);
  assert.deepEqual(JSON.parse(await call(h.host, 'list_subscriptions')).channels, []);
  assert.doesNotMatch(push, /fetchable via fetch_attachment/);
  assert.match(push, /attachment URL \(content unavailable through this server\)/);
  assert.match(push, /shot.png/);
  assert.ok(push.includes(files[0].url_private));
  const history = await call(h.host, 'fetch_history', { channelId: 'C1' });
  assert.doesNotMatch(history, /fetchable via fetch_attachment/);
  assert.match(history, /attachment URL \(content unavailable through this server\)/);
  assert.ok(history.includes(files[0].url_private));
  assert.match(history, /fetch_attachment is user content/);
});

test('Slack error hints omit disabled alternatives without losing unknown-write warnings', () => {
  const toolEnabled = () => false;
  for (const code of ['channel_not_found', 'restricted_action_thread_only_channel', 'restricted_action_non_threadable_channel', 'user_not_found', 'internal_error']) {
    const error = { message: code, code: 'slack_webapi_platform_error', data: { error: code } };
    const text = explainSlackError(error, { tool: 'send_message', args: { channelId: 'C1' }, toolEnabled });
    assert.doesNotMatch(text, /list_channels|reply_message|send_message|find_user|fetch_history|fetch_thread/);
    const explanation = text.split('\n\n').at(-1)!;
    assert.equal(explanation, explanation.trim());
    assert.doesNotMatch(explanation, / {2}/);
    if (code === 'channel_not_found') {
      assert.match(explanation, /Slack doesn't know conversation C1/);
      assert.match(explanation, /Copy channelId from an incoming channel message/);
    }
    if (code === 'user_not_found') assert.match(explanation, /Slack has no user/);
    if (code.startsWith('restricted_action')) {
      assert.match(explanation, /conversation C1.*thread replies/);
      assert.match(explanation, code.endsWith('non_threadable_channel')
        ? /Someone with Slack access can post in the conversation/
        : /Someone with Slack access can reply in the thread/);
    }
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
  assert.match(dm, /direct messages are turned off on this host/);
  assert.doesNotMatch(dm, /send_message|list_channels/);
  const read = await call(h.host, 'fetch_history', { channelId: 'invalid' });
  assert.match(read, /Copy channelId=/);
  assert.doesNotMatch(read, /list_channels/);
});

for (const disabledTools of [[], ['send_dm'], ['subscribe_channel'], ['unsubscribe_channel'], ['subscribe_channel', 'unsubscribe_channel']]) {
  test(`mention auto-subscription respects mutating tools: ${disabledTools.join(',') || 'all enabled'}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'slack-disabled-subscriptions-'));
    const file = join(directory, 'subscriptions.json');
    const saved = '["C2"]\n';
    writeFileSync(file, saved);
    const original = process.env.SLACK_SUBSCRIPTIONS_FILE;
    process.env.SLACK_SUBSCRIPTIONS_FILE = file;
    t.after(() => {
      if (original === undefined) delete process.env.SLACK_SUBSCRIPTIONS_FILE;
      else process.env.SLACK_SUBSCRIPTIONS_FILE = original;
      rmSync(directory, { recursive: true, force: true });
    });
    const fake = fakeSlack();
    const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools }));
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await fake.socket.emitMessage(MENTION_EVENT);
    await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'mention delivered');
    const push = JSON.stringify(h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params);
    const suppressed = disabledTools.some(name => name === 'subscribe_channel' || name === 'unsubscribe_channel');
    const expected = suppressed ? ['C2'] : ['C1', 'C2'];
    assert.deepEqual(JSON.parse(await call(h.host, 'list_subscriptions')).channels.sort(), expected);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sort(), expected);
    if (suppressed) {
      assert.doesNotMatch(push, /Auto-subscribed|unsubscribe_channel/);
      assert.equal(readFileSync(file, 'utf8'), saved, 'saved subscriptions are not rewritten');
    } else {
      assert.match(push, /Auto-subscribed/);
      assert.match(push, /unsubscribe_channel/);
    }
    // Existing saved subscriptions still deliver ambient traffic.
    await fake.socket.emitMessage({ ...MENTION_EVENT, channel: 'C2', text: 'ambient', ts: '112.1' });
    await until(() => h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length === 2, 'saved subscription ambient delivery');
  });
}

for (const disabledTools of [['fetch_history'], ['fetch_thread'], ['reply_message']]) {
  test(`message targets never use the parent when ${disabledTools} is disabled`, async t => {
    const h = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools }));
    t.after(() => h.close());
    await initialize(h, false);
    for (const name of ['delete_message', 'edit_message', 'add_reaction']) {
      const text = await call(h.host, name, { channelId: 'C1' });
      assert.match(text, /own id=/);
      if (disabledTools[0] !== 'reply_message') assert.match(text, /messageId from the sending tool/);
      assert.doesNotMatch(text, /thread=|reply_message/);
    }
    if (!disabledTools.includes('reply_message')) {
      assert.match(await call(h.host, 'reply_message', { channelId: 'C1', content: 'hi' }), /reply's thread=/);
    }
    if (!disabledTools.includes('fetch_thread')) {
      assert.match(await call(h.host, 'fetch_thread', { channelId: 'C1' }), /reply's thread=/);
    }
  });
}

test('Slack timestamp errors distinguish message targets from thread parents', () => {
  for (const disabled of ['fetch_history', 'fetch_thread']) {
    for (const code of ['message_not_found', 'bad_timestamp']) {
      for (const tool of ['delete_message', 'edit_message', 'add_reaction', 'reply_message', 'fetch_thread', 'upload_file']) {
        const text = explainSlackError(
          { code: 'slack_webapi_platform_error', data: { error: code } },
          { tool, args: { channelId: 'C1', messageId: '100.2', threadTs: '100.1' }, toolEnabled: name => name !== disabled },
        );
        if (['reply_message', 'fetch_thread', 'upload_file'].includes(tool)) {
          assert.match(text, /reply's thread=/);
        } else {
          assert.match(text, /own id=/);
          assert.doesNotMatch(text, /thread=/);
        }
      }
    }
  }
});

test('messaging receives addressed traffic without tools when its tools are disabled', async t => {
  // History and always-available tools may remain: only messaging's tools matter.
  const disabledTools = ['send_message', 'reply_message', 'upload_file', 'send_dm', 'add_reaction', 'edit_message', 'delete_message'];
  for (const disabled of [disabledTools, toolDefinitions.map(tool => tool.name)]) {
    const fake = fakeSlack();
    const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: disabled }));
    t.after(() => h.close());
    await initialize(h, true);
    assert.ok(!buildFeatureSets(disabled)['slack.messaging'].uses.includes('tools'));
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT.filter(path => path !== 'tools') });
    await fake.socket.emitMessage(MENTION_EVENT);
    await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'mention without tools capability');
  }
  assert.ok(buildFeatureSets(disabledTools.slice(1))['slack.messaging'].uses.includes('tools'));
});

test('read bounds and author validation do not recommend disabled tools', async t => {
  const h = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools: ['fetch_history'] }));
  t.after(() => h.close());
  await initialize(h, false);
  for (const bound of ['oldest', 'latest']) {
    const text = await call(h.host, 'fetch_thread', { channelId: 'C1', threadTs: '100.1', [bound]: 'bad' });
    assert.doesNotMatch(text, /fetch_history/);
    assert.match(text, /own id=/);
  }
  const users = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools: ['find_user'] }));
  t.after(() => users.close());
  await initialize(users, false);
  for (const authorIds of [[], ['bad']]) {
    const text = await call(users.host, 'fetch_history', { channelId: 'C1', authorIds });
    assert.doesNotMatch(text, /find_user/);
    assert.match(text, /authorId or authorBotId/);
  }
});

test('rollback preserves failure details without advertising disabled retry tools', async t => {
  const fake = fakeSlack();
  fake.slack.deleteMessage = async () => { throw new Error('connection lost'); };
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: ['delete_message', 'fetch_history', 'fetch_thread'] }));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const sent = await h.host.sendRequest('tools/call', {
    name: 'send_message', arguments: { channelId: 'C1', content: 'hello' },
  }) as { state: { parent: string } };
  const result = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: 'slack.messaging', checkpoint: sent.state.parent,
  }) as { reason: string };
  assert.doesNotMatch(result.reason, /delete_message|fetch_history|fetch_thread/);
  assert.match(result.reason, /May remain/);
  assert.match(result.reason, /100\.1/);
  assert.match(result.reason, /Someone with access/);
});

for (const disabledTools of [['fetch_history'], ['fetch_thread'], ['delete_message'], ['delete_message', 'fetch_history', 'fetch_thread']]) {
  test(`rollback upload comments require manual checks even with disabled ${disabledTools}`, async t => {
    const fake = fakeSlack();
    let files = 0;
    fake.slack.uploadFile = async () => ({ fileId: `F${++files}` });
    const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools }));
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    for (const count of [1, 2]) {
      const threadTs = count === 2 ? '123.4' : undefined;
      let parent = '';
      for (let i = 0; i < count; i++) {
        const sent = await h.host.sendRequest('tools/call', {
          name: 'upload_file', arguments: { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'hello', messageId: threadTs },
        }) as { state: { parent: string } };
        if (i === 0) parent = sent.state.parent;
      }
      const result = await h.host.sendRequest(method.STATE_ROLLBACK, {
        featureSet: 'slack.messaging', checkpoint: parent,
      }) as { reason: string };
      for (const name of disabledTools) assert.ok(!result.reason.includes(name), result.reason);
      assert.match(result.reason, /may remain/);
      assert.match(result.reason, /C1/);
      assert.match(result.reason, /manually check Slack for the possible post/);
      assert.match(result.reason, /cannot identify it, so do not delete messages based on this notice/);
      assert.doesNotMatch(result.reason, /fetch_history|fetch_thread|delete_message|locate and delete/);
      if (threadTs) assert.match(result.reason, /in thread 123\.4/);
      assert.ok(result.reason.endsWith('.'));
      assert.doesNotMatch(result.reason, /\.\.|, and Use/);
    }
  });
}

test('ungrouped tools remain advertised and callable without tool-bearing feature sets', async t => {
  const survivors = ['list_channels', 'find_user', 'refresh_channels'];
  const disabledTools = toolDefinitions.map(tool => tool.name).filter(name => !survivors.includes(name));
  const h = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools }));
  t.after(() => h.close());
  const init = await initialize(h, true);
  assert.deepEqual(init.capabilities.tools, {});
  assert.ok(Object.values(buildFeatureSets(disabledTools)).every(set => !set.uses.includes('tools')));
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const listed = await h.host.sendRequest('tools/list', {}) as { tools: { name: string }[] };
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...survivors].sort());
  for (const name of survivors) {
    const result = await h.host.sendRequest('tools/call', { name, arguments: name === 'find_user' ? { query: 'alice' } : {} }) as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /capability|not granted|disabled by operator/);
  }
});


for (const policy of [{ disableDms: true }, { sendChannels: ['C1'] }]) {
  test(`DM policy does not leave tool-free messaging dependent on tools: ${JSON.stringify(policy)}`, async t => {
    const disabledTools = ['send_message', 'reply_message', 'upload_file', 'add_reaction', 'edit_message', 'delete_message'];
    const fake = fakeSlack(policy);
    const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools }));
    t.after(() => h.close());
    const init = await initialize(h, true);
    const manifest = init.capabilities.experimental as { mcpl: { featureSets: Record<string, { uses: string[] }> } };
    assert.ok(!manifest.mcpl.featureSets['slack.messaging'].uses.includes('tools'));
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT.filter(path => path !== 'tools') });
    await fake.socket.emitMessage({ ...MENTION_EVENT, channel_type: 'channel' });
    await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'mention under DM policy');
  });
}

test('disabled fetch_history does not suppress automatic backscroll', async t => {
  const fake = fakeSlack({ historyMessages: [{ ts: '99.1', user: 'U2', text: 'automatic context survives' }] });
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: ['fetch_history'] }));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await fake.socket.emitMessage(MENTION_EVENT);
  await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'mention with automatic backscroll');
  assert.match(JSON.stringify(h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params), /automatic context survives/);
});

for (const disabled of ['send_message', 'reply_message']) {
  test(`publish thread remedy is a standalone sentence without ${disabled}`, () => {
    const text = explainSlackError({ code: 'slack_webapi_platform_error', data: { error: 'thread_not_found' } }, {
      tool: 'channels/publish', args: { channelId: 'C1', threadTs: '100.1' }, toolEnabled: name => name !== disabled,
    });
    assert.doesNotMatch(text, new RegExp(disabled));
    assert.ok(text.endsWith(disabled === 'send_message'
      ? 'reply_message posts under a message you choose.'
      : 'send_message posts in the conversation itself.'), text);
  });
}

test('closed edit window names Slack access when posting tools are disabled', () => {
  const text = explainSlackError({ code: 'slack_webapi_platform_error', data: { error: 'edit_window_closed' } }, {
    tool: 'edit_message', args: { channelId: 'C1', messageId: '100.1' },
    toolEnabled: name => !['send_message', 'reply_message'].includes(name),
  });
  assert.match(text, /Someone with Slack access can post a correction/);
  assert.doesNotMatch(text, /send_message|reply_message/);
});

test('DM refusal retains channel posting advice without list_channels', async t => {
  const h = connectHost(new SlackMcplServer(fakeSlack({ sendChannels: ['C1'] }).slack, { disabledTools: ['list_channels'] }));
  t.after(() => h.close());
  await initialize(h, false);
  const text = await call(h.host, 'send_dm', { userId: 'U1', content: 'hi' });
  assert.match(text, /post in a writable channel with send_message\./);
  assert.match(text, /Copy channelId from an incoming channel message/);
  assert.doesNotMatch(text, /list_channels/);
});

test('malformed author values do not suppress an available find_user hint', async t => {
  const h = connectHost(new SlackMcplServer(fakeSlack().slack, { disabledTools: ['send_message'] }));
  t.after(() => h.close());
  await initialize(h, false);
  assert.match(await call(h.host, 'fetch_history', { channelId: 'C1', authorIds: ['send_message'] }), /find_user/);
});

test('rollback comments require manual checks even without the host history grant', async t => {
  const fake = fakeSlack();
  fake.slack.uploadFile = async () => ({ fileId: 'F1' });
  const h = connectHost(new SlackMcplServer(fake.slack));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT, disabled: ['slack.history'] });
  const sent = await h.host.sendRequest('tools/call', {
    name: 'upload_file', arguments: { channelId: 'C1', filename: 'a.txt', content: 'a', comment: 'hello', messageId: '123.4' },
  }) as { state: { parent: string } };
  const result = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: 'slack.messaging', checkpoint: sent.state.parent,
  }) as { reason: string };
  assert.match(result.reason, /Someone with access.*thread 123.4/);
  assert.doesNotMatch(result.reason, /fetch_history|fetch_thread/);
});

test('omitted feature sets cannot become active by host selection', async () => {
  const { CapabilityGrant } = await import('../src/grant.js');
  const grant = new CapabilityGrant({});
  grant.apply({ effectiveCapabilities: FULL_GRANT, enabled: ['slack.history'] }, 'request');
  assert.equal(grant.isFeatureSetActive('slack.history'), false);
});

test('optional Slack-error sentences have no trailing or doubled spaces', () => {
  for (const disabled of [[], ['list_channels'], ['reply_message'], ['send_message'], ['send_message', 'reply_message']]) {
    for (const code of ['channel_not_found', 'invalid_channel_id', 'not_in_channel', 'edit_window_closed', 'user_not_found', 'restricted_action_thread_only_channel']) {
      const text = explainSlackError({ code: 'slack_webapi_platform_error', data: { error: code } }, {
        tool: 'send_message', args: { channelId: 'C1' }, toolEnabled: name => !disabled.includes(name),
      }).split('\n\n').at(-1)!;
      assert.ok(text.length > 0, code);
      assert.equal(text, text.trim());
      assert.doesNotMatch(text, / {2}/);
    }
  }
});

test('caller IDs cannot suppress available unknown-write remedies', () => {
  for (const tool of ['send_message', 'reply_message', 'upload_file', 'edit_message']) {
    const text = explainSlackError({ code: 'slack_webapi_platform_error', data: { error: 'internal_error' } }, {
      tool, args: { channelId: 'delete_message', messageId: 'delete_message' },
      toolEnabled: name => name !== 'delete_message',
    });
    assert.match(text, tool === 'reply_message' || tool === 'upload_file' ? /Check fetch_thread/ : /fetch_history/);
    assert.doesNotMatch(text, /ask someone with access|Ask someone with Slack access/);
  }
});

test('disabled sending omits channel discovery from DM policy advice', async t => {
  const fake = fakeSlack({ disableDms: true });
  const h = connectHost(new SlackMcplServer(fake.slack, { disabledTools: ['send_message'] }));
  t.after(() => h.close());
  await initialize(h, false);
  const text = await call(h.host, 'send_dm', { userId: 'U1', content: 'hi' });
  assert.match(text, /Someone with Slack access can contact the recipient/);
  assert.doesNotMatch(text, /list_channels|writable channel/);
});

test('disabled history fallback names the sending result for bot message IDs', () => {
  for (const tool of ['edit_message', 'delete_message']) {
    const text = explainSlackError(
      { code: 'slack_webapi_platform_error', data: { error: 'message_not_found' } },
      { tool, args: { channelId: 'C1', messageId: '100.2' },
        toolEnabled: name => !['fetch_history', 'fetch_thread'].includes(name) },
    );
    assert.match(text, /messageId from the original sending tool's result/);
  }
});

test('disabled subscribe mute advice distinguishes memory from persisted state', async t => {
  const previous = process.env.SLACK_SUBSCRIPTIONS_FILE;
  const dir = mkdtempSync(join(tmpdir(), 'mute-'));
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_SUBSCRIPTIONS_FILE;
    else process.env.SLACK_SUBSCRIPTIONS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  for (const persisted of [false, true]) {
    if (persisted) process.env.SLACK_SUBSCRIPTIONS_FILE = join(dir, 'subscriptions.json');
    else delete process.env.SLACK_SUBSCRIPTIONS_FILE;
    const h = connectHost(new SlackMcplServer(fakeSlack().slack, {
      disabledTools: ['subscribe_channel'], subscribeMemberChannels: true,
    }));
    try {
      await initialize(h, false);
      const text = await call(h.host, 'unsubscribe_channel', { channelId: 'C1' });
      assert.equal(text.includes('or this server restarts'), !persisted);
    } finally { await h.close(); }
  }
});
