/**
 * Tests for the fetch_attachment host allowlist — the bot token must only
 * ever be sent to files.slack.com.
 *
 * Run: node --import tsx --test test/attachmentUrls.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentName, parseSlackAttachmentUrl } from '../src/content.js';

const asGiven = 'Pass the url exactly as the message gives it after "fetchable via fetch_attachment:"; it starts ' +
  'with https://files.slack.com/.';

test('parseSlackAttachmentUrl accepts files.slack.com', () => {
  const url = parseSlackAttachmentUrl('https://files.slack.com/files-pri/T1-F1/screenshot.png');
  assert.equal(url.host, 'files.slack.com');
});

test('parseSlackAttachmentUrl rejects workspace and lookalike hosts', () => {
  // Workspace hosts serve /api/* — sending the bot token there is a leak.
  assert.throws(() => parseSlackAttachmentUrl('https://evil.slack.com/api/chat.postMessage?channel=C1&text=pwn'), {
    message:
      "Nothing was fetched: evil.slack.com isn't Slack's file server. fetch_attachment sends this bot's token with " +
      `the request, so it takes only links on files.slack.com. ${asGiven}`,
  });
  const otherHost = (host: string) => ({ message: new RegExp(`^Nothing was fetched: ${host.replace(/\./g, '\\.')} isn't Slack's file server\\.`) });
  assert.throws(() => parseSlackAttachmentUrl('https://slack.com/api/auth.test'), otherHost('slack.com'));
  assert.throws(() => parseSlackAttachmentUrl('https://files.slack.com.evil.example/x'), otherHost('files.slack.com.evil.example'));
  assert.throws(() => parseSlackAttachmentUrl('https://files.slack.com:8443@evil.example/x'), otherHost('evil.example'));
});

test('parseSlackAttachmentUrl rejects non-https, unparsable and empty input', () => {
  const notALink = (url: string) => `Nothing was fetched: "${url}" isn't a full https:// link. ${asGiven}`;
  assert.throws(() => parseSlackAttachmentUrl('http://files.slack.com/file'), { message: notALink('http://files.slack.com/file') });
  // Starts like a link, but isn't one: the URL parser's bare "Invalid URL" is not what the agent reads.
  assert.throws(() => parseSlackAttachmentUrl('https://'), { message: notALink('https://') });
  assert.throws(() => parseSlackAttachmentUrl(''), /required/);
});

test('parseSlackAttachmentUrl rejects a url that carries a user name or password', () => {
  // fetch() refuses one before connecting, which would read as a failure on the way.
  for (const url of ['https://bot:secret@files.slack.com/files-pri/T1-F1/a.png', 'https://bot@files.slack.com/x']) {
    assert.throws(() => parseSlackAttachmentUrl(url), {
      message: `Nothing was fetched: fetch_attachment can't fetch a url that carries a user name or password, and Slack's file links carry neither. ${asGiven}`,
    });
  }
});

test("attachmentName decodes the url's last segment, and keeps one that doesn't decode as given", () => {
  assert.equal(attachmentName(new URL('https://files.slack.com/files-pri/T1-F1/my%20shot.png')), 'my shot.png');
  // A malformed escape: decodeURIComponent would throw "URI malformed".
  assert.equal(attachmentName(new URL('https://files.slack.com/files-pri/T1-F1/shot%E0%A4%A.png')), 'shot%E0%A4%A.png');
  assert.equal(attachmentName(new URL('https://files.slack.com/files-pri/T1-F1/')), 'attachment');
});
