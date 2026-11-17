import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';
import { formatSlackText } from '../src/content.js';

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
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const liveAdapter = new SlackAdapter({
    users: { info: async () => { await delayed; return { user: { name: 'alice' } }; } },
  } as any, { on: (_: string, h: any) => { handler = h; } } as any, 'UBOT', 'example');
  liveAdapter.onMessage(m => { received.push(m); });
  handler({ event: { type: 'message', channel: 'C1', ...row }, ack: async () => {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(received.length, 0, 'live delivery awaits its own lookup');
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  return { contents: [history.messages[0].content, thread.messages[0].content, backscroll.messages[0].content], received };
}
async function expectText(payload: Record<string, unknown>, expected: string, bot = false) {
  const result = await shaped(payload, bot);
  const original = formatSlackText(typeof payload.text === 'string' ? payload.text : '', new Map([['U1', 'alice']]));
  let backscroll = expected;
  if (expected.length - original.length > 2000) {
    let suffix = expected.slice(original.length, original.length + 2000 - '[…truncated]'.length);
    if (/[\uD800-\uDBFF]$/.test(suffix)) suffix = suffix.slice(0, -1);
    backscroll = original + suffix + '[…truncated]';
  }
  assert.deepEqual(result.contents, [expected, expected, backscroll]);
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
  ] }, 'Heading\n*Section*\nField\nContext\n@alice (uid:U1) #C1\n• Link (https://example.com):wave:\n> Quote\n```Code```');
});

test('identical fallback deduplicates with whitespace normalization, distinct body remains', async () => {
  await expectText({ text: 'Keep  this\n', attachments: [{ fallback: 'Keep this' }, { text: 'Extra' }] }, 'Keep  this\n\nExtra');
});

test('malformed shapes are absent and nested cycles are bounded', async () => {
  const cycle: any = { type: 'rich_text_section' }; cycle.elements = [cycle];
  await expectText({ text: 'Original', attachments: [null, 7, { fields: [null, { title: {}, value: [] }] }, { text: 'Valid' }], blocks: [null, { type: 'section', text: 7, fields: {} }, { type: 'rich_text', elements: [cycle] }] }, 'Original\nValid[…truncated]', true);
  await expectText({ text: 'Original', attachments: {}, blocks: 'bad' }, 'Original');
});

test('suffix is capped at 16384 code units without truncating original text', async () => {
  const text = 'Original'.repeat(3000);
  await expectText({ text, attachments: [{ text: 'x'.repeat(20000) }] }, text + '\n' + 'x'.repeat(16383 - '[…truncated]'.length) + '[…truncated]');
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
          : { attachments: [{ blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: body }] }] }] }] };
        const result = await shaped({ text, ...payload });
        for (const [index, output] of [...result.contents, result.received[0].content, result.received[0].cleanContent].entries()) {
          // Runtime is Node 22; the project's TypeScript lib remains ES2022.
          assert.equal((output as string & { isWellFormed(): boolean }).isWellFormed(), true);
          assert.ok(output.startsWith(text));
          assert.ok(output.length <= text.length + 16384);
          const suffix = (text ? '\n' : '') + body;
          let expected = suffix.slice(0, (index === 2 ? 2000 : 16384) - '[…truncated]'.length);
          if (/[\uD800-\uDBFF]$/.test(expected)) expected = expected.slice(0, -1);
          assert.equal(output, text + expected + '[…truncated]');
        }
      }
    }
  });
}

