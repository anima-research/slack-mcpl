/**
 * Tests for SLACK_SUBSCRIBE_MEMBER_CHANNELS: every delivered channel counts as
 * subscribed, and unsubscribe_channel mutes one.
 *
 * Run: node --import tsx --test test/subscribeMemberChannels.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackMcplServer } from '../src/server.js';

const text = (r: unknown) => JSON.stringify(r);
const call = (server: SlackMcplServer, name: string, args: Record<string, unknown> = {}) =>
  (server as any).handleToolCall(name, args);

test('without the switch, a channel is subscribed only after subscribe_channel', async () => {
  delete process.env.SLACK_SUBSCRIPTIONS_FILE;
  const server = new SlackMcplServer({} as any);
  assert.equal((server as any).isChannelSubscribed('C1'), false);
  await call(server, 'subscribe_channel', { channelId: 'C1' });
  assert.equal((server as any).isChannelSubscribed('C1'), true);
});

test('with the switch, unsubscribe_channel mutes and subscribe_channel unmutes', async () => {
  delete process.env.SLACK_SUBSCRIPTIONS_FILE;
  const server = new SlackMcplServer({} as any, { subscribeMemberChannels: true });
  const is = (id: string) => (server as any).isChannelSubscribed(id);
  assert.equal(is('C1'), true);

  assert.match(text(await call(server, 'unsubscribe_channel', { channelId: 'C1' })), /Muted/);
  assert.equal(is('C1'), false, 'muted');
  assert.equal(is('C2'), true, 'others are unaffected');
  const listed = await call(server, 'list_subscriptions');
  assert.deepEqual(JSON.parse(listed.content[0].text).muted, ['C1']);

  assert.match(text(await call(server, 'subscribe_channel', { channelId: 'C1' })), /Unmuted/);
  assert.equal(is('C1'), true);
});

test('a mute survives a restart when SLACK_SUBSCRIPTIONS_FILE is set', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'slack-mcpl-')), 'subs.json');
  process.env.SLACK_SUBSCRIPTIONS_FILE = file;
  try {
    const first = new SlackMcplServer({} as any, { subscribeMemberChannels: true });
    await call(first, 'unsubscribe_channel', { channelId: 'C1' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { subscribed: [], muted: ['C1'] });

    const second = new SlackMcplServer({} as any, { subscribeMemberChannels: true });
    assert.equal((second as any).isChannelSubscribed('C1'), false);

    // Nothing muted: the file is a plain array again, as older versions write it.
    await call(second, 'subscribe_channel', { channelId: 'C1' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), []);
  } finally {
    delete process.env.SLACK_SUBSCRIPTIONS_FILE;
  }
});
