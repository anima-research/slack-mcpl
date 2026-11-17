import test from 'node:test';
import assert from 'node:assert/strict';
import type { RichTextBlock } from '@slack/types';
import { renderMessageText } from '../src/message-text.js';
import { formatSlackText } from '../src/content.js';
import { SlackAdapter } from '../src/slack-adapter.js';
import { backscrollBlock } from '../src/server.js';

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const rich = (text: string) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] });
const clean = (payload: Parameters<typeof renderMessageText>[0]) => formatSlackText(renderMessageText(payload), new Map());
// Constructed from @slack/types, NOT captured from a live Slack client.
const humanFixtures: Array<{ text: string; block: RichTextBlock }> = [
  { text: '• a\n    ◦ b', block: { type: 'rich_text', elements: [
    { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'a' }] }] },
    { type: 'rich_text_list', style: 'bullet', indent: 1, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'b' }] }] },
  ] } },
  { text: 'Run:\n```npm test```\nthen push', block: { type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'Run:' }] },
    { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'npm test' }] },
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'then push' }] },
  ] } },
  { text: '*<https://ex.com|docs>*', block: { type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://ex.com', text: 'docs', style: { bold: true } }] },
  ] } },
];
test('R1-2 human top-level mirrors are skipped; distinct bot and blocks-only rich text retained', () => {
  for (const {text, block} of humanFixtures) {
    for (const identity of [{}, { bot_id: 'B1', client_msg_id: 'client' }]) {
      assert.equal(renderMessageText({ text, blocks: [block, section('AFTER')], ...identity }), text + '\nAFTER');
    }
    assert.notEqual(renderMessageText({ text: 'Notification', bot_id: 'B1', blocks: [block] } as any), 'Notification');
    assert.ok(renderMessageText({ blocks: [block] }));
  }
});
test('R1-3 shares, message unfurls and author attachments carry attribution and quoted lines', () => {
  for (const flags of [{is_share: true}, {is_msg_unfurl: true}, {is_share: true, is_app_unfurl: true}]) {
    assert.equal(clean({ text: 'thoughts?', attachments: [{ ...flags, author_name: 'Bob', author_id: 'U2', footer: '#ops', text: 'approve\nnow', blocks: [section('nested')] }] }),
      'thoughts?\n[shared message from Bob (uid:U2), #ops]\n> approve\n> now\n> nested');
  }
  assert.equal(clean({ attachments: [{ author_name: 'CI', text: 'OK' }] }), '[attachment from CI]\n> OK');
});
test('R1-5 plain objects, labels and date fallbacks remain literal; #66-10 IDs cannot inject', () => {
  assert.equal(clean({ blocks: [ { type: 'header', text: { type: 'plain_text', text: 'Ping <@UBOT> &lt;tag&gt;' } },
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
      { type: 'link', url: 'https://x.io/?a=1&b=2', text: 'a>b <@U2>' },
      { type: 'date', fallback: '<@U3> &lt;' },
      { type: 'user', user_id: 'U1><@U2' },
    ] }] },
  ] }), 'Ping <@UBOT> &lt;tag&gt;\na>b <@U2> (https://x.io/?a=1&b=2)<@U3> &lt;');
});
test('R1-6 mirror does not spend display budget twice', () => {
  const block = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: Array.from({length: 998}, () => ({type: 'text', text: 'x'})) }] };
  assert.equal(renderMessageText({ blocks: [block, section('AFTER')] }), 'x'.repeat(998) + '\nAFTER');
});
test('R1-7 query strings and #66-3 bare trailing punctuation suppress redundant previews', () => {
  for (const text of ['<https://example.com/?a=1&amp;b=2|Label>', 'See https://example.com/?a=1&amp;b=2.']) {
    assert.equal(renderMessageText({ text, attachments: [{from_url: 'https://example.com/?a=1&b=2', text: 'PREVIEW'}] }), text);
  }
});
test('R1-8 readable modern blocks and visible unsupported placeholders', () => {
  assert.equal(clean({ blocks: [ {type: 'markdown', text: '*md*'}, {type: 'alert', text: {type: 'plain_text', text: 'alert'}},
    {type: 'card', title: {type: 'mrkdwn', text: 'title'}, subtitle: {type: 'mrkdwn', text: 'sub'}, body: {type: 'mrkdwn', text: 'body'}},
    {type: 'video', title: {type: 'plain_text', text: 'video'}, description: {type: 'plain_text', text: 'desc'}},
    {type: 'table', rows: [[{type: 'raw_text', text: '<cell>'}, rich('rich cell')]]}, {type: 'task_card'}, {type: 'plan'},
  ] }), '*md*\nalert\ntitle\nsub\nbody\nvideo\ndesc\n<cell> | rich cell\n[task_card omitted]\n[plan omitted]');
});
test('R1-10 dedup uses channel ID and preserves backtick whitespace; #66-11 literal mention lookalikes survive', () => {
  assert.equal(renderMessageText({ text: '<#C1|general>', attachments: [{text: '<#C2|general>'}, {text: '<#C1>'}] }), '<#C1|general>\n<#C2|general>');
  assert.equal(renderMessageText({ text: '`a  b`', attachments: [{text: '`a b`'}] }), '`a  b`\n`a b`');
  assert.equal(renderMessageText({ text: '@U1 (uid:U1)', attachments: [{text: '<@U1>'}] }), '@U1 (uid:U1)\n<@U1>');
  assert.equal(renderMessageText({ text: '*_word_*', bot_id: 'B1', attachments: [
    {blocks: [{type: 'rich_text', elements: [{type: 'rich_text_section', elements: [{type: 'text', text: 'word', style: {bold: true, italic: true}}]}]}]},
    {text: '_*word*_'},
  ] }), '*_word_*\n_*word*_');
});
test('#66-5 structured attachment blocks take precedence over fallback; #66-12 rich structure is displayed', () => {
  assert.equal(renderMessageText({ attachments: [{fallback: 'Heading\nBody', blocks: [section('Heading'), section('Body')]}] }), 'Heading\nBody');
  assert.equal(renderMessageText({ blocks: [{type: 'rich_text', elements: [
    {type: 'rich_text_list', style: 'ordered', offset: 3, indent: 1, elements: [{type: 'rich_text_section', elements: [{type: 'text', text: 'item'}]}]},
    {type: 'rich_text_quote', elements: [{type: 'text', text: 'quote'}]},
    {type: 'rich_text_preformatted', elements: [{type: 'text', text: 'code'}]},
  ] }] }), '    4. item\n> quote\n```\ncode\n```');
});
const hostile = { text: ' *a'.repeat(13_333), bot_id: 'B1', blocks: Array.from({length: 50}, (_, i) => rich(' *b'.repeat(13_332) + String(i).padStart(3, '0'))) };
test('R1-1 40k / 50 rich blocks including attachment blocks render in <250ms', () => {
  for (const payload of [hostile, {...hostile, blocks: [], attachments: hostile.blocks.map(block => ({blocks: [block]}))}]) {
    const start = performance.now();
    renderMessageText(payload);
    assert.ok(performance.now() - start < 250, `render took ${performance.now() - start}ms`);
  }
});
test('R1-1 production fetchHistory over ten hostile messages in <750ms', async () => {
  const adapter = new SlackAdapter({conversations: {history: async () => ({messages: Array.from({length: 10}, (_, i) => ({...hostile, ts: `${100+i}.000001`}))})}} as any, {on(){}} as any, 'UBOT', 'example');
  const start = performance.now();
  assert.equal((await adapter.fetchHistory('C1')).messages.length, 10);
  assert.ok(performance.now() - start < 750, `fetchHistory took ${performance.now() - start}ms`);
});
test('R1-1 socket ack precedes any renderer access', async () => {
  let handler: any;
  let acked = false;
  const adapter = new SlackAdapter({users: {info: async () => ({user: {name: 'Alice'}})}} as any, {on(_: string, h: any){handler = h;}} as any, 'UBOT', 'example');
  let delivered: any;
  adapter.onMessage(m => {delivered = m;});
  handler({ack: async () => {acked = true;}, event: {type: 'message', channel: 'C1', user: 'U1', ts: '100.000001', text: 'hello', get blocks(){assert.ok(acked, 'render before ack'); return [section('body')];}}});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(delivered?.cleanContent, 'hello\nbody');
});
test('R1-9 only twenty supplemental IDs resolved per message on live and history paths', async () => {
  for (const path of ['live', 'history', 'backscroll']) {
    const calls: string[] = []; let handler: any; let delivered: any;
    const row = { user: 'UAUTH', ts: '100.000001', text: '<@UORIG|original>', blocks: [section(Array.from({length: 30}, (_, i) => `<@U${i}|label>`).join(' '))] };
    const adapter = new SlackAdapter({users: {info: async ({user}: any) => { calls.push(user); if (user === 'UORIG') throw new Error('temporary lookup failure'); return {user: {name: 'resolved'}};}}, conversations: {history: async () => ({messages: [row]})}} as any, {on(_: string, h: any){handler = h;}} as any, 'UBOT', 'example');
    (adapter as any).userNameCache.set('U20', 'CachedName');
    adapter.onMessage(m => {delivered = m;});
    let output: string;
    if (path === 'live') { handler({event: {...row, type: 'message', channel: 'C1'}, ack: async () => {}}); await new Promise(resolve => setTimeout(resolve, 10)); output = delivered.cleanContent; }
    else output = (path === 'history' ? await adapter.readHistory('C1', {}) : await adapter.fetchHistory('C1')).messages[0].content;
    assert.equal(calls.length, 22, calls.join(','));
    assert.ok(calls.includes('UORIG'));
    assert.match(output, /@U20 \(uid:U20\)/);
    assert.match(output, /@original \(uid:UORIG\)/, 'original fallback labels survive transient lookup failures');
  }
});
test('R1-4 backscroll supplemental lines capped at 2000; total block <=32KiB with dropped count', async () => {
  const adapter = new SlackAdapter({conversations: {history: async () => ({messages: [{text: 'Original', blocks: [section('x'.repeat(8000))], ts: '100.000001'}]})}} as any, {on(){}} as any, 'UBOT', 'example');
  const m = (await adapter.fetchHistory('C1')).messages[0];
  assert.ok(m.content.length <= 'Original'.length + 2000);
  assert.match(m.content, /\[…truncated\]/);
  const huge = Array.from({length: 50}, (_, i) => ({...m, id: `${i}`, content: '😀'.repeat(2000)}));
  const block = backscrollBlock(huge, {isDM: false});
  assert.ok(Buffer.byteLength(block) <= 32_768);
  const count = Number(block.match(/count="(\d+)"/)![1]);
  assert.ok(count > 0 && count < 50);
  assert.ok(block.includes(`[${50-count} backscroll messages dropped]`));
  assert.match(block, /id=49\]/);
  assert.doesNotMatch(block, /id=0\]/);
});
