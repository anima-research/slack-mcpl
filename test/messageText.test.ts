import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';
import { formatSlackText, extractSlackUserIds } from '../src/content.js';
import { renderMessageText, MAX_MESSAGE_TEXT_APPEND } from '../src/message-text.js';

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
  let lookupEntered!: () => void;
  const entered = new Promise<void>(resolve => { lookupEntered = resolve; });
  const liveAdapter = new SlackAdapter({
    users: { info: async () => { lookupEntered(); await delayed; return { user: { name: 'alice' } }; } },
  } as any, { on: (_: string, h: any) => { handler = h; } } as any, 'UBOT', 'example');
  liveAdapter.onMessage(m => { received.push(m); });
  handler({ event: { type: 'message', channel: 'C1', ...row }, ack: async () => {} });
  if (!bot) await entered;
  assert.equal(received.length, 0, 'live delivery awaits its own lookup');
  release();
  await (liveAdapter as any).inbound.get('C1');
  return { contents: [history.messages[0].content, thread.messages[0].content, backscroll.messages[0].content], received };
}
async function expectText(payload: Record<string, unknown>, expected: string, bot = false) {
  const result = await shaped(payload, bot);
  const original = formatSlackText(typeof payload.text === 'string' ? payload.text : '', new Map([['U1', 'alice']]));
  const originalIds = new Set(extractSlackUserIds(typeof payload.text === 'string' ? payload.text : ''));
  // Every path uses cached names or raw IDs; U1 and IDs mentioned in original text are cached in this helper.
  let backscroll = expected.replace(/@alice \(uid:([A-Z0-9]+)\)/g,
    (mention, id) => originalIds.has(id) || id === 'U1' ? mention : `@${id} (uid:${id})`);
  if (backscroll.length - original.length > 2000) {
    let suffix = backscroll.slice(original.length, original.length + 2000 - '[…truncated]'.length);
    if (/[\uD800-\uDBFF]$/.test(suffix)) suffix = suffix.slice(0, -1);
    backscroll = original + suffix + '[…truncated]';
  }
  const readExpected = expected.replace(/@alice \(uid:([A-Z0-9]+)\)/g,
    (mention, id) => originalIds.has(id) || id === 'U1' ? mention : `@${id} (uid:${id})`);
  assert.deepEqual(result.contents, [readExpected, readExpected, backscroll]);
  if (bot) assert.equal(result.received.length, 0, 'existing live bot exclusion');
  else {
    const liveExpected = expected.replace(/@alice \(uid:([A-Z0-9]+)\)/g,
      (mention, id) => originalIds.has(id) || id === 'U1' ? mention : `@${id} (uid:${id})`);
    assert.equal(result.received[0].cleanContent, liveExpected);
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

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const richBlock = (...elements: unknown[]) => ({ type: 'rich_text', elements });
const richSection = (...elements: unknown[]) => ({ type: 'rich_text_section', elements });
const literal = (text: string) => ({ type: 'text', text });

test('review supplemental fragments dedup independently', async () => {
  await expectText({ text: 'Notification', attachments: [{ text: 'Body' }, { text: 'Body' }], blocks: [section('Body'), section('Other')] }, 'Notification\nBody\nOther');
});

test('review rich usergroup date and toned emoji preserved and deduplicated', async () => {
  const body = '@S1 Today :thumbsup::skin-tone-2:';
  const blocks = [richBlock(richSection({ type: 'usergroup', usergroup_id: 'S1' }, literal(' '), { type: 'date', fallback: 'Today' }, literal(' '), { type: 'emoji', name: 'thumbsup', skin_tone: 2 }))];
  await expectText({ blocks }, body);
  assert.equal((await expectText({ text: body, blocks }, body))!.content, body);
});

test('review rich literal escapes cannot become mentions or entities', async () => {
  const live = await expectText({ blocks: [richBlock(richSection(literal('&lt; <@U1> & >')))] }, '&lt; <@U1> & >');
  assert.deepEqual(live!.mentionIds, []);
});

test('review shared bot mentions are display-only and raw text is preserved', async () => {
  const live = await expectText({ text: 'Notification', attachments: [{ is_share: true, text: '<@UBOT>' }] }, 'Notification\n[shared message from unknown, unknown source]\n> @alice (uid:UBOT)');
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

test('review supplemental display uses the author cache or raw ID without fresh lookups', async () => {
  const live = await expectText({ text: '@U1 (uid:U1)', attachments: [{ text: '<@U1>' }, { text: '<@U2>' }] }, '@U1 (uid:U1)\n@alice (uid:U1)\n@alice (uid:U2)');
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

for (const length of [16383, 16384, 16385]) {
  test(`attachment nested section boundary: ${length} code units`, async () => {
    const text = 'x'.repeat(length - 11) + 'NEEDLE12345';
    const row = { ts: '100.000001', attachments: [{ blocks: [section(text)] }] };
    const marker = '[…truncated]';
    const expected = length <= MAX_MESSAGE_TEXT_APPEND ? text :
      text.slice(0, MAX_MESSAGE_TEXT_APPEND - marker.length) + marker;
    assert.equal(renderMessageText(row), expected);
    const adapter = new SlackAdapter({ conversations: {
      history: async () => ({ messages: [row] }),
    } } as any, { on() {} } as any, 'UBOT', 'example');
    const result = await adapter.readHistory('C1', { textContains: 'NEEDLE12345' });
    if (length <= MAX_MESSAGE_TEXT_APPEND) assert.equal(result.messages[0]?.content, text);
    else assert.equal(result.messages.length, 0);
  });
}

test('review history textContains searches delivered content; thread returns unfiltered content', async () => {
  const row = { ts: '100.000001', text: 'Notification', blocks: [section('deployment failed')] };
  const adapter = new SlackAdapter({ conversations: {
    history: async () => ({ messages: [row] }), replies: async () => ({ messages: [row] }),
  } } as any, { on() {} } as any, 'UBOT', 'example');
  for (const result of [await adapter.readHistory('C1', { textContains: 'deployment failed' }), await adapter.readThread('C1', row.ts, {})]) {
    assert.equal(result.messages[0]?.content, 'Notification\ndeployment failed');
  }
});

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { release } from '../scripts/release-changelog.mjs';
import { method } from '@animalabs/mcpl-core';
import { harness, initialize, FULL_GRANT, until } from './harness.js';

test('review fragment passes the actual release validator', () => {
  const root = mkdtempSync(join(tmpdir(), 'payload-release-'));
  try {
    // Permanent copy survives releases; never let unrelated pending entries
    // or repository version/Unreleased state make this validation pass.
    const name = 'readable-message-payloads.added.md';
    const fragment = readFileSync(join('test/fixtures', name), 'utf8');
    const pending = join('changelog.d', name);
    if (existsSync(pending)) assert.equal(readFileSync(pending, 'utf8'), fragment);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');
    mkdirSync(join(root, 'changelog.d'));
    assert.throws(() => release(root), /nothing to release/);
    writeFileSync(join(root, 'changelog.d', name), fragment);
    assert.match(release(root), /from 1 fragment/);
    assert.ok(readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(fragment.trim()));
    assert.equal(existsSync(join(root, 'changelog.d', name)), false);

  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review server shared mentions neither wake nor auto-subscribe; raw metadata remains original', async () => {
  const h = harness({ ackReaction: 'eyes' });
  try {
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
    const event = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '100.1', text: 'Notification', attachments: [{ is_share: true, text: '<@UBOT> Details' }] };
    await h.socket.emitMessage(event);
    // Wait for both queues, rather than trusting emitMessage's convenience delay.
    await (h.server as any).slack.inbound.get('C1');
    await (h.server as any).forwarding.get('C1');
    assert.equal(h.hostSaw.filter(r => r.method === method.PUSH_EVENT).length, 0, 'unsubscribed ambient shared mention is silent');
    const listed: any = await h.host.sendRequest('tools/call', {name: 'list_subscriptions', arguments: {}});
    assert.deepEqual(JSON.parse(listed.content[0].text).channels, [], 'shared mention must not auto-subscribe');
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
    assert.deepEqual(h.reactions, [], 'supplemental mentions never acknowledge');

  } finally { await h.close(); }
});

test('review docs pin the real nested-before-top-level order', () => {
  assert.match(readFileSync('README.md', 'utf8'), /then that attachment's nested blocks, then top-level blocks/);
});

// Non-rich supplemental units have no structural provenance: punctuation
// differences below survive on every shaping path. Equivalent bullet glyphs
// (•, ◦, ▪) are intentionally normalized, including for non-rich units.
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
    await expectText({ text, blocks: [richBlock(richSection({ ...literal('word'), style: { bold: true, italic: true } }))] }, text, true);
  }
});

test('attributed attachment preserves another author even when original text matches', async () => {
  await expectText({text: 'Build 42 failed', attachments: [{author_name: 'Jenkins', text: 'Build 42 failed'}]}, 'Build 42 failed\n[attachment from Jenkins]\n> Build 42 failed');
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
test('classic attachment fields format Slack tokens regardless of mrkdwn_in', async () => {
  const a = {title: 'Literal <@U2>', pretext: '<@U2>', text: '<@U2>', fields: [{title: 'a &lt; b', value: '<@U2>'}]};
  await expectText({attachments: [a]}, '@alice (uid:U2)\nLiteral @alice (uid:U2)\n@alice (uid:U2)\na < b: @alice (uid:U2)');
  await expectText({attachments: [{...a, mrkdwn_in: ['pretext', 'text', 'fields']}]}, '@alice (uid:U2)\nLiteral @alice (uid:U2)\n@alice (uid:U2)\na < b: @alice (uid:U2)');
  await expectText({attachments: [{fallback: '<@U2> &lt;'}]}, '@alice (uid:U2) <');
});
test('rich team broadcasts and dates retain styles', async () => {
  await expectText({blocks: [richBlock(richSection(
    {type: 'team', team_id: 'T1', style: {bold: true}}, literal(' '),
    {type: 'broadcast', range: 'here', style: {bold: true}}, literal(' '),
    {type: 'date', fallback: 'Today', style: {italic: true}},
  ))]}, '*team T1* *@here* _Today_');
});
test('attribution fields follow shared framing name and channel rules', async () => {
  await expectText({attachments: [{is_share: true, author_name: 'Bob [ops]', footer: 'Posted in <#C1|ops>', text: 'Body'}]},
    '[shared message from "Bob [ops]", "Posted in \\u003c#C1|ops\\u003e"]\n> Body');
  await expectText({attachments: [{is_share: true, author_name: 'Bob', channel_name: 'ops', text: 'Body'}]},
    '[shared message from Bob, #ops]\n> Body');
});

test('classic attachment Slack links and mentions format and deduplicate on every read path', async () => {
  const text = 'Deploy <https://ci.example/42|#42> by <@U2> &amp; team';
  const expected = 'Deploy #42 (https://ci.example/42) by @alice (uid:U2) & team';
  await expectText({attachments: [{text}]}, expected);
  for (const field of ['text', 'fallback']) {
    await expectText({text, attachments: [{[field]: text}]}, expected, true);
  }
});

test('identical attachment bodies retain distinct authors but deduplicate within an attribution', async () => {
  for (const shared of [false, true]) {
    const names = shared ? ['Bob', 'Carol'] : ['job-A', 'job-B'];
    const body = shared ? 'LGTM' : 'Build failed';
    const attachments = names.map(author_name => ({is_share: shared, author_name, text: body, blocks: [section(body)]}));
    const expected = names.map(name => (shared ? `[shared message from ${name}, unknown source]` : `[attachment from ${name}]`) + '\n> ' + body).join('\n');
    await expectText({attachments: [...attachments, attachments[0]]}, expected);
  }
});

test('bot fenced-code mirrors deduplicate both compact and newline-delimited serializations', async () => {
  const blocks = [richBlock(richSection(literal('Before')), {type: 'rich_text_preformatted', elements: [literal('x')]}, richSection(literal('After')))];
  for (const text of ['Before\n```x```\nAfter', 'Before\n```\nx\n```\nAfter']) {
    await expectText({text, blocks}, text, true);
  }
  await expectText({blocks}, 'Before\n```x```\nAfter', true);
});

test('shared attribution prefers a channel name over a footer', async () => {
  await expectText({attachments: [{is_share: true, author_name: 'Bob', channel_name: 'ops', footer: 'Posted in <#C1|ops>', text: 'Body'}]},
    '[shared message from Bob, #ops]\n> Body');
});

test('emphasis and fence comparison normalization leaves literal code and interior whitespace distinct', async () => {
  for (const [text, body] of [
    ['`_*word*_`', '`*_word_*`'],
    ['```a  b```', '```a b```'],
    ['```a\nb```', '```ab```'],
    ['```a\n`\nb```', '```a`b```'],
    ['```const s = `\nhi\n`;```', '```const s = `hi`;```'],
  ]) {
    await expectText({text, attachments: [{text: body}]}, text + '\n' + body);
  }
});

test('repeated rich channel labels stop rendering before materializing oversized children', () => {
  const text = '<#C1|' + 'x'.repeat(40_000) + '>';
  let reads = 0;
  const elements = Array.from({ length: 13_500 }, () => ({
    get type() { reads++; return 'channel'; }, channel_id: 'C1',
  }));
  for (const limit of [2000, MAX_MESSAGE_TEXT_APPEND]) {
    reads = 0;
    const result = renderMessageText({
      text, attachments: [{ blocks: [richBlock(richSection(...elements))] }],
    }, limit);
    assert.ok(result.startsWith(text));
    assert.ok(result.endsWith('[…truncated]'));
    assert.ok(result.length <= text.length + limit);
    assert.ok(reads <= Math.ceil((text.length + 1) / '<#C1>'.length), 'short ID tokens still stop at the render budget');
  }
});

test('null context elements spend visits without reading the discarded tail', () => {
  const elements = new Array(1_000_000).fill(null);
  Object.defineProperty(elements, 2000, { get() { throw new Error('read beyond visit budget'); } });
  assert.equal(renderMessageText({ blocks: [{ type: 'context', elements }] }), '[…truncated]');
});

test('whitespace-only attachment bodies and nested sections retain fallback', async () => {
  for (const attachment of [
    { text: '   ', fallback: 'Failure details' },
    { blocks: [section(' \n ')], fallback: 'Failure details' },
  ]) {
    await expectText({ attachments: [attachment] }, 'Failure details');
  }
});

test('nested duplicates do not consume the emitted render allowance', () => {
  const text = 'x'.repeat(8192);
  assert.equal(renderMessageText({ attachments: [{ blocks: [
    { type: 'markdown', text }, { type: 'markdown', text },
    { type: 'markdown', text: 'distinct' },
  ] }] }), text + '\ndistinct');
});

test('channel label expansion is bounded across separately deduplicated blocks', () => {
  const text = '<#C1|' + 'x'.repeat(40_000) + '>';
  for (const attachments of [false, true]) {
    for (const limit of [2000, MAX_MESSAGE_TEXT_APPEND]) {
      let reads = 0;
      const blocks = Array.from({ length: 1000 }, () => richBlock(richSection({
        get type() { reads++; return 'channel'; }, channel_id: 'C1',
      })));
      const result = renderMessageText({ text, bot_id: 'B1', ...(attachments
        ? { attachments: blocks.map(b => ({ blocks: [b] })) } : { blocks }) }, limit);
      assert.equal(result, text, 'all mirrors are discarded before label expansion');
      assert.equal(reads, 1000, 'visit short IDs rather than expanding duplicate labels');
    }
  }
});

test('whitespace human text does not suppress readable rich text', () => {
  assert.equal(renderMessageText({ text: '   ', blocks: [richBlock(richSection({
    type: 'text', text: 'Please investigate',
  }))] }), '   \nPlease investigate');
});

test('shared attachment identifies a source channel ID without a name', () => {
  assert.equal(renderMessageText({ attachments: [{ is_share: true, channel_id: 'C123', text: 'body' }] }),
    '[shared message from unknown, #C123]\n&gt; body');
});

test('non-HTTP rich links match original literal angle tokens', async () => {
  await expectText({ blocks: [richBlock(richSection({
    type: 'link', url: 'mailto:alice@example.com', text: 'Email Alice',
  }))] }, '<mailto:alice@example.com|Email Alice>');
});

test('bot shares retain distinct source timestamps while deduplicating mirrors', async () => {
  const share = { is_share: true, author_name: 'Alice', channel_id: 'C1', text: 'Approved' };
  const first = { ...share, ts: '123.000001' };
  const second = { ...share, ts: '123.000002' };
  await expectText({ attachments: [first, first, { text: 'Source boundary' }, second], bot_id: 'B1' },
    '[shared message from Alice, #C1]\n> Approved\nSource boundary\n[shared message from Alice, #C1]\n> Approved', true);
});

test('bot mailto rich mirror deduplicates against its original angle token', async () => {
  const text = 'Mail <mailto:a@example.com|a@example.com>';
  const payload = { text, bot_id: 'B1', blocks: [richBlock(richSection(
    { type: 'text', text: 'Mail ' },
    { type: 'link', url: 'mailto:a@example.com', text: 'a@example.com' },
  ))] };
  assert.equal(renderMessageText(payload), text);
  await expectText(payload, text, true);
});

test('non-HTTP rich URLs preserve literal bars and identical labels', () => {
  assert.equal(renderMessageText({ blocks: [richBlock(richSection(
    { type: 'link', url: 'custom:one|two', text: 'custom:one|two' },
  ))] }), '&lt;custom:one|two|custom:one|two&gt;');
});

test('capped attribution fields visibly mark shortening', () => {
  const output = renderMessageText({ attachments: [{
    is_share: true, author_name: 'a'.repeat(101), footer: 'b'.repeat(101), text: 'Body',
  }] });
  assert.ok(output.includes('a'.repeat(99) + '…'));
  assert.ok(output.includes('b'.repeat(99) + '…'));
});

test('ordinary non-HTTP tokens retain main formatting and literal history filters', async () => {
  const text = 'Mail <mailto:alice@example.com|Alice> <mailto:alice@example.com> <tel:+123|Call> <tel:+123> <slack://channel|Open>';
  await expectText({ text }, text);
  const adapter = new SlackAdapter({
    conversations: { history: async () => ({ messages: [{ ts: '100.000001', text }] }) },
  } as any, { on() {} } as any, 'UBOT', 'example');
  const result = await adapter.readHistory('C1', { textContains: '<mailto:alice@example.com|Alice>' });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].content, text);
});

test('source identity isolates channel IDs behind identical displayed headers', () => {
  const share = { is_share: true, author_name: 'Alice', channel_name: 'ops', ts: '123.1', text: 'Body' };
  const result = renderMessageText({ attachments: [
    { ...share, channel_id: 'C1' }, { ...share, channel_id: 'C2' },
  ] });
  assert.equal((result.match(/Body/g) || []).length, 2);
});

test('numeric source timestamps retain identity and match their string form', () => {
  const share = { is_share: true, channel_id: 'C1', text: 'Body' };
  const result = renderMessageText({ attachments: [
    { ...share, ts: 123.1 }, { ...share, ts: '123.1' },
    { text: 'Source boundary' }, { ...share, ts: 123.2 },
  ] });
  assert.equal(result, '[shared message from unknown, #C1]\n&gt; Body\nSource boundary\n[shared message from unknown, #C1]\n&gt; Body');
});

test('angle URL removal never synthesizes a bare URL for unfurl suppression', () => {
  const text = 'https://example.<https://other.example|label>com';
  assert.equal(renderMessageText({ text, attachments: [
    { from_url: 'https://example.com', text: 'Keep preview' },
  ] }), text + '\nKeep preview');
});

test('backscroll truncates raw supplemental entities before formatting', async () => {
  const body = 'x'.repeat(1985) + '&amp;' + 'z'.repeat(40);
  const result = await shaped({ attachments: [{ text: body }] });
  assert.equal(result.contents[0], 'x'.repeat(1985) + '&' + 'z'.repeat(40));
  assert.equal(result.contents[2], 'x'.repeat(1985) + '&am' + '[…truncated]');
});

test('top-level omission labels retain input order and can displace later readable blocks', () => {
  const output = renderMessageText({blocks: [
    ...Array.from({length: 30}, (_, i) => ({type: 'unknown' + i})),
    {type: 'markdown', text: 'Later readable section'},
  ]}, 100);
  assert.deepEqual(output.match(/\[unknown\d+ omitted\]/g),
    Array.from({length: 4}, (_, i) => `[unknown${i} omitted]`));
  assert.ok(!output.includes('Later readable section'));
  assert.ok(output.endsWith('[…truncated]'));
  assert.ok(output.length <= 100);
});

test('live app-as-user rich bodies keep the from-human tag', async () => {
  const h = harness();
  try {
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: FULL_GRANT});
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
    await h.socket.emitMessage({type: 'message', channel: 'C1', user: 'U1', ts: '101.1',
      text: '<@UBOT> Summary', app_id: 'A1',
      blocks: [{type: 'rich_text', elements: [{type: 'rich_text_section', elements: [{type: 'text', text: 'App body'}]}]}]});
    await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'app delivery');
    const push: any = h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params;
    assert.ok(push.tags.includes('chat:from-human'));
    assert.ok(JSON.stringify(push.payload.content).includes('App body'));
  } finally { await h.close(); }
});

test('explicit history/thread reads never look up supplemental-only IDs, even beyond the byte limit', async () => {
  for (const kind of ['history', 'thread'] as const) {
    const calls: string[] = [];
    const messages = Array.from({length: 30}, (_, i) => ({
      ts: `${100 + i}.000001`, user: 'UAUTHOR', text: '<@UORIGINAL> body',
      attachments: [{text: Array.from({length: 20}, (_, j) => `<@UEXTRA${i}X${j}>`).join(' ')}],
    }));
    const adapter = new SlackAdapter({
      users: {info: async ({user}: {user: string}) => { calls.push(user); return {user: {name: 'name-' + user}}; }},
      conversations: {history: async () => ({messages}), replies: async () => ({messages})},
    } as any, {on() {}} as any, 'UBOT', 'example');
    (adapter as any).userNameCache.set('UEXTRA0X0', 'cached');
    const result = kind === 'history'
      ? await adapter.readHistory('C1', {maxBytes: 3000})
      : await adapter.readThread('C1', '100.000001', {maxBytes: 3000});
    assert.equal(result.pagination.stopReason, 'byte_limit');
    assert.deepEqual(calls.sort(), ['UAUTHOR', 'UORIGINAL']);
    assert.equal((adapter as any).userNameCache.size, 3, 'no supplemental entries or refusals retained');
    const content = result.messages.map(m => m.content).join('\n');
    assert.match(content, /@UEXTRA/);
    if (kind === 'thread') assert.match(content, /@cached \(uid:UEXTRA0X0\)/);
  }
});

test('malformed nested/multiline mentions pin live addressing policy', async () => {
  for (const [text, ids, mentionsBot] of [
    ['<@U1|x<@UBOT>>', ['UBOT'], true],
    ['<@UBOT|a\nb>', [], false],
  ] as const) {
    const result = await shaped({text});
    assert.deepEqual(result.received[0].mentionIds, ids);
    assert.equal(result.received[0].mentionsBot, mentionsBot);
  }
});

test('blocks-only channel metadata preserves the empty original rawContent', async () => {
  const h = harness();
  try {
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: FULL_GRANT});
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
    await h.host.sendRequest('tools/call', {name: 'subscribe_channel', arguments: {channelId: 'C1'}});
    await h.host.sendRequest(method.CHANNELS_OPEN, {channelId: 'slack:C1', type: 'slack', address: {channelId: 'C1'}});
    await h.socket.emitMessage({type: 'message', channel: 'C1', user: 'U1', ts: '100.9', blocks: [section('block body')]});
    await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_INCOMING), 'blocks-only channel delivery');
    const incoming: any = h.hostSaw.find(r => r.method === method.CHANNELS_INCOMING)!.params;
    assert.equal(incoming.messages[0].metadata.rawContent, '');
  } finally { await h.close(); }
});

