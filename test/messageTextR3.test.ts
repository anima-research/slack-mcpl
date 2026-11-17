import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSlackText } from '../src/content.js';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';

const text = (text: string, style?: unknown) => ({type: 'text', text, style});
const section = (...elements: unknown[]) => ({type: 'rich_text_section', elements});
const rich = (...elements: unknown[]) => ({type: 'rich_text', elements});
const plain = (value: string) => rich(section(text(value)));
const link = (label?: string) => rich(section({type: 'link', url: 'https://ex.com', text: label}));

// All fixtures exercise real live, channel history, thread history and startup
// backscroll conversion. Slack itself is mocked; there is no network client.
async function paths(payload: Record<string, unknown>): Promise<string[]> {
  const row = {ts: '100.000001', user: 'U1', ...payload};
  let handler: any;
  const adapter = new SlackAdapter({
    users: {info: async () => ({user: {name: 'alice'}})},
    conversations: {
      history: async () => ({messages: [row]}),
      replies: async () => ({messages: [row]}),
    },
  } as any, {on(_: string, h: any) {handler = h;}} as any, 'UBOT', 'example');
  const delivered = new Promise<SlackMessageData>(resolve => adapter.onMessage(resolve));
  handler({event: {type: 'message', channel: 'C1', ...row}, ack: async () => {}});
  return [
    (await delivered).cleanContent,
    (await adapter.readHistory('C1', {})).messages[0].content,
    (await adapter.readThread('C1', row.ts, {})).messages[0].content,
    (await adapter.fetchHistory('C1')).messages[0].content,
  ];
}

const collisions: Array<[string, string, unknown]> = [
  ['decimal', 'Dose 1.5 mg', plain('Dose 15 mg')],
  ['comparison', 'x < y', plain('x > y')],
  ['hyphen', 're-sign', plain('resign')],
  ['word boundary', 'not now', plain('no tnow')],
  ['link label', '<https://ex.com|re-sign>', link('resign')],
];
for (const [name, original, block] of collisions) test(`R3 collision ${name}: human block ignored on all delivery paths`, async () => {
  const expected = formatSlackText(original, new Map([['U2', 'alice']]));
  assert.deepEqual(await paths({text: original, blocks: [block]}), Array(4).fill(expected));
});

const mirrors: Array<[string, string, unknown]> = [
  ['bold', '*word*', rich(section(text('word', {bold: true})))],
  ['italic', '_word_', rich(section(text('word', {italic: true})))],
  ['strike', '~word~', rich(section(text('word', {strike: true})))],
  ['inline code', '`x_* < y`', rich(section(text('x_* < y', {code: true})))],
  ['nested emphasis', '_*word*_', rich(section(text('word', {bold: true, italic: true})))],
  ['labelled link', '*<https://ex.com|docs>*', rich(section({type: 'link', url: 'https://ex.com', text: 'docs', style: {bold: true}}))],
  ['bare link', 'https://ex.com', link()],
  ['angle link', '<https://ex.com>', link()],
  ['mentions', '<@U2|bob> <#C1|ops> <!subteam^S1|team>', rich(section({type: 'user', user_id: 'U2'}, text(' '), {type: 'channel', channel_id: 'C1'}, text(' '), {type: 'usergroup', usergroup_id: 'S1'}))],
  ['emoji', ':wave:', rich(section({type: 'emoji', name: 'wave'}))],
  ['bullet list', '• first\n• second', rich({type: 'rich_text_list', style: 'bullet', elements: [section(text('first')), section(text('second'))]})],
  ['ordered list', '7. first\n8. second', rich({type: 'rich_text_list', style: 'ordered', offset: 6, elements: [section(text('first')), section(text('second'))]})],
  ['nested lists', '• first\n    ◦ nested\n• last', rich({type: 'rich_text_list', elements: [section(text('first'))]}, {type: 'rich_text_list', indent: 1, elements: [section(text('nested'))]}, {type: 'rich_text_list', elements: [section(text('last'))]})],
  ['quote', '&gt; first\n&gt; second', rich({type: 'rich_text_quote', elements: [text('first\nsecond')]})],
  ['code block', 'Before\n```\nx_* < y\n> literal\n```\nAfter', rich(section(text('Before')), {type: 'rich_text_preformatted', elements: [text('x_* < y\n> literal')]}, section(text('After')))],
  ['escaped text', 'A &amp; B &lt; C &gt; D', plain('A & B < C > D')],
  ['multiline', 'first\n\nsecond\t third', rich(section(text('first')), section(text('second third')))],
];
for (const [name, original, block] of mirrors) test(`R3 mirror ${name}: skipped on all delivery paths`, async () => {
  const expected = formatSlackText(original, new Map([['U2', 'alice']]));
  assert.deepEqual(await paths({text: original, blocks: [block]}), Array(4).fill(expected));
});

for (const [name, original, block] of [
  ['quoted digits', '> 7. item', rich({type: 'rich_text_quote', elements: [text('item')]})],
  ['bare URL punctuation', 'https://ex.com/*word*', rich(section({type: 'link', url: 'https://ex.com/word'}))],
  ['literal entity', 'A &amp; B', plain('A &amp; B')],
  ['case and compatibility', 'Straße Ａ Σς ẞ', plain('STRASSE a σσ ss')],
  ['unbalanced marker', '*word', plain('word')],
  ['intraword marker', 'a_b', plain('ab')],
  ['literal rich markers', 'word', plain('*word*')],
  ['literal code punctuation', '`*word*`', plain('word')],
  ['unknown-only block', 'word', rich({type: 'future_element', text: 'word'})],
  ['unknown element', 'word', rich(section(text('word'), {type: 'future_element', text: 'unknown'}))],
  ['budget hit', 'word', rich(section(text('word'), ...Array.from({length: 2000}, () => text(''))))],
] as const) test(`R3 uncertain or distinct ${name}: human block ignored`, async () => {
  const originalPlain = formatSlackText(original, new Map());
  for (const result of await paths({text: original, blocks: [block]})) {
    assert.equal(result, originalPlain);
  }
});
