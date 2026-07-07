/**
 * Tests for Slack mrkdwn formatting helpers.
 *
 * Run: node --import tsx --test test/formatSlackText.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSlackText, extractSlackUserIds } from '../src/content.js';

test('formatSlackText resolves user mentions via the name map', () => {
  const names = new Map([['U123ABC', 'alice']]);
  assert.equal(
    formatSlackText('hey <@U123ABC>, ping', names),
    'hey @alice (uid:U123ABC), ping',
  );
});

test('formatSlackText falls back to inline label, then raw ID', () => {
  const names = new Map<string, string>();
  assert.equal(
    formatSlackText('<@U1|bob> and <@U2>', names),
    '@bob (uid:U1) and @U2 (uid:U2)',
  );
});

test('formatSlackText rewrites channel mentions', () => {
  const names = new Map<string, string>();
  assert.equal(
    formatSlackText('see <#C42|general> or <#C43>', names),
    'see #general or #C43',
  );
});

test('formatSlackText rewrites broadcasts', () => {
  const names = new Map<string, string>();
  assert.equal(
    formatSlackText('<!here> and <!channel|channel>', names),
    '@here and @channel',
  );
});

test('formatSlackText rewrites links', () => {
  const names = new Map<string, string>();
  assert.equal(
    formatSlackText('<https://example.com|docs> vs <https://example.org>', names),
    'docs (https://example.com) vs https://example.org',
  );
});

test('formatSlackText unescapes Slack HTML entities', () => {
  const names = new Map<string, string>();
  assert.equal(
    formatSlackText('a &lt; b &amp;&amp; c &gt; d', names),
    'a < b && c > d',
  );
});

test('extractSlackUserIds dedupes and handles fallback syntax', () => {
  assert.deepEqual(
    extractSlackUserIds('<@U1> <@U2|name> <@U1> plain'),
    ['U1', 'U2'],
  );
});

test('extractSlackUserIds returns empty for no mentions', () => {
  assert.deepEqual(extractSlackUserIds('no mentions here'), []);
});
