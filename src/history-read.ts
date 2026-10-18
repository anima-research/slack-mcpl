/** Bounded tool reads. Internal backscroll keeps its existing contract. */
import {randomBytes, createHash} from 'node:crypto';
import {formatSlackText, type SlackHistoryMessage} from './content.js';

export type ReadMethod = 'conversations.info' | 'conversations.history' | 'conversations.replies';
export type SlackReadCall = (method: ReadMethod, args: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
type Kind = 'history' | 'thread';
type Position = {cursor?: string; oldest?: string; latest: string};
export type StopReason = 'exhausted' | 'match_limit' | 'scan_limit' | 'page_limit' | 'time_limit' | 'byte_limit' | 'rate_limited' | 'pagination_stalled';

export const READ_LIMITS = {
  limit: {minimum: 1, maximum: 1000},
  maxScanned: {minimum: 1, maximum: 10000, default: 1000},
  maxPages: {minimum: 1, maximum: 50, default: 10},
  maxMs: {minimum: 100, maximum: 30000, default: 10000},
  maxBytes: {minimum: 2048, maximum: 1048576, default: 65536},
} as const;

const TS = /^\d{1,16}(?:\.\d{1,6})?$/;
function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !TS.test(value) || !Number.isFinite(new Date(Number(value) * 1000).getTime())) throw new Error(`${name} must be a Slack timestamp`);
  return value;
}
function compareTs(a: string, b: string): number {
  const micros = (s: string) => { const [seconds, fraction = ''] = s.split('.'); return BigInt(seconds!) * 1000000n + BigInt(fraction.padEnd(6, '0')); };
  const x = micros(a), y = micros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function readOptions(args: Record<string, unknown>, kind: Kind) {
  const allowed = new Set(['channelId', 'limit', 'oldest', 'latest', 'cursor', ...Object.keys(READ_LIMITS),
    ...(kind === 'history' ? ['textContains', 'caseSensitive', 'authorIds'] : ['threadTs'])]);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('Unknown history read argument');
  const limits = {} as Record<keyof typeof READ_LIMITS, number>;
  for (const [name, bounds] of Object.entries(READ_LIMITS)) {
    const value = args[name] === undefined ? (name === 'limit' ? (kind === 'history' ? 50 : 100) : ('default' in bounds ? bounds.default : undefined)) : args[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.minimum || value > bounds.maximum) throw new Error(`${name} must be an integer from ${bounds.minimum} to ${bounds.maximum}`);
    limits[name as keyof typeof READ_LIMITS] = value;
  }
  const oldest = args.oldest === undefined ? undefined : timestamp(args.oldest, 'oldest');
  const latest = args.latest === undefined ? undefined : timestamp(args.latest, 'latest');
  if (oldest && latest && compareTs(oldest, latest) >= 0) throw new Error('oldest must precede latest');
  if (args.textContains !== undefined && (typeof args.textContains !== 'string' || args.textContains.length < 1 || args.textContains.length > 256)) throw new Error('textContains must contain 1 to 256 characters');
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') throw new Error('caseSensitive must be a boolean');
  if (args.authorIds !== undefined && (!Array.isArray(args.authorIds) || args.authorIds.length < 1 || args.authorIds.length > 50 || !args.authorIds.every(id => typeof id === 'string' && /^[UW][A-Z0-9]+$/.test(id)))) throw new Error('authorIds must contain 1 to 50 Slack user IDs');
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(args.cursor))) throw new Error('Invalid or expired history cursor');
  return {...limits, oldest, latest, textContains: args.textContains as string | undefined,
    caseSensitive: args.caseSensitive === true, authorIds: [...new Set((args.authorIds ?? []) as string[])].sort(), cursor: args.cursor as string | undefined};
}

