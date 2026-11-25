/** Subscription wording must distinguish eligibility from delivery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackMcplServer } from '../src/server.js';

for (const subscribeMemberChannels of [false, true]) {
  test(`subscription results qualify delivery in member mode ${subscribeMemberChannels}`, async () => {
    const server = new SlackMcplServer({ onMessage() {}, botMessages: 'all' } as any, { subscribeMemberChannels });
    const call = async (name: string, args = {}) =>
      (server as any).handleToolCall(name, args);
    const text = (r: any) => r.content[0].text as string;
    const list = async () => JSON.parse(text(await call('list_subscriptions')));
    const deliveryConditions = /Delivery requires active slack\.messaging, and the host can still reject messages\./;
    const checkList = async (ids: string[]) => {
      const result = await list();
      assert.deepEqual(subscribeMemberChannels ? result.muted : result.channels, ids);
      assert.match(result.note, /Mentions and DMs bypass subscriptions, subject to admission controls\./);
      if (subscribeMemberChannels || ids.length) {
        assert.match(result.note, /Admitted ambient messages .*eligible for delivery/);
        assert.match(result.note, deliveryConditions);
      } else {
        assert.match(result.note, /No ambient subscriptions\./);
      }
    };
    await checkList([]);
    if (subscribeMemberChannels) {
      const muted = text(await call('unsubscribe_channel', { channelId: 'C1' }));
      assert.match(muted, /Admitted mentions and DMs from there still bypass ambient subscriptions\./);
      await checkList(['C1']);
    }
    const subscribed = text(await call('subscribe_channel', { channelId: 'C1' }));
    assert.match(subscribed, /admitted ambient messages are eligible for delivery/);
    assert.match(subscribed, deliveryConditions);
    await checkList(subscribeMemberChannels ? [] : ['C1']);
    const unsubscribed = text(await call('unsubscribe_channel', { channelId: 'C1' }));
    assert.match(unsubscribed, /Admitted mentions and DMs from there still bypass ambient subscriptions\./);
    await checkList(subscribeMemberChannels ? ['C1'] : []);
  });
}