test('canonical mention dedup resolves labelled/unlabelled attachment and rich_text mentions', async () => {
  for (const [text, mirror] of [['<@U2|alice>', '<@U2>'], ['<@U2>', '<@U2|alice>']]) {
    const result = await expectText({ text, attachments: [{ text: mirror, mrkdwn_in: ['text'] }], blocks: [
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
    const result = await expectText({ text, attachments: [{ text: mirror, mrkdwn_in: ['text'] }] }, expected);
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

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const richBlock = (...elements: unknown[]) => ({ type: 'rich_text', elements });
const richSection = (...elements: unknown[]) => ({ type: 'rich_text_section', elements });
const literal = (text: string) => ({ type: 'text', text });

test('review supplemental fragments dedup independently', async () => {
  await expectText({ text: 'Notification', attachments: [{ text: 'Body' }, { text: 'Body' }], blocks: [section('Body'), section('Other')] }, 'Notification\nBody\nOther');
});

test('review rich usergroup date and toned emoji preserved and deduplicated', async () => {
  const body = '<!subteam^S1> Today :thumbsup::skin-tone-2:';
  const blocks = [richBlock(richSection({ type: 'usergroup', usergroup_id: 'S1' }, literal(' '), { type: 'date', fallback: 'Today' }, literal(' '), { type: 'emoji', name: 'thumbsup', skin_tone: 2 }))];
  await expectText({ blocks }, body);
  assert.equal((await expectText({ text: body, blocks }, body))!.content, body);
});

test('review rich literal escapes cannot become mentions or entities', async () => {
  const live = await expectText({ blocks: [richBlock(richSection(literal('&lt; <@U1> & >')))] }, '&lt; <@U1> & >');
  assert.deepEqual(live!.mentionIds, []);
});

test('review shared bot mentions are display-only and raw text is preserved', async () => {
  const live = await expectText({ text: 'Notification', attachments: [{ is_share: true, text: '<@UBOT>', mrkdwn_in: ['text'] }] }, 'Notification\n[shared message from unknown, unknown source]\n> @alice (uid:UBOT)');
  assert.deepEqual(live!.mentionIds, []);
  assert.equal(live!.mentionsBot, false);
  assert.equal(live!.rawContent, 'Notification');
});

test('review preview URLs compare exactly, Slack links normalize, shares survive', async () => {
  await expectText({ text: '<https://example.com/other|Label>', attachments: [
    { from_url: 'https://example.com', text: 'Details' },
    { from_url: 'https://example.com/other', text: 'Skip' },
    { from_url: 'https://example.com/other', is_share: true, text: 'Shared' },
    { from_url: 'https://example.com/other', is_msg_unfurl: true, text: 'Message' },
  ] }, 'Label (https://example.com/other)\nDetails\n[shared message from unknown, unknown source]\n> Shared\n[shared message from unknown, unknown source]\n> Message');
});

test('review fresh display lookup uses the extracted rendered payload', async () => {
  const live = await expectText({ text: '@U1 (uid:U1)', attachments: [{ text: '<@U1>', mrkdwn_in: ['text'] }, { text: '<@U2>', mrkdwn_in: ['text'] }] }, '@U1 (uid:U1)\n@alice (uid:U1)\n@alice (uid:U2)');
  assert.deepEqual(live!.mentionIds, []);
});

test('review traversal budget and array/depth cuts carry one final marker', async () => {
  for (const payload of [
    { attachments: Array.from({ length: 2001 }, () => ({})), blocks: [section('lost')] },
    { blocks: [richBlock(Array.from({length: 14}).reduce<any>(e => richSection(e), literal('deep')))] },
  ]) {
    const result = await shaped(payload);
    for (const text of result.contents) {
      assert.ok(text.endsWith('[…truncated]'));
      assert.equal(text.split('[…truncated]').length, 2);
    }
  }
});

test('review attachment nested blocks precede top-level blocks (documented order)', async () => {
  await expectText({ attachments: [{ blocks: [section('Nested')] }], blocks: [section('Top')] }, 'Nested\nTop');
});

test('review history textContains searches delivered content; thread returns unfiltered content', async () => {
  const row = { ts: '100.000001', text: 'Notification', blocks: [section('deployment failed')] };
  const adapter = new SlackAdapter({ conversations: {
    history: async () => ({ messages: [row] }), replies: async () => ({ messages: [row] }),
  } } as any, { on() {} } as any, 'UBOT', 'example');
  for (const result of [await adapter.readHistory('C1', { textContains: 'deployment failed' }), await adapter.readThread('C1', row.ts, {})]) {
    assert.equal(result.messages[0]?.content, 'Notification\ndeployment failed');
  }
});

import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { release } from '../scripts/release-changelog.mjs';
import { method } from '@animalabs/mcpl-core';
import { harness, initialize, FULL_GRANT, until } from './harness.js';

test('review fragment passes the actual release validator', () => {
  const root = mkdtempSync(join(tmpdir(), 'payload-release-'));
  try {
    for (const file of ['package.json', 'CHANGELOG.md', 'changelog.d']) cpSync(file, join(root, file), { recursive: true });
    assert.doesNotThrow(() => release(root));

  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review server shared mentions neither wake nor auto-subscribe; raw metadata remains original', async () => {
  const h = harness();
  try {
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
    const event = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '100.1', text: 'Notification', attachments: [{ is_share: true, text: '<@UBOT> Details', mrkdwn_in: ['text'] }] };
    await h.socket.emitMessage(event);
    assert.equal(h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0, 'unsubscribed ambient shared mention is silent');
    await h.host.sendRequest('tools/call', { name: 'subscribe_channel', arguments: { channelId: 'C1' } });
    await h.socket.emitMessage({ ...event, ts: '100.2' });
    await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'ambient delivery');
    const push: any = h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params;

    assert.ok(push.tags.includes('chat:ambient'));
    assert.ok(!push.tags.includes('chat:mention'));
    assert.ok(!push.tags.includes('chat:addressed'));
    await h.host.sendRequest(method.CHANNELS_OPEN, { channelId: 'slack:C1', type: 'slack', address: { channelId: 'C1' } });
    await h.socket.emitMessage({ ...event, ts: '100.3' });
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_INCOMING), 'channel delivery');
    const incoming: any = h.hostSaw.find(r => r.method === method.CHANNELS_INCOMING)!.params;
    assert.equal(incoming.messages[0].metadata.rawContent, 'Notification');
    assert.deepEqual(incoming.messages[0].metadata.mentionIds, []);

  } finally { await h.close(); }
});

test('review docs pin the real nested-before-top-level order', () => {
  assert.match(readFileSync('README.md', 'utf8'), /then that attachment's nested blocks, then top-level blocks/);
});

// Non-rich supplemental units have no structural provenance: punctuation
// differences must survive on every production shaping path.
for (const [text, body] of [
  ['a_b', 'ab'],
  ['a*b', 'ab'],
  ['a~b', 'ab'],
  ['a`b', 'ab'],
  ['a`b`c', 'abc'],
  ['• Ordinary sentence', 'Ordinary sentence'],
  ['> Ordinary sentence', 'Ordinary sentence'],
  ['*word*', 'word'],
  ['_word_', 'word'],
  ['~word~', 'word'],
] as const) {
  test('distinct punctuation is content: ' + text, async () => {
    for (const supplement of [
      { attachments: [{ text: body }] },
      { blocks: [section(body)] },
      { attachments: [{ fields: [{ value: body }] }] },
    ]) {
      const result = await shaped({ text, ...supplement });
      assert.deepEqual(result.contents, [text + '\n' + body, text + '\n' + body, text + '\n' + body]);
      assert.equal(result.received[0].content, text + '\n' + body);
    }
  });
}

test('top-level rich comparison retains literal or unbalanced markers', async () => {
  for (const text of ['a_b', 'a*b', 'a~b', 'a`b', '*word', '_word', '~word']) {
    const body = text.replace(/[_*~`]/g, '');
    const result = await shaped({ text, blocks: [richBlock(richSection(literal(body)))] }, true);
    assert.equal(result.contents[0], text + '\n' + body);
  }
  await expectText({ text: 'word', blocks: [richBlock(richSection(literal('*word*')))] }, 'word\n*word*', true);
});

test('bot rich combined emphasis uses italic inside bold', async () => {
  for (const text of ['*_word_*', '_*word*_']) {
    const result = await shaped({ text, blocks: [richBlock(richSection({ ...literal('word'), style: { bold: true, italic: true } }))] }, true);
    assert.equal(result.contents[0], text === '*_word_*' ? text : text + '\n*_word_*');
  }
});

test('attributed attachment deduplicates its body against original text before wrapping', async () => {
  await expectText({text: 'Build 42 failed', attachments: [{author_name: 'Jenkins', text: 'Build 42 failed'}]}, 'Build 42 failed');
});
test('attributed attachment deduplicates its inner body and blocks before wrapping', async () => {
  await expectText({attachments: [{author_name: 'CI', text: 'Body', blocks: [section('Body')]}]}, '[attachment from CI]\n> Body');
});
test('bot code mirror uses compact fences and deduplicates', async () => {
  const text = 'Run:\n```npm test```\nthen push';
  const blocks = [richBlock(richSection(literal('Run:')), {type: 'rich_text_preformatted', elements: [literal('npm test')]}, richSection(literal('then push')))];
  await expectText({text, blocks}, text, true);
  await expectText({blocks}, text, true);
});
test('bot nested list mirror cycles bullet glyphs by indent and deduplicates', async () => {
  const text = '• a\n    ◦ b\n        ▪ c\n            • d';
  const blocks = [richBlock(...['a', 'b', 'c', 'd'].map((value, indent) => ({type: 'rich_text_list', style: 'bullet', indent, elements: [richSection(literal(value))]})))];
  await expectText({text, blocks}, text, true);
  await expectText({blocks}, text, true);
});
test('app-id and bot-profile posts retain unique rich text on every delivery path', async () => {
  for (const identity of [{app_id: 'A1'}, {bot_profile: {id: 'B1'}}]) {
    await expectText({user: 'U1', ...identity, text: 'Summary', blocks: [richBlock(richSection(literal('UNIQUE DETAIL')))]}, 'Summary\nUNIQUE DETAIL');
  }
});
test('attachment fallback precedes unsupported placeholders and remote file blocks stay silent', async () => {
  for (const type of ['file', 'task_card', 'plan']) {
    await expectText({attachments: [{fallback: 'Readable fallback', blocks: [{type}]}]},
      'Readable fallback' + (type === 'file' ? '' : `\n[${type} omitted]`));
  }
  await expectText({text: 'shared a doc', blocks: [{type: 'file'}]}, 'shared a doc');
  await expectText({attachments: [{fallback: 'Not needed', blocks: [{type: 'plan'}, section('Readable')]}]}, 'Readable\n[plan omitted]');
});
test('classic attachment plain fields stay literal and mrkdwn_in controls body fields', async () => {
  const a = {title: 'Literal <@U2>', pretext: '<@U2>', text: '<@U2>', fields: [{title: 'a &lt; b', value: '<@U2>'}]};
  await expectText({attachments: [a]}, '<@U2>\nLiteral <@U2>\n<@U2>\na &lt; b: <@U2>');
  await expectText({attachments: [{...a, mrkdwn_in: ['pretext', 'text', 'fields']}]}, '@alice (uid:U2)\nLiteral <@U2>\n@alice (uid:U2)\na &lt; b: @alice (uid:U2)');
  await expectText({attachments: [{fallback: '<@U2> &lt;'}]}, '<@U2> &lt;');
});
test('rich team broadcasts and dates retain styles', async () => {
  await expectText({blocks: [richBlock(richSection(
    {type: 'team', team_id: 'T1', style: {bold: true}}, literal(' '),
    {type: 'broadcast', range: 'here', style: {bold: true}}, literal(' '),
    {type: 'date', fallback: 'Today', style: {italic: true}},
  ))]}, '*<!team^T1>* *@here* _Today_');
});
test('attribution fields follow shared framing name and channel rules', async () => {
  await expectText({attachments: [{is_share: true, author_name: 'Bob [ops]', footer: 'Posted in <#C1|ops>', text: 'Body'}]},
    '[shared message from "Bob [ops]", "Posted in \\u003c#C1|ops\\u003e"]\n> Body');
  await expectText({attachments: [{is_share: true, author_name: 'Bob', channel_name: 'ops', text: 'Body'}]},
    '[shared message from Bob, #ops]\n> Body');
});
