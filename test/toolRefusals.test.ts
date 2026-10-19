/**
 * What this server's own refusals and notes say to the agent, read where the
 * agent or its host reads them: a tool's result, or the error a host's request
 * gets. Each says what didn't happen, the value it's about, and what to do, or
 * that calling again won't help and who can change that.
 *
 * Run: node --import tsx --test test/toolRefusals.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackAdapter, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { FULL_GRANT, connectHost, initialize, until } from './harness.js';

type Result = { isError?: boolean; content: { text: string }[] };

const CHANNEL = { id: 'C1', name: 'general', is_member: true, is_im: false, is_mpim: false };

/** The real server over a Slack whose Web API answers as `web` does: plain
 *  MCP, or MCPL under `grant`. */
async function serve(
  t: { after(fn: () => Promise<void>): void },
  web: Record<string, unknown>,
  opts: { grant?: string[]; disableDms?: boolean } = {},
) {
  const socket = { on() {}, async start() {}, async disconnect() {} };
  const slack = new SlackAdapter(web as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, opts.disableDms);
  const h = connectHost(new SlackMcplServer(slack));
  t.after(() => h.close());
  await initialize(h, opts.grant !== undefined);
  if (opts.grant) await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: opts.grant });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await h.host.sendRequest('tools/call', { name, arguments: args })) as Result;
  const offered = async () =>
    ((await h.host.sendRequest('tools/list')) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  return { ...h, call, offered };
}

/** A host's request that fails with `text` as its message's end, and `code`. */
const failsWith = (code: number, text: string) => (err: Error & { code?: number }) => {
  assert.equal(err.code, code);
  assert.ok(err.message.endsWith(text), `${err.message}\ndoes not end with\n${text}`);
  return true;
};

test('find_user with no match names the query, what it matches, and what to try', async (t) => {
  const h = await serve(t, {
    users: { list: async () => ({ members: [{ id: 'U1', name: 'ann', real_name: 'Ann Lee' }] }) },
  });
  assert.deepEqual(JSON.parse((await h.call('find_user', { query: 'zed' })).content[0].text), {
    found: false,
    note:
      'No users matched "zed". find_user matches part of a username, real name or display name, ignoring case, ' +
      'and leaves out bots and deactivated accounts. Try a shorter part or another spelling.',
  });
});

test('an unknown tool lists the tools this server offers', async (t) => {
  const h = await serve(t, {});
  const tools = await h.offered();
  const called = await h.call('post_message');
  assert.equal(called.isError, true);
  assert.equal(
    called.content[0].text,
    `There's no tool named "post_message" here, so nothing ran. This server's tools are: ${tools.join(', ')}.`,
  );
  assert.ok(tools.includes('send_dm'));

  // With DMs off, send_dm is neither offered nor named.
  const off = await serve(t, {}, { disableDms: true });
  const offTools = await off.offered();
  const offCalled = await off.call('post_message');
  assert.equal(
    offCalled.content[0].text,
    `There's no tool named "post_message" here, so nothing ran. This server's tools are: ${offTools.join(', ')}.`,
  );
  assert.doesNotMatch(offCalled.content[0].text, /send_dm/);
});

