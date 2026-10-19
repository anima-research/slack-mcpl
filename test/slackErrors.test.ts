/**
 * Slack's failed calls, explained (src/slack-errors.ts). Each error here is
 * the one @slack/web-api throws, with this server's client settings, for what
 * Slack answers: a real WebClient calls a local endpoint that answers as
 * Slack's Web API does (test/slackApi.ts), so the explainer reads the client's
 * own shape (`code`, Slack's answer in `data`, `retryAfter`, `statusCode`).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebClient } from '@slack/web-api';
import { method } from '@animalabs/mcpl-core';
import { explainSlackError } from '../src/slack-errors.js';
import {
  CALL_SECONDS,
  OutOfCallTime,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  slackRefusal,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
import { connectHost, nonJsonSlackApiUrl, initialize, FULL_GRANT } from './harness.js';
import { fakeSlackApi, silentSlackApi, unreachableSlackApiUrl, type FakeSlackApi } from './slackApi.js';

let api: FakeSlackApi;
let client: WebClient;

before(async () => {
  api = await fakeSlackApi();
  // An upload's first two steps succeed, so its tests reach
  // files.completeUploadExternal, whose answer each test gives.
  api.answerFor('files.getUploadURLExternal', { body: { ok: true, file_id: 'FTEST', upload_url: `${api.url}file-upload` } });
  api.answerFor('file-upload', { body: { ok: true } });
  client = new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
});

after(() => api.close());

/** The error the client throws for an answer, or for Slack out of reach. */
async function clientError(call: WebClient = client): Promise<unknown> {
  try {
    await call.apiCall('chat.postMessage', { channel: 'C1', text: 'x' });
  } catch (err) {
    return err;
  }
  throw new Error('the client did not throw');
}

/** The error the client throws when Slack refuses a call with `error`. */
async function slackError(error: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  api.answer({ body: { ok: false, error, ...extra } });
  return clientError();
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
 *  listed apart: fetch_attachment downloads with its own fetch, whose texts
 *  for a download out of its call's time and one that times out are tested
 *  in attachmentDownload.test.ts, and the subscription tools keep local
 *  state. */
const CALLS: Array<[tool: string, lead: string, writes: boolean]> = [
  ['send_message', 'Nothing was posted', true],
  ['reply_message', 'Nothing was posted', true],
  ['channels/publish', 'Nothing was posted', true],
  ['send_dm', 'Nothing was sent', true],
  ['upload_file', 'Nothing was uploaded', true],
  ['edit_message', "The message wasn't changed", true],
  ['delete_message', 'Nothing was deleted', true],
  ['add_reaction', 'No reaction was added', true],
  ['fetch_history', 'No messages were returned', false],
  ['fetch_thread', 'No messages were returned', false],
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
  assert.match(read, /No messages were returned: this bot isn't a member of conversation C2, so Slack didn't let it read there/);
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
    "Pass the thread's parent id: a reply's thread=, a message's own id= when it shows no thread=, or a message's rootTs in fetch_history or fetch_thread results";
  assert.ok(
    (await explain('bad_timestamp', 'fetch_thread', { channelId: 'C4', threadTs: 'nope' })).endsWith(
      `No messages were returned: nope isn't a message id, which looks like 1718000000.000100. ${parent}.`,
    ),
  );
  assert.ok(
    (await explain('message_not_found', 'fetch_thread', { channelId: 'C4', threadTs: '1.7' })).endsWith(
      `No messages were returned: Slack has no message 1.7 in conversation C4. The id may be mistyped or remembered rather than copied, or the message was deleted or is in another conversation. ${parent}, with the conversation it's in.`,
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
    /No messages were returned: Slack has no thread under message 9\.9 in conversation C5\..*Pass the thread's parent id: a reply's thread=, a message's own id= when it shows no thread=, or a message's rootTs in fetch_history or fetch_thread results\.$/s,
  );
  // reply_message names the thread it replies under as messageId.
  assert.match(
    await explain('thread_not_found', 'reply_message', { channelId: 'C5', messageId: '8.8', content: 'hi' }),
    /Nothing was posted: Slack has no thread under message 8\.8 in conversation C5\./,
  );
  assert.match(
    await explain('invalid_ts_latest', 'fetch_history', { channelId: 'C5', latest: 'yesterday' }),
    /No messages were returned: latest yesterday isn't a message id/,
  );
  assert.match(
    await explain('invalid_ts_oldest', 'fetch_history', { channelId: 'C5', oldest: 'x' }),
    /No messages were returned: oldest x isn't a message id/,
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
      /No messages were returned: Slack doesn't accept this server's bot token, so it refused the call\. Every Slack tool here fails the same way until whoever runs this host fixes the token/,
      code,
    );
  }
});

