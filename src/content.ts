/**
 * Content helpers — Slack message formatting and attachment handling.
 *
 * Pure functions shared by the server layer and the Slack adapter. Kept free
 * of client/SDK dependencies so both sides can import without cycles.
 *
 * Salvaged from zulip-mcp PR #8 (multi-platform branch), Slack halves only.
 */

import { DEFAULT_PAGINATION, pageLimit } from './pagination.js';
import type { PolicyFileRef } from './file-access.js';
import { channelShown, mimeShown, nameShown } from './framing.js';

// Anthropic refuses images larger than this; mirror their cap server-side
// so an over-eager fetch can't poison the agent's next turn.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// MIME types we decode and return as `content_text` instead of base64,
// so the agent can read them directly (CSVs, JSON, plain text, etc).
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-www-form-urlencoded)\b)/i;

export interface FetchedAttachment {
  buf: Buffer;
  mimeType: string;
  name: string;
}

const bytes = (n: number) => n.toLocaleString('en-US');

/** Where fetch_attachment's url comes from, for each text that asks for it. */
export const ATTACHMENT_URL_SOURCE =
  'Pass the url exactly as the message gives it after "fetchable via fetch_attachment:"; it starts with ' +
  'https://files.slack.com/.';

/** A file over the limit: by its size when that's known, or else as a download that passed it. */
function tooLarge(size?: number): Error {
  const limit = `fetch_attachment's limit of ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB (${bytes(MAX_ATTACHMENT_BYTES)} bytes)`;
  return new Error(
    `Nothing was fetched: ${size === undefined ? `the download passed ${limit}` : `the file is ${bytes(size)} bytes, over ${limit}`}` +
      ", so calling again gets the same answer; this server can't fetch a file that large.",
  );
}

/** A download that failed on the way, before an answer or partway through one.
 *  One whose `signal` ended it keeps the signal's reason, such as its
 *  timeout's TimeoutError, which the explainer reads. Otherwise the reason is
 *  the failure's cause: its message, or, for an AggregateError of every
 *  address tried, each one's, or its code. */
function inTransit(err: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return err as Error;
  const e = err as { message?: unknown; cause?: { message?: unknown; errors?: unknown; code?: unknown } } | null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const cause = e?.cause;
  const each = Array.isArray(cause?.errors) ? cause.errors.map((x) => text((x as { message?: unknown } | null)?.message)).filter(Boolean) : [];
  const why = text(cause?.message) || each.join('; ') || text(cause?.code) || String(e?.message ?? err);
  return new Error(`Nothing was fetched: the download failed on the way (${why}). Try again shortly.`);
}

/**
 * Authenticated GET with an enforced size cap. Checks Content-Length when the
 * server provides one, and streams with a running byte budget as defense in
 * depth so a missing or lying header can't OOM the process. `signal` ends the
 * download when it aborts, while the body is still arriving too, and the call
 * rejects with its reason.
 */
export async function fetchAttachmentBytes(
  url: string,
  fallbackName: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestInit['redirect'] } = {},
): Promise<FetchedAttachment> {
  const resp = await fetch(url, { headers: opts.headers ?? {}, redirect: opts.redirect ?? 'follow', signal: opts.signal }).catch((err: unknown) => {
    throw inTransit(err, opts.signal);
  });
  if (!resp.ok) {
    const answered = `HTTP ${resp.status} ${resp.statusText}`.trim();
    // Policy callers cannot fix a denial by supplying a different URL.
    const source = opts.redirect === 'error'
      ? 'Use channelId and fileId from an attachment reference; this server verifies access again.'
      : ATTACHMENT_URL_SOURCE;
    // A timeout, a rate limit or a failing server says nothing about the url.
    throw new Error(
      resp.status === 408 || resp.status === 429 || resp.status >= 500
        ? `Nothing was fetched: the file's url answered ${answered}, so the server was busy or failing. Try again shortly.`
        : `Nothing was fetched: the file's url answered ${answered}. ${source} ${opts.redirect === 'error' ? 'The' : 'If it was exact, the'} ` +
            'file may have been deleted, or this bot may not be allowed to read it; calling again gets the same ' +
            'answer unless someone shares the file where this bot can read it, or, if the Slack app lacks ' +
            "files:read (Slack's file links need it), whoever runs this host adds that scope to the app's bot " +
            'token scopes and reinstalls the app.',
    );
  }

  // Pre-check Content-Length so an oversized declared body never starts buffering.
  const declared = resp.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_ATTACHMENT_BYTES) {
      throw tooLarge(n);
    }
  }

  // A response with no body stream, such as a 204's, carries no bytes.
  const reader = resp.body?.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (reader) {
    const { value, done } = await reader.read().catch((err: unknown) => {
      throw inTransit(err, opts.signal);
    });
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  const buf = Buffer.concat(chunks, total);

  const headerMime = resp.headers.get('content-type')?.split(';')[0].trim();
  const classified = classifyExtension(fallbackName);
  const mimeType = headerMime || classified.mimeType;
  return { buf, mimeType, name: fallbackName };
}

