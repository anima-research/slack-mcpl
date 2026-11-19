import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legacyPageProbe } from './legacyPageProbe.js';
const main = readFileSync(new URL('./fixtures/main-legacy-pages.json', import.meta.url), 'utf8');
test('unset paged reads (find_user, list_channels, backscroll, fetch_history) match main byte for byte over the one-dimension-at-a-time page corpus, errors included', async () => {
  assert.equal(`${JSON.stringify(await legacyPageProbe(), null, 2)}\n`, main);
});