test("Slack's own failure: a read is tried again, a write's outcome is unknown and named how to check", async () => {
  assert.match(
    await explain('internal_error', 'fetch_thread', { channelId: 'C14', threadTs: '1.1' }),
    /No messages were returned: Slack failed while handling the call\. Try again shortly\./,
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
    /whether the reaction was added is unknown .*Adding it again is safe: if it's there, add_reaction says so and changes nothing\./s,
  );
  const unavailable = await explain('service_unavailable', 'send_message', { channelId: 'C14' });
  assert.match(unavailable, /whether the message was posted is unknown\. Check fetch_history/);
  assert.doesNotMatch(unavailable, /part of a call/, 'only internal_error and fatal_error are documented as partial');
});

test('a rate limit says nothing was done and how long Slack asks to wait', async () => {
  api.answer({ status: 429, headers: { 'retry-after': '7' }, body: { ok: false, error: 'ratelimited' } });
  const err = await clientError();
  assert.equal(
    explainSlackError(err, { tool: 'send_message', args: { channelId: 'C15' } }),
    'A rate-limit has been reached, you may retry this request in 7 seconds\n\nNothing was posted: Slack is ' +
      'rate-limiting this kind of call for the workspace, and asks to wait 7 seconds before trying again.',
  );
  assert.match(
    explainSlackError(err, { tool: 'fetch_history', args: { channelId: 'C15' } }),
    /\n\nNo messages were returned: Slack is rate-limiting this kind of call for the workspace, and asks to wait 7 seconds/,
  );
  api.answer({ status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } });
  assert.match(
    explainSlackError(await clientError(), { tool: 'send_message', args: { channelId: 'C15' } }),
    /asks to wait 1 second before trying again\.$/,
  );
  // A count below 0 isn't a wait, so it's left out, as for a ratelimited
  // refusal.
  api.answer({ status: 429, headers: { 'retry-after': '-1' }, body: { ok: false, error: 'ratelimited' } });
  assert.match(
    explainSlackError(await clientError(), { tool: 'send_message', args: { channelId: 'C15' } }),
    /\n\nNothing was posted: Slack is rate-limiting this kind of call for the workspace\. Try again shortly\.$/,
  );
  // A listing a call pages through starts over from its first page, so calling again can stop at the same place.
  for (const [tool, lead] of [
    ['list_channels', 'Nothing was listed'],
    ['find_user', 'No users were listed'],
    ['refresh_channels', 'Nothing was announced to the host'],
  ] as const) {
    assert.match(
      explainSlackError(err, { tool, args: {} }),
      new RegExp(`\\n\\n${lead}: Slack is rate-limiting this kind of call for the workspace, and asks to wait 7 seconds ` +
        'before trying again\\. A new call starts the listing over from the first page, so if the workspace is too large ' +
        "to list within Slack's limit, calling again stops near the same place\\.$"),
      tool,
    );
  }
  api.answer({ body: { ok: false, error: 'ratelimited' } });
  assert.match(
    explainSlackError(await clientError(), { tool: 'list_channels', args: {} }),
    /\n\nNothing was listed: Slack is rate-limiting this kind of call for the workspace\. Try again shortly\. A new call starts the listing over from the first page, so if the workspace is too large to list within Slack's limit, calling again stops near the same place\.$/,
  );
});