/**
 * Shape a successful fetch into the tool's response. Images return as native
 * MCP content blocks (via `_content`), text-ish MIME types return decoded
 * `content_text`, other binary returns `base64`.
 */
export function toFetchResult({ buf, mimeType, name }: FetchedAttachment): Record<string, unknown> {
  if (mimeType.startsWith('image/')) {
    return {
      _content: [
        { type: 'text', text: `Fetched ${nameShown(name)} (${mimeShown(mimeType)}, ${buf.byteLength} bytes):` },
        { type: 'image', data: buf.toString('base64'), mimeType },
      ],
    };
  }
  if (TEXT_MIME_RE.test(mimeType)) {
    return {
      name,
      mimeType,
      size: buf.byteLength,
      content_text: buf.toString('utf-8'),
    };
  }
  return {
    name,
    mimeType,
    size: buf.byteLength,
    base64: buf.toString('base64'),
    note: 'Non-image, non-text attachment returned as base64. Decode externally as needed.',
  };
}

/**
 * Validate a Slack attachment URL before the bot token is attached to the
 * request. The host must be exactly files.slack.com — `url_private` is always
 * served from there. A `*.slack.com` wildcard would be a token leak: every
 * workspace lives at `<name>.slack.com` and serves `/api/*`, and the tool's
 * input is influenced by message content from untrusted senders.
 */
export function parseSlackAttachmentUrl(rawUrl: string): URL {
  if (!rawUrl) throw new Error('url is required');
  const notALink = () => new Error(`Nothing was fetched: "${rawUrl}" isn't a full https:// link. ${ATTACHMENT_URL_SOURCE}`);
  if (!rawUrl.startsWith('https://')) throw notALink();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw notALink();
  }
  if (url.host !== 'files.slack.com') {
    throw new Error(
      `Nothing was fetched: ${url.host} isn't Slack's file server. fetch_attachment sends this bot's token with ` +
        `the request, so it takes only links on files.slack.com. ${ATTACHMENT_URL_SOURCE}`,
    );
  }
  // fetch() refuses such a url before connecting.
  if (url.username || url.password) {
    throw new Error(
      `Nothing was fetched: fetch_attachment can't fetch a url that carries a user name or password, and Slack's ` +
        `file links carry neither. ${ATTACHMENT_URL_SOURCE}`,
    );
  }
  return url;
}

/** The file's name, from the url's last segment, decoded when it decodes: it's
 *  only a label, so a segment with a malformed escape is kept as given. */
export function attachmentName(url: URL): string {
  const segment = url.pathname.split('/').pop() || 'attachment';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export type AttachmentRef = PolicyFileRef | LegacyAttachmentRef;

export interface LegacyAttachmentRef {
  channelId?: never;
  fileId?: never;
  path: string;       // url_private — needs Bearer bot-token auth to fetch
  name: string;       // basename for human display
  mimeType: string;   // best-effort from extension or the API
  isImage: boolean;
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const NONIMAGE_EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
};

export function classifyExtension(name: string): { mimeType: string; isImage: boolean } {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT_MIME[ext]) return { mimeType: IMAGE_EXT_MIME[ext], isImage: true };
  if (NONIMAGE_EXT_MIME[ext]) return { mimeType: NONIMAGE_EXT_MIME[ext], isImage: false };
  return { mimeType: 'application/octet-stream', isImage: false };
}

