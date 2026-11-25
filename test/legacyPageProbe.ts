/** Shared probe, also run verbatim against the independent main export: with
 *  the access policy unset, every paged read (find_user's users.list,
 *  list_channels' conversations.list, backscroll and fetch_history's
 *  conversations.history) over the corpus below, which varies containers,
 *  rows and cursors one dimension at a time, not as a product: a malformed
 *  row behind a valid cursor, for one, is not in it. Each run ends within
 *  main's own termination and under every documented page and match limit,
 *  so a difference from main on these inputs is an unset behaviour change. */
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize } from './harness.js';

const containers: unknown[] = [undefined, null, 42, 0, {}, false, true, 'ab', [], [null], [42], ['x'], [[]], [{}]];
const cursors: unknown[] = [undefined, '', 'next', 0, null, false, {}, 7];
const directoryRows: unknown[] = [
  { id: 'U1', name: 'match' }, { id: 'U2', name: 'other' }, { name: 'match' }, { id: 'U3', name: 'match', deleted: true },
  { id: 'U4', name: 'match', is_bot: true }, { id: 'U5', real_name: 'MATCH' }, { id: 'U6', profile: { display_name: 'match' } },
  { id: 'U7', profile: null }, { id: 'U8', name: 42 }, { id: 'U9', profile: { display_name: 5 } }, { id: 0, name: 'match' },
];
const channelRows: unknown[] = [
  { id: 'C1', name: 'general', is_channel: true, is_member: true }, { id: 'C2', name: 'random', is_channel: true, is_member: false },
  { id: 'G1', name: 'secret', is_group: true, is_private: true, is_member: true }, { id: 'D1', is_im: true, user: 'U1' },
  { id: 'C3', is_member: true }, { name: 'noid', is_member: true }, { id: 42, is_member: true },
];
const historyRows: unknown[] = [
  { ts: '1.0', text: 'hi', user: 'U1' }, { ts: '9999999999999999', text: 'far' }, { ts: 'x', text: 'bad' }, { text: 'no ts' },
  { ts: '2.0', thread_ts: '1.0', reply_count: 1 }, { ts: 3 },
];

/** The corpus: each container alone, each row alone, then a second page
 *  behind each cursor, so a cursor's meaning is exercised. */
function corpus(rows: unknown[], key: string): Array<{ name: string; pages: unknown[] }> {
  const out: Array<{ name: string; pages: unknown[] }> = [];
  for (const c of containers) out.push({ name: `container ${JSON.stringify(c) ?? 'undefined'}`, pages: [{ ok: true, [key]: c }] });
  for (const r of rows) out.push({ name: `row ${JSON.stringify(r)}`, pages: [{ ok: true, [key]: [r] }] });
  for (const cur of cursors) {
    out.push({ name: `cursor ${JSON.stringify(cur) ?? 'undefined'}`, pages: [
      { ok: true, [key]: [rows[0]], response_metadata: { next_cursor: cur } }, { ok: true, [key]: [rows[1]] },
    ] });
  }
  out.push({ name: 'page null', pages: [null] });
  out.push({ name: 'metadata null', pages: [{ ok: true, [key]: [rows[0]], response_metadata: null }] });
  return out;
}

const settle = async (run: () => Promise<unknown>) => {
  try { return { value: await run() }; }
  catch (err) { return { error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err) }; }
};

export async function legacyPageProbe() {
  const report: Record<string, unknown> = {};
  let pages: unknown[] = [];
  let at = 0;
  const next = async () => {
    const page = at < pages.length ? pages[at] : { ok: true };
    at++;
    return page;
  };
  const web = {
    users: { list: next },
    conversations: {
      list: next,
      history: next,
      info: async () => ({ ok: true, channel: { id: 'C1', name: 'general', is_channel: true, is_member: true } }),
      replies: next,
    },
  };
  const adapter = new SlackAdapter(web as never, { on() {}, async start() {}, async disconnect() {} } as never, 'UBOT', 'test');
  const h = connectHost(new SlackMcplServer(adapter));
  try {
    await initialize(h, false);
    const call = (name: string, args: Record<string, unknown>) => h.host.sendRequest('tools/call', { name, arguments: args });
    const runs: Array<[string, unknown[], string, () => Promise<unknown>]> = [
      ['find_user', directoryRows, 'members', () => call('find_user', { query: 'match' })],
      ['list_channels', channelRows, 'channels', () => call('list_channels', {})],
      ['backscroll', historyRows, 'messages', () => adapter.fetchHistory('C1')],
      ['fetch_history', historyRows, 'messages', () => call('fetch_history', { channelId: 'C1' })],
    ];
    for (const [tool, rows, key, run] of runs) {
      for (const c of corpus(rows, key)) {
        pages = c.pages;
        at = 0;
        const result = await settle(run);
        report[`${tool}: ${c.name}`] = { ...result, requests: at };
      }
    }
  } finally { await h.close(); await adapter.stop(); }
  return report;
}
