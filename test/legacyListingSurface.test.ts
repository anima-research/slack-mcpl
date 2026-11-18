import test from 'node:test';
import assert from 'node:assert/strict';
import { policyListingTool, toolDefinitions } from '../src/tools.js';

test('listing documentation changes only with explicit policy', () => {
  const legacy = toolDefinitions.find(t => t.name === 'list_channels')!;
  assert.equal(policyListingTool(legacy, false), legacy);
  assert.match(legacy.description!, /also list public channels/);
  assert.doesNotMatch(legacy.description!, /legacy mode only/);
  assert.equal((legacy.inputSchema.properties!.includeNonMember as { description: string }).description,
    'Also include public channels the bot is not a member of (default false)');
  const before = JSON.stringify(legacy);
  assert.match(policyListingTool(legacy, true).description!, /unjoined public channels are never listed/);
  assert.equal(JSON.stringify(legacy), before, 'policy transformation must not mutate legacy definition');
});
