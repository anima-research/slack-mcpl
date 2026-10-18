/**
 * conversations.list asks only for the types the token's scopes can read, as
 * Slack last reported them. Driven through a fake client for the requests the
 * adapter builds, and through the real client against a local endpoint that
 * answers as Slack does, with the x-oauth-scopes header Slack sends with each
 * answer, a refusal's included.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  NoReadableConversations,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize } from './harness.js';
import { fakeSlackApi, type FakeSlackApi, type SlackApiAnswer } from './slackApi.js';

const ALL = ['channels:read', 'groups:read', 'im:read', 'mpim:read'];

/** An adapter over a fake client: conversations.list answers `responses` in
 *  turn, then no conversations, and auth.test reports `authScopes`, or the
 *  scopes the adapter starts with. */
function fixture(scopes: string[] | undefined, disableDms = false, responses: any[] = [], authScopes?: string[]) {
  const calls: Record<string, unknown>[] = [];
  let authCalls = 0;
  const web = {
    conversations: {
      async list(args: Record<string, unknown>) {
        calls.push(args);
        return responses.shift() ?? { channels: [] };
      },
    },
    auth: {
      async test() {
        authCalls++;
        return { response_metadata: { scopes: authScopes ?? scopes } };
      },
    },
  } as any;
  const socket = { on() {} } as any;
  return {
    calls,
    authCalls: () => authCalls,
    adapter: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, disableDms, undefined, scopes),
  };
}

const cases = [
  { name: 'without group-DM scope', scopes: ['channels:read', 'groups:read', 'im:read'], types: 'public_channel,private_channel,im', leftOut: ['mpim'] },
  { name: 'without DM scope', scopes: ['channels:read', 'groups:read', 'mpim:read'], types: 'public_channel,private_channel,mpim', leftOut: ['im'] },
  { name: 'all four scopes', scopes: ALL, types: 'public_channel,private_channel,im,mpim', leftOut: [] },
  { name: 'public channels only', scopes: ['channels:read'], types: 'public_channel', leftOut: ['private_channel', 'im', 'mpim'] },
  { name: 'private channels only', scopes: ['groups:read'], types: 'private_channel', leftOut: ['public_channel', 'im', 'mpim'] },
  { name: 'DMs disabled with all scopes', scopes: ALL, disableDms: true, types: 'public_channel,private_channel', leftOut: [] },
  { name: 'an empty scope list is unknown, so every type is asked for', scopes: [], types: 'public_channel,private_channel,im,mpim', leftOut: [] },
  { name: "a blank header's [''] is unknown too", scopes: [''], types: 'public_channel,private_channel,im,mpim', leftOut: [] },
  { name: 'unknown scopes keep legacy request', scopes: undefined, types: 'public_channel,private_channel,im,mpim', leftOut: [] },
];
for (const row of cases) {
  test(`conversation scope matrix: ${row.name}`, async () => {
    const { adapter, calls, authCalls } = fixture(row.scopes, row.disableDms);
    assert.deepEqual(await adapter.listConversations(), { conversations: [], leftOut: row.leftOut });
    assert.deepEqual(calls.map((call) => call.types), [row.types]);
    assert.equal(authCalls(), 0);
  });
}

for (const row of [
  { name: 'no readable scopes', scopes: ['chat:write'], needed: ALL },
  { name: 'DMs disabled with only DM scopes', scopes: ['im:read', 'mpim:read'], disableDms: true, needed: ['channels:read', 'groups:read'] },
]) {
  test(`with no readable type, auth.test is asked once and the listing is refused unsent: ${row.name}`, async () => {
    const { adapter, calls, authCalls } = fixture(row.scopes, row.disableDms);
    const err = await adapter.listConversations().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NoReadableConversations, String(err));
    assert.deepEqual(err.needed, row.needed);
    assert.equal(calls.length, 0, 'conversations.list was not sent');
    assert.equal(authCalls(), 1);
  });
}

test('with no readable type, a type auth.test now reports is listed', async () => {
  const { adapter, calls, authCalls } = fixture(['chat:write'], false, [], ['chat:write', 'channels:read']);
  assert.deepEqual(await adapter.listConversations(), { conversations: [], leftOut: ['private_channel', 'im', 'mpim'] });
  assert.deepEqual(calls.map((call) => call.types), ['public_channel']);
  assert.equal(authCalls(), 1);
});

