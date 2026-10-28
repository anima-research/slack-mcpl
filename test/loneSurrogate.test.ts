/**
 * A message's text that holds a lone UTF-16 surrogate is refused before Slack
 * is asked, by every write that sends text. @slack/web-api 7.19.0 builds its
 * form body with node:querystring, which pairs a lone surrogate with the code
 * unit after it, so Slack would post a different character while the write
 * answered success, or throws "URI malformed" when nothing follows it.
 * Driven through the real client against a local endpoint that answers as
 * Slack does.
 *
 * Run: node --import tsx --test test/loneSurrogate.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SLACK_CLIENT_OPTIONS, SlackAdapter, SlackWebClient, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { FULL_GRANT, connectHost, initialize, until } from './harness.js';
import { fakeSlackApi } from './slackApi.js';

const codePoints = (s: string) => [...s].map((ch) => ch.codePointAt(0)!.toString(16)).join(' ');

/** A server over the real client, with registration done, so a test can
 *  tell every Slack call a write makes. With `disableDms`, a write to a
 *  conversation that isn't registered asks Slack whether it's a DM first. */
async function serve(t: { after(fn: () => unknown): void }, opts: { disableDms?: boolean; sendChannels?: string[] } = {}) {
  const api = await fakeSlackApi();
  t.after(() => api.close());
  api.answerFor('conversations.list', { body: { ok: true, channels: [{ id: 'C1', name: 'general', is_channel: true, is_member: true }] } });
  api.answerFor('chat.postMessage', { body: { ok: true, channel: 'C1', ts: '1.1' } });
  api.answerFor('chat.update', { body: { ok: true, channel: 'C1', ts: '1.0' } });
  api.answerFor('conversations.open', { body: { ok: true, channel: { id: 'D9' } } });
  api.answerFor('conversations.info', { body: { ok: true, channel: { id: 'C7', is_channel: true } } });
  const client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  const socket = { on() {}, async start() {}, async disconnect() {} };
  const slack = new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme', undefined, opts.sendChannels, opts.disableDms);
  const h = connectHost(new SlackMcplServer(slack));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
  const tool = (name: string, args: Record<string, unknown>) => async () => {
    const result = (await h.host.sendRequest('tools/call', { name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { failed: result.isError === true, text: result.content[0].text };
  };
  /** Each write that sends text, to `channelId`, with the opening its refusal
   *  takes; send_dm only where DMs are on. */
  const writes = (text: string, channelId: string): Array<{ name: string; opening: string; run: () => Promise<{ failed: boolean; text: string }> }> => [
    { name: 'send_message', opening: 'Nothing was posted', run: tool('send_message', { channelId, content: text }) },
    { name: 'reply_message', opening: 'Nothing was posted', run: tool('reply_message', { channelId, messageId: '1.0', content: text }) },
    ...(opts.disableDms ? [] : [{ name: 'send_dm', opening: 'Nothing was sent', run: tool('send_dm', { userId: 'U2', content: text }) }]),
    { name: 'edit_message', opening: "The message wasn't changed", run: tool('edit_message', { channelId, messageId: '1.0', content: text }) },
    {
      name: 'channels/publish',
      opening: 'Nothing was posted',
      run: () => h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: `slack:${channelId}`, content: [{ type: 'text', text }] })
        .then((answer) => ({ failed: false, text: JSON.stringify(answer) }), (err: Error) => ({ failed: true, text: err.message })),
    },
  ];
  return { api, writes };
}

/** What a write answers for text with a lone surrogate: a tool's whole result
 *  text, or the error a host's publish gets. */
const refusal = (opening: string) =>
  `${opening}: the text holds a lone UTF-16 surrogate, which UTF-8 can't encode: remove it.`;

for (const disableDms of [false, true]) {
  // With DMs off, the conversation isn't registered, so a check placed after
  // the DM lookup would ask Slack conversations.info first.
  const channelId = disableDms ? 'C7' : 'C1';
  test(`each write refuses text with a lone surrogate before Slack is asked, wherever the surrogate is${disableDms ? ', with DMs off' : ''}`, async (t) => {
    const { api, writes } = await serve(t, { disableDms });
    // A high or low surrogate before more text, which the client would pair
    // with the character after it; one at the end, where it throws; one at
    // the start; and a text that is only a surrogate.
    for (const text of ['a \ud800 b', 'a \udc00 b', 'a \ud800', 'a \udc00', '\udc00 a', '\ud800']) {
      for (const { name, opening, run } of writes(text, channelId)) {
        const before = api.calls.length;
        const { failed, text: said } = await run();
        const what = `${name} given [${codePoints(text)}]`;
        assert.deepEqual(api.calls.slice(before), [], `${what}: Slack is asked nothing`);
        assert.equal(failed, true, `${what}: the write fails`);
        assert.equal(said, refusal(opening), `${what}: the refusal says what's wrong and what to do, and nothing more`);
      }
    }
  });
}

test("a write the allow-list refuses says so first, though its text holds a lone surrogate", async (t) => {
  // Calling again can't change the allow-list's refusal, while the agent can
  // fix the text, so the agent isn't sent to fix the text for a write that
  // could never go.
  const { api, writes } = await serve(t, { sendChannels: ['C9'] });
  for (const { name, opening, run } of writes('a \ud800 b', 'C1')) {
    const before = api.calls.length;
    const { failed, text: said } = await run();
    assert.deepEqual(api.calls.slice(before), [], `${name}: Slack is asked nothing`);
    assert.equal(failed, true, `${name}: the write fails`);
    assert.ok(said.includes(`${opening}: this bot may write only to C9`), `${name}: the allow-list's refusal, and got: ${said}`);
    assert.ok(!said.includes('surrogate'), `${name}: not the text's refusal, and got: ${said}`);
  }
});

test('a surrogate pair reaches Slack as given', async (t) => {
  const { api, writes } = await serve(t);
  const text = 'a \ud83d\ude00 b';
  for (const { name, run } of writes(text, 'C1')) {
    const before = api.calls.length;
    const { failed, text: said } = await run();
    assert.equal(failed, false, `${name}: ${said}`);
    const sent = api.sent.slice(before).map((p) => p.get('text')).filter((x): x is string => x !== null);
    assert.deepEqual(sent.map(codePoints), [codePoints(text)], `${name}: Slack gets the text's own code points`);
  }
});
