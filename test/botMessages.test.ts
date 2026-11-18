/** Bot delivery through authentication and the real MCPL delivery lanes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SocketModeClient } from '@slack/socket-mode';
import { connectSlack, type SlackMessageData } from '../src/slack-adapter.js';
import { buildFeatureSets, MESSAGING_FEATURE_SET } from '../src/feature-sets.js';
import { startupSettings } from '../src/config.js';
import { fakeSlackApi } from './slackApi.js';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until } from './botHarness.js';

for (const lane of [method.PUSH_EVENT, method.CHANNELS_INCOMING]) {
  for (const policy of ['all', ['BOTHER', 'UBOT', 'BSELF', 'U2']] as const) {
    test(`opted-in bot messages are marked on ${lane} (${typeof policy === 'string' ? 'all' : 'list'})`, async (t) => {
      const h = harness({ botMessages: typeof policy === 'string' ? policy : [...policy] });
      t.after(() => h.close());
      await initialize(h, true);
      await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
      await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
      if (lane === method.CHANNELS_INCOMING) {
        await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1' });
      }

      const deliveries = () => h.hostSaw.filter((r) => r.method === lane);
      // Each self identity is tested alone, including in all mode.
      await h.socket.emitMessage({ ...MENTION_EVENT, bot_id: undefined, user: 'UBOT' });
      await h.socket.emitMessage({ ...MENTION_EVENT, bot_id: 'BSELF', user: undefined });
      if (Array.isArray(policy)) await h.socket.emitMessage({ ...MENTION_EVENT, user: 'UDENIED', bot_id: 'BDENIED' });
      assert.equal(deliveries().length, 0);

      await h.socket.emitMessage({ ...MENTION_EVENT, subtype: 'bot_message', bot_id: 'BOTHER' });
      await until(() => deliveries().length === 1, 'bot delivery');
      const params = deliveries()[0].params as any;
      const message = lane === method.CHANNELS_INCOMING ? params.messages[0] : params;
      const identity = lane === method.CHANNELS_INCOMING ? message.metadata : message.origin;
      assert.equal(identity.isBot, true);
      assert.equal(identity.authorBotId, 'BOTHER');
      assert.ok(message.tags.includes('chat:from-bot'));
      assert.ok(!message.tags.includes('chat:from-human'));
      assert.ok(message.tags.includes('chat:addressed'));
      const content = lane === method.CHANNELS_INCOMING ? message.content : message.payload.content;
      assert.match(content.map((b: any) => b.text ?? '').join('\n'), /\[Slack source: bot\]/);
      if (Array.isArray(policy)) {
        // The harness omits is_bot: a listed, user-only unknown must still
        // arrive conservatively tagged, not silently reclassified as human.
        await h.socket.emitMessage({ ...MENTION_EVENT, ts: '112.0' });
        await until(() => deliveries().length === 2, 'listed unknown delivery');
        const nextParams = deliveries()[1].params as any;
        const next = lane === method.CHANNELS_INCOMING ? nextParams.messages[0] : nextParams;
        const nextIdentity = lane === method.CHANNELS_INCOMING ? next.metadata : next.origin;
        assert.equal(nextIdentity.isBot, true);
        assert.equal(nextIdentity.authorBotId, undefined);
        const nextContent = lane === method.CHANNELS_INCOMING ? next.content : next.payload.content;
        assert.match(nextContent.map((b: any) => b.text ?? '').join('\n'), /\[Slack source: bot\]/);
        assert.ok(next.tags.includes('chat:from-bot'));
        assert.ok(!next.tags.includes('chat:from-human'));
      }
    });
  }
}

test('startup policy and authenticated bot ID reach the Socket Mode self-filter', async (t) => {
  const api = await fakeSlackApi();
  t.after(() => api.close());
  api.answerFor('auth.test', { body: { ok: true, user_id: 'UBOT', bot_id: 'BSELF', team: 'acme' } });
  api.answerFor('users.info', { body: { ok: true, user: { name: 'other', is_bot: true } } });
  const startup = startupSettings(['--stdio'], {
    SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_BOT_MESSAGES: 'all',
  });
  assert.ok('settings' in startup);
  let emit: (args: any) => void;
  // Capture the production Socket Mode subscription; no network socket needed.
  const original = SocketModeClient.prototype.on;
  t.mock.method(SocketModeClient.prototype, 'on', function (this: SocketModeClient, name: string, handler: any) {
    if (name === 'message') emit = handler;
    return original.call(this, name, handler);
  });
  const slack = await connectSlack(startup.settings, api.url);
  const received: SlackMessageData[] = [];
  slack.onMessage((msg) => received.push(msg));
  let acked = 0;
  for (const identity of [{ bot_id: 'BSELF' }, { user: 'UBOT' }, { bot_id: 'BOTHER', user: 'UOTHER' }]) {
    emit!({ event: { ...MENTION_EVENT, user: undefined, ...identity }, ack: async () => { acked++; } });
  }
  await until(() => received.length === 1 && acked === 3, 'authenticated bot admission');
  assert.equal(received[0].authorBotId, 'BOTHER');
  assert.equal(received[0].isBot, true);
  assert.deepEqual(api.calls, ['auth.test', 'users.info', 'users.info']);
});

test('messaging ontology declares the bot sender tag', () => {
  assert.ok(buildFeatureSets(true)[MESSAGING_FEATURE_SET].tagOntology!.coreTags?.includes('chat:from-bot'));
});

test('Socket Mode user-only sender cannot bypass a list after a real Slack refusal', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const api = await fakeSlackApi();
  t.after(() => api.close());
  api.answerFor('auth.test', { body: { ok: true, user_id: 'UBOT', bot_id: 'BSELF', team: 'acme' } });
  api.answerFor('users.info',
    { body: { ok: false, error: 'missing_scope' } },
    { body: { ok: true, user: { name: 'unlisted-bot', is_bot: true } } },
  );
  let emit: (args: any) => void;
  const original = SocketModeClient.prototype.on;
  t.mock.method(SocketModeClient.prototype, 'on', function (this: SocketModeClient, name: string, handler: any) {
    if (name === 'message') emit = handler;
    return original.call(this, name, handler);
  });
  const slack = await connectSlack({
    botToken: 'xoxb-test', appToken: 'xapp-test', botMessages: ['BALLOWED'],
  }, api.url);
  const received: SlackMessageData[] = [];
  slack.onMessage((msg) => received.push(msg));
  for (let n = 1; n <= 3; n++) {
    // Same-conversation admitted markers settle after the preceding sender's
    // processing, so absence assertions do not depend on arbitrary sleeps.
    emit!({ event: { type: 'message', channel: 'C1', user: 'UUNKNOWN', ts: `${n}.0` }, ack: async () => {} });
    emit!({ event: { type: 'message', channel: 'C1', bot_id: 'BALLOWED', ts: `${n}.1` }, ack: async () => {} });
    await until(() => received.some(m => m.id === `${n}.1`), 'settled sender and marker');
    assert.deepEqual(received.map(m => m.authorId), Array(n).fill('BALLOWED'));
    now += 30_000;
  }
  assert.equal(api.calls.filter(m => m === 'users.info').length, 1, 'permanent refusal remains negative, not a verified identity');
});

for (const lane of [method.PUSH_EVENT, method.CHANNELS_INCOMING]) {
  for (const failure of ['offline', 'missing_scope']) {
    test(`all-mode ${failure} user-only lookup stays non-bot on ${lane}`, async t => {
      const h = harness({ botMessages: 'all' });
      t.after(() => h.close());
      await initialize(h, true);
      await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
      await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
      if (lane === method.CHANNELS_INCOMING) await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1' });
      (h.server as any).slack.web.users.info = async () => {
        throw failure === 'missing_scope'
          ? Object.assign(new Error(failure), { code: 'slack_webapi_platform_error', data: { error: failure } })
          : new Error(failure);
      };
      await h.socket.emitMessage({ ...MENTION_EVENT, user: 'UUNKNOWN' });
      await until(() => h.hostSaw.some(r => r.method === lane), 'delivery');
      const params = h.hostSaw.find(r => r.method === lane)!.params as any;
      const msg = lane === method.CHANNELS_INCOMING ? params.messages[0] : params;
      assert.ok(!msg.tags.includes('chat:from-bot'));
      assert.ok(msg.tags.includes('chat:from-human'));
      assert.equal((lane === method.CHANNELS_INCOMING ? msg.metadata : msg.origin).isBot, undefined);
      const content = lane === method.CHANNELS_INCOMING ? msg.content : msg.payload.content;
      assert.doesNotMatch(content.map((b: any) => b.text ?? '').join('\n'), /\[Slack source: bot\]/);
    });
  }
}

for (const botMessages of [undefined, 'all', ['BOTHER', 'U2']] as const) {
test(`backscroll always filters own user ID and filters own bot ID when opted in: ${botMessages}`, async t => {
  const h = harness({ botMessages: typeof botMessages === 'object' ? [...botMessages] : botMessages, historyMessages: [
    { ts: '99.0', user: 'UBOT', text: 'OWN_USER_BACKSCROLL_POST' },
    { ts: '100.0', bot_id: 'BSELF', text: 'OWN_BACKSCROLL_POST' },
    { ts: '101.0', bot_id: 'BOTHER', text: 'OTHER_BACKSCROLL_POST' },
  ] });
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
  await h.socket.emitMessage(MENTION_EVENT);
  await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'delivery');
  const push = h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params as any;
  const text = push.payload.content.map((b: any) => b.text ?? '').join('\n');
  assert.equal(text.includes('OWN_BACKSCROLL_POST'), botMessages === undefined);
  assert.match(text, /OTHER_BACKSCROLL_POST/);
  assert.doesNotMatch(text, /OWN_USER_BACKSCROLL_POST/);
});

}

for (const lane of [method.PUSH_EVENT, method.CHANNELS_INCOMING]) {
  test(`newly verified unlisted human stays human on ${lane}`, async t => {
    const h = harness({ botMessages: ['BALLOWED'] });
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
    if (lane === method.CHANNELS_INCOMING) await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1' });
    const lookups: string[] = [];
    (h.server as any).slack.web.users.info = async ({ user }: { user: string }) => {
      lookups.push(user);
      return { user: { name: 'human', is_bot: false } };
    };
    await h.socket.emitMessage({ ...MENTION_EVENT, user: 'UHUMAN' });
    await until(() => h.hostSaw.some(r => r.method === lane), 'human delivery');
    assert.ok(lookups.includes('UHUMAN'), 'sender verified on first delivery');
    const params = h.hostSaw.find(r => r.method === lane)!.params as any;
    const msg = lane === method.CHANNELS_INCOMING ? params.messages[0] : params;
    assert.ok(msg.tags.includes('chat:from-human'));
    assert.ok(!msg.tags.includes('chat:from-bot'));
    const identity = lane === method.CHANNELS_INCOMING ? msg.metadata : msg.origin;
    assert.equal(identity.isBot, undefined);
    assert.equal(identity.authorBotId, undefined);
    const content = lane === method.CHANNELS_INCOMING ? msg.content : msg.payload.content;
    assert.doesNotMatch(content.map((b: any) => b.text ?? '').join('\n'), /\[Slack source: bot\]/);
  });
}


test('connectSlack refuses an allow-list when auth.test reports no users:read', async t => {
  const api = await fakeSlackApi();
  t.after(() => api.close());
  api.answerFor('auth.test', {
    headers: { 'x-oauth-scopes': 'chat:write,channels:read' },
    body: { ok: true, user_id: 'UBOT', bot_id: 'BSELF', team: 'acme' },
  });
  await assert.rejects(connectSlack({
    botToken: 'xoxb-test', appToken: 'xapp-test', botMessages: ['BALLOWED'],
  }, api.url), /users:read/);
  assert.deepEqual(api.calls, ['auth.test']);
});
