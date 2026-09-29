/**
 * Tests for the location header in front of incoming messages.
 *
 * Run: node --import tsx --test test/locationHeader.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { locationHeader } from '../src/server.js';

test('same conversation, top level: message ID only', () => {
  assert.equal(locationHeader({ messageId: '2.0' }), '[id=2.0] ');
});

test('same conversation, in a thread: the thread is named every time', () => {
  assert.equal(locationHeader({ threadTs: '1.0', messageId: '2.0' }), '[thread=1.0 id=2.0] ');
});

test('conversation changed: channel and workspace lead', () => {
  assert.equal(
    locationHeader({ conversation: '#support', teamName: 'acme', threadTs: '1.0', messageId: '2.0' }),
    '[#support (acme) thread=1.0 id=2.0] ',
  );
});
