import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { renderMessageText } from '../src/message-text.js';
import { formatSlackText } from '../src/content.js';
import { SlackAdapter } from '../src/slack-adapter.js';
import { backscrollBlock } from '../src/server.js';

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const rich = (text: string) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] });
const clean = (payload: Parameters<typeof renderMessageText>[0]) => formatSlackText(renderMessageText(payload), new Map());
test('shares, message unfurls and author attachments carry attribution and quoted lines', () => {
  for (const flags of [{is_share: true}, {is_msg_unfurl: true}, {is_share: true, is_app_unfurl: true}]) {
    assert.equal(clean({ text: 'thoughts?', attachments: [{ ...flags, author_name: 'Bob', author_id: 'U2', channel_name: 'ops', text: 'approve\nnow', blocks: [section('nested')] }] }),
      'thoughts?\n[shared message from Bob (uid:U2), #ops]\n> approve\n> now\n> nested');
  }
  assert.equal(clean({ attachments: [{ author_name: 'CI', text: 'OK' }] }), '[attachment from CI]\n> OK');
});
test('plain objects, labels and date fallbacks remain literal; IDs cannot inject', () => {
  assert.equal(clean({ blocks: [ { type: 'header', text: { type: 'plain_text', text: 'Ping <@UBOT> &lt;tag&gt;' } },
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
      { type: 'link', url: 'https://x.io/?a=1&b=2', text: 'a>b <@U2>' },
      { type: 'date', fallback: '<@U3> &lt;' },
      { type: 'user', user_id: 'U1><@U2' },
    ] }] },
  ] }), 'Ping <@UBOT> &lt;tag&gt;\na>b <@U2> (https://x.io/?a=1&b=2)<@U3> &lt;');
});
test('mirror does not spend display budget twice', () => {
  const block = { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: Array.from({length: 998}, () => ({type: 'text', text: 'x'})) }] };
  assert.equal(renderMessageText({ blocks: [block, section('AFTER')] }), 'x'.repeat(998) + '\nAFTER');
});
test('query strings and bare trailing punctuation suppress redundant previews', () => {
  for (const text of ['<https://example.com/?a=1&amp;b=2|Label>', 'See https://example.com/?a=1&amp;b=2.']) {
    assert.equal(renderMessageText({ text, attachments: [{from_url: 'https://example.com/?a=1&b=2', text: 'PREVIEW'}] }), text);
  }
});
test('readable modern blocks and visible unsupported placeholders', () => {
  assert.equal(clean({ blocks: [ {type: 'markdown', text: '*md*'}, {type: 'alert', text: {type: 'plain_text', text: 'alert'}},
    {type: 'card', title: {type: 'mrkdwn', text: 'title'}, subtitle: {type: 'mrkdwn', text: 'sub'}, body: {type: 'mrkdwn', text: 'body'}},
    {type: 'video', title: {type: 'plain_text', text: 'video'}, description: {type: 'plain_text', text: 'desc'}},
    {type: 'table', rows: [[{type: 'raw_text', text: '<cell>'}, rich('rich cell')]]}, {type: 'task_card'}, {type: 'plan'},
  ] }), '*md*\nalert\ntitle\nsub\nbody\nvideo\ndesc\n<cell> | rich cell\n[task_card omitted]\n[plan omitted]');
});
test('dedup uses channel ID and preserves backtick whitespace; literal mention lookalikes survive', () => {
  assert.equal(renderMessageText({ text: '<#C1|general>', attachments: [{text: '<#C2|general>', mrkdwn_in: ['text']}, {text: '<#C1>', mrkdwn_in: ['text']}] }), '<#C1|general>\n<#C2|general>');
  assert.equal(renderMessageText({ text: '`a  b`', attachments: [{text: '`a b`'}] }), '`a  b`\n`a b`');
  assert.equal(renderMessageText({ text: '@U1 (uid:U1)', attachments: [{text: '<@U1>', mrkdwn_in: ['text']}] }), '@U1 (uid:U1)\n<@U1>');
  assert.equal(renderMessageText({ text: '*_word_*', bot_id: 'B1', attachments: [
    {blocks: [{type: 'rich_text', elements: [{type: 'rich_text_section', elements: [{type: 'text', text: 'word', style: {bold: true, italic: true}}]}]}]},
    {text: '_*word*_'},
  ] }), '*_word_*');
});
test('structured attachment blocks take precedence over fallback; rich structure is displayed', () => {
  assert.equal(renderMessageText({ attachments: [{fallback: 'Heading\nBody', blocks: [section('Heading'), section('Body')]}] }), 'Heading\nBody');
  assert.equal(renderMessageText({ blocks: [{type: 'rich_text', elements: [
    {type: 'rich_text_list', style: 'ordered', offset: 3, indent: 1, elements: [{type: 'rich_text_section', elements: [{type: 'text', text: 'item'}]}]},
    {type: 'rich_text_quote', elements: [{type: 'text', text: 'quote'}]},
    {type: 'rich_text_preformatted', elements: [{type: 'text', text: 'code'}]},
  ] }] }), '    4. item\n> quote\n```code```');
});
const hostile = { text: ' *a'.repeat(13_333), bot_id: 'B1', blocks: Array.from({length: 50}, (_, i) => rich(' *b'.repeat(13_332) + String(i).padStart(3, '0'))) };
test('bounded adversarial rich blocks including attachment blocks', () => {
  for (const payload of [hostile, {...hostile, blocks: [], attachments: hostile.blocks.map(block => ({blocks: [block]}))}]) {
    const rendered = renderMessageText(payload);
    assert.ok(rendered.length <= payload.text.length + 16_384);
    assert.ok(rendered.endsWith('[…truncated]'));
  }
});
test('production fetchHistory over ten hostile messages stays bounded', async () => {
  const adapter = new SlackAdapter({conversations: {history: async () => ({messages: Array.from({length: 10}, (_, i) => ({...hostile, ts: `${100+i}.000001`}))})}} as any, {on(){}} as any, 'UBOT', 'example');
  const messages = (await adapter.fetchHistory('C1')).messages;
  assert.equal(messages.length, 10);
  assert.ok(messages.every(m => m.content.length <= hostile.text.length + 2000));
});
test('socket ack precedes any renderer access', async () => {
  let handler: any;
  let acked = false;
  const adapter = new SlackAdapter({users: {info: async () => ({user: {name: 'Alice'}})}} as any, {on(_: string, h: any){handler = h;}} as any, 'UBOT', 'example');
  const delivered = new Promise<any>(resolve => adapter.onMessage(resolve));
  handler({ack: async () => {acked = true;}, event: {type: 'message', channel: 'C1', user: 'U1', ts: '100.000001', text: 'hello', get blocks(){assert.ok(acked, 'render before ack'); return [section('body')];}}});
  assert.equal((await delivered).cleanContent, 'hello\nbody');
});
test('only twenty supplemental IDs resolved per message on live and history paths', async () => {
  for (const path of ['live', 'history', 'backscroll']) {
    const calls: string[] = []; let handler: any;
    const row = { user: 'UAUTH', ts: '100.000001', text: '<@UORIG|original>', blocks: [section(Array.from({length: 30}, (_, i) => `<@U${i}|label>`).join(' '))] };
    const adapter = new SlackAdapter({users: {info: async ({user}: any) => { calls.push(user); if (user === 'UORIG') throw new Error('temporary lookup failure'); return {user: {name: 'resolved'}};}}, conversations: {history: async () => ({messages: [row]})}} as any, {on(_: string, h: any){handler = h;}} as any, 'UBOT', 'example');
    (adapter as any).userNameCache.set('U20', 'CachedName');
    const delivered = new Promise<any>(resolve => adapter.onMessage(resolve));
    let output: string;
    if (path === 'live') { handler({event: {...row, type: 'message', channel: 'C1'}, ack: async () => {}}); output = (await delivered).cleanContent; }
    else output = (path === 'history' ? await adapter.readHistory('C1', {}) : await adapter.fetchHistory('C1')).messages[0].content;
    assert.equal(calls.length, 22, calls.join(','));
    assert.ok(calls.includes('UORIG'));
    assert.match(output, /@U20 \(uid:U20\)/);
    assert.match(output, /@original \(uid:UORIG\)/, 'original fallback labels survive transient lookup failures');
  }
});
test('backscroll supplemental lines capped at 2000; total block <=32KiB with explicit older summary', async () => {
  const adapter = new SlackAdapter({conversations: {history: async () => ({messages: [{text: 'Original', blocks: [section('x'.repeat(8000))], ts: '100.000001'}]})}} as any, {on(){}} as any, 'UBOT', 'example');
  const m = (await adapter.fetchHistory('C1')).messages[0];
  assert.ok(m.content.length <= 'Original'.length + 2000);
  assert.match(m.content, /\[…truncated\]/);
  const huge = Array.from({length: 50}, (_, i) => ({...m, id: `${i}`, content: '😀'.repeat(2000)}));
  const block = backscrollBlock(huge, {isDM: false});
  assert.ok(Buffer.byteLength(block) <= 32_768);
  const count = Number(block.match(/count="(\d+)"/)![1]);
  assert.ok(count > 0 && count < 50);
  assert.match(block, /older backscroll messages not shown; fetch_history latest=/);
  assert.match(block, /message omitted \(\d+ bytes\); fetch_history has it/);
  assert.match(block, /id=49\]/);
  assert.doesNotMatch(block, /id=0\]/);
});

