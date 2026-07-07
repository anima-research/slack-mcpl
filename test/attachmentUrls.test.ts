/**
 * Tests for the fetch_attachment host allowlist — the bot token must only
 * ever be sent to files.slack.com.
 *
 * Run: node --import tsx --test test/attachmentUrls.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackAttachmentUrl } from '../src/content.js';

test('parseSlackAttachmentUrl accepts files.slack.com', () => {
  const url = parseSlackAttachmentUrl('https://files.slack.com/files-pri/T1-F1/screenshot.png');
  assert.equal(url.host, 'files.slack.com');
});

test('parseSlackAttachmentUrl rejects workspace and lookalike hosts', () => {
  // Workspace hosts serve /api/* — sending the bot token there is a leak.
  assert.throws(() => parseSlackAttachmentUrl('https://evil.slack.com/api/chat.postMessage?channel=C1&text=pwn'), /refusing to fetch/);
  assert.throws(() => parseSlackAttachmentUrl('https://slack.com/api/auth.test'), /refusing to fetch/);
  assert.throws(() => parseSlackAttachmentUrl('https://files.slack.com.evil.example/x'), /refusing to fetch/);
  assert.throws(() => parseSlackAttachmentUrl('https://files.slack.com:8443@evil.example/x'), /refusing to fetch/);
});

test('parseSlackAttachmentUrl rejects non-https and empty input', () => {
  assert.throws(() => parseSlackAttachmentUrl('http://files.slack.com/file'), /https/);
  assert.throws(() => parseSlackAttachmentUrl(''), /required/);
});