const CHANNEL_ID_SOURCE = "list_channels shows each conversation's id.";
for (const [tool, args, text] of [
  ['send_message', {}, `channelId must be a non-empty string, and this call left it out. ${CHANNEL_ID_SOURCE}`],
  ['send_message', { channelId: '' }, `channelId must be a non-empty string, and this call passed an empty string. ${CHANNEL_ID_SOURCE}`],
  ['send_message', { channelId: 42 }, `channelId must be a non-empty string, and this call passed a number. ${CHANNEL_ID_SOURCE}`],
  ['send_message', { channelId: true }, `channelId must be a non-empty string, and this call passed a boolean. ${CHANNEL_ID_SOURCE}`],
  ['send_message', { channelId: null }, `channelId must be a non-empty string, and this call passed null. ${CHANNEL_ID_SOURCE}`],
  ['send_message', { channelId: ['C1'] }, `channelId must be a non-empty string, and this call passed an array. ${CHANNEL_ID_SOURCE}`],
  ['send_message', { channelId: { id: 'C1' } }, `channelId must be a non-empty string, and this call passed an object. ${CHANNEL_ID_SOURCE}`],
  ['send_message', { channelId: 'C1' }, "content must be a non-empty string, and this call left it out. Pass the message's text."],
  [
    'add_reaction',
    { channelId: 'C1' },
    'messageId must be a non-empty string, and this call left it out. Take it from the message: its id= ' +
      "(reply_message takes its thread= when it shows one, or its rootTs in fetch_history and fetch_thread results), or " +
      "from fetch_history's ids.",
  ],
  [
    'add_reaction',
    { channelId: 'C1', messageId: '1.0' },
    'emoji must be a non-empty string, and this call left it out. Pass an emoji name, such as thumbsup.',
  ],
  [
    'fetch_thread',
    { channelId: 'C1' },
    "threadTs must be a non-empty string, and this call left it out. Pass the thread's parent id: a reply's thread=, " +
      "a message's own id= when it shows no thread=, or a message's rootTs in fetch_history or fetch_thread results.",
  ],
  ['fetch_thread', {}, `channelId must be a non-empty string, and this call left it out. ${CHANNEL_ID_SOURCE}`],
  ['send_dm', {}, "userId must be a non-empty string, and this call left it out. find_user returns each person's userId."],
  ['find_user', {}, "query must be a non-empty string, and this call left it out. Pass part of a person's name."],
  [
    'fetch_attachment',
    {},
    'url must be a non-empty string, and this call left it out. Pass the url exactly as the message gives it after ' +
      '"fetchable via fetch_attachment:"; it starts with https://files.slack.com/.',
  ],
] as const) {
  test(`${tool} ${JSON.stringify(args)}: a missing or wrong argument says what was passed and where the value comes from`, async (t) => {
    const h = await serve(t, {});
    const called = await h.call(tool, args);
    assert.equal(called.isError, true);
    // A read's refusal opens as the read's other failures do.
    const lead = tool === 'fetch_thread' ? 'No messages were returned' : 'Nothing was done';
    assert.equal(called.content[0].text, `${lead}: ${text}`);
  });
}

test("fetch_attachment keeps a file name the url can't decode, rather than fail", async (t) => {
  // The download itself is fetchAttachmentBytes', tested on its own; here it answers at once.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('the notes', { headers: { 'content-type': 'text/plain' } })) as typeof fetch;
  t.after(async () => { globalThis.fetch = original; });
  const h = await serve(t, {});
  const fetched = await h.call('fetch_attachment', { url: 'https://files.slack.com/files-pri/T1-F1/notes%E0%A4%A.txt' });
  assert.notEqual(fetched.isError, true, fetched.content[0].text);
  assert.equal(JSON.parse(fetched.content[0].text).name, 'notes%E0%A4%A.txt');
});

test("fetch_attachment with a bot token a request header can't carry says so, without quoting the token", async (t) => {
  // The Web API client sends such a token without the line break, so the
  // server starts and its other tools work; fetch() refuses it before connecting.
  const original = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test\nsecret';
  t.after(() => {
    if (original === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = original;
  });
  const h = await serve(t, {});
  const fetched = await h.call('fetch_attachment', { url: 'https://files.slack.com/files-pri/T1-F1/shot.png' });
  assert.equal(fetched.isError, true);
  assert.equal(
    fetched.content[0].text,
    "Nothing was fetched: this server's bot token holds a character a request header can't carry, such as a line " +
      "break, so fetch_attachment can't send it. Calling again won't change that until whoever runs this host " +
      'fixes the token.',
  );
  assert.ok(!fetched.content[0].text.includes('secret'), 'the token stays out of the text');
});

test('refresh_channels without channels.register fails before Slack is asked', async (t) => {
  let listed = 0;
  const h = await serve(t, { conversations: { list: async () => { listed++; return { channels: [CHANNEL] }; } } }, { grant: ['tools'] });
  assert.ok((await h.offered()).includes('refresh_channels'), 'offered under MCPL, where a grant can widen');
  const refreshed = await h.call('refresh_channels');
  assert.equal(refreshed.isError, true);
  assert.equal(
    refreshed.content[0].text,
    "Nothing was announced to the host: its policy hasn't granted this server channels.register, so it can't register " +
      "conversations with the host, and calling again won't change that until the host grants it.",
  );
  assert.equal(listed, 0);
});

test('refresh_channels on a plain MCP connection is not offered, and a call is refused before Slack is asked', async (t) => {
  let listed = 0;
  const h = await serve(t, { conversations: { list: async () => { listed++; return { channels: [CHANNEL] }; } } });
  assert.ok(!(await h.offered()).includes('refresh_channels'));
  const refreshed = await h.call('refresh_channels');
  assert.equal(refreshed.isError, true);
  assert.equal(
    refreshed.content[0].text,
    "Nothing was announced: this connection is plain MCP, without MCPL's channels, so there's no host to register " +
      "conversations with, and calling again won't change that.",
  );
  assert.equal(listed, 0);
});

test('with direct messages off, channels/open says refresh_channels registers channels only', async (t) => {
  const h = await serve(t, { conversations: { list: async () => ({ channels: [CHANNEL] }) } }, { grant: FULL_GRANT, disableDms: true });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:D9', type: 'slack', address: {} }),
    failsWith(
      -32603,
      "No matching channel found: slack:D9 isn't a channel this server has registered with this host, so nothing " +
        'was opened. refresh_channels registers the conversations this bot is in, channels only while direct ' +
        'messages are turned off; open one by the id it announces.',
    ),
  );
});

