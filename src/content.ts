/**
 * Content helpers — Slack message formatting and attachment handling.
 *
 * Pure functions shared by the server layer and the Slack adapter. Kept free
 * of client/SDK dependencies so both sides can import without cycles.
 *
 * Salvaged from zulip-mcp PR #8 (multi-platform branch), Slack halves only.
 */

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

/**
 * Authenticated GET with an enforced size cap. Checks Content-Length when the
 * server provides one, and streams with a running byte budget as defense in
 * depth so a missing or lying header can't OOM the process.
 */
export async function fetchAttachmentBytes(
  url: string,
  fallbackName: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<FetchedAttachment> {
  const resp = await fetch(url, { headers: opts.headers ?? {}, redirect: 'follow' });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);

  // Pre-check Content-Length so an oversized declared body never starts buffering.
  const declared = resp.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${n} bytes (max ${MAX_ATTACHMENT_BYTES})`);
    }
  }

  const reader = resp.body?.getReader();
  let buf: Buffer;
  if (!reader) {
    // No streaming body: fall back to arrayBuffer with a post-read check.
    buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${buf.byteLength} bytes (max ${MAX_ATTACHMENT_BYTES})`);
    }
  } else {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_ATTACHMENT_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error(`attachment too large: streamed past ${MAX_ATTACHMENT_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    buf = Buffer.concat(chunks, total);
  }

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
        { type: 'text', text: `Fetched ${name} (${mimeType}, ${buf.byteLength} bytes):` },
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
  if (!rawUrl.startsWith('https://')) {
    throw new Error('url must be a full https:// link');
  }
  const url = new URL(rawUrl);
  if (url.host !== 'files.slack.com') {
    throw new Error(`refusing to fetch from host ${url.host}; Slack attachments are served from files.slack.com only`);
  }
  return url;
}

export interface AttachmentRef {
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
// (`@name (uid:U123)`), resolving user IDs via the provided map
// (best-effort: unresolved IDs keep the raw ID as the name).
export function formatSlackText(text: string, userNames: Map<string, string>): string {
  let formatted = text;

  // User mentions: <@U123> or <@U123|fallback>
  formatted = formatted.replace(slackUserMentionRe(), (_m, id: string, fallback?: string) => {
    const name = userNames.get(id) || fallback || id;
    return `@${name} (uid:${id})`;
  });

  // Channel mentions: <#C123|name> or <#C123>
  formatted = formatted.replace(slackChannelMentionRe(), (_m, id: string, name?: string) => {
    return name ? `#${name}` : `#${id}`;
  });

  // Broadcasts: <!here>, <!channel>, <!everyone>
  formatted = formatted.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1');

  // Links: <url|label> → label (url), <url> → url
  formatted = formatted.replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, '$2 ($1)');
  formatted = formatted.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // Unescape Slack's HTML entities
  formatted = formatted
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  return formatted;
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

/**
 * Resolve Slack user IDs to display names into the caller's cache, memoized
 * for the cache's lifetime. Failures leave the raw ID in place (best-effort).
 */
export async function resolveSlackUserNames(
  client: SlackUserInfoClient,
  cache: Map<string, string>,
  userIds: string[],
): Promise<void> {
  const unresolved = Array.from(new Set(userIds)).filter(id => id && !cache.has(id));
  // Chunked, not one big Promise.all — a busy channel can reference dozens of
  // distinct users, and an unbounded users.info fan-out just queues up 429
  // retries inside the SDK.
  const CONCURRENCY = 8;
  for (let i = 0; i < unresolved.length; i += CONCURRENCY) {
    await Promise.all(unresolved.slice(i, i + CONCURRENCY).map(async (id) => {
      try {
        const { user } = await client.users.info({ user: id });
        cache.set(id, user?.profile?.display_name || user?.real_name || user?.name || id);
      } catch {
        cache.set(id, id);
      }
    }));
  }
}

/** The fields of a conversations.history message the server reads —
 * structurally satisfied by @slack/web-api's MessageElement. */
export interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  files?: Array<{ name?: string; mimetype?: string; url_private?: string }>;
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
  },
): Promise<{ messages: SlackHistoryMessage[]; truncated: boolean }> {
  const collected: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const result = await client.conversations.history({
      channel: params.channel,
      ...(params.oldest !== undefined ? { oldest: params.oldest } : {}),
      ...(params.latest !== undefined ? { latest: params.latest } : {}),
      ...(params.inclusive ? { inclusive: true } : {}),
      limit: Math.min(200, params.maxMessages - collected.length),
      cursor,
    });
    collected.push(...((result.messages ?? []) as SlackHistoryMessage[]));
    cursor = result.response_metadata?.next_cursor || undefined;
    if (cursor && collected.length >= params.maxMessages) {
      truncated = true;
      cursor = undefined;
    }
  } while (cursor);
  return { messages: collected.reverse(), truncated };
}