// Slack user/channel IDs are documented as uppercase alphanumerics. Single
// source of truth for every mention regex below — if Slack ever widens the
// ID alphabet, this is the only line to change. Fresh RegExp per use: 'g'
// regexes carry lastIndex state and must not be shared between callers.
const SLACK_ID = '[A-Z0-9]+';
const slackUserMentionRe = () => new RegExp(`<@(${SLACK_ID})(?:\\|([^>]*))?>`, 'g');
const slackChannelMentionRe = () => new RegExp(`<#(${SLACK_ID})(?:\\|([^>]*))?>`, 'g');

// Slack message text uses mrkdwn escapes: <@U123> user mentions,
// <#C123|name> channel mentions, <!here>/<!channel> broadcasts, and
// <url|label> links. Rewrite them into a readable shape
// (`@name (uid:U123)` and `#name`, with a name that isn't plain quoted),
// resolving user IDs via the provided map (best-effort: an unresolved ID shows
// the label Slack sent with it, else the raw ID).
export function formatSlackText(text: string, userNames: Map<string, string>): string {
  let formatted = text;

  // User mentions: <@U123> or <@U123|fallback>. The name goes in with its `&`
  // escaped as Slack escapes it, so the unescape below gives it back as it is.
  formatted = formatted.replace(slackUserMentionRe(), (_m, id: string, fallback?: string) => {
    const name = userNames.get(id) || (fallback && unescapeSlack(fallback)) || id;
    return `@${nameShown(name).replace(/&/g, '&amp;')} (uid:${id})`;
  });

  // Channel mentions: <#C123|name> or <#C123>. The label is whatever the
  // poster sent, so it's shown by the name rule, as a user mention's name is.
  formatted = formatted.replace(slackChannelMentionRe(), (_m, id: string, name?: string) => {
    return name ? channelShown(unescapeSlack(name)).replace(/&/g, '&amp;') : `#${id}`;
  });

  // Broadcasts: <!here>, <!channel>, <!everyone>
  formatted = formatted.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1');

  // Links: <url|label> → label (url), <url> → url
  formatted = formatted.replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, '$2 ($1)');
  formatted = formatted.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  return unescapeSlack(formatted);
}

/** Slack's HTML entities, unescaped; `&amp;` last, so `&amp;lt;` gives `&lt;`. */
function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The name reactions.add is sent for an emoji as given: Slack wants the bare
 *  name, so every colon is removed, which also takes the pair out of a skin
 *  tone such as thumbsup::skin-tone-2. */
export function reactionName(emoji: string): string {
  return emoji.replace(/:/g, '');
}

/** Extract user IDs referenced as <@U123> in Slack mrkdwn, for pre-resolution. */
export function extractSlackUserIds(text: string): string[] {
  const ids = new Set<string>();
  const re = slackUserMentionRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

/** The minimal users.info surface resolveSlackUserNames needs — structurally
 * satisfied by @slack/web-api's WebClient without importing the SDK here. */
export interface SlackUserInfoClient {
  users: {
    info(args: { user: string }): Promise<{
      user?: { profile?: { display_name?: string }; real_name?: string; name?: string };
    }>;
  };
}

/** Slack's codes for its own failure while handling a call, or for a call it
 *  couldn't take then, which say nothing about what the call asked for. */
export const SLACK_FAILED = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'ratelimited']);

/** The form of Slack's error codes. web-api 7.19.0 reads an answer whose body
 *  isn't JSON as a refusal whose code is the body itself (buildResult, in
 *  dist/WebClient.js), which shows nothing about what Slack did, so a code
 *  of any other form isn't Slack's. A body that is itself one such word
 *  reads exactly as a refusal of Slack's carrying only that code. */
export const SLACK_CODE = /^[a-z0-9_]+$/;

/** Node's codes for a connection never made, which the client's request error
 *  keeps on `original`: nothing reached Slack, so nothing was done. Every code
 *  the resolver reports (ENOTFOUND, and EAI_AGAIN, EAI_FAIL and the other EAI_
 *  codes) comes before a connection. */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH']);
export const connectionNeverMade = (nodeCode: unknown): boolean =>
  typeof nodeCode === 'string' && (NEVER_CONNECTED.has(nodeCode) || nodeCode.startsWith('EAI_'));

