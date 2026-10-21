/**
 * A post this server can't name: Slack's answer named no message (no ts), or
 * the post failed in a way that may have posted it. Its call answers as an
 * unknown outcome, never as a success with an empty id, and a rollback past it
 * says it may remain, with where the agent can find its id, rather than send a
 * delete with an empty ts. A post that can't have gone out, such as one Slack
 * refused, leaves nothing to say. Driven through the real client against a
 * local endpoint that answers as Slack does.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import {
  CALL_SECONDS,
  SLACK_CLIENT_OPTIONS,
  SlackAdapter,
  SlackWebClient,
  postLeftBy,
  withCallTime,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack-adapter.js';
import { explainSlackError, type SlackCall } from '../src/slack-errors.js';
import { SlackMcplServer } from '../src/server.js';
import { MESSAGING_FEATURE_SET } from '../src/feature-sets.js';
import { FULL_GRANT, connectHost, initialize, nonJsonSlackApiUrl } from './harness.js';
import { fakeSlackApi, silentSlackApi, unreachableSlackApiUrl, type SlackApiAnswer, type FakeSlackApi } from './slackApi.js';

let api: FakeSlackApi;
let client: SlackWebClient;
before(async () => {
  api = await fakeSlackApi();
  client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
});
after(() => api.close());

const socket: SlackSocketLike = { on() {}, async start() {}, async disconnect() {} };

type Result = { isError?: boolean; content: { text: string }[]; state?: { checkpoint: string; parent: string | null } };

/** A server with slack.messaging active, whose posts get `posts` in turn. */
async function server(t: { after(fn: () => unknown): void }, ...posts: SlackApiAnswer[]) {
  api.answerFor('chat.postMessage', ...posts);
  t.after(() => api.answerFor('chat.postMessage'));
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const call = (name: string, args: Record<string, unknown>) =>
    h.host.sendRequest('tools/call', { name, arguments: args }) as Promise<Result>;
  const rollback = (checkpoint: string) => h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: MESSAGING_FEATURE_SET, checkpoint,
  }) as Promise<{ success: boolean; reason?: string }>;
  /** The chat.delete calls from `from` on, as [channel, ts]. */
  const deletes = (from: number) =>
    api.calls.flatMap((called, i) => (i >= from && called === 'chat.delete' ? [[api.sent[i].get('channel'), api.sent[i].get('ts')]] : []));
  return { h, call, rollback, deletes };
}

const named = { body: { ok: true, ts: '1.1' } };
const unnamed = { body: { ok: true } };

/** The lines a rollback logged for posts this server can't name. */
const unnamedLines = (logged: { mock: { calls: Array<{ arguments: unknown[] }> } }) =>
  logged.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.includes("Slack's answer to the post named none"));

test("a post whose answer names no message is an unknown outcome, joins the next call's checkpoint, and a rollback past it says it may remain instead of deleting an empty ts", { timeout: 5000 }, async (t) => {
  const { call, rollback, deletes } = await server(t, named, unnamed, { body: { ok: true, ts: '1.3' } });
  const one = await call('send_message', { channelId: 'C1', content: 'one' });
  const two = await call('send_message', { channelId: 'C1', content: 'two' });
  assert.equal(two.isError, true);
  assert.equal(two.state, undefined, 'a failed call makes no checkpoint');
  assert.match(
    two.content[0].text,
    /^chat\.postMessage: the answer named no message in C1\n\nSlack's answer to the post named no message, so whether the message was posted is unknown\. Check fetch_history for conversation C1 before posting again, so it isn't posted twice\.$/,
  );
  const three = await call('send_message', { channelId: 'C1', content: 'three' });
  assert.equal(three.state!.parent, one.state!.checkpoint, 'no checkpoint came between them');
  // The post with no ts belongs to three's checkpoint, as what any failed
  // call leaves does, so a rollback to that checkpoint keeps it.
  let from = api.calls.length;
  assert.deepEqual(await rollback(three.state!.checkpoint), { checkpoint: three.state!.checkpoint, success: true });
  assert.deepEqual(deletes(from), []);
  const logged = t.mock.method(console, 'error', () => {});
  from = api.calls.length;
  const back = await rollback(one.state!.checkpoint);
  assert.deepEqual(deletes(from), [['C1', '1.3']]);
  assert.deepEqual(back, {
    checkpoint: one.state!.checkpoint,
    success: true,
    reason: "Rolled back (1/2 messages deleted). May remain: a message in C1 whose id this server doesn't know. No rollback " +
      'tries these again: delete_message can delete one by its id, which fetch_history shows (fetch_thread, for one in a thread)',
  });
  assert.deepEqual(unnamedLines(logged), [
    "[slack-mcpl] Rollback couldn't delete a message in C1: Slack's answer to the post named none, or the post's outcome is unknown",
  ]);
});

