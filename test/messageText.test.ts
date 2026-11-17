import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';

// Exercise the public production entry points, not just the renderer.
async function shaped(payload: Record<string, unknown>, bot = false) {
  const row = { ts: '100.000001', user: 'U1', ...payload, ...(bot ? { bot_id: 'B1' } : {}) };
  let handler: any;
  const adapter = new SlackAdapter({
    users: { info: async () => ({ user: { name: 'alice' } }) },
    conversations: {
      history: async () => ({ messages: [row] }),
      replies: async () => ({ messages: [row] }),
    },
  } as any, { on: (_: string, h: any) => { handler = h; } } as any, 'UBOT', 'example');
  const history = await adapter.readHistory('C1', {});
  const thread = await adapter.readThread('C1', row.ts, {});
  const backscroll = await adapter.fetchHistory('C1');
  const received: SlackMessageData[] = [];
  adapter.onMessage(m => { received.push(m); });
  handler({ event: { type: 'message', channel: 'C1', ...row }, ack: async () => {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { contents: [history.messages[0].content, thread.messages[0].content, backscroll.messages[0].content], received };
}
async function expectText(payload: Record<string, unknown>, expected: string, bot = false) {
  const result = await shaped(payload, bot);
  assert.deepEqual(result.contents, [expected, expected, expected]);
  if (bot) assert.equal(result.received.length, 0, 'existing live bot exclusion');
  else {
    assert.equal(result.received[0].cleanContent, expected);
    return result.received[0];
  }
}

test('attachments-only classic bot post: all reads, plus eligible live attachment post', async () => {
  const payload = { attachments: [{ pretext: 'Before', title: 'Report', title_link: 'https://example.com', text: '*Body*', fields: [{ title: 'State', value: 'OK' }] }, { fallback: 'Fallback' }, { image_url: 'https://example.com/image' }] };
  const expected = 'Before\nReport https://example.com\n*Body*\nState: OK\nFallback';
  await expectText(payload, expected, true);
  assert.equal((await expectText(payload, expected))!.content, expected);
});

test('blocks-only post: headers, sections, fields, context and rich text on every path', async () => {
  await expectText({ blocks: [
    { type: 'header', text: { text: 'Heading' } },
    { type: 'section', text: { text: '*Section*' }, fields: [{ text: 'Field' }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Context' }, { type: 'image', alt_text: 'ignored' }] },
    { type: 'rich_text', elements: [
      { type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U1' }, { type: 'text', text: ' ' }, { type: 'channel', channel_id: 'C1' }] },
      { type: 'rich_text_list', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com', text: 'Link' }, { type: 'emoji', name: 'wave' }] }] },
      { type: 'rich_text_quote', elements: [{ type: 'text', text: 'Quote' }] },
      { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'Code' }] },
    ] },
    { type: 'actions', elements: [{ text: { text: 'ignored' } }] },
  ] }, 'Heading\n*Section*\nField\nContext\n@alice (uid:U1) #C1\nLink (https://example.com):wave:\nQuote\nCode');
});

test('identical fallback deduplicates with whitespace normalization, distinct body remains', async () => {
  await expectText({ text: 'Keep  this\n', attachments: [{ fallback: 'Keep this' }, { text: 'Extra' }] }, 'Keep  this\n\nExtra');
});

test('rich_text mirror stays byte-identical; distinct block still appended', async () => {
  const text = 'Hello  *world* <https://example.com|Link>\n';
  const mirror = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world', style: { bold: true } }, { type: 'text', text: ' ' }, { type: 'link', url: 'https://example.com', text: 'Link' }] }] };
  const clean = 'Hello  *world* Link (https://example.com)\n';
  const result = await expectText({ text, blocks: [mirror] }, clean);
  assert.equal(result!.content, text);
  await expectText({ text, blocks: [mirror], attachments: [{ text: 'Extra' }] }, clean + '\nExtra');
});

test('malformed shapes are absent and nested cycles are bounded', async () => {
  const cycle: any = { type: 'rich_text_section' }; cycle.elements = [cycle];
  await expectText({ text: 'Original', attachments: [null, 7, { fields: [null, { title: {}, value: [] }] }, { text: 'Valid' }], blocks: [null, { type: 'section', text: 7, fields: {} }, { type: 'rich_text', elements: [cycle] }] }, 'Original\nValid');
  await expectText({ text: 'Original', attachments: {}, blocks: 'bad' }, 'Original');
});

test('suffix is capped at 16384 code units without truncating original text', async () => {
  const text = 'Original'.repeat(3000);
  await expectText({ text, attachments: [{ text: 'x'.repeat(20000) }] }, text + '\n' + 'x'.repeat(16383));
});

test('unfurls already linked in text and app unfurls are skipped; standalone preview retained', async () => {
  await expectText({ text: 'https://example.com', attachments: [
    { from_url: 'https://example.com', text: 'Redundant preview' },
    { is_app_unfurl: true, text: 'App preview' },
    { from_url: 'https://example.org', text: 'Standalone' },
  ] }, 'https://example.com\nStandalone');
});

test('ordinary text and file shaped output stays identical with absent or empty extra payloads', async () => {
  const payload = { text: 'Hello &amp; <@U1>', files: [{ name: 'note.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/note' }] };
  const before = await shaped(payload);
  assert.deepEqual(await shaped({ ...payload, attachments: [], blocks: [] }), before);
  assert.equal(before.received[0].content, payload.text);
  assert.equal(before.received[0].cleanContent, 'Hello & @alice (uid:U1)');
  await expectText({ ...payload, attachments: [{ text: 'Extra' }] }, 'Hello & @alice (uid:U1)\nExtra');
});

test('Notification placeholder retains the top-level section body on every path', async () => {
  await expectText({ text: 'Notification', blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: '*Readable body*' } },
  ] }, 'Notification\n*Readable body*');
});

test('colour attachment renders its nested blocks through the shared block renderer', async () => {
  await expectText({ text: 'Notification', attachments: [
    { color: '#00ff00', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Readable body*' } }] },
  ] }, 'Notification\n*Readable body*');
});

test('explicit empty text plus attachments has no leading blank line', async () => {
  const result = await expectText({ text: '', attachments: [{ text: 'Body' }] }, 'Body');
  assert.equal(result!.content, 'Body');
  const blocks = await expectText({ text: '', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Body' } }] }, 'Body');
  assert.equal(blocks!.content, 'Body');
});

for (const shape of ['attachment', 'section', 'rich_text'] as const) {
  test(`code-point-safe truncation: ${shape}, odd/even boundaries and original separator`, async () => {
    for (const text of ['', 'H', 'H'.repeat(16384)]) {
      for (const prefix of ['', 'x']) {
        const body = prefix + '😀'.repeat(9000);
        const payload = shape === 'attachment' ? { attachments: [{ text: body }] }
          : shape === 'section' ? { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: body } }] }
          : { blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: body }] }] }] };
        const result = await shaped({ text, ...payload });
        for (const output of [...result.contents, result.received[0].content, result.received[0].cleanContent]) {
          // Runtime is Node 22; the project's TypeScript lib remains ES2022.
          assert.equal((output as string & { isWellFormed(): boolean }).isWellFormed(), true);
          assert.ok(output.startsWith(text));
          assert.ok(output.length <= text.length + 16384);
          const suffix = (text ? '\n' : '') + body;
          let expected = suffix.slice(0, 16384);
          if (/[\uD800-\uDBFF]$/.test(expected)) expected = expected.slice(0, -1);
          assert.equal(output, text + expected);
        }
      }
    }
  });
}