test('non-rich comparison intentionally treats bullet glyph variants as equivalent', () => {
  assert.equal(renderMessageText({text: '• x', attachments: [{text: '◦ x'}]}), '• x');
});


test('duplicate deferred omission labels do not falsely truncate original text', () => {
  assert.equal(renderMessageText({text: '[poll omitted]', attachments: [{blocks: [{type: 'poll'}]}]}, 13), '[poll omitted]');
});

test('history filters agree with rendered channel labels, usergroups and truncation markers', async () => {
  const row = {ts: '100.000001', text: '<#C1|operations> <!subteam^S1|responders>', attachments: [{text: 'x'.repeat(17000)}]};
  const adapter = new SlackAdapter({conversations: {history: async () => ({messages: [row]})}} as any, {on() {}} as any, 'UBOT', 'example');
  const all = await adapter.readHistory('C1', {});
  for (const textContains of ['#operations', '@responders', '[…truncated]']) {
    assert.ok(all.messages[0].content.includes(textContains));
    assert.deepEqual((await adapter.readHistory('C1', {textContains})).messages, all.messages);
  }
});

test('cut duplicate prefixes preserve a marker for potentially distinct tails', () => {
  const padded = 'hello' + ' '.repeat(17000) + 'IMPORTANT';
  for (const payload of [
    {attachments: [{text: padded}]},
    {attachments: [{fallback: padded}]},
    {attachments: [{blocks: [{type: 'markdown', text: padded}]}]},
    {blocks: [{type: 'markdown', text: padded}]},
    {blocks: [{type: 'section', fields: [{text: 'hello'}, {text: ' '.repeat(17000) + 'IMPORTANT'}]}]},
  ]) assert.equal(renderMessageText({text: 'hello', ...payload}), 'hello\n[…truncated]');
  assert.match(renderMessageText({text: 'hello', blocks: [{type: 'markdown', text: 'distinct'.repeat(3000)}]}), /\[…truncated\]$/);
});

test('null client_msg_id is not client provenance for app rich text', () => {
  assert.equal(renderMessageText({text: 'summary', app_id: 'A1', client_msg_id: null,
    blocks: [{type: 'rich_text', elements: [{type: 'rich_text_section', elements: [{type: 'text', text: 'details'}]}]}],
  }), 'summary\ndetails');
});

test('normalized duplicate omission labels do not spend deferred allowance', () => {
  assert.equal(renderMessageText({attachments: [{blocks: [{type: 'poll'}, {type: 'poll '}]}]}, 15), '[poll omitted]');
});
