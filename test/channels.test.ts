/**
 * Tests for MCPL channel ID mapping and the ChannelManager.
 *
 * Run: node --import tsx --test test/channels.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mcplChannelId, parseMcplChannelId, toDescriptor, ChannelManager } from '../src/channels.js';

test('mcplChannelId round-trips through parseMcplChannelId', () => {
  assert.equal(mcplChannelId('C123'), 'slack:C123');
  assert.deepEqual(parseMcplChannelId('slack:C123'), { conversationId: 'C123' });
});

test('parseMcplChannelId rejects foreign and empty IDs', () => {
  assert.equal(parseMcplChannelId('discord:1:2'), null);
  assert.equal(parseMcplChannelId('slack:'), null);
  assert.equal(parseMcplChannelId('C123'), null);
});

test('toDescriptor labels channels, DMs, and group DMs distinctly', () => {
  const chan = toDescriptor({ id: 'C1', kind: 'channel', name: 'general', isMember: true }, 'acme');
  assert.equal(chan.id, 'slack:C1');
  assert.equal(chan.label, '#general (acme)');

  const dm = toDescriptor({ id: 'D1', kind: 'dm', name: 'alice', userId: 'U1', isMember: true }, 'acme');
  assert.equal(dm.label, 'DM: @alice (acme)');
  assert.deepEqual(dm.address, { channelId: 'D1', userId: 'U1' });

  const gdm = toDescriptor({ id: 'G1', kind: 'group_dm', name: 'mpdm-a--b-1', isMember: true }, 'acme');
  assert.equal(gdm.label, 'Group DM: mpdm-a--b-1 (acme)');
});

test('ChannelManager tracks registered vs open channels', () => {
  const mgr = new ChannelManager();
  const desc = toDescriptor({ id: 'C1', kind: 'channel', name: 'general', isMember: true }, 'acme');
  mgr.register(desc);

  assert.equal(mgr.isOpen('slack:C1'), false);
  assert.equal(mgr.openByConversationId('C1')?.id, 'slack:C1');
  assert.equal(mgr.isOpen('slack:C1'), true);
  assert.equal(mgr.close('slack:C1'), true);
  assert.equal(mgr.isOpen('slack:C1'), false);

  // Opening an unregistered channel is a no-op
  assert.equal(mgr.open('slack:C404'), undefined);
  assert.equal(mgr.isOpen('slack:C404'), false);

  assert.equal(mgr.unregister('slack:C1'), true);
  assert.deepEqual(mgr.getAll(), []);
});

test('a conversation the bot may not write to is inbound only', () => {
  const conv = { id: 'C1', kind: 'channel' as const, name: 'general', isMember: true };
  assert.equal(toDescriptor(conv, 'acme').direction, 'bidirectional');
  assert.equal(toDescriptor(conv, 'acme', true).direction, 'bidirectional');
  assert.equal(toDescriptor(conv, 'acme', false).direction, 'inbound');
});
