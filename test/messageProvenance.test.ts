import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageText } from '../src/message-text.js';
import { SlackAdapter, type SlackMessageData } from '../src/slack-adapter.js';

const literal = (text: string) => ({type: 'text', text});
const section = (...elements: unknown[]) => ({type: 'rich_text_section', elements});
const rich = (...elements: unknown[]) => ({type: 'rich_text', elements});
// Reconstructed composer block/text pairs, NOT live captures (offline run).
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
for (const [name, identity] of [
  ['human without app provenance', {}],
  ['explicit client id despite bot provenance', {client_msg_id: '', bot_id: 'B1', app_id: 'A1', bot_profile: {id: 'B1'}}],
] as const) test(`top-level rich mirrors skip without traversal for ${name}`, async () => {
  let reads = 0;
  const mirror = {type: 'rich_text', get elements() {reads++; throw new Error('mirror traversed');}};
  // Bot id is checked by live delivery before rendering; test that class at
  // the renderer, and explicit client-id precedence on eligible live posts.
  assert.equal(renderMessageText({text: 'original', ...identity, blocks: [mirror]}), 'original');
  const eligible = {...identity, bot_id: undefined};
  assert.deepEqual(await paths({text: 'original', ...eligible, blocks: [mirror,
    {type: 'section', text: {type: 'mrkdwn', text: 'section'}}], attachments: [{blocks: [rich(section(literal('nested'))) ]}]}), Array(4).fill('original\nnested\nsection'));
  assert.equal(reads, 0);
});
for (const {name, text, block} of fixtures) test(`bot reconstructed ${name} renders the modeled text then deduplicates`, () => {
  assert.equal(renderMessageText({bot_id: 'B1', blocks: [block]}), text);
  assert.equal(renderMessageText({bot_id: 'B1', text, blocks: [block]}), text);
});
test('blocks-only app-as-user rich text survives all four delivery paths', async () => {
  for (const text of [undefined, '']) {
    assert.deepEqual(await paths({text, app_id: 'A1', client_msg_id: 'client', blocks: [rich(section(literal('app body')))]}), Array(4).fill('app body'));
  }
});
test('bots retain plain per-unit display dedup', () => {
  assert.equal(renderMessageText({text: '*_word_*', bot_id: 'B1', blocks: [rich(section({type: 'text', text: 'word', style: {bold: true, italic: true}}))]}), '*_word_*');
  const block = rich(section(literal('body')));
  assert.equal(renderMessageText({text: 'summary', bot_id: 'B1', blocks: [block, block]}), 'summary\nbody');
  // Plain display dedup intentionally does not distinguish entity provenance.
  assert.equal(renderMessageText({text: 'summary', bot_id: 'B1', blocks: [
    rich(section({type: 'link', url: 'https://review.invalid/a', text: 'run'})),
    rich(section(literal('run (https://review.invalid/a)'))),
  ]}), 'summary\n<https://review.invalid/a|run>');
});

test('addressed message with uncoercible rich-list indent and offset is still delivered', async (t) => {
  const { method } = await import('@animalabs/mcpl-core');
  const { harness, initialize, FULL_GRANT, until } = await import('./harness.js');
  const h = harness();
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: FULL_GRANT});
  await until(() => h.hostSaw.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
  // Number() throws on both: a non-callable toString, and recursion through nesting.
  let deep: unknown = 1;
  for (let i = 0; i < 100_000; i++) deep = [deep];
  const list = (fields: Record<string, unknown>) => ({type: 'rich_text_list', ...fields, elements: [section(literal('item'))]});
  await h.socket.emitMessage({type: 'message', channel: 'C1', user: 'U1', ts: '2000.000001', text: '<@UBOT> hi', attachments: [{blocks: [rich(
    list({style: 'bullet', indent: {toString: null}}), list({style: 'ordered', indent: deep, offset: deep}),
    list({style: 'ordered', indent: 1, offset: 2}))]}]});
  await until(() => h.hostSaw.some(r => r.method === method.PUSH_EVENT), 'delivery');
  const push = h.hostSaw.find(r => r.method === method.PUSH_EVENT)!.params as {payload: {content: Array<{text: string}>}};
  const text = push.payload.content.map(c => c.text).join('\n');
  assert.match(text, /hi\n\s*• item\n\s*1\. item\n\s* {4}3\. item/);
});