test("a failure in transit leaves a write's outcome unknown, and a read is tried again", async () => {
  // A request with no answer: the client's own timeout, shortened here.
  const silent = await silentSlackApi();
  const unanswered = await clientError(
    new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, timeout: 300, slackApiUrl: silent.url }),
  ).finally(() => silent.close());
  assert.match(
    explainSlackError(unanswered, { tool: 'send_message', args: { channelId: 'C16' } }),
    /^A request error occurred: .*\n\nSlack went 10 seconds without answering, or the connection to it failed, so whether the message was posted is unknown\. Check fetch_history for conversation C16 before posting again, so it isn't posted twice\.$/s,
  );
  assert.match(
    explainSlackError(unanswered, { tool: 'fetch_history', args: { channelId: 'C16' } }),
    /\n\nNo messages were returned: Slack went 10 seconds without answering, or the connection to it failed\. Try again shortly\.$/,
  );
  api.answer({ status: 503, body: { ok: false } });
  const unavailable = await clientError();
  assert.match(
    explainSlackError(unavailable, { tool: 'edit_message', args: { channelId: 'C16', messageId: '1.3' } }),
    /^An HTTP protocol error occurred: statusCode = 503\n\nSlack answered with HTTP 503, so whether the edit took is unknown\. fetch_history shows message 1\.3 as it is now if it's in the channel itself, and fetch_thread does, with its thread's id, if it's a thread reply\.$/,
  );
  assert.match(
    explainSlackError(unavailable, { tool: 'find_user', args: { query: 'ann' } }),
    /\n\nNo users were listed: Slack answered with HTTP 503\. Try again shortly\.$/,
  );
});

test("a connection that couldn't be made says nothing was done, even for a write", async () => {
  const refused = await clientError(
    new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await unreachableSlackApiUrl() }),
  );
  assert.match(
    explainSlackError(refused, { tool: 'send_message', args: { channelId: 'C17' } }),
    /^A request error occurred: connect ECONNREFUSED .*\n\nNothing was posted: Slack couldn't be reached\. Try again shortly\. If it keeps failing, whoever runs this host has to check its connection to Slack\.$/s,
  );
  assert.match(
    explainSlackError(refused, { tool: 'fetch_history', args: { channelId: 'C17' } }),
    /\n\nNo messages were returned: Slack couldn't be reached\. Try again shortly\. If it keeps failing, whoever runs this host has to check its connection to Slack\.$/,
  );
  // The other codes Node gives for a connection never made can't be produced
  // here, so each is put on the client's own error in place of ECONNREFUSED.
  const withNodeCode = (code: string) => Object.assign(new Error((refused as Error).message), {
    code: (refused as { code: unknown }).code,
    original: Object.assign(new Error(`connect ${code}`), { code }),
  });
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENETUNREACH', 'EHOSTUNREACH']) {
    assert.match(
      explainSlackError(withNodeCode(code), { tool: 'send_message', args: { channelId: 'C17' } }),
      /\n\nNothing was posted: Slack couldn't be reached\. Try again shortly\. If it keeps failing, whoever runs this host has to check its connection to Slack\.$/,
      code,
    );
  }
  // A connection that was made, then failed, leaves a write's outcome unknown.
  assert.match(
    explainSlackError(withNodeCode('ECONNRESET'), { tool: 'send_message', args: { channelId: 'C17' } }),
    /so whether the message was posted is unknown/,
  );
});