/** Metadata observations, not scope checks or a guarantee a future write works. */
export function channelReadPolicy(id: string, writeAllowedByPolicy: boolean, raw?: Record<string, unknown>) {
  const flags: Record<string, boolean> = {};
  for (const name of ['is_archived', 'is_frozen', 'is_read_only', 'is_thread_only', 'is_non_threadable']) {
    if (typeof raw?.[name] === 'boolean') flags[name] = raw[name] as boolean;
  }
  const properties = raw?.properties as Record<string, unknown> | undefined;
  const restrictions = (name: string): boolean | null => {
    const value = properties?.[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.values(value);
    return entries.every(v => Array.isArray(v)) ? entries.some(v => (v as unknown[]).length > 0) : null;
  };
  const postingRestricted = restrictions('posting_restricted_to');
  const threadsRestricted = restrictions('threads_restricted_to');
  const assessment = (names: string[], restricted: boolean | null): boolean | null =>
    names.some(name => flags[name] === true) ? false :
      names.every(name => flags[name] === false) && restricted === false ? true : null;
  return {id, writeAllowedByPolicy, slack: {metadataAvailable: !!raw, flags, postingRestricted, threadsRestricted,
    channelPostAllowedByMetadata: assessment(['is_archived', 'is_frozen', 'is_read_only', 'is_thread_only'], postingRestricted),
    threadReplyAllowedByMetadata: assessment(['is_archived', 'is_frozen', 'is_read_only', 'is_non_threadable'], threadsRestricted)}};
}

export function historyRecord(raw: SlackHistoryMessage, names: Map<string, string>) {
  const id = timestamp(raw.ts, 'Slack message ts');
  const reported = raw.thread_ts ?? raw.root?.thread_ts ?? raw.root?.ts;
  const rootTs = reported === undefined ? id : timestamp(reported, 'Slack thread ts');
  const count = raw.reply_count;
  return {id, ...(raw.user ? {authorId: raw.user} : {}), ...(raw.bot_id ? {authorBotId: raw.bot_id} : {}),
    author: raw.user ? names.get(raw.user) ?? raw.user : raw.username ?? 'bot',
    timestamp: new Date(Number(id) * 1000).toISOString(), content: formatSlackText(raw.text ?? '', names),
    ...(rootTs !== id ? {threadTs: rootTs} : {}), rootTs, rootSource: reported === undefined ? 'message' : 'reported',
    ...(Number.isSafeInteger(count) && count! >= 0 ? {replyCount: count} : {}),
    ...(raw.files?.length ? {attachments: raw.files.map(a => `${a.name ?? 'attachment'}${a.mimetype ? ` (${a.mimetype})` : ''}${a.url_private ? ` — fetchable via fetch_attachment: ${a.url_private}` : ''}`)} : {})};
}

type ReadRecord = ReturnType<typeof historyRecord>;
type ReadChannel = ReturnType<typeof channelReadPolicy>;
export interface HistoryReadResult {
  messages: ReadRecord[];
  channel: ReadChannel;
  pagination: {scanned: number; matched: number; returned: number; pages: number; scanComplete: boolean; stopReason: StopReason;
    threadRepliesSearched: boolean; scope: 'channel_messages' | 'single_thread'; nextCursor?: string; retryAfterSeconds?: number};
}
class Deadline extends Error {}

/** Only positions/query hashes are retained, never Slack messages or credentials.
 * Random 192-bit handles are instance-bound, expire in 15 minutes, and are capped
 * at 128 entries. Restart/eviction invalidates them; callers can restart a read. */
export class BoundedHistoryReader {
  private cursors = new Map<string, {query: string; position: Position; expires: number}>();
  constructor(private call: SlackReadCall, private canWrite: (id: string) => boolean,
    private names: Map<string, string>, private disableDms: boolean, private clock = () => performance.now()) {}

  async read(kind: Kind, channelId: string, args: Record<string, unknown>, threadTs?: string): Promise<HistoryReadResult> {
    if (!/^[CGD][A-Z0-9]+$/.test(channelId)) throw new Error('channelId must be a Slack conversation ID');
    if (kind === 'thread') timestamp(threadTs, 'threadTs');
    const opts = readOptions(args, kind);
    const query = createHash('sha256').update(JSON.stringify({kind, channelId, threadTs, oldest: opts.oldest, latest: opts.latest,
      textContains: opts.textContains, caseSensitive: opts.caseSensitive, authorIds: opts.authorIds})).digest('hex');
    for (const [key, value] of this.cursors) if (value.expires <= this.clock()) this.cursors.delete(key);
    const previous = opts.cursor ? this.cursors.get(opts.cursor) : undefined;
    if (opts.cursor && (!previous || previous.query !== query)) throw new Error('Invalid, expired or query-mismatched history cursor');
    let position: Position = previous ? {...previous.position} : {oldest: opts.oldest, latest: opts.latest ?? (Date.now() / 1000).toFixed(6)};
    const deadline = this.clock() + opts.maxMs;
    const request = async (method: ReadMethod, values: Record<string, unknown>) => {
      const remaining = deadline - this.clock();
      if (remaining <= 0) throw new Deadline();
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Deadline()); }, remaining); });
      try { return await Promise.race([this.call(method, values, abort.signal), timeout]); }
      finally { clearTimeout(timer!); }
    };
    let channel = channelReadPolicy(channelId, this.canWrite(channelId));
    const messages: ReadRecord[] = [];
    let scanned = 0, matched = 0, pages = 0;
    let stopReason: StopReason = 'exhausted', complete = false, retryAfterSeconds: number | undefined;
    const result = (nextCursor?: string): HistoryReadResult => ({messages: kind === 'history' ? [...messages].reverse() : messages,
      channel, pagination: {scanned, matched, returned: messages.length, pages, scanComplete: complete, stopReason,
        threadRepliesSearched: kind === 'thread', scope: kind === 'history' ? 'channel_messages' : 'single_thread',
        ...(nextCursor ? {nextCursor} : {}), ...(retryAfterSeconds === undefined ? {} : {retryAfterSeconds})}});
    try {
      // Metadata is optional when the token can read history without info's scope.
      // No cached membership or buffered cursor content can authorize a read.
      let raw: Record<string, unknown> | undefined;
      try {
        const info = await request('conversations.info', {channel: channelId});
        if (!info.channel || typeof info.channel !== 'object' || (info.channel as Record<string, unknown>).id !== channelId) throw new Error('Slack returned mismatched conversation metadata');
        raw = info.channel as Record<string, unknown>;
      } catch (error) {
        if ((error as {data?: {error?: string}}).data?.error !== 'missing_scope') throw error;
      }
      if (this.disableDms && (channelId.startsWith('D') || raw?.is_im !== false || raw?.is_mpim !== false)) throw new Error('Direct messages are disabled or conversation type is unknown (SLACK_DISABLE_DMS)');
      if (raw?.is_member === false && raw.is_im !== true && raw.is_mpim !== true) throw new Error('Slack conversation is no longer joined');
      channel = channelReadPolicy(channelId, this.canWrite(channelId), raw);
      const seen = new Set<string>();
      while (true) {
        if (this.clock() >= deadline) { stopReason = 'time_limit'; break; }
        if (scanned >= opts.maxScanned) { stopReason = 'scan_limit'; break; }
        if (messages.length >= opts.limit) { stopReason = 'match_limit'; break; }
        if (pages >= opts.maxPages) { stopReason = 'page_limit'; break; }
        const beforePage = {...position};
        pages++;
        const page = await request(kind === 'history' ? 'conversations.history' : 'conversations.replies',
          {channel: channelId, ...(threadTs ? {ts: threadTs} : {}), ...position,
            limit: Math.min(200, opts.maxScanned - scanned, opts.limit - messages.length), inclusive: false});
        if (!Array.isArray(page.messages)) throw new Error('Slack returned invalid history messages');
        const rows = page.messages as SlackHistoryMessage[];
        let consumed: string | undefined;
        let halted = false;
        for (const rawMessage of rows) {
          if (this.clock() >= deadline) { stopReason = 'time_limit'; halted = true; break; }
          if (scanned >= opts.maxScanned) { stopReason = 'scan_limit'; halted = true; break; }
          const id = timestamp(rawMessage.ts, 'Slack message ts');
          const beforeMessage = consumed ? {...position, cursor: undefined, ...(kind === 'history' ? {latest: consumed} : {oldest: consumed})} : beforePage;
          scanned++;
          const haystack = rawMessage.text ?? '';
          const textMatches = opts.textContains === undefined || (opts.caseSensitive ? haystack.includes(opts.textContains) : haystack.toLowerCase().includes(opts.textContains.toLowerCase()));
          if (textMatches && (!opts.authorIds.length || (rawMessage.user !== undefined && opts.authorIds.includes(rawMessage.user)))) {
            matched++;
            messages.push(historyRecord(rawMessage, this.names));
            // Reserve the exact fixed-size continuation handle and worst-case
            // stopReason while checking the complete JSON result, not raw text.
            const probe = result('x'.repeat(32));
            probe.pagination.stopReason = 'pagination_stalled';
            if (Buffer.byteLength(JSON.stringify(probe)) + 64 > opts.maxBytes) {
              messages.pop(); position = beforeMessage; stopReason = 'byte_limit'; halted = true; break;
            }
          }
          consumed = id;
          position = {...position, cursor: undefined, ...(kind === 'history' ? {latest: id} : {oldest: id})};
          if (messages.length >= opts.limit && id !== rows.at(-1)?.ts) { stopReason = 'match_limit'; halted = true; break; }
        }
        if (halted) break;
        const metadata = page.response_metadata as {next_cursor?: unknown} | undefined;
        const next = metadata?.next_cursor;
        if (next !== undefined && (typeof next !== 'string' || next.length > 4096)) throw new Error('Slack returned invalid pagination');
        if (!next && page.has_more !== true) { complete = true; break; }
        if (!consumed || (next && seen.has(next))) { stopReason = 'pagination_stalled'; break; }
        if (next) { seen.add(next); position = {...beforePage, cursor: next}; }
        // has_more without a cursor uses exclusive timestamp pagination.
      }
    } catch (error) {
      const failure = error as {code?: string; retryAfter?: number};
      if (error instanceof Deadline || this.clock() >= deadline) stopReason = 'time_limit';
      else if (failure.code === 'slack_webapi_rate_limited_error') {
        stopReason = 'rate_limited';
        if (Number.isFinite(failure.retryAfter) && failure.retryAfter! >= 0) retryAfterSeconds = failure.retryAfter;
      } else throw error;
    }
    let nextCursor: string | undefined;
    if (!complete) {
      nextCursor = randomBytes(24).toString('base64url');
      while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(nextCursor, {query, position, expires: this.clock() + 15 * 60 * 1000});
    }
    const output = result(nextCursor);
    if (Buffer.byteLength(JSON.stringify(output)) > opts.maxBytes) throw new Error('maxBytes is too small for history metadata');
    return output;
  }
}
