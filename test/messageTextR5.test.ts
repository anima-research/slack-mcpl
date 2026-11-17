import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageText } from '../src/message-text.js';
import { formatSlackText } from '../src/content.js';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';

const literal = (text: string) => ({type: 'text', text});
const section = (...elements: unknown[]) => ({type: 'rich_text_section', elements});
const rich = (...elements: unknown[]) => ({type: 'rich_text', elements});
// Reconstructed client-shaped R1-2 fixtures, NOT live captures (offline run).
// Composer structure follows @slack/types RichTextBlock/element definitions.
const fixtures = [
  {name: 'nested list', text: '• a\n    ◦ b', block: rich(
    {type: 'rich_text_list', style: 'bullet', indent: 0, elements: [section(literal('a'))]},
    {type: 'rich_text_list', style: 'bullet', indent: 1, elements: [section(literal('b'))]})},
  {name: 'code between paragraphs', text: 'Run:\n```npm test```\nthen push', block: rich(
    section(literal('Run:')), {type: 'rich_text_preformatted', elements: [literal('npm test')]}, section(literal('then push')))},
  {name: 'bold link', text: '*<https://ex.com|docs>*', block: rich(section(
    {type: 'link', url: 'https://ex.com', text: 'docs', style: {bold: true}}))},
];
async function paths(payload: Record<string, unknown>): Promise<string[]> {
  const row = {ts: '100.000001', user: 'U1', ...payload};
  let handler: any;
  const adapter = new SlackAdapter({
    users: {info: async () => ({user: {name: 'alice'}})},
    conversations: {history: async () => ({messages: [row]}), replies: async () => ({messages: [row]})},
  } as any, {on(_: string, h: any) {handler = h;}} as any, 'UBOT', 'example');
  const delivered = new Promise<SlackMessageData>(resolve => adapter.onMessage(resolve));
  handler({event: {type: 'message', channel: 'C1', ...row}, ack: async () => {}});
  return [(await delivered).cleanContent, (await adapter.readHistory('C1', {})).messages[0].content,
    (await adapter.readThread('C1', row.ts, {})).messages[0].content, (await adapter.fetchHistory('C1')).messages[0].content];
}
for (const {name, text, block} of fixtures) test(`R5 client ${name}: exactly once without reading mirror`, async () => {
  let reads = 0;
  const mirror = {...block, block_id: 'client-block', get elements() {reads++; return block.elements;}};
  const payload = {type: 'message', team: 'T1', user: 'U1', ts: '100.000001', client_msg_id: 'ac8a1e5a-0000-4000-8000-000000000001', text, blocks: [mirror]};
  assert.deepEqual(await paths(payload), Array(4).fill(formatSlackText(text, new Map())));
  assert.equal(reads, 0, 'human rich_text must be skipped, not compared or rendered');
});
test('R5 literal identity rule skips only top-level rich blocks with nonempty human text', () => {
  const block = rich(section(literal('different')));
  for (const identity of [{}, {client_msg_id: 'client'}, {bot_id: 'B1', client_msg_id: ''}]) {
    assert.equal(renderMessageText({text: 'original', ...identity, blocks: [block,
      {type: 'section', text: {type: 'mrkdwn', text: 'section'}}], attachments: [{blocks: [block]}]}), 'original\ndifferent\nsection');
  }
  assert.equal(renderMessageText({text: 'original', bot_id: 'B1', blocks: [block]}), 'original\ndifferent');
});
test('R5 blocks-only app-as-user rich text survives all four delivery paths', async () => {
  for (const text of [undefined, '']) {
    assert.deepEqual(await paths({text, client_msg_id: 'client', blocks: [rich(section(literal('app body')))]}), Array(4).fill('app body'));
  }
});
test('R5 bots retain plain per-unit dedup, without emphasis or fence equivalence', () => {
  assert.equal(renderMessageText({text: '*_word_*', bot_id: 'B1', blocks: [rich(section({type: 'text', text: 'word', style: {bold: true, italic: true}}))]}), '*_word_*\n_*word*_');
  const block = rich(section(literal('body')));
  assert.equal(renderMessageText({text: 'summary', bot_id: 'B1', blocks: [block, block]}), 'summary\nbody');
  // Plain display dedup intentionally does not distinguish entity provenance.
  assert.equal(renderMessageText({text: 'summary', bot_id: 'B1', blocks: [
    rich(section({type: 'link', url: 'https://review.invalid/a', text: 'run'})),
    rich(section(literal('run (https://review.invalid/a)'))),
  ]}), 'summary\n<https://review.invalid/a|run>');
});