test("the stderr line names only the enabled types the token can't read, and says when that changes", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  fixture(['channels:read', 'groups:read', 'im:read']);
  fixture(['channels:read'], true);
  fixture(ALL);
  fixture(undefined);
  assert.deepEqual(lines, [
    '[slack-mcpl] Conversation listing omits types without a granted read scope: mpim (requires mpim:read).',
    '[slack-mcpl] Conversation listing omits types without a granted read scope: private_channel (requires groups:read).',
  ]);
  lines.length = 0;
  const { adapter } = fixture(['channels:read', 'groups:read', 'im:read'], false, [
    { channels: [], response_metadata: { scopes: ALL } },
    { channels: [], response_metadata: { scopes: ALL } },
    { channels: [], response_metadata: { scopes: ['channels:read', 'groups:read'] } },
  ]);
  await adapter.listConversations();
  await adapter.listConversations();
  assert.deepEqual(lines, [
    '[slack-mcpl] Conversation listing omits types without a granted read scope: mpim (requires mpim:read).',
    "[slack-mcpl] Conversation listing now asks for every type it lists: the token has each one's read scope.",
    '[slack-mcpl] Conversation listing now omits types without a granted read scope: im (requires im:read), mpim (requires mpim:read).',
  ]);
});

// Through the real client: Slack's answer names the token's scopes in its
// x-oauth-scopes header, and the client puts them on the answer, or on a
// refusal's data, as response_metadata.scopes.

let api: FakeSlackApi;
let client: SlackWebClient;
before(async () => {
  api = await fakeSlackApi();
  client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
});
after(() => api.close());

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };
const realAdapter = (scopes?: string[]) =>
  new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, false, undefined, scopes);
/** Slack's answer to a listing page, naming the token's scopes. */
const page = (scopes: string, channels: unknown[] = [], next?: string): SlackApiAnswer => ({
  headers: { 'x-oauth-scopes': scopes },
  body: { ok: true, channels, ...(next ? { response_metadata: { next_cursor: next } } : {}) },
});
/** Slack's refusal of a listing for a type whose read scope the token lacks. */
const refused = (scopes: string, needed: string): SlackApiAnswer => ({
  headers: { 'x-oauth-scopes': scopes },
  body: { ok: false, error: 'missing_scope', needed },
});
const channel = (id: string) => ({ id, name: id.toLowerCase(), is_im: false, is_mpim: false, is_member: true });
/** The types and cursor of each conversations.list request from `from` on. */
const asked = (from: number) =>
  api.calls.flatMap((called, i) =>
    i >= from && called === 'conversations.list' ? [[api.sent[i].get('types'), api.sent[i].get('cursor') ?? undefined]] : []);

test('a refusal whose scopes leave out a type the listing asked for starts it over without that type', { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  const from = api.calls.length;
  // Scopes unknown, so the first request asks for every type.
  api.answerFor('conversations.list',
    refused('channels:read,groups:read,im:read,chat:write', 'mpim:read'),
    page('channels:read,groups:read,im:read,chat:write', [channel('C1')]));
  const listed = await realAdapter().listConversations();
  assert.deepEqual(listed.conversations.map((c) => c.id), ['C1']);
  assert.deepEqual(listed.leftOut, ['mpim']);
  assert.deepEqual(asked(from), [
    ['public_channel,private_channel,im,mpim', undefined],
    ['public_channel,private_channel,im', undefined],
  ]);
});

test('a listing starts over once: a second change of scopes stands for this listing and applies to the next', { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  const from = api.calls.length;
  api.answerFor('conversations.list',
    refused('channels:read,groups:read,im:read', 'mpim:read'),
    refused('channels:read,groups:read', 'im:read'),
    page('channels:read,groups:read'));
  const slack = realAdapter();
  const err = (await slack.listConversations().then(() => null, (e: unknown) => e)) as { data?: { error?: string } } | null;
  assert.equal(err?.data?.error, 'missing_scope');
  await slack.listConversations();
  assert.deepEqual(asked(from), [
    ['public_channel,private_channel,im,mpim', undefined],
    ['public_channel,private_channel,im', undefined],
    ['public_channel,private_channel', undefined],
  ]);
});

test("a refusal whose scopes read no type ends the listing unsent, rather than ask with no types", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  const from = api.calls.length;
  api.answerFor('conversations.list', refused('chat:write', 'channels:read'));
  const err = await realAdapter().listConversations().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NoReadableConversations, String(err));
  assert.deepEqual(err.needed, ALL);
  assert.deepEqual(asked(from), [['public_channel,private_channel,im,mpim', undefined]]);
});

