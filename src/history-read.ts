/**
 * fetch_history's and fetch_thread's reads: bounded, filtered, and saying
 * whether they covered their range, with a cursor to continue. Each page is a
 * request through the adapter's client, so it keeps the call's time and wait
 * budget like every other request. Backscroll keeps the adapter's own pager.
 */
import { createHash } from 'node:crypto';
import { formatSlackText, type SlackHistoryMessage } from './content.js';
import { isNearMiss } from './near-miss.js';
import type { HistoryMessage } from './slack-adapter.js';

type Kind = 'history' | 'thread';
export type StopReason =
  | 'exhausted' | 'match_limit' | 'scan_limit' | 'byte_limit' | 'time_limit' | 'rate_limited' | 'pagination_stalled';

export const READ_LIMITS = {
  limit: { minimum: 1, maximum: 1000 },
  maxScanned: { minimum: 1, maximum: 10000, default: 1000 },
  maxBytes: { minimum: 2048, maximum: 1048576, default: 65536 },
} as const;

/** The most messages this server asks for in one page of either method,
 *  the most Slack recommends. Slack may give fewer, such as at most 15 to an
 *  app distributed commercially outside the Slack Marketplace and installed
 *  since May 29, 2025, and a read follows has_more either way. */
const PAGE_SIZE = 200;

/** The arguments each read tool takes, as its schema in tools.ts lists them. */
export const READ_ARGUMENTS = {
  history: ['channelId', 'limit', 'oldest', 'latest', 'cursor', 'maxScanned', 'maxBytes', 'textContains', 'caseSensitive', 'authorIds'],
  thread: ['channelId', 'threadTs', 'limit', 'oldest', 'latest', 'cursor', 'maxScanned', 'maxBytes'],
} as const;

/** How every failure of a read opens, once the read runs. A read can fail
 *  after its first pages, so it says what the caller didn't get. */
export const NOTHING_RETURNED = 'No messages were returned';
/** One of the read's own failures, which opens as all of them do. */
const refused = (text: string) => new Error(`${NOTHING_RETURNED}: ${text}`);
/** What a Slack timestamp looks like, for a refusal of one. */
export const TS_FORM = 'which looks like 1718000000.000100';
/** Where a thread's parent id comes from, for fetch_thread's description and
 *  a refusal of an argument that names one: fetch_thread's threadTs, and
 *  reply_message's and upload_file's messageId. */
export const PARENT_IDS =
  "Pass the thread's parent id: a reply's thread=, a message's own id= when it shows no thread=, or a message's rootTs in " +
  'fetch_history or fetch_thread results';
/** What an answer this server can't read means for calling again. */
const UNREADABLE = "Calling again may work; if it fails the same way, this server can't read Slack's answer for this range.";

/** A Slack timestamp, a message's ts. */
export const SLACK_TS = /^\d{1,16}(?:\.\d{1,6})?$/;
const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && SLACK_TS.test(value) && Number.isFinite(new Date(Number(value) * 1000).getTime());
/** The value a refusal names: a string as JSON quotes it, so a stray space
 *  shows, or what else it is. */