test('canonical mention dedup resolves labelled/unlabelled attachment and rich_text mentions', async () => {
  for (const [text, mirror] of [['<@U2|alice>', '<@U2>'], ['<@U2>', '<@U2|alice>']]) {
    const result = await expectText({ text, attachments: [{ text: mirror }], blocks: [
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U2' }] }] },
    ] }, '@alice (uid:U2)');
    assert.equal(result!.content, text, 'raw original must be untouched');
  }
});

test('canonical dedup uses existing link rendering and escape semantics without double formatting', async () => {
  for (const [text, mirror, expected] of [
    ['<https://example.com>', 'https://example.com', 'https://example.com'],
    ['<https://example.com|Label>', 'Label (https://example.com)', 'Label (https://example.com)'],
    ['A &amp; B', 'A & B', 'A & B'],
    ['&amp;lt;', '&lt;', '&lt;\n<'],
  ]) {
    const result = await expectText({ text, attachments: [{ text: mirror }] }, expected);
    assert.equal(result!.content, text === '&amp;lt;' ? text + '\n' + mirror : text);
  }
});

const senderBlocksWithoutText = [
  { type: 'section', text: { type: 'mrkdwn', text: '*Header*' } },
  { type: 'section', text: { type: 'mrkdwn', text: 'Body' } },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Context' }] },
];

for (const nested of [true, false]) {
  test(`absent text key: ${nested ? 'colour attachment-nested' : 'top-level'} sender blocks on every path`, async () => {
    const payload = nested
      ? { attachments: [{ color: '#36a64f', blocks: senderBlocksWithoutText }] }
      : { blocks: senderBlocksWithoutText };
    assert.equal(Object.hasOwn(payload, 'text'), false, 'text must be absent, not empty');
    const expected = '*Header*\nBody\nContext';
    const live = await expectText(payload, expected);
    assert.equal(live!.content, expected, 'raw live content has no leading newline or undefined');
  });
}
