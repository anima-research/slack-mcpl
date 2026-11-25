import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legacySurfaceProbe } from './legacySurfaceProbe.js';
const main = JSON.parse(readFileSync(new URL('./fixtures/main-legacy-surface.json', import.meta.url), 'utf8'));
test('unset feature descriptions, plain-MCP and MCPL tool definitions, subscription results and listing match main byte for byte', async () => {
  assert.equal(JSON.stringify(await legacySurfaceProbe()), JSON.stringify(main));
});
