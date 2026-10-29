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
const listed = async (server: SlackMcplServer) => JSON.parse((await call(server, 'list_subscriptions')).content[0].text);

test('without the switch, a channel is subscribed only after subscribe_channel', async () => {
  delete process.env.SLACK_SUBSCRIPTIONS_FILE;
  const server = new SlackMcplServer({ onMessage() {} } as any);
  assert.deepEqual((await listed(server)).channels, []);
  await call(server, 'subscribe_channel', { channelId: 'C1' });
  assert.deepEqual((await listed(server)).channels, ['C1']);
});

test('with the switch, unsubscribe_channel mutes and subscribe_channel unmutes', async () => {
  delete process.env.SLACK_SUBSCRIPTIONS_FILE;
  const server = new SlackMcplServer({ onMessage() {} } as any, { subscribeMemberChannels: true });
  assert.deepEqual((await listed(server)).muted, []);

  assert.match(text(await call(server, 'unsubscribe_channel', { channelId: 'C1' })), /Muted/);
  assert.deepEqual((await listed(server)).muted, ['C1'], 'only C1 is muted');

  assert.match(text(await call(server, 'subscribe_channel', { channelId: 'C1' })), /Unmuted/);
  assert.deepEqual((await listed(server)).muted, []);
});

test('a mute survives a restart when SLACK_SUBSCRIPTIONS_FILE is set', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'slack-mcpl-')), 'subs.json');
  process.env.SLACK_SUBSCRIPTIONS_FILE = file;
  try {
    const first = new SlackMcplServer({ onMessage() {} } as any, { subscribeMemberChannels: true });
    await call(first, 'unsubscribe_channel', { channelId: 'C1' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { subscribed: [], muted: ['C1'] });

    const second = new SlackMcplServer({ onMessage() {} } as any, { subscribeMemberChannels: true });
    assert.deepEqual((await listed(second)).muted, ['C1']);

    // Nothing muted: the file is a plain array again, as older versions write it.
    await call(second, 'subscribe_channel', { channelId: 'C1' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), []);
  } finally {
    delete process.env.SLACK_SUBSCRIPTIONS_FILE;
  }
});