test('a page whose scopes add a type starts the listing over from the first page, and its pages keep their types', { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  const from = api.calls.length;
  api.answerFor('conversations.list',
    page('channels:read,groups:read,im:read', [channel('C1')], 'p2'),
    // The second page reports mpim:read granted meanwhile.
    page('channels:read,groups:read,im:read,mpim:read', [channel('C2')]),
    page('channels:read,groups:read,im:read,mpim:read', [channel('C1')], 'p2'),
    page('channels:read,groups:read,im:read,mpim:read', [channel('C2')]));
  const listed = await realAdapter(['channels:read', 'groups:read', 'im:read']).listConversations();
  assert.deepEqual(listed.conversations.map((c) => c.id), ['C1', 'C2'], 'what the first pass listed is dropped');
  assert.deepEqual(listed.leftOut, []);
  assert.deepEqual(asked(from), [
    ['public_channel,private_channel,im', undefined],
    ['public_channel,private_channel,im', 'p2'],
    ['public_channel,private_channel,im,mpim', undefined],
    ['public_channel,private_channel,im,mpim', 'p2'],
  ]);
});

test("a listing in the background that starts over counts its waits afresh, since it's a new request", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  const limited: SlackApiAnswer = { status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } };
  api.answerFor('conversations.list',
    limited,
    refused('channels:read,groups:read,im:read', 'mpim:read'),
    limited,
    page('channels:read,groups:read,im:read', [channel('C1')]));
  const inARow: number[] = [];
  const listed = await realAdapter().listConversations(false, async (_wait, n) => { inARow.push(n); });
  assert.deepEqual(listed.conversations.map((c) => c.id), ['C1']);
  assert.deepEqual(inARow, [1, 1]);
});

test('a blank x-oauth-scopes header, which the client reads as [""], keeps the scopes last reported', { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  api.answerFor('conversations.list', page(''));
  const direct = await client.conversations.list({ types: 'public_channel' });
  assert.deepEqual(direct.response_metadata?.scopes, ['']);
  const from = api.calls.length;
  const slack = realAdapter(['channels:read']);
  await slack.listConversations();
  await slack.listConversations();
  assert.deepEqual(asked(from), [['public_channel', undefined], ['public_channel', undefined]]);
});

test('list_channels says which kinds a listing left out beside the list, and answers with the list alone when none', { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  api.answerFor('conversations.list', page('channels:read,groups:read,chat:write', [channel('C1')]));
  const h = connectHost(new SlackMcplServer(realAdapter(['channels:read', 'groups:read', 'chat:write'])));
  t.after(() => h.close());
  await initialize(h, false);
  type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
  const listed = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as ToolResult;
  assert.notEqual(listed.isError, true);
  assert.equal(listed.content.length, 2);
  assert.deepEqual(JSON.parse(listed.content[0].text).map((c: { id: string }) => c.id), ['C1']);
  assert.equal(listed.content[1].text,
    "This listing leaves out DMs and group DMs: this bot's token doesn't have im:read and mpim:read, the read " +
      "scopes Slack needs to list those. Whoever runs this host can add them to the app's bot token scopes and " +
      'reinstall the app to the workspace.');
  // A grant reported meanwhile: the listing starts over with it, and the list stands alone.
  api.answerFor('conversations.list', page('channels:read,groups:read,im:read,mpim:read,chat:write', [channel('C1')]));
  const all = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as ToolResult;
  assert.equal(all.content.length, 1);
  assert.deepEqual(JSON.parse(all.content[0].text).map((c: { id: string }) => c.id), ['C1']);
});

test("refresh_channels' note says which kinds the listing left out", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.list'));
  api.answerFor('conversations.list', page('channels:read,groups:read,im:read', [channel('C1')]));
  const h = connectHost(new SlackMcplServer(realAdapter(['channels:read', 'groups:read', 'im:read'])));
  t.after(() => h.close());
  await initialize(h, false);
  const refreshed = (await h.host.sendRequest('tools/call', { name: 'refresh_channels', arguments: {} })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.notEqual(refreshed.isError, true, refreshed.content[0].text);
  const { note } = JSON.parse(refreshed.content[0].text) as { note: string };
  assert.ok(note.endsWith(
    " This listing leaves out group DMs: this bot's token doesn't have mpim:read, the read scope Slack needs to " +
      "list them. Whoever runs this host can add it to the app's bot token scopes and reinstall the app to the " +
      'workspace.'), note);
});

test('list_channels with no readable type says so, names the read scopes, and sends no listing', { timeout: 5000 }, async (t) => {
  const from = api.calls.length;
  const h = connectHost(new SlackMcplServer(realAdapter(['chat:write'])));
  t.after(() => h.close());
  await initialize(h, false);
  const listed = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.equal(listed.isError, true);
  assert.equal(listed.content[0].text,
    'conversations.list: the token has none of the read scopes channels:read, groups:read, im:read, mpim:read\n\n' +
      "Nothing was listed: Slack lists each kind of conversation only for a token with that kind's read scope. " +
      "Calling again won't change that: whoever runs this host has to add one of those scopes to the app's bot " +
      'token scopes and reinstall the app to the workspace.');
  assert.deepEqual(api.calls.slice(from), ['auth.test']);
});
