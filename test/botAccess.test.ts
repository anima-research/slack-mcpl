import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import type { SlackMessageData } from '../src/slack-adapter.js';
import { accessTest as test, accessFixture, joined } from './adapterAccessFixture.js';
import { connectHost, FULL_GRANT, initialize, until } from './harness.js';
import { virtualClock } from './virtualClock.js';

for (const open of [false, true]) {
  const lane = open ? method.CHANNELS_INCOMING : method.PUSH_EVENT;
  test(`policy admission and final membership checks apply to bot messages on ${lane}`, async t => {
    virtualClock(t);
    const f = accessFixture({ botMessages: ['BOTHER'] });
    f.state.listed = [joined()];
    const server = new SlackMcplServer(f.adapter);
    const h = connectHost(server);
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
    if (open) await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1' });

    // Isolate inbound and final admission from optional backscroll lookups.
    t.mock.method(f.adapter, 'fetchHistory', async () => ({ messages: [] }));
    let membership: boolean[] = [];
    let observed: boolean[] = [];
    t.mock.method(f.web.conversations, 'info', async () => {
      const is_member = membership.shift();
      assert.notEqual(is_member, undefined, 'unexpected membership lookup');
      observed.push(is_member!);
      return { channel: { ...joined(), is_member } };
    });
    const send = (ts: string) => f.emit({
      type: 'message', subtype: 'bot_message', bot_id: 'BOTHER', username: 'integration',
      text: '<@UBOT> status', channel: 'C1', channel_type: 'channel', ts,
      files: [{ mode: 'hosted', id: 'F1', url_private: 'https://files.slack.com/private' }],
    });
    const deliveries = () => h.hostSaw.filter(r => r.method === lane);
    for (const [ts, sequence] of [['2.0', [false]], ['3.0', [true, false]], ['4.0', [true, true]]] as const) {
      membership = [...sequence];
      observed = [];
      assert.equal(await send(ts), true);
      assert.deepEqual(observed, sequence, 'bot reached the same fresh membership checks');
      assert.equal(deliveries().length, ts === '4.0' ? 1 : 0);
    }
    const params = deliveries()[0].params as any;
    const message = open ? params.messages[0] : params;
    const identity = open ? message.metadata : message.origin;
    assert.equal(identity.isBot, true);
    assert.equal(identity.authorBotId, 'BOTHER');
    assert.ok(message.tags.includes('chat:from-bot'));
    assert.match(JSON.stringify(params), /fileId/);
    assert.doesNotMatch(JSON.stringify(params), /files\.slack\.com/);
  });
}

test('an allow-listed bot still needs the policy-admitted user identity in a one-to-one DM', async t => {
  virtualClock(t);
  const f = accessFixture({ botMessages: ['BOTHER'] });
  f.state.conversation = { id: 'D1', is_im: true, is_mpim: false, user: 'U1' };
  const received: SlackMessageData[] = [];
  f.adapter.onMessage(msg => received.push(msg));
  const send = (ts: string, user?: string) => f.emit({
    type: 'message', subtype: 'bot_message', bot_id: 'BOTHER', channel: 'D1', channel_type: 'im',
    text: 'status', ts, user,
  });
  await send('1.0'); // Bot ID alone is not a DM peer.
  await send('2.0', 'U2'); // Not a policy-admitted peer.
  assert.deepEqual(f.methods(), []);
  await send('3.0', 'W1'); // Policy admits W1, but it is not this conversation's peer.
  assert.deepEqual(f.methods(), ['info']);
  assert.equal(received.length, 0);
  await send('4.0', 'U1');
  assert.deepEqual(received.map(m => [m.id, m.isBot, m.isDM]), [['4.0', true, true]]);
});
