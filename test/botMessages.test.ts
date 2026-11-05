/** Bot delivery through authentication and the real MCPL delivery lanes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SocketModeClient } from '@slack/socket-mode';
import { connectSlack, type SlackMessageData } from '../src/slack-adapter.js';
import { SLACK_TAG_ONTOLOGY } from '../src/feature-sets.js';
import { startupSettings } from '../src/config.js';
import { fakeSlackApi } from './slackApi.js';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until } from './harness.js';

for (const lane of [method.PUSH_EVENT, method.CHANNELS_INCOMING]) {
  test(`opted-in bot messages are marked on ${lane}`, async (t) => {
    const h = harness({ botMessages: ['BOTHER', 'UBOT', 'BSELF'] });
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
    if (lane === method.CHANNELS_INCOMING) {
      await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1' });
    }

    const deliveries = () => h.hostSaw.filter((r) => r.method === lane);
    // Even an addressed self-message or unlisted bot must never reach the host.
    await h.socket.emitMessage({ ...MENTION_EVENT, bot_id: undefined, user: 'UBOT' });
    await h.socket.emitMessage({ ...MENTION_EVENT, bot_id: 'BSELF', user: undefined });
    await h.socket.emitMessage({ ...MENTION_EVENT, bot_id: 'BDENIED' });
    assert.equal(deliveries().length, 0);

    await h.socket.emitMessage({ ...MENTION_EVENT, subtype: 'bot_message', bot_id: 'BOTHER' });
    await until(() => deliveries().length === 1, 'bot delivery');
    const params = deliveries()[0].params as any;
    const message = lane === method.CHANNELS_INCOMING ? params.messages[0] : params;
    assert.ok(message.tags.includes('chat:from-bot'));
    assert.ok(!message.tags.includes('chat:from-human'));
    assert.ok(message.tags.includes('chat:addressed'));
    const content = lane === method.CHANNELS_INCOMING ? message.content : message.payload.content;
    assert.match(content.map((b: any) => b.text ?? '').join('\n'), /\[Slack source: bot\]/);
  });
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
  assert.ok(SLACK_TAG_ONTOLOGY.coreTags?.includes('chat:from-bot'));
});

test('Socket Mode user-only sender cannot bypass a list after a real Slack refusal', async (t) => {
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
  }
  assert.equal(api.calls.filter(m => m === 'users.info').length, 2, 'retry refusal, then cache verified bot');
});
