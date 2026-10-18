/** Real JSON-RPC dispatch: these assertions fail on the upstream tool contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, initialize, FULL_GRANT} from './harness.js';
import {method} from '@animalabs/mcpl-core';

async function tool(h: ReturnType<typeof harness>, name: string, args: Record<string, unknown>) {
  const result = await h.host.sendRequest('tools/call', {name, arguments: args}) as {isError?: boolean; content: Array<{text: string}>};
  return {error: result.isError, value: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text)};
}

test('history and thread tools expose bounded schemas and structured channel/completeness results', async t => {
  const h = harness(); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: FULL_GRANT});
  const listed = await h.host.sendRequest('tools/list', {}) as {tools: Array<{name: string; inputSchema: {properties: Record<string, any>}}>};
  const history = listed.tools.find(item => item.name === 'fetch_history')!;
  assert.equal(history.inputSchema.properties.limit.type, 'integer');
  assert.equal(history.inputSchema.properties.maxScanned.maximum, 10000);
  assert.ok(history.inputSchema.properties.textContains);
  const out = await tool(h, 'fetch_history', {channelId: 'C1'});
  assert.notEqual(out.error, true);
  assert.equal(out.value.channel.id, 'C1');
  assert.equal(out.value.channel.writeAllowedByPolicy, true);
  assert.equal(out.value.channel.slack.channelPostAllowedByMetadata, null);
  assert.equal(out.value.pagination.scanComplete, true);
  assert.equal(out.value.pagination.threadRepliesSearched, false);
  const thread = await tool(h, 'fetch_thread', {channelId: 'C1', threadTs: '1.0'});
  assert.equal(thread.value.pagination.scope, 'single_thread');
  assert.equal(thread.value.pagination.threadRepliesSearched, true);
});

test('tool dispatcher refuses invalid limits/unknown filters and preserves existing list writable meaning', async t => {
  const h = harness({sendChannels: ['C9']}); t.after(() => h.close());
  await initialize(h, false);
  for (const args of [{limit: -1}, {limit: '50'}, {maxPages: 51}, {regex: '.*'}]) {
    assert.equal((await tool(h, 'fetch_history', {channelId: 'C1', ...args})).error, true);
  }
  const listed = await tool(h, 'list_channels', {});
  assert.equal(listed.value[0].writable, false);
  const history = await tool(h, 'fetch_history', {channelId: 'C1'});
  assert.equal(history.value.channel.writeAllowedByPolicy, false);
  assert.equal(h.posts.length, 0);
});

test('MCPL feature denial still refuses bounded history before Slack calls', async t => {
  const h = harness(); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: ['tools'], disabled: ['slack.history']});
  const result = await tool(h, 'fetch_history', {channelId: 'C1'});
  assert.equal(result.error, true);
  assert.match(result.value, /not enabled/);
});
