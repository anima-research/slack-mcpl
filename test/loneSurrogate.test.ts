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
import { FULL_GRANT, connectHost, initialize } from './harness.js';
import { fakeSlackApi } from './slackApi.js';

const codePoints = (s: string) => [...s].map((ch) => ch.codePointAt(0)!.toString(16)).join(' ');

async function serve(t: { after(fn: () => unknown): void }) {
  const api = await fakeSlackApi();
  t.after(() => api.close());
  api.answerFor('chat.postMessage', { body: { ok: true, channel: 'C1', ts: '1.1' } });
  api.answerFor('chat.update', { body: { ok: true, channel: 'C1', ts: '1.0' } });
  api.answerFor('conversations.open', { body: { ok: true, channel: { id: 'D9' } } });
  const client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  const socket = { on() {}, async start() {}, async disconnect() {} };
  const h = connectHost(new SlackMcplServer(new SlackAdapter(client as unknown as SlackWebLike, socket, 'UBOT', 'acme')));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const tool = (name: string, args: Record<string, unknown>) => async () => {
    const result = (await h.host.sendRequest('tools/call', { name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { failed: result.isError === true, text: result.content[0].text };
  };
  /** Each write that sends text, with the opening its refusal takes. */
  const writes = (text: string): Array<{ name: string; opening: string; run: () => Promise<{ failed: boolean; text: string }> }> => [
    { name: 'send_message', opening: 'Nothing was posted', run: tool('send_message', { channelId: 'C1', content: text }) },
    { name: 'reply_message', opening: 'Nothing was posted', run: tool('reply_message', { channelId: 'C1', messageId: '1.0', content: text }) },
    { name: 'send_dm', opening: 'Nothing was sent', run: tool('send_dm', { userId: 'U2', content: text }) },
    { name: 'edit_message', opening: "The message wasn't changed", run: tool('edit_message', { channelId: 'C1', messageId: '1.0', content: text }) },
    {
      name: 'channels/publish',
      opening: 'Nothing was posted',
      run: () => h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text }] })
        .then((answer) => ({ failed: false, text: JSON.stringify(answer) }), (err: Error) => ({ failed: true, text: err.message })),
    },
  ];
  return { api, writes };
}

test('each write refuses text with a lone surrogate before Slack is asked, wherever the surrogate is', async (t) => {
  const { api, writes } = await serve(t);
  // A high or low surrogate before more text, which the client would pair
  // with the space after it, and one at the end, where it throws.
  for (const text of ['a \ud800 b', 'a \udc00 b', 'a \ud800']) {
    for (const { name, opening, run } of writes(text)) {
      const before = api.calls.length;
      const { failed, text: said } = await run();
      const what = `${name} given [${codePoints(text)}]`;
      assert.deepEqual(api.calls.slice(before).filter((c) => c.startsWith('chat.')), [], `${what}: Slack is asked to post nothing`);
      assert.equal(failed, true, `${what}: the write fails`);
      assert.ok(
        said.includes(`${opening}: the text holds a lone UTF-16 surrogate, which UTF-8 can't encode: remove it.`),
        `${what}: the refusal says what's wrong and what to do, and got: ${said}`,
      );
    }
  }
});

test('a surrogate pair reaches Slack as given', async (t) => {
  const { api, writes } = await serve(t);
  const text = 'a \ud83d\ude00 b';
  for (const { name, run } of writes(text)) {
    const before = api.calls.length;
    const { failed, text: said } = await run();
    assert.equal(failed, false, `${name}: ${said}`);
    const sent = api.sent.slice(before).map((p) => p.get('text')).filter((x): x is string => x !== null);
    assert.deepEqual(sent.map(codePoints), [codePoints(text)], `${name}: Slack gets the text's own code points`);
  }
});
