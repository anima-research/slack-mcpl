/**
 * Tests for MCPL channel ID mapping and the ChannelManager.
 *
 * Run: node --import tsx --test test/channels.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mcplChannelId, parseMcplChannelId, toDescriptor, ChannelManager } from '../src/channels.js';
import { HOSTILE_NAME as hostile, NAME_LEAK as leak } from './hostileName.js';

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

for (const kind of ['channel', 'private_channel', 'group_dm', 'dm'] as const) {
  const prefix = kind === 'dm' ? 'DM: @' : kind === 'group_dm' ? 'Group DM: ' : '';
  const sigil = kind === 'channel' || kind === 'private_channel' ? '#' : '';

  test(`toDescriptor preserves plain ${kind} names and team names`, () => {
    const desc = toDescriptor({ id: 'C1', kind, name: 'plain-name', isMember: true }, 'acme team');
    assert.equal(desc.label, `${prefix}${sigil}plain-name (acme team)`);
  });

  test(`toDescriptor quotes hostile ${kind} names losslessly`, () => {
    const desc = toDescriptor({ id: 'C1', kind, name: hostile, isMember: true }, 'acme');
    assert.doesNotMatch(desc.label, leak);
    assert.ok(desc.label.startsWith(prefix));
    assert.ok(desc.label.endsWith(' (acme)'));
    const quoted = desc.label.slice(prefix.length, -' (acme)'.length);
    assert.equal(JSON.parse(quoted), `${sigil}${hostile}`);
  });

  test(`toDescriptor quotes hostile team names for ${kind} losslessly`, () => {
    const desc = toDescriptor({ id: 'C1', kind, name: 'plain-name', isMember: true }, hostile);
    assert.doesNotMatch(desc.label, leak);
    const beforeTeam = `${prefix}${sigil}plain-name (`;
    assert.ok(desc.label.startsWith(beforeTeam));
    assert.ok(desc.label.endsWith(')'));
    assert.equal(JSON.parse(desc.label.slice(beforeTeam.length, -1)), hostile);
  });

  test(`toDescriptor omits an empty workspace for ${kind}`, () => {
    const desc = toDescriptor({ id: 'C1', kind, name: 'plain-name', isMember: true }, '');
    assert.equal(desc.label, `${prefix}${sigil}plain-name`);
  });
}

test('ChannelManager tracks registered vs open channels', () => {
  const mgr = new ChannelManager();
  const desc = toDescriptor({ id: 'C1', kind: 'channel', name: 'general', isMember: true }, 'acme');
  mgr.register(desc);

  assert.equal(mgr.isOpen('slack:C1'), false);
  assert.equal(mgr.open('slack:C1')?.id, 'slack:C1');
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