test("a reply this server can't name is placed under its thread, beside a message a delete didn't confirm gone", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('chat.delete'));
  const { call, rollback } = await server(t, named, { body: { ok: true, ts: '1.2' } }, unnamed);
  const one = await call('send_message', { channelId: 'C1', content: 'one' });
  await call('send_message', { channelId: 'C1', content: 'two' });
  const reply = await call('reply_message', { channelId: 'C1', messageId: '1.1', content: 'three' });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /Check fetch_thread for the thread under message 1\.1 in conversation C1 before posting again/);
  // A delete that failed on the way, so the message may remain, beside the
  // one whose id this server doesn't know.
  api.answerFor('chat.delete', { status: 503, body: { ok: false } });
  const logged = t.mock.method(console, 'error', () => {});
  assert.equal(
    (await rollback(one.state!.checkpoint)).reason,
    'Rolled back (0/2 messages deleted). May remain: message 1.2 in C1; a message in the thread under message 1.1 in C1 ' +
      "whose id this server doesn't know. No rollback tries these again: delete_message can try a message among them " +
      "again, by its id, and fetch_history shows the id of one this server doesn't know (fetch_thread, for one in a thread)",
  );
  assert.deepEqual(unnamedLines(logged), [
    "[slack-mcpl] Rollback couldn't delete a message in the thread under message 1.1 in C1: Slack's answer to the post " +
      "named none, or the post's outcome is unknown",
  ]);
});

test("a post this server can't name stays under may remain beside a message Slack refused to delete for good", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('chat.delete'));
  const { call, rollback } = await server(t, named, { body: { ok: true, ts: '1.2' } }, unnamed);
  const one = await call('send_message', { channelId: 'C1', content: 'one' });
  await call('send_message', { channelId: 'C1', content: 'two' });
  await call('send_message', { channelId: 'C1', content: 'three' });
  api.answerFor('chat.delete', { body: { ok: false, error: 'cant_delete_message' } });
  assert.equal(
    (await rollback(one.state!.checkpoint)).reason,
    "Rolled back (0/2 messages deleted). May remain: a message in C1 whose id this server doesn't know. No rollback tries " +
      'these again: delete_message can delete one by its id, which fetch_history shows (fetch_thread, for one in a thread). ' +
      "Slack refused to delete these, and calling again won't change that: message 1.2 in C1",
  );
});

