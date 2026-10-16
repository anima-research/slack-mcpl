/**
 * Slack's refusals, explained (src/slack-errors.ts). Each error here is the
 * one @slack/web-api throws for Slack's answer: a real WebClient calls a local
 * endpoint that answers as Slack's Web API does, so the explainer reads the
 * client's own shape (`code`, and Slack's answer in `data`).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebClient } from '@slack/web-api';
import { method } from '@animalabs/mcpl-core';
import { explainSlackError } from '../src/slack-errors.js';
import { SlackAdapter, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
import { connectHost, initialize, FULL_GRANT } from './harness.js';

/** What the endpoint answers every method but conversations.list. */
let answer: Record<string, unknown> = { ok: true };
/** The last method called, with the parameters the client sent it. */
let lastCall: { method: string; params: URLSearchParams } | undefined;
let endpoint: http.Server;
let client: WebClient;

before(async () => {
  endpoint = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const called = (req.url ?? '').split('/').pop() ?? '';
      lastCall = { method: called, params: new URLSearchParams(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      const response = called === 'conversations.list'
        ? { ok: true, channels: [] }
        : called === 'files.getUploadURLExternal'
          ? { ok: true, file_id: 'FTEST', upload_url: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/file-upload` }
          : called === 'file-upload' ? { ok: true } : answer;
      res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', () => resolve()));
  const { port } = endpoint.address() as { port: number };
  client = new WebClient('xoxb-test', { slackApiUrl: `http://127.0.0.1:${port}/api/` });
});

after(async () => {
  endpoint.closeAllConnections();
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
});

/** The error the client throws when Slack refuses a call with `error`. */
async function slackError(error: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  answer = { ok: false, error, ...extra };
  try {
    await client.apiCall('chat.postMessage', { channel: 'C1', text: 'x' });
  } catch (err) {
    return err;
  }
  throw new Error(`the client did not throw for ${error}`);
}

async function explain(
  error: string,
  tool: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Promise<string> {
  return explainSlackError(await slackError(error, extra), { tool, args });
}

test("the client's own text stays first, and the explanation follows it", async () => {
  const text = await explain('channel_not_found', 'send_message', { channelId: 'C0NOPE', content: 'hi' });
  assert.match(
    text,
    /^An API error occurred: channel_not_found\n\nNothing was posted: Slack doesn't know conversation C0NOPE, or this bot can't see it\. /,
  );
  assert.match(text, /mistyped or remembered rather than copied, or it's a private conversation this bot isn't in/);
  assert.match(text, /list_channels shows the conversations this bot can use, with their ids\.$/);
});

test('a value is named exactly as the call was given it, whitespace included', async () => {
  const text = await explain('channel_not_found', 'send_message', { channelId: 'C0NOPE ', content: 'hi' });
  assert.ok(text.includes("Slack doesn't know conversation C0NOPE , or"), text);
});

/** Every call whose Slack errors reach the explainer: what its refusal says
 *  didn't happen, and whether it writes, so that Slack's own failure leaves
 *  its outcome unknown. The tools that call no Slack Web API method are
 *  listed apart: fetch_attachment downloads with its own fetch, and the
 *  subscription tools keep local state. */
const CALLS: Array<[tool: string, lead: string, writes: boolean]> = [
  ['send_message', 'Nothing was posted', true],
  ['reply_message', 'Nothing was posted', true],
  ['channels/publish', 'Nothing was posted', true],
  ['send_dm', 'Nothing was sent', true],
  ['upload_file', 'Nothing was uploaded', true],
  ['edit_message', "The message wasn't changed", true],
  ['delete_message', 'Nothing was deleted', true],
  ['add_reaction', 'No reaction was added', true],
  ['fetch_history', 'Nothing was read', false],
  ['fetch_thread', 'Nothing was read', false],
  ['list_channels', 'Nothing was listed', false],
  ['find_user', 'No users were listed', false],
  ['refresh_channels', 'Nothing was announced to the host', false],
];
const NO_SLACK_CALLS = ['fetch_attachment', 'subscribe_channel', 'unsubscribe_channel', 'list_subscriptions'];

test('every tool is either explained, with its lead and whether it writes, or calls no Slack method', () => {
  const listed = toolDefinitions.map((t) => t.name).sort();
  const covered = [...CALLS.map(([tool]) => tool).filter((t) => t !== 'channels/publish'), ...NO_SLACK_CALLS].sort();
  assert.deepEqual(listed, covered, 'a new tool needs its place here, and in NOT_DONE and WRITES if it calls Slack');
});

test('what did not happen is said for the call that failed', async () => {
  for (const [tool, lead] of CALLS) {
    const text = await explain('missing_scope', tool, {}, { needed: 'channels:read' });
    assert.ok(text.includes(`\n\n${lead}: `), `${tool}: ${text}`);
  }
  const unknown = await explain('missing_scope', 'not_a_tool', {});
  assert.ok(unknown.includes('\n\nNothing was done: '), unknown);
});

test("Slack's own failure leaves a write's outcome unknown, and a read is just tried again", async () => {
  for (const [tool, , writes] of CALLS) {
    const text = await explain('internal_error', tool, { channelId: 'C1', messageId: '1.1', emoji: 'eyes' });
    if (writes) assert.match(text, /\n\nSlack failed while handling the call, so whether .* is unknown/, tool);
    else assert.match(text, /: Slack failed while handling the call\. Try again shortly\.$/, tool);
  }
});

test("an id Slack can't read as a conversation's is named as such", async () => {
  const text = await explain('invalid_channel_id', 'edit_message', { channelId: '#general', messageId: '1.2' });
  assert.match(text, /The message wasn't changed: #general isn't a Slack conversation id\. The id may be mistyped/);
  assert.match(text, /list_channels shows the conversations this bot can use/);
});

test('a conversation the bot is not in: a post can be fixed by an invite or a scope, a read by an invite', async () => {
  const post = await explain('not_in_channel', 'send_message', { channelId: 'C2' });
  assert.match(post, /Nothing was posted: this bot isn't a member of conversation C2, so Slack didn't let it post there/);
  assert.match(post, /has to invite the bot \(in Slack, \/invite and the bot's name\)/);
  assert.match(post, /chat:write\.public/);
  const read = await explain('not_in_channel', 'fetch_history', { channelId: 'C2' });
  assert.match(read, /Nothing was read: this bot isn't a member of conversation C2, so Slack didn't let it read there/);
  assert.doesNotMatch(read, /chat:write\.public/, 'the scope lets a bot post, not read');
  const edit = await explain('not_in_channel', 'edit_message', { channelId: 'C2', messageId: '1.1' });
  assert.match(edit, /The message wasn't changed: this bot isn't a member of conversation C2, so Slack didn't let it do that there\. Someone in that conversation has to invite the bot/);
  assert.doesNotMatch(edit, /chat:write\.public/, 'the scope lets a bot post, not edit');
});

test('an archived or closed conversation says nothing here changes it', async () => {
  assert.match(
    await explain('is_archived', 'add_reaction', { channelId: 'C3', messageId: '1.2', emoji: 'eyes' }),
    /No reaction was added: conversation C3 is archived, so nothing can be posted or changed there\. Calling again won't change that unless someone in the workspace unarchives it\./,
  );
  assert.match(
    await explain('is_inactive', 'edit_message', { channelId: 'C3', messageId: '1.2' }),
    /The message wasn't changed: conversation C3 is archived, frozen or deleted/,
  );
});

test('a message id Slack does not know names where real ones show', async () => {
  const missing = await explain('message_not_found', 'delete_message', { channelId: 'C4', messageId: '1718000000.000100' });
  assert.match(missing, /Nothing was deleted: Slack has no message 1718000000\.000100 in conversation C4\./);
  assert.match(missing, /deleted or is in another conversation\. Copy the message's id= from where it arrived, or take it from fetch_history/);
  const malformed = await explain('bad_timestamp', 'add_reaction', { channelId: 'C4', messageId: '1718000000', emoji: 'eyes' });
  assert.match(malformed, /No reaction was added: 1718000000 isn't a message id, which looks like 1718000000\.000100\./);
  // reply_message's messageId and fetch_thread's threadTs name a thread's parent, so each is told how to
  // pass one; the tools that name the message itself are told to copy its id=, as above.
  const parent =
    "Pass the thread's parent id: a reply's thread=, or the id of the message the replies are under, which fetch_history shows";
  assert.ok(
    (await explain('bad_timestamp', 'fetch_thread', { channelId: 'C4', threadTs: 'nope' })).endsWith(
      `Nothing was read: nope isn't a message id, which looks like 1718000000.000100. ${parent}.`,
    ),
  );
  assert.ok(
    (await explain('message_not_found', 'fetch_thread', { channelId: 'C4', threadTs: '1.7' })).endsWith(
      `Nothing was read: Slack has no message 1.7 in conversation C4. The id may be mistyped or remembered rather than copied, or the message was deleted or is in another conversation. ${parent}, with the conversation it's in.`,
    ),
  );
  assert.ok(
    (await explain('message_not_found', 'reply_message', { channelId: 'C4', messageId: '1.7', content: 'hi' })).endsWith(
      `Nothing was posted: Slack has no message 1.7 in conversation C4. The id may be mistyped or remembered rather than copied, or the message was deleted or is in another conversation. ${parent}, with the conversation it's in.`,
    ),
  );
  assert.ok(
    (await explain('bad_timestamp', 'reply_message', { channelId: 'C4', messageId: '1.7x', content: 'hi' })).endsWith(
      `Nothing was posted: 1.7x isn't a message id, which looks like 1718000000.000100. ${parent}.`,
    ),
  );
  // A call that named no message can't have named a wrong one, so nothing is added.
  for (const code of ['message_not_found', 'bad_timestamp', 'thread_not_found']) {
    assert.equal(await explain(code, 'send_message', { channelId: 'C4', content: 'hi' }), `An API error occurred: ${code}`);
  }
});

test("a thread or a history bound Slack doesn't know says which value it was", async () => {
  assert.match(
    await explain('thread_not_found', 'fetch_thread', { channelId: 'C5', threadTs: '9.9' }),
    /Nothing was read: Slack has no thread under message 9\.9 in conversation C5\..*Pass the thread's parent id: a reply's thread=, or the id of the message the replies are under, which fetch_history shows\.$/s,
  );
  // reply_message names the thread it replies under as messageId.
  assert.match(
    await explain('thread_not_found', 'reply_message', { channelId: 'C5', messageId: '8.8', content: 'hi' }),
    /Nothing was posted: Slack has no thread under message 8\.8 in conversation C5\./,
  );
  assert.match(
    await explain('invalid_ts_latest', 'fetch_history', { channelId: 'C5', latest: 'yesterday' }),
    /Nothing was read: latest yesterday isn't a message id/,
  );
  assert.match(
    await explain('invalid_ts_oldest', 'fetch_history', { channelId: 'C5', oldest: 'x' }),
    /Nothing was read: oldest x isn't a message id/,
  );
});

test("another author's message can be neither edited nor deleted, and the text says so", async () => {
  assert.match(
    await explain('cant_update_message', 'edit_message', { channelId: 'C6', messageId: '1.5' }),
    /The message wasn't changed: this bot can edit only messages it posted, and message 1\.5 in conversation C6 isn't one of them\. Calling again won't change that\./,
  );
  assert.match(
    await explain('cant_delete_message', 'delete_message', { channelId: 'C6', messageId: '1.5' }),
    /Nothing was deleted: this bot can delete only messages it posted/,
  );
});

test('a closed edit window offers a new message instead', async () => {
  const text = await explain('edit_window_closed', 'edit_message', { channelId: 'C7', messageId: '1.1' });
  assert.match(text, /this workspace doesn't allow editing a message this old, and calling again won't change that/);
  assert.match(text, /post a new message, or use reply_message with its id/);
});

test("text that's too long: an edit names Slack's limit, a send asks for shorter messages", async () => {
  const edit = await explain('msg_too_long', 'edit_message', { channelId: 'C8', messageId: '1.1' });
  assert.match(edit, /Slack takes at most 4,000 characters of text in an edit, and this text is longer/);
  const send = await explain('msg_too_long', 'send_message', { channelId: 'C8' });
  assert.match(send, /Nothing was posted: Slack refused the text as too long\. Split it into shorter messages/);
  assert.doesNotMatch(send, /4,000/, "chat.postMessage's reference gives no such limit");
});

test('an emoji Slack does not know is named as Slack judged it: as sent, where removing its colons changed it', async () => {
  const add = (emoji: string) => explain('invalid_name', 'add_reaction', { channelId: 'C9', messageId: '1.1', emoji });
  const picker = "Pass a name Slack's emoji picker shows, such as thumbsup, white_check_mark or eyes";
  const custom = 'a custom emoji has to be added to the workspace first.';
  assert.ok((await add('thumbs_upp')).endsWith(`No reaction was added: this workspace has no emoji named "thumbs_upp". ${picker}; ${custom}`));
  assert.ok(
    (await add(':thumbs_upp:')).endsWith(
      `No reaction was added: this workspace has no emoji named "thumbs_upp", the name this server sent for ":thumbs_upp:". ${picker}; ${custom}`,
    ),
  );
  assert.match(await add('thumbs_upp:'), /no emoji named "thumbs_upp", the name this server sent for "thumbs_upp:"\./);
  assert.match(await add('::'), /no emoji named "", the name this server sent for "::"\./);
  assert.ok(
    (await add('thumbsup::skin-tone-2')).endsWith(
      'No reaction was added: this workspace has no emoji named "thumbsupskin-tone-2", the name this server sent for ' +
        '"thumbsup::skin-tone-2". This server removes every colon from a name, so a name with a colon inside, such as ' +
        `a skin tone's, can't be added here. ${picker}.`,
    ),
  );
  assert.match(await add('party:parrot'), /"partyparrot", the name this server sent for "party:parrot"\. This server removes every colon/);
  // A colon beside whitespace isn't inside the name: the spaces are what Slack judged.
  assert.ok(
    (await add(' :eyes: ')).endsWith(
      `No reaction was added: this workspace has no emoji named " eyes ", the name this server sent for " :eyes: ". ${picker}; ${custom}`,
    ),
  );
  // A blank name counts as none given.
  assert.ok((await add('   ')).endsWith(`No reaction was added: this workspace has no emoji by the name given. ${picker}; ${custom}`));
});

test("a conversation's threading rule points to the tool that fits it", async () => {
  assert.match(
    await explain('restricted_action_thread_only_channel', 'send_message', { channelId: 'C10' }),
    /Nothing was posted: conversation C10 takes messages only as thread replies\. Use reply_message with the id of the message you're answering\./,
  );
  assert.match(
    await explain('restricted_action_non_threadable_channel', 'reply_message', { channelId: 'C10', messageId: '1.1' }),
    /Nothing was posted: conversation C10 doesn't take thread replies\. Post with send_message instead\./,
  );
});

test("a workspace's settings that forbid the call say only its admins can change them", async () => {
  const details: Array<[string, RegExp]> = [
    ['restricted_action', /a workspace setting stops this bot from doing this/],
    ['restricted_action_read_only_channel', /conversation C11 is read-only/],
    ['restricted_action_thread_locked', /the thread is locked/],
    ['thread_locked', /the thread is locked/],
    ['ekm_access_denied', /the workspace's admins have turned this off there/],
  ];
  for (const [code, detail] of details) {
    const text = await explain(code, 'send_message', { channelId: 'C11' });
    assert.match(text, /Nothing was posted: Slack refused it under the workspace's settings: /, code);
    assert.match(text, detail, code);
    assert.match(text, /Calling again won't change that; only the workspace's admins can\.$/, code);
  }
});

test('a missing scope is for whoever runs the host, and names the scope when Slack does', async () => {
  const named = await explain('missing_scope', 'add_reaction', { channelId: 'C12', messageId: '1.1', emoji: 'eyes' }, {
    needed: 'reactions:write',
    provided: 'chat:write',
  });
  assert.match(named, /hasn't been granted the scope this call needs \(Slack names reactions:write\), so Slack refused it/);
  assert.match(named, /whoever runs this host has to add it to the app's bot token scopes and reinstall the app/);
  const unnamed = await explain('missing_scope', 'send_message', { channelId: 'C12' });
  assert.match(unnamed, /hasn't been granted the scope this call needs, so Slack refused it/);
  assert.match(unnamed, /has to add the scope to the app's bot token scopes/);
});

test("a token Slack doesn't accept says every tool fails until the host fixes it", async () => {
  for (const code of ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']) {
    const text = await explain(code, 'fetch_history', { channelId: 'C13' });
    assert.match(
      text,
      /Nothing was read: Slack doesn't accept this server's bot token, so it refused the call\. Every Slack tool here fails the same way until whoever runs this host fixes the token/,
      code,
    );
  }
});

test("Slack's own failure: a read is tried again, a write's outcome is unknown and named how to check", async () => {
  assert.match(
    await explain('internal_error', 'fetch_thread', { channelId: 'C14', threadTs: '1.1' }),
    /Nothing was read: Slack failed while handling the call\. Try again shortly\./,
  );
  const post = await explain('internal_error', 'send_message', { channelId: 'C14' });
  assert.match(post, /\n\nSlack failed while handling the call, so whether the message was posted is unknown \(Slack says part of a call can take effect before this error\)\./);
  assert.match(post, /Check fetch_history for conversation C14 before posting again, so it isn't posted twice\./);
  assert.doesNotMatch(post, /Nothing was posted/, 'a failed write is not said to have done nothing');
  assert.match(
    await explain('fatal_error', 'send_dm', { userId: 'U1' }),
    /whether the message was posted is unknown \(Slack says part of a call can take effect before this error\)\. Check the DM's history \(list_channels shows its id, and fetch_history its messages\)/,
  );
  // fetch_history leaves out a reply that wasn't also sent to the channel, so a reply is looked for in its thread.
  assert.match(
    await explain('internal_error', 'reply_message', { channelId: 'C14', messageId: '1.2' }),
    /Check fetch_thread for the thread under message 1\.2 in conversation C14 before posting again/,
  );
  assert.match(
    await explain('internal_error', 'channels/publish', { channelId: 'C14', threadTs: '1.3' }),
    /Check fetch_thread for the thread under message 1\.3 in conversation C14 before posting again/,
  );
  assert.match(
    await explain('internal_error', 'channels/publish', { channelId: 'C14' }),
    /Check fetch_history for conversation C14 before posting again/,
  );
  // channels/publish names no thread itself: it goes to the thread of the last message from the
  // conversation that the host took, as handlePublish recorded it before the post.
  for (const code of ['thread_not_found', 'message_not_found', 'bad_timestamp']) {
    assert.ok(
      (await explain(code, 'channels/publish', { channelId: 'C14', threadTs: '1.3' })).endsWith(
        'Nothing was posted: this server replies in the thread of the last message from a conversation that ' +
          'reached you. Here that was the thread under message 1.3 in conversation C14, and Slack refused it. ' +
          'Another publish to conversation C14 now would go to the same thread. ' +
          'send_message posts in the conversation itself, and reply_message under a message you choose.',
      ),
      code,
    );
    assert.equal(await explain(code, 'channels/publish', { channelId: 'C14' }), `An API error occurred: ${code}`);
  }
  assert.match(
    await explain('internal_error', 'edit_message', { channelId: 'C14', messageId: '1.2' }),
    /whether the edit took is unknown .*fetch_history shows message 1\.2 as it is now if it's in the channel itself, and fetch_thread does, with its thread's id, if it's a thread reply\./s,
  );
  assert.match(
    await explain('internal_error', 'delete_message', { channelId: 'C14', messageId: '1.2' }),
    /whether message 1\.2 was deleted is unknown .*fetch_history shows whether it's still there if it's in the channel itself, and fetch_thread does, with its thread's id, if it's a thread reply\. Deleting it again is safe: once it's gone, Slack answers message_not_found\./s,
  );
  assert.match(
    await explain('internal_error', 'add_reaction', { channelId: 'C14', messageId: '1.2', emoji: 'eyes' }),
    /whether the reaction was added is unknown .*Adding it again is safe: if it's there, Slack answers already_reacted\./s,
  );
  const unavailable = await explain('service_unavailable', 'send_message', { channelId: 'C14' });
  assert.match(unavailable, /whether the message was posted is unknown\. Check fetch_history/);
  assert.doesNotMatch(unavailable, /part of a call/, 'only internal_error and fatal_error are documented as partial');
});

test('a user id Slack does not know or show points to find_user, or says nothing changes it', async () => {
  assert.match(
    await explain('user_not_found', 'send_dm', { userId: 'U0NOPE', content: 'hi' }),
    /Nothing was sent: Slack has no user U0NOPE\. The id may be mistyped or remembered rather than copied\. find_user returns each person's userId\./,
  );
  assert.match(
    await explain('user_not_visible', 'send_dm', { userId: 'U9', content: 'hi' }),
    /Nothing was sent: this bot isn't allowed to see user U9, so it can't open a DM with them\. Calling again won't change that\./,
  );
});

test('other errors and other codes pass through unchanged', async () => {
  const unlisted = await slackError('invalid_arguments');
  assert.equal(explainSlackError(unlisted, { tool: 'send_message', args: {} }), 'An API error occurred: invalid_arguments');
  const reacted = await slackError('already_reacted');
  assert.equal(
    explainSlackError(reacted, { tool: 'add_reaction', args: { channelId: 'C1', messageId: '1.1', emoji: 'eyes' } }),
    'An API error occurred: already_reacted',
  );
  const local = new Error('channelId is required');
  assert.equal(explainSlackError(local, { tool: 'send_message', args: {} }), 'channelId is required');
  // A refusal's shape without the client's code is not read as one.
  const lookalike = Object.assign(new Error('An API error occurred: channel_not_found'), { data: { error: 'channel_not_found' } });
  assert.equal(explainSlackError(lookalike, { tool: 'send_message', args: { channelId: 'C1' } }), lookalike.message);
  assert.equal(explainSlackError('a string', { tool: 'send_message', args: {} }), 'a string');
});

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };

test("a tool's refusal reaches the agent explained, still marked as an error", async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  answer = { ok: false, error: 'channel_not_found' };
  const result = (await h.host.sendRequest('tools/call', {
    name: 'send_message',
    arguments: { channelId: 'C0NOPE', content: 'hi' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /^An API error occurred: channel_not_found\n\nNothing was posted: Slack doesn't know conversation C0NOPE/,
  );
  await h.close();
});

test("an upload refusal reaches the agent with an upload-specific explanation", async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  try {
    for (const [error, messageId] of [
      ['missing_scope', undefined],
      ['not_in_channel', undefined],
      ['internal_error', undefined],
      ['internal_error', '1.7'],
    ] as const) {
      answer = { ok: false, error, needed: 'files:write' };
      const result = (await h.host.sendRequest('tools/call', {
        name: 'upload_file',
        arguments: { channelId: 'CFILES', filename: 'report.txt', content: 'report', ...(messageId ? { messageId } : {}) },
      })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true);
      assert.equal(lastCall?.method, 'files.completeUploadExternal');
      const text = result.content[0].text;
      assert.ok(text.startsWith(`An API error occurred: ${error}\n\n`), text);
      assert.doesNotMatch(text, /Nothing was done|Nothing was sent|the message was posted/);
      if (error === 'internal_error') {
        assert.match(text, /whether the file was uploaded is unknown/);
        assert.doesNotMatch(text, /Nothing was uploaded/);
        assert.ok(text.includes(messageId
          ? 'fetch_thread for the thread under message 1.7 in conversation CFILES'
          : 'fetch_history for conversation CFILES'), text);
        assert.match(text, /before uploading again, so it isn't uploaded twice\.$/);
      } else {
        assert.match(text, /\n\nNothing was uploaded: /);
        if (error === 'missing_scope') assert.match(text, /Slack names files:write/);
        else {
          assert.match(text, /Slack didn't let it upload there/);
          assert.doesNotMatch(text, /chat:write.public/);
        }
      }
    }
  } finally {
    await h.close();
  }
});

test('an emoji Slack refuses is named as add_reaction sent it', async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  answer = { ok: false, error: 'invalid_name' };
  const result = (await h.host.sendRequest('tools/call', {
    name: 'add_reaction',
    arguments: { channelId: 'C9', messageId: '1.1', emoji: 'thumbsup::skin-tone-2' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(lastCall?.method, 'reactions.add');
  assert.equal(lastCall?.params.get('name'), 'thumbsupskin-tone-2');
  assert.match(result.content[0].text, /no emoji named "thumbsupskin-tone-2", the name this server sent for "thumbsup::skin-tone-2"/);
  await h.close();
});

test("the host's channels/publish gets the same explanation in its error", async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, true);
  answer = { ok: true };
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  answer = { ok: false, error: 'not_in_channel' };
  await assert.rejects(
    h.host.sendRequest(method.CHANNELS_PUBLISH, {
      conversationId: 'conv-1',
      channelId: 'slack:C0OUT',
      content: [{ type: 'text', text: 'hello' }],
    }),
    /An API error occurred: not_in_channel\n\nNothing was posted: this bot isn't a member of conversation C0OUT, so Slack didn't let it post there/,
  );
  await h.close();
});
