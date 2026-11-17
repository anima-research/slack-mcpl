import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
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
test('blocks-only rendering retains following content within the minimum traversal allowance', () => {
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
  ] }] }), '    4. item\n&gt; quote\n```code```');
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
  const accesses: boolean[] = [];
  const adapter = new SlackAdapter({users: {info: async () => ({user: {name: 'Alice'}})}} as any, {on(_: string, h: any){handler = h;}} as any, 'UBOT', 'example');
  const delivered = new Promise<any>(resolve => adapter.onMessage(resolve));
  handler({ack: async () => {acked = true;}, event: {type: 'message', channel: 'C1', user: 'U1', ts: '100.000001', text: 'hello', get blocks(){accesses.push(acked); return [section('body')];}}});
  assert.equal((await delivered).cleanContent, 'hello\nbody');
  assert.ok(accesses.length > 0);
  assert.ok(accesses.every(Boolean), 'render before ack');
});
test('supplemental IDs use cached names or raw IDs across all delivery paths', async () => {
  for (const path of ['live', 'history', 'backscroll']) {
    const calls: string[] = []; let handler: any;
    const row = { user: 'UAUTH', ts: '100.000001', text: '<@UORIG|original>', blocks: [section(Array.from({length: 30}, (_, i) => `<@U${i}|label>`).join(' '))] };
    const adapter = new SlackAdapter({users: {info: async ({user}: any) => { calls.push(user); if (user === 'UORIG') throw new Error('temporary lookup failure'); return {user: {name: 'resolved'}};}}, conversations: {history: async () => ({messages: [row]})}} as any, {on(_: string, h: any){handler = h;}} as any, 'UBOT', 'example');
    (adapter as any).userNameCache.set('U20', 'CachedName');
    const delivered = new Promise<any>(resolve => adapter.onMessage(resolve));
    let output: string;
    if (path === 'live') { handler({event: {...row, type: 'message', channel: 'C1'}, ack: async () => {}}); output = (await delivered).cleanContent; }
    else output = (path === 'history' ? await adapter.readHistory('C1', {}) : await adapter.fetchHistory('C1')).messages[0].content;
    assert.equal(calls.length, 2, calls.join(','));
    assert.match(output, /@U0 \(uid:U0\)/);
    assert.ok(calls.includes('UORIG'));
    assert.match(output, /@CachedName \(uid:U20\)/);
    assert.match(output, /@original \(uid:UORIG\)/, 'original fallback labels survive transient lookup failures');
  }
});
test('backscroll supplemental lines capped at 2000; total block <=32KiB with explicit older summary', async () => {
  const adapter = new SlackAdapter({conversations: {history: async () => ({messages: [{text: 'Original', blocks: [section('x'.repeat(8000))], ts: '100.000001'}]})}} as any, {on(){}} as any, 'UBOT', 'example');
  const m = (await adapter.fetchHistory('C1')).messages[0];
  assert.ok(m.content.length <= 'Original'.length + 2000);
  assert.match(m.content, /\[…truncated\]/);
  const huge = Array.from({length: 50}, (_, i) => ({...m, id: `${i}`, content: '😀'.repeat(2000)}));
  const block = backscrollBlock(huge, {isDM: false}, true);
  assert.ok(Buffer.byteLength(block) <= 32_768);
  const count = Number(block.match(/count="(\d+)"/)![1]);
  assert.ok(count > 0 && count < 50);
  assert.match(block, /older backscroll messages not shown; try fetch_history latest=/);
  assert.match(block, /message omitted \(\d+ bytes\).*; try fetch_history/);
  assert.match(block, /id=49\]/);
  assert.doesNotMatch(block, /id=0\]/);
});

