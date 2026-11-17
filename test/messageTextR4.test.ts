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

const pre = (payload: string) => rich({type: 'rich_text_preformatted', elements: [text(payload)]});
const code = (payload: string) => rich(section(text(payload, {code: true})));
const entity = (type: string, key: string, value: string) => rich(section({type, [key]: value}));

// Adversarial table: every row runs the four production delivery conversions.
const distinct: Array<[string, string, unknown]> = [
  ['intraword emphasis', 'deploy_*prod*_now', plain('deploy_prod_now')],
  ['nested intraword emphasis', 'snake_~case~_name', plain('snake_case_name')],
  ['path emphasis', '/home/~cache~/logs', plain('/home/cache/logs')],
  ['combining marks', 'á_b_́c', plain('áb́c')],
  ['inline spaces', '`print("a  b")`', code('print("a b")')],
  ['inline tabs', '`a\tb`', code('a b')],
  ['inline trailing', '`x `', code('x')],
  ['inline leading', '` x`', code('x')],
  ['inline newline', '`a\nb`', code('a b')],
  ['fenced indentation', '```if x:\n  run()```', pre('if x:\nrun()')],
  ['fenced spaces', '```a  b```', pre('a b')],
  ['fenced tabs', '```\n\trun()\n```', pre(' run()')],
  ['fenced trailing', '```\nx  \n```', pre('x')],
  ['fenced leading', '```\n  x\n```', pre('x')],
  ['fenced unframed trailing newline', '```x\n```', pre('x')],
  ['fenced unframed leading newline', '```\nx```', pre('x')],
  ['code HTML bytes', '`&lt;@U2&gt;`', code('<@U2>')],
  ['fenced payload newline', '```\nx\n\n```', pre('x')],
  ['literal user vs entity', '&lt;@U2&gt;', entity('user', 'user_id', 'U2')],
  ['user vs literal', '<@U2>', plain('<@U2>')],
  ['literal channel vs entity', '&lt;#C1&gt;', entity('channel', 'channel_id', 'C1')],
  ['channel vs literal', '<#C1>', plain('<#C1>')],
  ['literal usergroup vs entity', '&lt;!subteam^S1&gt;', entity('usergroup', 'usergroup_id', 'S1')],
  ['usergroup vs literal', '<!subteam^S1>', plain('<!subteam^S1>')],
  ['literal broadcast vs entity', '&lt;!here&gt;', entity('broadcast', 'range', 'here')],
  ['broadcast vs literal', '<!here>', plain('@here')],
  ['broadcast vs angle literal', '<!here>', plain('<!here>')],
  ['link vs literal URL', '<https://ex.com>', plain('https://ex.com')],
  ['literal link vs entity', '&lt;https://ex.com|docs&gt;', link('docs')],
  ['labelled link vs literal', '<https://ex.com|docs>', plain('docs (https://ex.com)')],
  ['link label spaces', '<https://ex.com|a  b>', link('a b')],
  ['link label tabs', '<https://ex.com|a\tb>', link('a b')],
  ['link label vs bare', '<https://ex.com|https://ex.com>', link()],
  ['emoji vs literal', ':wave:', plain(':wave:')],
  ['code vs literal', '`x`', plain('x')],
  ['token boundary', '<@U2> <#C1>', rich(section({type: 'user', user_id: 'U2'}, {type: 'channel', channel_id: 'C1'}))],
];
for (const [name, original, block] of distinct) test(`R4 distinct ${name}: human block ignored on all four paths`, async () => {
  const expected = formatSlackText(original, new Map([['U2', 'alice']]));
  assert.deepEqual(await paths({text: original, blocks: [block]}), Array(4).fill(expected));
});

const mirrors: Array<[string, string, unknown]> = [
  ...['a  b', 'a\tb', 'x ', '  x', 'if x:\n  run()'].map((payload): [string, string, unknown] => ['inline exact ' + JSON.stringify(payload), '`' + payload + '`', code(payload)]),
  ...['a  b', '\tx', 'x  ', '  x', 'x\n'].map((payload): [string, string, unknown] => ['fenced exact ' + JSON.stringify(payload), '```\n' + payload + '\n```', pre(payload)]),
  ['split preformatted payload', '```\na  b\n```', rich({type: 'rich_text_preformatted', elements: [text('a '), text(' b')]})],
  ['split text normalization', ' a  b ', rich(section(text('a '), text(' b')))],
  ['prose around code', 'before  `a  b` \n after', rich(section(text('before '), text('a  b', {code: true}), text(' after')))],
  ['adjacent entity text', '<@U2> a  b <#C1|ops>', rich(section({type: 'user', user_id: 'U2'}, text(' a '), text(' b '), {type: 'channel', channel_id: 'C1'}))],
  ['broadcast', '<!here>', entity('broadcast', 'range', 'here')],
  ['skin tone', ':thumbsup::skin-tone-2:', rich(section({type: 'emoji', name: 'thumbsup', skin_tone: 2}))],
  ['literal user', '&lt;@U2&gt;', plain('<@U2>')],
  ['literal link', '&lt;https://ex.com|docs&gt;', plain('<https://ex.com|docs>')],
];
for (const [name, original, block] of mirrors) test(`R4 genuine mirror ${name}: skipped on all four paths`, async () => {
  assert.deepEqual(await paths({text: original, blocks: [block]}), Array(4).fill(formatSlackText(original, new Map([['U2', 'alice']]))));
});

test('R4 cross-block link/literal collision: human rich blocks both ignored', async () => {
  assert.deepEqual(await paths({text: 'summary', blocks: [
    rich(section({type: 'link', url: 'https://review.invalid/a', text: 'run'})),
    plain('run (https://review.invalid/a)'),
  ]}), Array(4).fill('summary'));
});