for (const unit of ['<@U1|', '<https://x/']) test(`unclosed angle candidates remain literal at the text limit ${unit}`, () => {
  const text = unit.repeat(Math.floor(40000 / unit.length));
  assert.equal(renderMessageText({text}), text);
  assert.equal(formatSlackText(text, new Map()), text);
});
test('long labelled mentions format and unclosed openers remain literal', () => {
  const long = `<@U1|${'a'.repeat(1001)}>`;
  assert.equal(formatSlackText(long, new Map()), '@' + 'a'.repeat(1001) + ' (uid:U1)');
  assert.equal(renderMessageText({text: long, attachments: [{text: '<@U1>', mrkdwn_in: ['text']}]}), long);
  assert.equal(formatSlackText('literal < broken <@U1> <https://x', new Map()), 'literal < broken @U1 (uid:U1) <https://x');
});
test('large bot rich blocks retain distinct words within the supplemental limit', () => {
  const text = 'Ａb '.repeat(13333);
  const output = renderMessageText({text, bot_id: 'B1', blocks: [rich('UNIQUE ' + text)]});
  assert.ok(output.includes('UNIQUE'));
  assert.ok(output.length <= text.length + 16384);
});

test('long non-trailing URL punctuation stays bounded across repeated renders', {timeout: 5000}, async (t) => {
  const text = 'http://a' + '.'.repeat(39990) + 'x';
  for (let i = 0; i < 20; i++) {
    t.signal.throwIfAborted();
    assert.equal(renderMessageText({text, client_msg_id: 'human'}), text);
    // Let the runner enforce its timeout even when rendering blocks the loop.
    await setImmediate();
  }
});

test('bare URL trailing punctuation trimming preserves interior punctuation', () => {
  for (const [suffix, url] of [['.', 'a'], ['?!', 'a'], ['', 'a'], ['..b.', 'a..b']]) {
    const text = 'http://a' + suffix;
    assert.equal(renderMessageText({text, attachments: [{from_url: 'http://' + url, text: 'PREVIEW'}]}), text);
  }
});