test('a request Slack received only in part, or rate-limited in its answer, says nothing was done', async () => {
  assert.match(
    await explain('request_timeout', 'send_message', { channelId: 'C18' }),
    /\n\nNothing was posted: Slack didn't receive the whole request, so it didn't act on it\. Try again shortly\.$/,
  );
  assert.match(
    await explain('request_timeout', 'fetch_history', { channelId: 'C18' }),
    /\n\nNo messages were returned: Slack didn't receive the whole request, so it didn't act on it\. Try again shortly\.$/,
  );
  assert.match(
    await explain('ratelimited', 'edit_message', { channelId: 'C18', messageId: '1.1' }),
    /\n\nThe message wasn't changed: Slack is rate-limiting this kind of call for the workspace\. Try again shortly\.$/,
  );
  // With a Retry-After, which the client keeps in the answer's
  // response_metadata, it gives Slack's seconds, as a 429's text does.
  api.answer({ headers: { 'retry-after': '12' }, body: { ok: false, error: 'ratelimited' } });
  assert.match(
    explainSlackError(await clientError(), { tool: 'edit_message', args: { channelId: 'C18', messageId: '1.1' } }),
    /\n\nThe message wasn't changed: Slack is rate-limiting this kind of call for the workspace, and asks to wait 12 seconds before trying again\.$/,
  );
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

test("other errors and other codes pass through unchanged, and a read's still says that no messages were returned", async () => {
  const unlisted = await slackError('invalid_arguments');
  assert.equal(explainSlackError(unlisted, { tool: 'send_message', args: {} }), 'An API error occurred: invalid_arguments');
  // A read that fails returns nothing, so its failure says so, unless its own
  // text opens with it, as the read's own refusals do.
  assert.equal(
    explainSlackError(unlisted, { tool: 'fetch_history', args: { channelId: 'C1' } }),
    'An API error occurred: invalid_arguments\n\nNo messages were returned.',
  );
  assert.equal(explainSlackError(new Error('a bug'), { tool: 'fetch_thread', args: {} }), 'a bug\n\nNo messages were returned.');
  const own = new Error('No messages were returned: limit must be an integer from 1 to 1000.');
  assert.equal(explainSlackError(own, { tool: 'fetch_history', args: {} }), own.message);
  const reacted = await slackError('already_reacted');
  assert.equal(
    explainSlackError(reacted, { tool: 'add_reaction', args: { channelId: 'C1', messageId: '1.1', emoji: 'eyes' } }),
    'An API error occurred: already_reacted',
  );
  // file_not_found is explained for an upload's last step alone; chat.update's
  // passes through.
  assert.equal(
    await explain('file_not_found', 'edit_message', { channelId: 'C1', messageId: '1.1', content: 'hi' }),
    'An API error occurred: file_not_found',
  );
  // So are a workspace's refusals of an upload, which no other tool gets.
  for (const code of ['file_uploads_disabled', 'storage_limit_reached']) {
    assert.equal(await explain(code, 'send_message', { channelId: 'C1', content: 'hi' }), `An API error occurred: ${code}`);
  }
  const local = new Error('channelId is required');
  assert.equal(explainSlackError(local, { tool: 'send_message', args: {} }), 'channelId is required');
  // A refusal's shape without the client's code is not read as one.
  const lookalike = Object.assign(new Error('An API error occurred: channel_not_found'), { data: { error: 'channel_not_found' } });
  assert.equal(explainSlackError(lookalike, { tool: 'send_message', args: { channelId: 'C1' } }), lookalike.message);
  assert.equal(explainSlackError('a string', { tool: 'send_message', args: {} }), 'a string');
});

test("a body that is one lowercase word reads as Slack's refusal, as the shape rule takes it (R1-4)", async (t) => {
  const err = await clientError(new WebClient('xoxb-test', {
    ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t, 'upstream_error'),
  }));
  assert.equal(slackRefusal(err), 'upstream_error');
  assert.equal(explainSlackError(err, { tool: 'send_message', args: { channelId: 'C1', content: 'hi' } }), 'An API error occurred: upstream_error');
});

test("an answer that isn't in Slack's form leaves a write's outcome unknown, and another call says to try again", async (t) => {
  // A body that isn't JSON, such as a proxy's page, which the client reads as
  // a refusal whose code is the body itself.
  const err = await clientError(new WebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: await nonJsonSlackApiUrl(t) }));
  const posted = explainSlackError(err, { tool: 'send_message', args: { channelId: 'C1', content: 'hi' } });
  assert.ok(posted.endsWith(
    "\n\nSlack answered in a form this server can't read, so whether the message was posted is unknown. Check " +
      "fetch_history for conversation C1 before posting again, so it isn't posted twice."), posted);
  const listed = explainSlackError(err, { tool: 'list_channels', args: {} });
  assert.ok(listed.endsWith(
    "\n\nNothing was listed: Slack answered in a form this server can't read. Try again shortly. If it keeps failing, " +
      'whoever runs this host has to check its connection to Slack.'), listed);
  // A read's failure opens with what every failure of a read opens with.
  for (const [tool, args] of [['fetch_history', { channelId: 'C1' }], ['fetch_thread', { channelId: 'C1', threadTs: '1.1' }]] as const) {
    const read = explainSlackError(err, { tool, args });
    assert.ok(read.endsWith(
      "\n\nNo messages were returned: Slack answered in a form this server can't read. Try again shortly. If it keeps " +
        'failing, whoever runs this host has to check its connection to Slack.'), read);
  }
});

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };

test("a request its call's deadline left no time for says it wasn't sent, and that calling again is safe", () => {
  const text = explainSlackError(new OutOfCallTime('chat.postMessage', 16), { tool: 'send_message', args: { channelId: 'C1', content: 'hi' } });
  assert.ok(text.startsWith("chat.postMessage: out of this call's time\n\n"), text);
  assert.ok(
    text.endsWith(
      `\n\nNothing was posted: this server gives each call ${CALL_SECONDS} seconds from when it reaches this server, and ` +
        'this one had used 16 of them, waiting behind earlier calls or on its own earlier requests, so too few were ' +
        "left to send this request to Slack. It wasn't sent, so calling again is safe.",
    ),
    text,
  );
  const listing = explainSlackError(new OutOfCallTime('conversations.list', 20), { tool: 'list_channels', args: {} });
  assert.match(
    listing,
    new RegExp(`calling again is safe\\. A new call starts the listing over from the first page, so if the workspace is too large to list within a call's ${CALL_SECONDS} seconds, calling again stops near the same place\\.$`),
  );
});

test("a tool's refusal reaches the agent explained, still marked as an error", async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  api.answer({ body: { ok: false, error: 'channel_not_found' } });
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
  // The adapter's own client, which marks each error with its request, as
  // connectSlack builds it: the last step's errors read as the sharing's.
  const own = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  const slack = new SlackAdapter(own as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  try {
    for (const [error, messageId] of [
      ['missing_scope', undefined],
      ['not_in_channel', undefined],
      ['internal_error', undefined],
      ['internal_error', '1.7'],
    ] as const) {
      api.answerFor('files.completeUploadExternal', { body: { ok: false, error, needed: 'files:write' } });
      const result = (await h.host.sendRequest('tools/call', {
        name: 'upload_file',
        arguments: { channelId: 'CFILES', filename: 'report.txt', content: 'report', ...(messageId ? { messageId } : {}) },
      })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true);
      assert.equal(api.calls.at(-1), 'files.completeUploadExternal');
      const text = result.content[0].text;
      assert.ok(text.startsWith(`An API error occurred: ${error}\n\n`), text);
      assert.doesNotMatch(text, /Nothing was done|Nothing was sent|the message was posted/);
      if (error === 'internal_error') {
        assert.match(text, /whether the file was shared is unknown/);
        assert.doesNotMatch(text, /Nothing was (uploaded|shared)/);
        assert.ok(text.includes(messageId
          ? 'fetch_thread for the thread under message 1.7 in conversation CFILES'
          : 'fetch_history for conversation CFILES'), text);
        assert.match(text, /before uploading again, so it isn't shared twice\.$/);
      } else {
        // The last step shares the file, so its refusal shared nothing.
        assert.match(text, /\n\nNothing was shared: /);
        if (error === 'missing_scope') assert.match(text, /Slack names files:write/);
        else {
          assert.match(text, /Slack didn't let it share the file there/);
          assert.doesNotMatch(text, /chat:write.public/);
        }
      }
    }
  } finally {
    api.answerFor('files.completeUploadExternal');
    await h.close();
  }
});

test('an emoji Slack refuses is named as add_reaction sent it', async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  api.answer({ body: { ok: false, error: 'invalid_name' } });
  const result = (await h.host.sendRequest('tools/call', {
    name: 'add_reaction',
    arguments: { channelId: 'C9', messageId: '1.1', emoji: 'thumbsup::skin-tone-2' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(api.calls.at(-1), 'reactions.add');
  assert.equal(api.sent.at(-1)?.get('name'), 'thumbsupskin-tone-2');
  assert.match(result.content[0].text, /no emoji named "thumbsupskin-tone-2", the name this server sent for "thumbsup::skin-tone-2"/);
  await h.close();
});

test("the host's channels/publish gets the same explanation in its error", async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, true);
  api.answer({ body: { ok: true } });
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  api.answer({ body: { ok: false, error: 'not_in_channel' } });
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

test('a reaction already there answers as a success that says nothing changed', async () => {
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  await initialize(h, false);
  api.answer({ body: { ok: false, error: 'already_reacted' } });
  const result = (await h.host.sendRequest('tools/call', {
    name: 'add_reaction',
    arguments: { channelId: 'C1', messageId: '1718000000.000100', emoji: 'eyes' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].text, "Nothing changed: message 1718000000.000100 already has this bot's eyes reaction.");
  // Any other refusal stays an error.
  api.answer({ body: { ok: false, error: 'invalid_name' } });
  const refused = (await h.host.sendRequest('tools/call', {
    name: 'add_reaction',
    arguments: { channelId: 'C1', messageId: '1718000000.000100', emoji: 'nope' },
  })) as { isError?: boolean };
  assert.equal(refused.isError, true);
  await h.close();
});
