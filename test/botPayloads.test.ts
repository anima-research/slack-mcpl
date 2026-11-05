/** Integration bot payloads through the real live delivery lanes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { startupSettings } from '../src/config.js';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until } from './harness.js';

const blocks = [
  { type: 'section', text: { type: 'mrkdwn', text: '*Header*' } },
  { type: 'section', text: { type: 'mrkdwn', text: 'Body' } },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Context' }] },
];
const shapes = [
  { name: 'Notification and section blocks', payload: { text: 'Notification', blocks }, expected: 'Notification\n*Header*\nBody\nContext' },
  { name: 'absent text and colour attachment blocks', payload: { attachments: [{ color: '#36a64f', blocks }] }, expected: '*Header*\nBody\nContext' },
];
for (const lane of [method.PUSH_EVENT, method.CHANNELS_INCOMING]) {
  for (const shape of shapes) {
    test(`SLACK_BOT_MESSAGES=all: ${shape.name} on ${lane}; self still dropped`, async t => {
      const startup = startupSettings(['--stdio'], {
        SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_BOT_MESSAGES: 'all',
      });
      assert.ok('settings' in startup);
      const h = harness({ subscribeMemberChannels: true, botMessages: startup.settings.botMessages });
      t.after(() => h.close());
      await initialize(h, true);
      await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
      await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
      if (lane === method.CHANNELS_INCOMING) await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1' });
      const { text: _text, ...base } = MENTION_EVENT;
      const event = { ...base, subtype: 'bot_message', user: undefined, ...shape.payload };
      if (!('text' in shape.payload)) assert.equal(Object.hasOwn(event, 'text'), false);
      const deliveries = () => h.hostSaw.filter(r => r.method === lane);
      await h.socket.emitMessage({ ...event, bot_id: 'BSELF' });
      await h.socket.emitMessage({ ...event, bot_id: 'BOTHER', user: 'UBOT' });
      assert.equal(deliveries().length, 0);
      await h.socket.emitMessage({ ...event, bot_id: 'BOTHER' });
      await until(() => deliveries().length === 1, 'integration bot delivery');
      const params = deliveries()[0].params as any;
      const message = lane === method.CHANNELS_INCOMING ? params.messages[0] : params;
      const content = lane === method.CHANNELS_INCOMING ? message.content : message.payload.content;
      const rendered = content.map((b: any) => b.text ?? '').join('\n');
      assert.ok(rendered.endsWith('BOTHER: ' + shape.expected.replaceAll('\n', '\n  ')), JSON.stringify(rendered));
      assert.ok(!rendered.includes('undefined'));
      assert.ok(message.tags.includes('chat:from-bot'));
      const metadata = lane === method.CHANNELS_INCOMING ? message.metadata : message.origin;
      // #65 exposes raw text and mention IDs only on channels/incoming.
      if (lane === method.CHANNELS_INCOMING) {
        assert.equal(metadata.rawContent, 'text' in shape.payload ? shape.payload.text : '');
        assert.deepEqual(metadata.mentionIds, []);
      }
      assert.equal(metadata.isMention, false);
    });
  }
}