test('channels/open says why nothing opened: an unregistered id, an address it cannot read, or a type with none', async (t) => {
  const h = await serve(t, { conversations: { list: async () => ({ channels: [CHANNEL] }) } }, { grant: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
  await new Promise((r) => setImmediate(r));

  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C9', type: 'slack', address: {} }),
    failsWith(
      -32603,
      "No matching channel found: slack:C9 isn't a channel this server has registered with this host, so nothing " +
        'was opened. refresh_channels registers the conversations this bot is in; open one by the id it announces.',
    ),
  );
  // Slack's own id, without this server's slack: prefix.
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'C1', type: 'slack', address: {} }),
    failsWith(
      -32603,
      'No matching channel found: "C1" isn\'t one of this server\'s channel ids, which look like slack:C0123ABCD, so ' +
        'nothing was opened.',
    ),
  );
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { type: 'slack', address: { userId: 'U2' } }),
    failsWith(
      -32603,
      'No matching channel found: this server opens a channel by its id, such as slack:C0123ABCD, or by an address ' +
        'of type slack with a channelId, and this request gave neither, so nothing was opened. refresh_channels ' +
        'registers the conversations this bot is in; open one by the id it announces.',
    ),
  );
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { type: 'other' }),
    failsWith(
      -32603,
      'No matching channel found: no channel of type other is registered, and the request named none, so nothing ' +
        "was opened. This server's channels are of type slack. refresh_channels registers the conversations this " +
        'bot is in; open one by the id it announces.',
    ),
  );
});

test("channels/open without channels.register says this server can't register conversations, rather than point to refresh_channels", async (t) => {
  const h = await serve(t, { conversations: { list: async () => ({ channels: [CHANNEL] }) } }, { grant: ['channels.lifecycle'] });
  const unregistrable = "This host hasn't granted this server channels.register, so this server can't register conversations with it.";
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1', type: 'slack', address: {} }),
    failsWith(
      -32603,
      `No matching channel found: slack:C1 isn't a channel this server has registered with this host, so nothing was opened. ${unregistrable}`,
    ),
  );
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { type: 'slack', address: { userId: 'U2' } }),
    failsWith(
      -32603,
      'No matching channel found: this server opens a channel by its id, such as slack:C0123ABCD, or by an address ' +
        `of type slack with a channelId, and this request gave neither, so nothing was opened. ${unregistrable}`,
    ),
  );
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_OPEN, { type: 'slack' }),
    failsWith(
      -32603,
      'No matching channel found: no channel of type slack is registered, and the request named none, so nothing ' +
        `was opened. This server's channels are of type slack. ${unregistrable}`,
    ),
  );
});

test('channels/publish to an id that is not this server\'s names it and the form ids take', async (t) => {
  const h = await serve(t, { conversations: { list: async () => ({ channels: [CHANNEL] }) } }, { grant: FULL_GRANT });
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'C1', content: [{ type: 'text', text: 'hi' }] }),
    failsWith(-32603, 'Nothing was posted: "C1" isn\'t one of this server\'s channel ids, which look like slack:C0123ABCD.'),
  );
});

test('a denied capability keeps the spec\'s code, data and opening words, and says calling again won\'t help', async (t) => {
  const h = await serve(t, {}, { grant: ['tools'] });
  await assert.rejects(h.host.sendRequest(method.CHANNELS_LIST), (err: Error & { code?: number; data?: unknown }) => {
    failsWith(
      -32002,
      "Capability denied: channels.register. This host's policy hasn't granted it, so the request didn't run, and " +
        "calling again won't change that until the host grants it.",
    )(err);
    assert.deepEqual(err.data, { capability: 'channels.register' });
    return true;
  });
});