for (const unit of ['<@U1|', '<https://x/']) test(`unclosed angle candidates remain literal at the text limit ${unit}`, () => {
  const text = unit.repeat(Math.floor(40000 / unit.length));
  assert.equal(renderMessageText({text, blocks: [section('extra')]}), text + '\nextra');
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

test('URL punctuation matcher completes in an interruptible worker', async () => {
  const worker = new Worker(new URL('./fixtures/url-punctuation-worker.mjs', import.meta.url));
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      worker.once('error', fail);
      worker.once('exit', code => fail(new Error(`matcher worker exited early: ${code}`)));
      worker.on('message', message => {
        if (message === 'ready') {
          // Exclude TS loader startup. This is a hard interruption, not a
          // same-thread timing assertion: the restored /[.,;:!?]+$/ matcher
          // attempts ~500 billion comparisons on this bounded input.
          clearTimeout(timer);
          timer = setTimeout(() => fail(new Error('URL matcher exceeded hard worker deadline')), 10_000);
          worker.postMessage(1_000_000);
        } else {
          clearTimeout(timer);
          if (message === 'done') resolve();
          else fail(new Error(String(message)));
        }
      });
      timer = setTimeout(() => fail(new Error('matcher worker failed to start')), 60_000);
    });
  } finally { await worker.terminate(); }
});

test('bare URL trailing punctuation trimming preserves interior punctuation', () => {
  for (const [suffix, url] of [['.', 'a'], ['?!', 'a'], ['', 'a'], ['..b.', 'a..b']]) {
    const text = 'http://a' + suffix;
    assert.equal(renderMessageText({text, attachments: [{from_url: 'http://' + url, text: 'PREVIEW'}]}), text);
  }
});

test('large bot rich-text mirrors fit traversal before comparison (R4-1)', () => {
  for (const size of [290, 400]) {
    const lines = Array.from({ length: size }, (_, n) => `- \`cmd${n}\` does *thing${n}* see <https://ex.com/${n}|doc${n}>`);
    const text = lines.join('\n');
    const blocks = [{ type: 'rich_text', elements: [{ type: 'rich_text_list', style: 'bullet', elements:
      lines.map((_, n) => ({ type: 'rich_text_section', elements: [
        { type: 'text', text: `cmd${n}`, style: { code: true } },
        { type: 'text', text: ' does ' },
        { type: 'text', text: `thing${n}`, style: { bold: true } },
        { type: 'text', text: ' see ' },
        { type: 'link', url: `https://ex.com/${n}`, text: `doc${n}` },
      ] })),
    }] }];
    for (const budget of [2000, 16384]) assert.equal(renderMessageText({ text, bot_id: 'B1', blocks }, budget), text);
  }
});

test('attributed content differs from original but identical displayed headers deduplicate', () => {
  const name = 'x'.repeat(100);
  const rendered = renderMessageText({ text: 'same', attachments: [
    { author_name: name + 'A', text: 'same' },
    { author_name: name + 'B', text: 'same' },
  ] });
  assert.equal(rendered.split('same').length - 1, 2);
});

test('backscroll channel framing cannot exceed the byte budget', () => {
  const rendered = backscrollBlock([], { channelName: '🙂'.repeat(40_000), isDM: false });
  assert.ok(Buffer.byteLength(rendered) <= 32768);
});

test('backscroll keeps an exactly fitting complete window without summary reservation', () => {
  const msg = { id: '1.0', authorName: 'A', timestamp: new Date(0), content: '', attachments: [] };
  for (const older of [[], [{ ...msg, id: '0.0', content: 'short' }]]) {
    const base = backscrollBlock([...older, msg], { isDM: false });
    const content = 'x'.repeat(32768 - Buffer.byteLength(base));
    const result = backscrollBlock([...older, { ...msg, content }], { isDM: false });
    assert.equal(Buffer.byteLength(result), 32768);
    assert.ok(result.includes(content));
    assert.doesNotMatch(result, /omitted|not shown/);
  }
});

test('one-character bot mirrors retain their container and attachment traversal allowance', () => {
  for (const size of [2000, 4000]) {
    const text = 'x'.repeat(size);
    const block = {type: 'rich_text', elements: [{type: 'rich_text_section',
      elements: Array.from({length: size}, () => ({type: 'text', text: 'x'}))}]};
    for (const cap of [2000, 16384]) {
      for (const attachments of [[], Array.from({length: 1900}, () => ({text: 'extra'}))]) {
        assert.equal(renderMessageText({text, bot_id: 'B1', attachments, blocks: [block, section('AFTER')]}, cap),
          text + (attachments.length ? '\nextra' : '') + '\nAFTER');
      }
    }
  }
});

