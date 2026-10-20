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
  assert.equal(history.inputSchema.properties.maxPages, undefined);
  assert.equal(history.inputSchema.properties.maxMs, undefined);
  const out = await tool(h, 'fetch_history', {channelId: 'C1'});
  assert.notEqual(out.error, true);
  assert.deepEqual(out.value.channel, {id: 'C1', writable: true});
  assert.equal(out.value.pagination.scanComplete, true);
  assert.equal(out.value.pagination.threadRepliesSearched, false);
  const thread = await tool(h, 'fetch_thread', {channelId: 'C1', threadTs: '1.0'});
  assert.equal(thread.value.pagination.scope, 'single_thread');
  assert.equal(thread.value.pagination.threadRepliesSearched, true);
});

test('tool dispatcher refuses invalid limits/unknown filters and preserves existing list writable meaning', async t => {
  const h = harness({sendChannels: ['C9']}); t.after(() => h.close());
  await initialize(h, false);
  for (const args of [{limit: -1}, {limit: '50'}, {maxScanned: 10001}, {regex: '.*'}]) {
    assert.equal((await tool(h, 'fetch_history', {channelId: 'C1', ...args})).error, true);
  }
  const listed = await tool(h, 'list_channels', {});
  assert.equal(listed.value[0].writable, false);
  const history = await tool(h, 'fetch_history', {channelId: 'C1'});
  assert.equal(history.value.channel.writable, false);
  assert.equal(h.posts.length, 0);
});

test('MCPL feature denial still refuses bounded history before Slack calls', async t => {
  const h = harness(); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: ['tools'], disabled: ['slack.history']});
  const result = await tool(h, 'fetch_history', {channelId: 'C1'});
  assert.equal(result.error, true);
  assert.equal(
    result.value,
    "fetch_history is turned off on this host: the host's policy hasn't enabled its feature set, slack.history, so " +
      "nothing ran, and calling again won't change that until the host enables it.",
  );
  assert.deepEqual(h.reads, [], 'Slack was asked for nothing');
});

test("a read missing its channel or thread opens with what the read's other failures open with", async t => {
  const h = harness(); t.after(() => h.close());
  await initialize(h, false);
  assert.deepEqual(await tool(h, 'fetch_history', {}), {
    error: true,
    value: "No messages were returned: channelId must be a non-empty string, and this call left it out. Take it from the message's channelId=, or list_channels shows each conversation's id.",
  });
  assert.deepEqual(await tool(h, 'fetch_thread', {channelId: 'C1', threadTs: ''}), {
    error: true,
    value: 'No messages were returned: threadTs must be a non-empty string, and this call passed an empty string. ' +
      "Pass the thread's parent id: a reply's thread=, a message's own id= when it shows no thread=, or a message's rootTs in fetch_history or fetch_thread results.",
  });
  assert.deepEqual(h.reads, []);
});

test("a slip for a read's required argument is named as a slip, not as the argument left out", async t => {
  const h = harness(); t.after(() => h.close());
  await initialize(h, false);
  assert.deepEqual(await tool(h, 'fetch_thread', {channelID: 'C1', threadTs: '1.0'}), {
    error: true,
    value: 'No messages were returned: fetch_thread takes no argument named channelID (did you mean channelId?). It takes ' +
      'channelId, threadTs, limit, oldest, latest, cursor, maxScanned, maxBytes.',
  });
  assert.deepEqual(await tool(h, 'fetch_history', {channelid: 'C1'}), {
    error: true,
    value: 'No messages were returned: fetch_history takes no argument named channelid (did you mean channelId?). It takes ' +
      'channelId, limit, oldest, latest, cursor, maxScanned, maxBytes, textContains, caseSensitive, authorIds.',
  });
  assert.deepEqual(h.reads, []);
});
