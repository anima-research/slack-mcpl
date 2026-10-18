/**
 * fetch_history's and fetch_thread's reads: bounded, filtered, and saying
 * whether they covered their range, with a cursor to continue. Each page is a
 * request through the adapter's client, so it keeps the call's time and wait
 * budget like every other request. Backscroll keeps the adapter's own pager.
 */
import { createHash } from 'node:crypto';
import type { SlackHistoryMessage } from './content.js';
import type { HistoryMessage } from './slack-adapter.js';

type Kind = 'history' | 'thread';
export type StopReason =
  | 'exhausted' | 'match_limit' | 'scan_limit' | 'byte_limit' | 'time_limit' | 'rate_limited' | 'pagination_stalled';

export const READ_LIMITS = {
  limit: { minimum: 1, maximum: 1000 },
  maxScanned: { minimum: 1, maximum: 10000, default: 1000 },
  maxBytes: { minimum: 2048, maximum: 1048576, default: 65536 },
} as const;

/** The most messages Slack returns in one page of either method. */
const PAGE_SIZE = 200;

/** A Slack timestamp, a message's ts. */
export const SLACK_TS = /^\d{1,16}(?:\.\d{1,6})?$/;
function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SLACK_TS.test(value) || !Number.isFinite(new Date(Number(value) * 1000).getTime())) {
    throw new Error(`${name} must be a Slack timestamp`);
  }
  return value;
}
function compareTs(a: string, b: string): number {
  const micros = (s: string) => {
    const [seconds, fraction = ''] = s.split('.');
    return BigInt(seconds!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  };
  const x = micros(a), y = micros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A read's arguments, checked before Slack is asked: an argument this tool
 *  doesn't take is refused, so a misspelled filter can't read as no filter. */
export type ReadOptions = ReturnType<typeof readOptions>;
export function readOptions(args: Record<string, unknown>, kind: Kind, channelId: string, threadTs?: string) {
  const allowed = new Set(['channelId', 'limit', 'oldest', 'latest', 'cursor', ...Object.keys(READ_LIMITS),
    ...(kind === 'history' ? ['textContains', 'caseSensitive', 'authorIds'] : ['threadTs'])]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  if (!/^[CGD][A-Z0-9]+$/.test(channelId)) throw new Error('channelId must be a Slack conversation ID');
  if (kind === 'thread') timestamp(threadTs, 'threadTs');
  const limits = {} as Record<keyof typeof READ_LIMITS, number>;
  for (const [name, bounds] of Object.entries(READ_LIMITS)) {
    const value = args[name] === undefined
      ? (name === 'limit' ? (kind === 'history' ? 50 : 100) : ('default' in bounds ? bounds.default : undefined))
      : args[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.minimum || value > bounds.maximum) {
      throw new Error(`${name} must be an integer from ${bounds.minimum} to ${bounds.maximum}`);
    }
    limits[name as keyof typeof READ_LIMITS] = value;
  }
  const oldest = args.oldest === undefined ? undefined : timestamp(args.oldest, 'oldest');
  const latest = args.latest === undefined ? undefined : timestamp(args.latest, 'latest');
  if (oldest && latest && compareTs(oldest, latest) >= 0) throw new Error('oldest must precede latest');
  if (args.textContains !== undefined &&
    (typeof args.textContains !== 'string' || args.textContains.length < 1 || args.textContains.length > 256)) {
    throw new Error('textContains must contain 1 to 256 characters');
  }
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') throw new Error('caseSensitive must be a boolean');
  if (args.authorIds !== undefined && (!Array.isArray(args.authorIds) || args.authorIds.length < 1 || args.authorIds.length > 50 ||
    !args.authorIds.every((id) => typeof id === 'string' && /^[UW][A-Z0-9]+$/.test(id)))) {
    throw new Error('authorIds must contain 1 to 50 Slack user IDs');
  }
  const query = {
    kind, channelId, threadTs, oldest, latest,
    textContains: args.textContains as string | undefined,
    caseSensitive: args.caseSensitive === true,
    authorIds: [...new Set((args.authorIds ?? []) as string[])].sort(),
  };
  const queryHash = createHash('sha256').update(JSON.stringify(query)).digest('hex').slice(0, 32);
  const at = args.cursor === undefined ? undefined : cursorPosition(args.cursor, queryHash);
  return { ...limits, ...query, queryHash, at };
}

/** A cursor carries the position the next page starts from, history's
 *  `latest` or a thread's `oldest`, and the hash of the query it belongs to,
 *  so this server keeps no state for it. */
function encodeCursor(queryHash: string, at: string): string {
  return Buffer.from(JSON.stringify({ q: queryHash, at })).toString('base64url');
}
function cursorPosition(cursor: unknown, queryHash: string): string {
  let decoded: { q?: unknown; at?: unknown } | undefined;
  try {
    decoded = typeof cursor === 'string' && cursor.length <= 256 ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : undefined;
  } catch {
    decoded = undefined;
  }
  if (!decoded || typeof decoded.at !== 'string' || !SLACK_TS.test(decoded.at) || typeof decoded.q !== 'string') {
    throw new Error('cursor is not a nextCursor this server gave: pass it exactly as pagination.nextCursor gave it');
  }
  if (decoded.q !== queryHash) {
    throw new Error(
      "cursor belongs to another query: pass it with the same channel, thread, oldest, latest and filters as the " +
        'call that gave it',
    );
  }
  return decoded.at;
}

/** A message as the read tools return it. */
export function historyRecord(m: HistoryMessage) {
  return {
    id: m.id,
    ...(m.authorId ? { authorId: m.authorId } : {}),
    ...(m.authorBotId ? { authorBotId: m.authorBotId } : {}),
    author: m.authorName,
    timestamp: m.timestamp.toISOString(),
    content: m.content,
    ...(m.threadTs ? { threadTs: m.threadTs } : {}),
    rootTs: m.rootTs,
    ...(m.replyCount !== undefined ? { replyCount: m.replyCount } : {}),
    ...(m.attachments.length > 0
      ? {
          attachments: m.attachments.map((a) =>
            `${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}${a.url ? ` — fetchable via fetch_attachment: ${a.url}` : ''}`,
          ),
        }
      : {}),
  };
}

type ReadRecord = ReturnType<typeof historyRecord>;
export interface HistoryReadResult {
  messages: ReadRecord[];
  channel: { id: string; writable: boolean };
  pagination: {
    scanned: number; matched: number; returned: number; pages: number; scanComplete: boolean; stopReason: StopReason;
    threadRepliesSearched: boolean; scope: 'channel_messages' | 'single_thread'; nextCursor?: string; retryAfterSeconds?: number;
  };
}

/** Why a page's failure stops a read with what it has: the call's time had
 *  no room for the page, or Slack rate-limited it for longer than the call
 *  could wait, with Slack's seconds when it gave them. */
export type ReadStop = { reason: 'time_limit' } | { reason: 'rate_limited'; retryAfter?: number };

/** What a read needs from the adapter: a page of Slack's answer starting
 *  after `at` (history's `latest`, a thread's `oldest`, both exclusive), the
 *  shaping of the messages it returns, whether this bot may write here, and
 *  which of a page's failures stop the read rather than fail it. */
export interface ReadSource {
  page(at: string | undefined, limit: number): Promise<{ messages?: unknown; has_more?: unknown }>;
  shape(messages: SlackHistoryMessage[]): Promise<HistoryMessage[]>;
  writable: boolean;
  stopped(err: unknown): ReadStop | undefined;
}

/**
 * Reads pages until the matches, the messages scanned or the result's bytes
 * reach their limit, or the range is covered. A page the call's time has no
 * room for, or a rate limit longer than the call can wait, stops the read
 * with what it has and a cursor, once something has been scanned; before
 * that, the call fails with Slack's or the time's error, as any call does.
 */
export async function readBounded(opts: ReadOptions, source: ReadSource): Promise<HistoryReadResult> {
  const { kind } = opts;
  const filtering = opts.textContains !== undefined || opts.authorIds.length > 0;
  const needle = opts.textContains === undefined ? undefined : opts.caseSensitive ? opts.textContains : opts.textContains.toLowerCase();
  // History pages back from `latest`, now unless given, fixed at the read's
  // start; a thread pages forward from `oldest`, its start unless given.
  let at = opts.at ?? (kind === 'history' ? opts.latest ?? (Date.now() / 1000).toFixed(6) : opts.oldest);
  const records: ReadRecord[] = [];
  let scanned = 0, matched = 0, pages = 0;
  let stopReason: StopReason = 'exhausted', complete = false, retryAfterSeconds: number | undefined;
  const result = (nextCursor?: string): HistoryReadResult => ({
    messages: kind === 'history' ? [...records].reverse() : records,
    channel: { id: opts.channelId, writable: source.writable },
    pagination: {
      scanned, matched, returned: records.length, pages, scanComplete: complete, stopReason,
      threadRepliesSearched: kind === 'thread', scope: kind === 'history' ? 'channel_messages' : 'single_thread',
      ...(nextCursor ? { nextCursor } : {}), ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  });
  // The result's bytes without its records, at the longest cursor, stop
  // reason and counts it can end with, so a record that fits beside the
  // records before it leaves the finished result within maxBytes. Each record
  // adds its own bytes and a comma.
  const skeleton = Buffer.byteLength(JSON.stringify({
    ...result(encodeCursor(opts.queryHash, '9999999999999999.999999')),
    messages: [],
    pagination: {
      ...result().pagination, scanned: opts.maxScanned, matched: opts.limit, returned: opts.limit, pages: opts.maxScanned,
      stopReason: 'pagination_stalled', nextCursor: encodeCursor(opts.queryHash, '9999999999999999.999999'), retryAfterSeconds: 99999,
    },
  }));
  let recordBytes = 0;
  try {
    pages: while (true) {
      if (scanned >= opts.maxScanned) { stopReason = 'scan_limit'; break; }
      if (records.length >= opts.limit) { stopReason = 'match_limit'; break; }
      // A filtered read scans as far as it may; an unfiltered one asks for
      // the matches it still needs.
      const size = Math.min(PAGE_SIZE, opts.maxScanned - scanned, filtering ? PAGE_SIZE : opts.limit - records.length);
      const page = await source.page(at, size);
      pages++;
      if (!Array.isArray(page.messages)) throw new Error('Slack returned invalid history messages');
      // Only a message past the position counts, so one Slack returns again,
      // such as a thread's parent, is neither returned twice nor moves the
      // position back.
      const from = at;
      const rows = (page.messages as SlackHistoryMessage[]).filter((m) => {
        const ts = timestamp(m.ts, 'Slack message ts');
        return from === undefined || (kind === 'history' ? compareTs(ts, from) < 0 : compareTs(ts, from) > 0);
      });
      const isMatch = (m: SlackHistoryMessage) => {
        const text = opts.caseSensitive ? m.text ?? '' : (m.text ?? '').toLowerCase();
        return (needle === undefined || text.includes(needle)) &&
          (!opts.authorIds.length || (m.user !== undefined && opts.authorIds.includes(m.user)));
      };
      // Only the matches the read can still return are shaped, so names are
      // looked up for them alone.
      const wanted = rows.filter(isMatch).slice(0, opts.limit - records.length);
      const shaped = new Map((await source.shape(wanted)).map((m, i) => [wanted[i]!, m]));
      for (const row of rows) {
        const record = shaped.get(row);
        scanned++;
        if (record) {
          matched++;
          const returned = historyRecord(record);
          const bytes = Buffer.byteLength(JSON.stringify(returned));
          if (skeleton + recordBytes + records.length + bytes > opts.maxBytes) {
            // Held back whole, so the next read starts at it; it counts as
            // scanned and matched, and isn't returned.
            stopReason = 'byte_limit';
            break pages;
          }
          records.push(returned);
          recordBytes += bytes;
        }
        at = row.ts!;
        if (records.length >= opts.limit && row !== rows.at(-1)) { stopReason = 'match_limit'; break pages; }
      }
      if (page.has_more !== true) { complete = true; break; }
      if (rows.length === 0) { stopReason = 'pagination_stalled'; break; }
    }
  } catch (err) {
    // With nothing scanned yet, the call fails, as any call does.
    const stop = scanned === 0 ? undefined : source.stopped(err);
    if (!stop) throw err;
    stopReason = stop.reason;
    if (stop.reason === 'rate_limited') retryAfterSeconds = stop.retryAfter;
  }
  return result(complete || at === undefined ? undefined : encodeCursor(opts.queryHash, at));
}