test('a post that failed in a way that may have posted it may remain after a rollback, and one Slack refused leaves nothing', { timeout: 5000 }, async (t) => {
  const { call, rollback, deletes } = await server(t, named, { status: 503, body: { ok: false } }, { body: { ok: false, error: 'not_in_channel' } });
  const one = await call('send_message', { channelId: 'C1', content: 'one' });
  // Each in a conversation of its own, so the rollback's note shows which one
  // it keeps.
  const lost = await call('send_message', { channelId: 'C2', content: 'two' });
  assert.match(lost.content[0].text, /Slack answered with HTTP 503, so whether the message was posted is unknown\./);
  const refused = await call('send_message', { channelId: 'C3', content: 'three' });
  assert.match(refused.content[0].text, /^An API error occurred: not_in_channel\n\nNothing was posted/);
  const from = api.calls.length;
  const back = await rollback(one.state!.checkpoint);
  assert.deepEqual(deletes(from), []);
  assert.match(back.reason ?? '', /^Rolled back \(0\/1 messages deleted\)\. May remain: a message in C2 whose id this server doesn't know\./);
});

test("deleting a message this server named leaves one it can't name for a rollback to report", { timeout: 5000 }, async (t) => {
  const { call, rollback, deletes } = await server(t, named, unnamed, { body: { ok: true, ts: '1.3' } });
  const one = await call('send_message', { channelId: 'C1', content: 'one' });
  await call('send_message', { channelId: 'C1', content: 'two' });
  await call('send_message', { channelId: 'C1', content: 'three' });
  assert.equal((await call('delete_message', { channelId: 'C1', messageId: '1.3' })).isError, undefined);
  const from = api.calls.length;
  const back = await rollback(one.state!.checkpoint);
  assert.deepEqual(deletes(from), [], 'the deleted message is forgotten, and the other has no id to delete');
  assert.match(back.reason ?? '', /^Rolled back \(0\/1 messages deleted\)\. May remain: a message in C1 whose id this server doesn't know\./);
});

test('a failed post is marked as one that may have posted exactly when the explainer reads its outcome as unknown', { timeout: 15000 }, async (t) => {
  t.after(() => {
    api.answerFor('chat.postMessage');
    api.answerFor('conversations.open');
    api.answerFor('conversations.info');
  });
  const adapter = (web: SlackWebClient, disableDms = false) =>
    new SlackAdapter(web as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, undefined, disableDms);
  const elsewhere = async (url: string) => adapter(new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: url }));
  const slack = adapter(client);
  const post = (answer: SlackApiAnswer) => {
    api.answerFor('chat.postMessage', answer);
    return slack.sendMessage('C1', 'x');
  };
  const toC1: SlackCall = { tool: 'send_message', args: { channelId: 'C1', content: 'x' } };
  /** What the case for the client's URIError saw, checked after the cases,
   *  since a case's every rejection is the error it reads. */
  let uriError: { code: unknown; requests: number } | undefined;
  /** `says`, where given, is what the explainer's text must also say. */
  const cases: Array<{ what: string; unknown: boolean; says?: RegExp; call?: SlackCall; send: () => Promise<unknown> }> = [
    { what: 'HTTP 503', unknown: true, send: () => post({ status: 503, body: { ok: false } }) },
    { what: "Slack's internal_error", unknown: true, send: () => post({ body: { ok: false, error: 'internal_error' } }) },
    { what: "an answer not in Slack's form", unknown: true, send: async () => (await elsewhere(await nonJsonSlackApiUrl(t))).sendMessage('C1', 'x') },
    { what: 'an answer with no ts', unknown: true, send: () => post({ body: { ok: true } }) },
    { what: "an answer whose ts isn't a string", unknown: true, send: () => post({ body: { ok: true, ts: [] } }) },
    { what: 'not_in_channel', unknown: false, send: () => post({ body: { ok: false, error: 'not_in_channel' } }) },
    { what: 'a rate limit', unknown: false, send: () => post({ status: 429, headers: { 'retry-after': '30' }, body: { ok: false } }) },
    { what: 'a 429 without Retry-After', unknown: false, send: () => post({ status: 429, body: { ok: false } }) },
    // The client's URIError while it builds the body, before the request: a
    // lone surrogate that ends a field. A message's text never carries one to
    // it (assertSendable), so this one ends the channel id.
    {
      what: 'a lone surrogate ending the channel id',
      unknown: false,
      call: { tool: 'send_message', args: { channelId: 'C1\ud800', content: 'x' } },
      send: async () => {
        const calls = api.calls.length;
        const err = await slack.sendMessage('C1\ud800', 'x').then(() => undefined, (e: unknown) => e);
        uriError = { code: (err as { code?: unknown } | undefined)?.code, requests: api.calls.length - calls };
        throw err;
      },
    },
    // The client's TypeError for a JSON body that isn't an object, after a
    // 200: Slack may have acted, so it keeps the default.
    {
      what: 'an answer whose JSON body is null',
      unknown: true,
      says: /Slack's answer, if one came, couldn't be read, so whether the message was posted is unknown/,
      send: () => post({ body: null }),
    },
    {
      what: 'a request whose connection was made and then timed out',
      unknown: true,
      send: async () => {
        const silent = await silentSlackApi();
        t.after(() => silent.close());
        return adapter(new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, timeout: 50, slackApiUrl: silent.url }))
          .sendMessage('C1', 'x');
      },
    },
    { what: 'a connection never made', unknown: false, send: async () => (await elsewhere(await unreachableSlackApiUrl())).sendMessage('C1', 'x') },
    {
      what: "too little of the call's time",
      unknown: false,
      send: () => withCallTime(Date.now() - CALL_SECONDS * 1000, () => slack.sendMessage('C1', 'x')),
    },
    {
      what: 'a failed conversations.open, before a DM',
      unknown: false,
      call: { tool: 'send_dm', args: { userId: 'U9', content: 'x' } },
      send: () => {
        api.answerFor('conversations.open', { status: 503, body: { ok: false } });
        return slack.sendDM('U9', 'x');
      },
    },
    {
      // The same TypeError, from a request before the post: nothing was posted.
      what: 'a conversations.open whose JSON body is null, before a DM',
      unknown: false,
      call: { tool: 'send_dm', args: { userId: 'U9', content: 'x' } },
      send: () => {
        api.answerFor('conversations.open', { body: null });
        return slack.sendDM('U9', 'x');
      },
    },
    {
      what: 'a failed conversations.info, before a post with DMs off',
      unknown: false,
      call: { tool: 'send_message', args: { channelId: 'C7', content: 'x' } },
      send: () => {
        api.answerFor('conversations.info', { status: 503, body: { ok: false } });
        return adapter(client, true).sendMessage('C7', 'x');
      },
    },
  ];
  for (const { what, unknown, says, call = toC1, send } of cases) {
    const err = await send().then(() => assert.fail(`${what}: the post was answered as made`), (e: unknown) => e);
    const told = explainSlackError(err, call);
    assert.equal(/whether the message was posted is unknown/.test(told), unknown, `${what}: ${told}`);
    if (says) assert.match(told, says, what);
    assert.equal(postLeftBy(err) !== undefined, unknown, `${what}: marked as one that may have posted`);
  }
  assert.deepEqual(uriError, { code: 'ERR_INVALID_URI', requests: 0 }, "the client's URIError, with no request sent");
});