/**
 * Resolve Slack user IDs to display names into the caller's cache, memoized
 * for the cache's lifetime. A user Slack refuses to look up (user_not_found,
 * missing_scope, …) is cached as the raw ID for the process's life, as a name
 * is: a refusal answers for the user, the app's scopes or token, or the
 * workspace's settings, which seldom change while the process runs, and a
 * restart asks again, as it does for a renamed user. A lookup that fails
 * otherwise (a rate limit, a failure in transit, Slack failing, or an answer
 * not in Slack's form) isn't cached, so the next message that names the user
 * asks again; meanwhile a mention shows the label Slack sent with it, else
 * the raw ID, and an author shows the raw ID (best-effort). Returns the
 * error of each lookup left uncached, by user ID.
 */
export async function resolveSlackUserNames(
  client: SlackUserInfoClient,
  cache: Map<string, string>,
  userIds: string[],
): Promise<Map<string, unknown>> {
  const failed = new Map<string, unknown>();
  const unresolved = Array.from(new Set(userIds)).filter(id => id && !cache.has(id));
  // Chunked, not one big Promise.all — a busy channel can reference dozens of
  // distinct users, and an unbounded users.info fan-out runs into Slack's
  // rate limit for users.info.
  const CONCURRENCY = 8;
  for (let i = 0; i < unresolved.length; i += CONCURRENCY) {
    await Promise.all(unresolved.slice(i, i + CONCURRENCY).map(async (id) => {
      try {
        const { user } = await client.users.info({ user: id });
        cache.set(id, user?.profile?.display_name || user?.real_name || user?.name || id);
      } catch (err) {
        // Slack's own answer is in data.error (the client's platform error),
        // when its code is in Slack's form.
        const refused = (err as { data?: { error?: unknown } } | null)?.data?.error;
        if (typeof refused === 'string' && SLACK_CODE.test(refused) && !SLACK_FAILED.has(refused)) cache.set(id, id);
        else failed.set(id, err);
      }
    }));
  }
  return failed;
}

/** The fields of a conversations.history message the server reads —
 * structurally satisfied by @slack/web-api's MessageElement. */
export interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  root?: { thread_ts?: string; ts?: string };
  reply_count?: number;
  bot_id?: string;
  files?: Array<{ id?: string; name?: string; mimetype?: string; url_private?: string }>;
}

/** The minimal conversations.history surface fetchSlackHistory needs —
 * structurally satisfied by @slack/web-api's WebClient. */
export interface SlackHistoryClient {
  conversations: {
    history(args: {
      channel: string;
      oldest?: string;
      latest?: string;
      inclusive?: boolean;
      limit?: number;
      cursor?: string;
    }): Promise<{
      messages?: unknown[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

/**
 * Fetch conversations.history with cursor pagination. The API returns
 * newest-first pages and next_cursor walks toward older messages, so draining
 * the cursor collects everything in [oldest, latest]; `maxMessages` is a
 * backstop against unbounded backlogs. Returns messages oldest-first plus a
 * `truncated` flag — when truncated, the dropped messages are the OLDEST in
 * range (callers that keep a read cursor must NOT advance it then, or the
 * dropped messages are skipped forever).
 */
export async function fetchSlackHistory(
  client: SlackHistoryClient,
  params: {
    channel: string;
    oldest?: string;
    latest?: string;
    inclusive?: boolean;
    maxMessages: number;
    maxPages?: number;
  },
): Promise<{ messages: SlackHistoryMessage[]; truncated: boolean }> {
  const maxPages = pageLimit(params.maxPages === undefined ? DEFAULT_PAGINATION.backscroll : params.maxPages, 'SLACK_BACKSCROLL_PAGE_LIMIT');
  let pages = 0;
  const collected: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  let truncated = false;
  const cursors = new Set<string>();
  do {
    const result = await client.conversations.history({
      channel: params.channel,
      ...(params.oldest !== undefined ? { oldest: params.oldest } : {}),
      ...(params.latest !== undefined ? { latest: params.latest } : {}),
      ...(params.inclusive ? { inclusive: true } : {}),
      limit: Math.min(200, params.maxMessages - collected.length),
      cursor,
    });
    pages++;
    collected.push(...((result.messages ?? []) as SlackHistoryMessage[]));
    cursor = result.response_metadata?.next_cursor || undefined;
    if (cursor && collected.length >= params.maxMessages) {
      truncated = true;
      cursor = undefined;
    }
    if (cursor && cursors.has(cursor)) throw new Error('Slack history cursor cycle');
    if (cursor) cursors.add(cursor);
    if (cursor && pages >= maxPages) { truncated = true; break; }
  } while (cursor);
  return { messages: collected.reverse(), truncated };
}