function passed(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
/** A timestamp argument, refused with what was passed and where a right one
 *  comes from. */
function timestamp(value: unknown, name: string, source: string): string {
  if (!isTimestamp(value)) {
    throw refused(`${name} must be a Slack timestamp, ${TS_FORM}, and this call passed ${passed(value)}. ${source}`);
  }
  return value;
}
/** A message's ts, as Slack gave it: a read can't place a message without
 *  one, or an entry that isn't a message at all. */
function messageTs(m: SlackHistoryMessage | null | undefined): string {
  const ts = m?.ts;
  if (!isTimestamp(ts)) throw refused(`Slack gave a message without a valid timestamp, so this read can't place it. ${UNREADABLE}`);
  return ts;
}
function compareTs(a: string, b: string): number {
  const micros = (s: string) => {
    const [seconds, fraction = ''] = s.split('.');
    return BigInt(seconds!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  };
  const x = micros(a), y = micros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** An author's id: a user's (U or W) or a bot's (B), as a record's authorId
 *  and authorBotId give them. */
export const AUTHOR_ID = /^[UWB][A-Z0-9]+$/;

/** The names a filter matches mentions by: each user's own ID. A filter
 *  matches a message's text formatted as its content is, except that a
 *  mentioned user reads @U… (uid:U…), with or without a label Slack sent, so a
 *  match never depends on a lookup or on what the name cache holds. */
const BY_ID = new (class extends Map<string, string> {
  override get(id: string): string {
    return id;
  }
})();

/** Refuses an argument this read tool doesn't take, naming any it looks like
 *  a slip for, so a misspelled filter can't read as no filter. The server
 *  checks this before the arguments it requires, so a slip for one of those
 *  is named as one. */
export function refuseUnknownArguments(args: Record<string, unknown>, kind: Kind): void {
  const takes: readonly string[] = READ_ARGUMENTS[kind];
  const unknown = Object.keys(args).filter((key) => !takes.includes(key));
  if (unknown.length) {
    const named = unknown.map((key) => {
      const meant = takes.filter((name) => isNearMiss(key, name));
      return meant.length ? `${key} (did you mean ${meant.join(' or ')}?)` : key;
    });
    throw refused(
      `${kind === 'history' ? 'fetch_history' : 'fetch_thread'} takes no argument${unknown.length === 1 ? '' : 's'} named ` +
        `${named.join(', ')}. It takes ${takes.join(', ')}.`,
    );
  }
}

/** A read's arguments, checked before Slack is asked. */
export type ReadOptions = ReturnType<typeof readOptions>;
export function readOptions(args: Record<string, unknown>, kind: Kind, channelId: string, threadTs?: string) {
  refuseUnknownArguments(args, kind);
  if (!/^[CGD][A-Z0-9]+$/.test(channelId)) {
    throw refused(
      `channelId must be a Slack conversation id, such as C0123456789, and this call passed ${passed(channelId)}. ` +
        "list_channels shows each conversation's id.",
    );
  }
  if (kind === 'thread') timestamp(threadTs, 'threadTs', `${PARENT_IDS}.`);
  const limits = {} as Record<keyof typeof READ_LIMITS, number>;
  for (const [name, bounds] of Object.entries(READ_LIMITS)) {
    const value = args[name] === undefined
      ? (name === 'limit' ? (kind === 'history' ? 50 : 100) : ('default' in bounds ? bounds.default : undefined))
      : args[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.minimum || value > bounds.maximum) {
      throw refused(`${name} must be an integer from ${bounds.minimum} to ${bounds.maximum}.`);
    }
    limits[name as keyof typeof READ_LIMITS] = value;
  }
  const bound = "Take one from fetch_history's ids, or from a message's id=.";
  const oldest = args.oldest === undefined ? undefined : timestamp(args.oldest, 'oldest', bound);
  const latest = args.latest === undefined ? undefined : timestamp(args.latest, 'latest', bound);
  if (oldest && latest && compareTs(oldest, latest) >= 0) throw refused('oldest must precede latest.');
  // Characters as the schema's maxLength counts them: code points.
  if (args.textContains !== undefined &&
    (typeof args.textContains !== 'string' || [...args.textContains].length < 1 || [...args.textContains].length > 256)) {
    throw refused('textContains must contain 1 to 256 characters.');
  }
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') throw refused('caseSensitive must be a boolean.');
  if (args.authorIds !== undefined) {
    const ids = args.authorIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) {
      throw refused(
        "authorIds must contain 1 to 50 Slack user or bot IDs, as a message's authorId or authorBotId gives them, or find_user's " +
          'userId.',
      );
    }
    // The first malformed entry, by its place, so a call that passes many can
    // tell which to fix.
    const bad = ids.findIndex((id) => typeof id !== 'string' || !AUTHOR_ID.test(id));
    if (bad >= 0) {
      throw refused(
        `authorIds[${bad}] must be a Slack user or bot ID, as a message's authorId or authorBotId gives it, or find_user's ` +
          `userId, and this call passed ${passed(ids[bad])}.`,
      );
    }
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
    throw refused("cursor isn't a nextCursor this server gave. Pass it exactly as pagination.nextCursor gave it.");
  }
  if (decoded.q !== queryHash) {
    throw refused(
      'cursor belongs to another query. Pass it with the same channel, thread, oldest, latest and filters as the call ' +
        'that gave it.',
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
 * reach their limit, or the range is covered. A call either covers its range,
 * moves past where it started, or fails, saying why: a page the call's time has no room for, a
 * rate limit longer than the call can wait, a message too big for maxBytes
 * beside the ones before it, or a page that says more remain but holds
 * nothing new, stops the read with what it has and a cursor once it has
 * moved, and fails the call before that.
 */
export async function readBounded(opts: ReadOptions, source: ReadSource): Promise<HistoryReadResult> {
  const { kind } = opts;
  const filtering = opts.textContains !== undefined || opts.authorIds.length > 0;
  const fold = (text: string) => (opts.caseSensitive ? text : text.toLowerCase());
  const needle = opts.textContains === undefined ? undefined : fold(opts.textContains);
  // History pages back from `latest`, Slack's own now unless given, except
  // that given `oldest` alone the adapter's first page names the host's now
  // plus a minute; a thread pages forward from `oldest`, its start unless
  // given.
  let at = opts.at ?? (kind === 'history' ? opts.latest : opts.oldest);
  const records: ReadRecord[] = [];
  let scanned = 0, matched = 0, pages = 0;
  let stopReason: StopReason = 'exhausted', complete = false, retryAfterSeconds: number | undefined;
  let held: { ts: string; bytes: number } | undefined;
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
      stopReason: 'pagination_stalled', nextCursor: encodeCursor(opts.queryHash, '9999999999999999.999999'),
      retryAfterSeconds: Number.MAX_SAFE_INTEGER,
    },
  }));
  let recordBytes = 0;
  try {
    pages: while (true) {
      if (scanned >= opts.maxScanned) { stopReason = 'scan_limit'; break; }
      if (records.length >= opts.limit) { stopReason = 'match_limit'; break; }
      // A filtered read scans as far as it may; an unfiltered one asks for
      // the matches it still needs. Past a thread's start, Slack may give the
      // parent again within the page's size, so such a page asks for one
      // more, up to Slack's page size.
      const wanted = Math.min(opts.maxScanned - scanned, filtering ? PAGE_SIZE : opts.limit - records.length);
      const size = Math.min(PAGE_SIZE, wanted + (kind === 'thread' && at !== undefined ? 1 : 0));
      const page = await source.page(at, size);
      pages++;
      if (!Array.isArray(page.messages)) throw refused(`Slack's answer for a page of messages held no list of them. ${UNREADABLE}`);
      // The page's messages in reading order, each strictly past the one
      // before it, starting from the position: one Slack gives again, such as
      // a thread's parent, or twice in one page, is taken once and never
      // moves the position back, whatever order the page came in.
      const beyond = (ts: string, from: string | undefined) =>
        from === undefined || (kind === 'history' ? compareTs(ts, from) < 0 : compareTs(ts, from) > 0);
      const rows: { m: SlackHistoryMessage; ts: string }[] = [];
      for (const row of (page.messages as SlackHistoryMessage[])
        .map((m) => ({ m, ts: messageTs(m) }))
        .sort((a, b) => (kind === 'history' ? compareTs(b.ts, a.ts) : compareTs(a.ts, b.ts)))) {
        if (beyond(row.ts, rows.at(-1)?.ts ?? at)) rows.push(row);
      }
      const isMatch = (m: SlackHistoryMessage) =>
        (needle === undefined || fold(formatSlackText(m.text ?? '', BY_ID)).includes(needle)) &&
        (!opts.authorIds.length || [m.user, m.bot_id].some((id) => id !== undefined && opts.authorIds.includes(id)));
      // Only the matches the limit can still take are shaped, so names are
      // looked up for them, not for every message scanned. Some may then not
      // fit maxBytes; their names stay cached for the call that continues.
      const matches = rows.filter(({ m }) => isMatch(m)).slice(0, opts.limit - records.length).map(({ m }) => m);
      const shaped = new Map((await source.shape(matches)).map((m, i) => [matches[i]!, m]));
      for (const [i, { m, ts }] of rows.entries()) {
        if (scanned >= opts.maxScanned) { stopReason = 'scan_limit'; break pages; }
        const record = shaped.get(m);
        if (record) {
          const returned = historyRecord(record);
          const bytes = Buffer.byteLength(JSON.stringify(returned));
          if (skeleton + recordBytes + records.length + bytes > opts.maxBytes) {
            // Held back whole, and neither scanned nor matched here: the
            // next read starts at it.
            stopReason = 'byte_limit';
            held = { ts, bytes };
            break pages;
          }
          matched++;
          records.push(returned);
          recordBytes += bytes;
        }
        scanned++;
        at = ts;
        if (records.length >= opts.limit && i < rows.length - 1) { stopReason = 'match_limit'; break pages; }
      }
      if (page.has_more !== true) { complete = true; break; }
      if (rows.length === 0) { stopReason = 'pagination_stalled'; break; }
    }
  } catch (err) {
    // A call that hasn't moved fails, as any call does.
    const stop = scanned === 0 ? undefined : source.stopped(err);
    if (!stop) throw err;
    stopReason = stop.reason;
    if (stop.reason === 'rate_limited') retryAfterSeconds = stop.retryAfter;
  }
  if (complete) return result();
  if (scanned === 0 || at === undefined) throw new Error(stoppedAtStart(opts, stopReason, held, skeleton));
  return result(encodeCursor(opts.queryHash, at));
}

/** Why a read that didn't move past its start returns nothing, and how to go
 *  on: a message too big for maxBytes, or a page that held nothing new. */
function stoppedAtStart(opts: ReadOptions, stopReason: StopReason, held: { ts: string; bytes: number } | undefined, skeleton: number): string {
  const n = (value: number) => value.toLocaleString('en-US');
  if (stopReason === 'byte_limit' && held) {
    const past = `call again with the same arguments, but without cursor and with ${opts.kind === 'history' ? 'latest' : 'oldest'} ` +
      `set to ${held.ts}`;
    const needed = skeleton + held.bytes;
    const most = READ_LIMITS.maxBytes.maximum;
    return `${NOTHING_RETURNED}: the next message, ${held.ts}, takes ${n(held.bytes)} bytes in this tool's result, ` +
      `which with up to ${n(skeleton)} bytes of the result's own fields is more than maxBytes, ${n(opts.maxBytes)}. ` +
      (needed <= most
        ? `To read it, call again with maxBytes of at least ${n(needed)}; to read past it, ${past}.`
        : `maxBytes goes up to ${n(most)}, so this tool can't return it whole; to read past it, ${past}.`);
  }
  return `${NOTHING_RETURNED}: Slack's page held no message past where this read started, though it said more ` +
    "remain. Calling again may get them; if it stops the same way, Slack's answers don't take this read past its start.";
}