test("a DM this server can't name may remain in the DM's conversation", { timeout: 5000 }, async (t) => {
  t.after(() => api.answerFor('conversations.open'));
  const { call, rollback } = await server(t, named, unnamed);
  api.answerFor('conversations.open', { body: { ok: true, channel: { id: 'D9' } } });
  const one = await call('send_message', { channelId: 'C1', content: 'one' });
  const dm = await call('send_dm', { userId: 'U9', content: 'two' });
  assert.equal(dm.isError, true);
  assert.match(dm.content[0].text, /whether the message was posted is unknown\. Check the DM's history/);
  assert.match((await rollback(one.state!.checkpoint)).reason ?? '', /May remain: a message in D9 whose id this server doesn't know\./);
});

test('a publish whose answer names no message is answered as any publish whose outcome is unknown, and may remain after a rollback', { timeout: 5000 }, async (t) => {
  const { h, call, rollback, deletes } = await server(t, named, { body: { ok: false, error: 'internal_error' } }, unnamed);
  /** The error a publish was answered with: it's never delivered here. */
  const publish = async () => {
    try {
      await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'hello' }] });
    } catch (err) {
      return err as { code?: number; message: string };
    }
    return assert.fail('the publish was answered as delivered');
  };
  const one = await call('send_message', { channelId: 'C1', content: 'one' });
  // Slack's own failure, after which the post may have landed: how a publish
  // has said "unknown" all along. Then an answer with no ts.
  const failed = await publish();
  const unconfirmed = await publish();
  assert.match(failed.message, /An API error occurred: internal_error\n\nSlack failed while handling the call, /);
  assert.match(unconfirmed.message, /chat\.postMessage: the answer named no message in C1\n\nSlack's answer to the post named no message, /);
  // Both are the same kind of error, ending in the same check.
  for (const answer of [failed, unconfirmed]) {
    assert.equal(answer.code, -32603);
    assert.match(
      answer.message,
      /so whether the message was posted is unknown(?: \([^)]*\))?\. Check fetch_history for conversation C1 before posting again, so it isn't posted twice\.$/,
    );
  }
  const from = api.calls.length;
  const back = await rollback(one.state!.checkpoint);
  assert.deepEqual(deletes(from), []);
  assert.match(
    back.reason ?? '',
    /^Rolled back \(0\/2 messages deleted\)\. May remain: a message in C1 whose id this server doesn't know; a message in C1 whose id this server doesn't know\./,
  );
});