test('malformed tokens cannot cross original or supplemental line boundaries', () => {
  assert.equal(clean({text: '<@U123|', attachments: [{text: 'important>'}]}), '<@U123|\nimportant>');
  assert.equal(clean({attachments: [{author_name: 'CI', text: '<https://example.com\nhello'}]}),
    '[attachment from CI]\n> <https://example.com\n> hello');
});

test('rich quotes prefix every logical line', () => {
  for (const separator of ['\r', '\r\n', '\u2028', '\u2029']) {
    assert.equal(clean({blocks: [{type: 'rich_text', elements: [{type: 'rich_text_quote',
      elements: [{type: 'text', text: 'quoted' + separator + 'also quoted'}]}]}]}),
      '> quoted\n> also quoted');
  }
});

test('mid-line bullet glyph after inline code remains distinct', () => {
  assert.equal(clean({text: '`x`- alert', attachments: [{text: '`x`• alert'}]}),
    '`x`- alert\n`x`• alert');
});

test('hidden attribution fields do not duplicate identical displayed attachments', () => {
  for (const is_share of [false, true]) {
    const a = {author_name: 'CI', channel_name: 'ops', text: 'Body', is_share};
    assert.equal(clean({attachments: [{...a, footer: 'one'}, {...a, footer: 'two'}]}),
      (is_share ? '[shared message from CI, #ops]' : '[attachment from CI]') + '\n> Body');
  }
});

test('filtered history never renders author-excluded or beyond-limit rows', async () => {
  let accesses = 0;
  const unread = (ts: string, user: string) => ({ts, user, text: 'target',
    get blocks() { accesses++; return [section('expensive')]; }});
  const adapter = new SlackAdapter({conversations: {history: async () => ({messages: [
    unread('103.0', 'U2'), {ts: '102.0', user: 'U1', text: 'target'}, unread('101.0', 'U1'),
  ]})}} as any, {on(){}} as any, 'UBOT', 'example');
  const result = await adapter.readHistory('C1', {authorIds: ['U1'], textContains: 'target', limit: 1});
  assert.equal(result.messages.length, 1);
  assert.equal(accesses, 0);
});

test('nested omission labels do not preempt later readable attachment blocks', () => {
  const blocks = Array.from({length: 100}, (_, i) => ({type: 'unsupported' + i + 'x'.repeat(200)}));
  const result = renderMessageText({attachments: [{blocks: [...blocks, section('USEFUL')]}]});
  assert.match(result, /^USEFUL\n/);
  assert.ok(result.length <= 16384);
});

test('duplicate rich channel labels do not spend the traversal budget', () => {
  const text = '<#C1|' + 'label'.repeat(1000) + '>';
  const mirror = {type: 'rich_text', elements: [{type: 'rich_text_section', elements: [{type: 'channel', channel_id: 'C1'}]}]};
  assert.equal(renderMessageText({text, bot_id: 'B1', blocks: Array(20).fill(mirror)}), text);
  const distinct = {type: 'rich_text', elements: [{type: 'rich_text_section', elements: [{type: 'text', text: 'extra '}, {type: 'channel', channel_id: 'C1'}]}]};
  assert.equal(renderMessageText({text, bot_id: 'B1', blocks: [distinct]}), text + '\nextra ' + text);
});

test('duplicate deferred omission labels do not falsely truncate', () => {
  const blocks = Array.from({length: 18}, (_, i) => ({type: String(i).padStart(100, 'x')}));
  const message = {attachments: [{blocks: [...blocks, blocks[0]]}]};
  const expected = blocks.map(b => `[${b.type} omitted]`).join('\n');
  assert.equal(expected.length, 1997);
  assert.equal(renderMessageText(message, 2000), expected);
});

test('rich usergroups have readable ID and label fallbacks', () => {
  assert.equal(clean({blocks: [{type: 'rich_text', elements: [{type: 'usergroup', usergroup_id: 'S123'}]}]}), '@S123');
  assert.equal(formatSlackText('<!subteam^S123|@ops>', new Map()), '@ops');
});
