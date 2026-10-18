/**
 * SlackAdapter — owns the Slack connection and all platform operations.
 *
 * Conversation IDs are Slack's immutable IDs (C… public, G… private,
 * D… DM) — names are mutable and never used for routing.
 *
 * Connectivity: Web API (xoxb- bot token) for calls, Socket Mode (xapp-
 * app-level token) for real-time events — no public webhook URL needed,
 * matching the stdio-spawned server model.
 *
 * Threads map to thread_ts: incoming messages carry their thread_ts, and
 * reply/publish routing posts into the thread of the referenced message
 * (top-level when the conversation isn't threaded).
 *
 * No typing indicator: Slack's Web API exposes none for bots (RTM-only,
 * deprecated), so the server treats channels/typing as a no-op.
 *
 * Event handling salvaged from zulip-mcp PR #8's SlackAdapter.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { WebClient, ErrorCode, LogLevel, type Logger, type WebAPICallResult, type WebClientOptions } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import {
  formatSlackText,
  extractSlackUserIds,
  resolveSlackUserNames,
  fetchSlackHistory,
  classifyExtension,
  reactionName,
  SLACK_FAILED,
  connectionNeverMade,
  type AttachmentRef,
  type SlackHistoryMessage,
} from './content.js';

/** An acknowledgement reaction is removed after this, replied to or not. */
const ACK_TTL_MS = 10 * 60 * 1000;
/** A removal that failed without an answer from Slack is tried again after
 *  this, at most ACK_MAX_TRIES times in all. */
const ACK_RETRY_MS = 60 * 1000;
const ACK_MAX_TRIES = 5;
/** Slack's answers to a write after which it may have taken effect:
 *  already_reacted, to an acknowledgement's add, and the failures the
 *  explainer calls an unknown outcome. */
const MAY_HAVE_LANDED = new Set(['already_reacted', 'internal_error', 'fatal_error', 'service_unavailable', 'file_update_failed']);

type AckEntry = {
  timer: ReturnType<typeof setTimeout>;
  added: Promise<boolean>;
  tries: number;
  removing?: Promise<void>;
};

/** How long work no call waits on waits before asking Slack again after a
 *  failure that gives no Retry-After. */
const FAILED_WAIT_SECONDS = 30;

/** Why work no call waits on, such as channel registration, waits before
 *  asking Slack again after a request to `method`: Slack rate-limited it and
 *  asked for this many seconds (`limited`), or it failed in a way that can
 *  pass: in transit, with an HTTP error, by Slack's own failure, or by not
 *  being sent because its call was out of time (`failed`). */
export interface SlackWait {
  method: string;
  seconds: number;
  why: 'limited' | 'failed';
}

/** The wait before asking Slack again after `err` from a request to `method`,
 *  for work no call waits on; undefined when Slack's answer will be the same
 *  next time, or `err` isn't the client's. A request the host is waiting on
 *  waits out only a `limited` one, within its budget (SlackWebClient). */
export function waitToAskAgain(err: unknown, method: string): SlackWait | undefined {
  const e = err as { code?: unknown; retryAfter?: unknown; data?: { error?: unknown } } | null;
  if (e?.code === ErrorCode.RateLimitedError && typeof e.retryAfter === 'number') {
    return { method, seconds: e.retryAfter, why: 'limited' };
  }
  // A request its call's time left no room for can go out in a later call.
  // Only a request made for a call can get it, and work no call waits on
  // never does, so its wait is left at none.
  if (err instanceof OutOfCallTime) return { method, seconds: 0, why: 'failed' };
  const failedAtSlack = e?.code === ErrorCode.PlatformError && typeof e.data?.error === 'string' &&
    SLACK_FAILED.has(e.data.error);
  if (e?.code === ErrorCode.RequestError || e?.code === ErrorCode.HTTPError || failedAtSlack) {
    return { method, seconds: FAILED_WAIT_SECONDS, why: 'failed' };
  }
  return undefined;
}

/** Called by a listing no call waits on before it asks Slack again: with the
 *  wait, and how many times in a row this request has needed one. Rejecting
 *  ends the listing with that error, unless it's GaveUp on a DM's name. */
export type SlackWaitOut = (wait: SlackWait, inARow: number) => Promise<void>;

/** What a SlackWaitOut rejects with when it gives up on a request rather than
 *  on the whole listing. A page given up ends the listing; a DM whose user's
 *  name is given up is labelled with the user's id, as a refused lookup is. */
export class GaveUp extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GaveUp';
  }
}

/** Message subtypes that represent real user content. Everything else
 * (message_changed, message_deleted, channel_join, bot_message, …) is noise
 * for the inference loop. */
const CONTENT_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast', 'me_message']);

/** The fields of a Socket Mode message event this adapter dereferences.
 * Payloads come off the wire — everything is optional until checked. */
interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  /** On a thread_broadcast the parent may be named only here. */
  root?: { thread_ts?: string };
  bot_id?: string;
  channel_type?: string;
  team?: string;
  files?: Array<{ url_private?: string; name?: string; mimetype?: string }>;
}

/** The fields of a conversations.list/info entry this adapter dereferences —
 * structurally satisfied by @slack/web-api's Channel type. */
export interface SlackApiConversation {
  id?: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
}

export type ConversationKind = 'channel' | 'private_channel' | 'dm' | 'group_dm';

export interface SlackConversationInfo {
  id: string;
  kind: ConversationKind;
  /** Channel name, group-DM name, or the DM counterpart's display name. */
  name: string;
  /** DM counterpart user ID (dm only). */
  userId?: string;
  topic?: string;
  isMember: boolean;
  numMembers?: number;
  /** A DM whose user's name Slack didn't give, in a way that can pass: the
   *  wait before asking again, as waitToAskAgain gives it. Its name is the
   *  user's id until a lookup succeeds. */
  nameWait?: SlackWait;
}

export interface SlackMessageData {
  /** Slack conversation ID (C…/G…/D…). */
  channelId: string;
  /** Message ts — Slack's message ID within the conversation. */
  id: string;
  threadTs?: string;
  authorId: string;
  authorName: string;
  /** Raw mrkdwn text as received. */
  content: string;
  /** Mentions resolved to @name (uid:U…), links/broadcasts unescaped. */
  cleanContent: string;
  /** User IDs mentioned as <@U…> in the text. */
  mentionIds: string[];
  /** Personal mention of the bot — @here/@channel broadcasts don't count. */
  mentionsBot: boolean;
  isDM: boolean;
  channelType?: string;
  teamId?: string;
  timestamp: Date;
  attachments: AttachmentRef[];
}

export interface HistoryMessage {
  id: string;
  authorId?: string;
  authorName: string;
  content: string;
  threadTs?: string;
  timestamp: Date;
  attachments: Array<{ name: string; mimeType?: string; url?: string }>;
}

export interface SlackUserMatch {
  userId: string;
  username?: string;
  realName?: string;
  displayName?: string;
}

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  /** When set, DMs from anyone not in this user-ID list are dropped. */
  dmUsers?: string[];
  /** Conversation-ID allow-list for every write (send, DM, edit, delete,
   *  reaction). Unset or empty = no restriction. */
  sendChannels?: string[];
  /** Drop incoming DMs and refuse DM sends and DM history reads. */
  disableDms?: boolean;
  /** Emoji name put on an addressed message while the agent works on it. */
  ackReaction?: string;
}

/**
 * The Web API client's settings for every request after startup, so that each
 * one answers at once with what happened. A rate limit comes back with
 * Slack's Retry-After (rejectRateLimitedCalls), and SlackWebClient waits out
 * one a request from the host can afford. A failure in transit comes
 * back without the request being sent again (no retries), so this client never
 * sends a post that may have reached Slack a second time. A request fails once
 * Slack has gone 10 seconds without answering, or without sending more of its
 * answer, and SlackWebClient sends a request only if those 10 seconds fit
 * before its call's deadline; an answer that keeps arriving a little at a time
 * isn't cut off. With the client's defaults, a rate limit or a network failure
 * was retried inside the call for up to about 30 minutes, and every request
 * behind it waited, since requests are handled one at a time.
 */
export const SLACK_CLIENT_OPTIONS = {
  rejectRateLimitedCalls: true,
  retryConfig: { retries: 0 },
  timeout: 10_000,
} satisfies WebClientOptions;

/** How long, in seconds, this server gives a request from the host, counted
 *  from when it reaches this server. */
export const CALL_SECONDS = 25;

/** How long, in seconds, the Slack requests made for one request from the
 *  host may spend waiting out Slack's rate limits, in all. */
export const WAIT_PER_CALL_SECONDS = 5;

/** The time of the request from the host being handled: when it reached this
 *  server, its deadline, and what is left of its waiting. serve() handles one
 *  request at a time, so one store is live at once. */
interface CallTime {
  arrived: number;
  deadline: number;
  secondsLeft: number;
}
const callTime = new AsyncLocalStorage<CallTime>();

/** Handle one request from the host, which reached this server at `arrived`
 *  (ms since the epoch): its Slack requests are sent only while their timeout
 *  fits before CALL_SECONDS after that, and share WAIT_PER_CALL_SECONDS of
 *  waiting for rate limits (SlackWebClient). */
export function withCallTime<T>(arrived: number, handle: () => Promise<T>): Promise<T> {
  return callTime.run({ arrived, deadline: arrived + CALL_SECONDS * 1000, secondsLeft: WAIT_PER_CALL_SECONDS }, handle);
}

/** Start work that outlives the request from the host it began in, such as
 *  registration or an acknowledgement's removal, outside that request's time:
 *  its Slack requests have no deadline and answer a rate limit at once, as any
 *  made outside a request do, and it waits in its own way, if at all. */
export function outsideCallTime<T>(start: () => T): T {
  return callTime.exit(start);
}

/** What assertRequestFits throws instead of letting a request go out whose
 *  timeout wouldn't end before its call's deadline. The request wasn't sent.
 *  `method` names it: a Web API method, or what else it was, such as
 *  fetch_attachment's download. */
export class OutOfCallTime extends Error {
  readonly code = 'slack_mcpl_out_of_call_time';
  /** `usedSeconds`: whole seconds, rounded up, so a refusal never reads as
   *  leaving room for the request; at most CALL_SECONDS. */
  constructor(readonly method: string, readonly usedSeconds: number) {
    super(`${method}: out of this call's time`);
    this.name = 'OutOfCallTime';
  }
}

/** The Web API method of the request each error SlackWebClient passes on came
 *  from, so the explainer can tell a write's own request from one made before
 *  it. */
const failedRequests = new WeakMap<object, string>();

/** The request `err` came from: the Web API method SlackWebClient marked it
 *  with, or OutOfCallTime's own, which names a Web API method or what else the
 *  request was, such as an upload's bytes; undefined for an error no request
 *  of SlackWebClient's threw. */
export function failedRequest(err: unknown): string | undefined {
  if (err instanceof OutOfCallTime) return err.method;
  return err !== null && typeof err === 'object' ? failedRequests.get(err) : undefined;
}

/** The file an upload left when it failed after its first step, and whether
 *  Slack may have shared it. */
export interface FileLeft {
  fileId: string;
  mayHaveShared: boolean;
}
const filesLeft = new WeakMap<object, FileLeft>();

/** The file an upload left when it failed after its first step, which a
 *  rollback deletes too, and whether Slack may have shared it; undefined for
 *  any other error. */
export function fileLeftByUpload(err: unknown): FileLeft | undefined {
  return err !== null && typeof err === 'object' ? filesLeft.get(err) : undefined;
}

/** Whether a request's failure leaves it undone: the call's time left no room
 *  to send it, the connection to Slack was never made, or Slack refused it or
 *  rate-limited it. A failure Slack says may have taken effect
 *  (MAY_HAVE_LANDED), an HTTP error, a timeout or a connection that failed
 *  once made doesn't say. */
function cannotHaveLanded(err: unknown): boolean {
  if (err instanceof OutOfCallTime) return true;
  const e = err as { code?: unknown; original?: { code?: unknown }; data?: { error?: unknown } } | null;
  if (e?.code === ErrorCode.RequestError) return connectionNeverMade(e.original?.code);
  if (e?.code === ErrorCode.RateLimitedError) return true;
  return e?.code === ErrorCode.PlatformError && typeof e.data?.error === 'string' && !MAY_HAVE_LANDED.has(e.data.error);
}

/** An upload's last step answered without the file: whether Slack shared it
 *  can't be told. */
export class UploadNotConfirmed extends Error {
  constructor(readonly fileId: string) {
    super(`files.completeUploadExternal: the answer named no file ${fileId}`);
    this.name = 'UploadNotConfirmed';
  }
}

/** A post of a file's bytes to Slack's upload server that failed: its timeout
 *  ran out (`TimeoutError`), the connection failed (`transit`), or the server
 *  answered with this HTTP status. The bytes may have reached the server, but
 *  Slack shares a file only at the upload's last step, so nothing was shared. */
export class UploadBytesFailed extends Error {
  constructor(readonly why: 'TimeoutError' | 'transit' | number) {
    super(`The upload of the file's bytes: ${why === 'TimeoutError' ? 'timed out' : why === 'transit' ? 'the connection failed' : `HTTP ${why}`}`);
    this.name = 'UploadBytesFailed';
  }
}

/** The ts of the message that shared `file` in `channelId`, from
 *  files.completeUploadExternal's answer, if it names one. */
function sharingTs(file: SlackUploadedFile, channelId: string): string | undefined {
  for (const where of [file.shares?.public, file.shares?.private]) {
    const ts = where?.[channelId]?.[0]?.ts;
    if (typeof ts === 'string' && ts) return ts;
  }
  return undefined;
}

/** The start rule for every request a request from the host makes, made
 *  through SlackWebClient or not: one that can take up to `requestMs` goes out
 *  only if it would end before the call's deadline, and otherwise this throws
 *  OutOfCallTime and nothing is sent. Outside a request from the host there is
 *  no deadline. */
export function assertRequestFits(method: string, requestMs: number): void {
  const call = callTime.getStore();
  if (call && Date.now() + requestMs > call.deadline) {
    throw new OutOfCallTime(method, Math.min(CALL_SECONDS, Math.ceil((Date.now() - call.arrived) / 1000)));
  }
}

/**
 * The adapter's Web API client, built with SLACK_CLIENT_OPTIONS, which keeps
 * each request from the host to its time.
 *
 * A Slack request made for a request from the host is sent only if its whole
 * timeout fits before that call's deadline, CALL_SECONDS after the call reached
 * this server, whether the call waited behind earlier calls or spent the time
 * on its own requests. So a request that times out does so before the
 * deadline, and a write never runs into the deadline and comes back possibly
 * done. Only an answer from Slack that keeps arriving a little at a time can
 * outlast it, since the timeout then ends only a pause in the answer. A
 * request that doesn't fit throws OutOfCallTime, unsent.
 *
 * When Slack answers one of these requests with a rate limit no longer than
 * what is left of its call's WAIT_PER_CALL_SECONDS, and the request would still
 * fit after the wait, the client waits that long and sends it once more. The
 * second answer stands, rate limit included. Slack refused the first without
 * acting on it, so sending it again can't post twice. A short limit, such as
 * chat.postMessage's one message per second, then costs the agent a second
 * inside the call instead of a turn of its own. A longer one, such as a method
 * tier's minute window, comes back at once with Slack's seconds. Requests are
 * handled one at a time, so every second a call waits, the requests queued
 * behind it wait too, and a listing that pages through a large workspace can
 * meet a limit on each page, which a budget for the whole call bounds where one
 * per request wouldn't.
 *
 * A request made outside a request from the host has no deadline and answers a
 * rate limit at once. The client binds each of its methods to apiCall as it's
 * built (`dist/methods.js`, bindApiCall), so this override reaches every Web
 * API method call. An upload's bytes go out with fetch, outside the client,
 * under the same start rule (postFileBytes).
 */
export class SlackWebClient extends WebClient {
  /** Each request's timeout, in ms: the longest a request can take. */
  private readonly requestMs: number;

  /** `options.timeout` is required: the start rule needs each request's whole
   *  time. */
  constructor(token: string | undefined, options: WebClientOptions & { timeout: number }) {
    super(token, options);
    this.requestMs = options.timeout;
  }

  override apiCall(method: string, options?: Record<string, unknown>): Promise<WebAPICallResult> {
    return this.send(method, options, true);
  }

  /** One send of a request, which keeps the start rule as it goes out. After a
   *  rate limit the call can wait out, the request goes through here once more,
   *  so a wait whose timer fires late can't send it past the deadline. */
  private async send(method: string, options: Record<string, unknown> | undefined, mayWait: boolean): Promise<WebAPICallResult> {
    assertRequestFits(method, this.requestMs);
    const call = callTime.getStore();
    try {
      return await super.apiCall(method, options);
    } catch (err) {
      if (err !== null && typeof err === 'object') failedRequests.set(err, method);
      const wait = waitToAskAgain(err, method);
      if (
        !mayWait || !call || wait?.why !== 'limited' || !(wait.seconds >= 0 && wait.seconds <= call.secondsLeft) ||
        Date.now() + wait.seconds * 1000 + this.requestMs > call.deadline
      ) {
        throw err;
      }
      call.secondsLeft -= wait.seconds;
      await new Promise((resolve) => setTimeout(resolve, wait.seconds * 1000));
      return this.send(method, options, false);
    }
  }
}

/**
 * A logger for a Slack client that writes each line to stderr, labelled with
 * `client`, at info and above, as the client's own logger writes at its
 * default level. Over stdio, stdout carries the protocol, and the client's own
 * logger writes its info and debug lines there, with console.info and
 * console.debug. setLevel and setName, which the Logger interface asks for,
 * do nothing: the Web API and Socket Mode clients use a logger they're given
 * as it is, without calling either.
 */
export function stderrLogger(client: string): Logger {
  const write = (level: string) => (...msg: unknown[]) => console.error(`[slack-mcpl] ${client} (${level}):`, ...msg);
  return {
    debug() {},
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    getLevel: () => LogLevel.INFO,
    setLevel() {},
    setName() {},
  };
}

/**
 * The Slack clients connectSlack builds, each logging to stderr
 * (stderrLogger). auth.test's keeps the Web API client's default patience: a
 * Slack that can't be reached at launch is retried, rather than ending the
 * process, and each try has the same timeout as every other call. Every
 * request after startup goes through the adapter's, a SlackWebClient built
 * with SLACK_CLIENT_OPTIONS. Socket Mode's client builds a Web API client of
 * its own, for apps.connections.open, and gives it the same logger.
 * `slackApiUrl` is Slack's own unless given, as a test gives its local
 * endpoint.
 */
export function slackClients(
  botToken: string,
  appToken: string,
  slackApiUrl?: string,
): { auth: WebClient; web: WebClient; socket: SocketModeClient } {
  const api = slackApiUrl ? { slackApiUrl } : {};
  return {
    auth: new WebClient(botToken, { timeout: SLACK_CLIENT_OPTIONS.timeout, logger: stderrLogger('auth.test'), ...api }),
    web: new SlackWebClient(botToken, { ...SLACK_CLIENT_OPTIONS, logger: stderrLogger('Web API'), ...api }),
    socket: new SocketModeClient({ appToken, logger: stderrLogger('Socket Mode'), clientOptions: { ...api } }),
  };
}

/**
 * Connect to Slack and build an adapter: auth.test resolves the bot's own
 * user ID (for self-filtering and mention detection) and the team name
 * (for channel labels), then Socket Mode is wired but not yet started —
 * call start() after registering the message handler. `slackApiUrl` is
 * Slack's own unless given, as slackClients' is.
 */
export async function connectSlack(config: SlackAdapterConfig, slackApiUrl?: string): Promise<SlackAdapter> {
  const clients = slackClients(config.botToken, config.appToken, slackApiUrl);
  const auth = await clients.auth.auth.test();
  return new SlackAdapter(
    // WebClient satisfies SlackWebLike at runtime; the cast bridges the
    // parameter-width gap (SlackWebLike takes loose records so tests can
    // inject fakes, WebClient's methods want their exact argument types).
    clients.web as unknown as SlackWebLike,
    clients.socket,
    (auth.user_id as string | undefined) ?? null,
    (auth.team as string | undefined) ?? '',
    config.dmUsers,
    config.sendChannels,
    config.disableDms,
    config.ackReaction,
  );
}

/** A file as files.completeUploadExternal's answer describes it: `shares` names
 *  the messages that shared it, by conversation. */
export interface SlackUploadedFile {
  id?: string;
  shares?: { public?: Record<string, Array<{ ts?: string }>>; private?: Record<string, Array<{ ts?: string }>> };
}

/** The client surfaces the adapter needs — structural, so tests can inject fakes. */
export interface SlackWebLike {
  conversations: {
    list(args: Record<string, unknown>): Promise<{ channels?: unknown[]; response_metadata?: { next_cursor?: string } }>;
    info(args: { channel: string }): Promise<{ channel?: unknown }>;
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
    history(args: Record<string, unknown>): Promise<{ messages?: unknown[]; response_metadata?: { next_cursor?: string } }>;
    replies(args: Record<string, unknown>): Promise<{ messages?: unknown[]; response_metadata?: { next_cursor?: string } }>;
  };
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
    delete(args: Record<string, unknown>): Promise<unknown>;
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  files: {
    getUploadURLExternal(args: { filename: string; length: number }): Promise<{ upload_url?: string; file_id?: string }>;
    completeUploadExternal(args: Record<string, unknown>): Promise<{ files?: SlackUploadedFile[] }>;
    delete(args: { file: string }): Promise<unknown>;
  };
  users: {
    info(args: { user: string }): Promise<{ user?: { profile?: { display_name?: string }; real_name?: string; name?: string } }>;
    list(args: { limit?: number; cursor?: string }): Promise<{ members?: unknown[]; response_metadata?: { next_cursor?: string } }>;
  };
}

export interface SlackSocketLike {
  on(event: string, handler: (args: { event: SlackMessageEvent; ack: () => Promise<void> }) => void): void;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export class SlackAdapter {
  private userNameCache = new Map<string, string>();
  private messageHandlers: Array<(msg: SlackMessageData) => void> = [];
  private socketStarted = false;
  /** Conversations Slack reported as DMs or group DMs, and as channels. IDs
   *  alone don't tell them apart. */
  private dmIds = new Set<string>();
  private channelIds = new Set<string>();

  get dmsDisabled(): boolean {
    return this.disableDms;
  }

  /** Can send_dm succeed at all? A DM ID starts with D. */
  get dmsWritable(): boolean {
    return !this.disableDms && (!this.sendChannels?.length || this.sendChannels.some((id) => id.startsWith('D')));
  }

  private stopping = false;

  constructor(
    private web: SlackWebLike,
    private socket: SlackSocketLike,
    readonly botUserId: string | null,
    readonly teamName: string,
    private dmUsers?: string[],
    private sendChannels?: string[],
    private disableDms = false,
    private ackReaction?: string,
  ) {
    // Register the handler at construction so start() ordering can't race
    // an early event past an unregistered listener.
    this.socket.on('message', ({ event, ack }) => {
      void (async () => {
        // Always ack first — Slack redelivers unacked envelopes.
        try { await ack(); } catch { /* ignore */ }
        try {
          await this.handleMessageEvent(event);
        } catch (error) {
          console.error('[slack-mcpl] Failed to handle Slack message event:', error);
        }
      })();
    });
  }

  onMessage(handler: (msg: SlackMessageData) => void): void {
    this.messageHandlers.push(handler);
  }

  /** Open the Socket Mode connection. Resolves once connected. */
  async start(): Promise<void> {
    if (this.socketStarted) return;
    await this.socket.start();
    this.socketStarted = true;
  }

  async stop(): Promise<void> {
    // Best effort: take our reactions off before going away. A crash or kill
    // cannot, and leaves them on Slack. No new ones while that runs.
    this.stopping = true;
    await Promise.all([...this.ackPending.keys()].map((c) => this.clearAck(c)));
    // A removal that failed just before stop() began has armed its retry, and
    // the clear above only joined it. Nothing is tried again after a stop.
    for (const [channelId, pending] of [...this.ackPending]) {
      for (const [ts, entry] of [...pending]) this.dropAck(channelId, ts, entry);
    }
    if (this.socketStarted) {
      await this.socket.disconnect().catch(() => {});
      this.socketStarted = false;
    }
  }

  // ── Conversations ──

  /** Enumerate conversations the bot can act in: member channels, DMs, and
   *  group DMs. conversations.list also returns public channels the bot is
   *  NOT a member of (no events, no posting without joining) — those are
   *  excluded here; list_channels with includeNonMember surfaces them.
   *
   *  A page Slack rate-limits past what a call's client waits out, or that
   *  its call's deadline leaves no time for (SlackWebClient), or that fails in
   *  a way that can pass, ends the listing, unless `waitOut` is given, for a
   *  listing that runs in the background. Then the page, or the name of a DM's
   *  user, is asked for again once `waitOut` resolves (waitToAskAgain says how
   *  long). A DM whose name is still missing carries `nameWait`. */
  async listConversations(includeNonMember = false, waitOut?: SlackWaitOut): Promise<SlackConversationInfo[]> {
    const out: SlackConversationInfo[] = [];
    let cursor: string | undefined;
    let limited = 0;
    const names = { waitOut };
    for (;;) {
      let result: Awaited<ReturnType<SlackWebLike['conversations']['list']>>;
      try {
        result = await this.web.conversations.list({
          types: this.disableDms ? 'public_channel,private_channel' : 'public_channel,private_channel,im,mpim',
          exclude_archived: true,
          limit: 200,
          cursor,
        });
      } catch (err) {
        const wait = waitOut && waitToAskAgain(err, 'conversations.list');
        if (!wait) throw err;
        await waitOut!(wait, ++limited);
        continue;
      }
      limited = 0;
      for (const raw of (result.channels ?? []) as SlackApiConversation[]) {
        const info = await this.describeConversation(raw, names);
        if (!info) continue;
        if (!includeNonMember && info.kind === 'channel' && !info.isMember) continue;
        out.push(info);
      }
      cursor = result.response_metadata?.next_cursor || undefined;
      if (!cursor) return out;
    }
  }

  async getConversationMeta(channelId: string): Promise<SlackConversationInfo | null> {
    const info = await this.web.conversations.info({ channel: channelId });
    return this.describeConversation((info.channel ?? {}) as SlackApiConversation);
  }

  /** `names.waitOut`, in a listing that runs in the background, waits out a
   *  DM's name lookup that can pass; describeConversation clears it once it
   *  gives up on a name. */
  private async describeConversation(
    conv: SlackApiConversation,
    names?: { waitOut?: SlackWaitOut },
  ): Promise<SlackConversationInfo | null> {
    if (!conv.id) return null;
    if (conv.is_im) {
      // DM: label with the human's name so the host can scope/whitelist it.
      // The host keeps a registered DM's label, so a listing in the background
      // waits out a lookup that can pass, as it does a page. When the wait gives
      // up on a name, the DM is labelled with the user's id, as a refused
      // lookup's is, and the listing goes on; later DMs in it are looked up
      // once, without waiting, so a lookup that keeps failing holds it once.
      let nameWait: SlackWait | undefined;
      for (let inARow = 0; conv.user;) {
        const failed = (await this.resolveUserNames([conv.user])).get(conv.user);
        nameWait = waitToAskAgain(failed, 'users.info');
        if (!nameWait || !names?.waitOut) break;
        try {
          await names.waitOut(nameWait, ++inARow);
        } catch (err) {
          if (!(err instanceof GaveUp)) throw err;
          console.error(
            `[slack-mcpl] Gave up on the name of user ${conv.user}: ${err.message}. DM ${conv.id} is labelled with ` +
              "the user's id, and the listing's later DMs are looked up without waiting.",
          );
          names.waitOut = undefined;
          break;
        }
      }
      const userName = (conv.user ? this.userNameCache.get(conv.user) : undefined) ?? conv.user ?? conv.id;
      this.dmIds.add(conv.id);
      return { id: conv.id, kind: 'dm', name: userName, userId: conv.user, isMember: true, ...(nameWait ? { nameWait } : {}) };
    }
    if (conv.is_mpim) {
      this.dmIds.add(conv.id);
      return { id: conv.id, kind: 'group_dm', name: conv.name ?? conv.id, isMember: true };
    }
    // Cached as a channel only when Slack says outright it is neither kind of DM.
    if (conv.is_im === false && conv.is_mpim === false) this.channelIds.add(conv.id);
    return {
      id: conv.id,
      kind: conv.is_private ? 'private_channel' : 'channel',
      name: conv.name ?? conv.id,
      topic: conv.topic?.value || undefined,
      isMember: !!conv.is_member,
      numMembers: conv.num_members,
    };
  }

  // ── Messaging ──

  /** Slack scopes are workspace-wide, so "speak only here" is enforced here:
   *  the one place every write passes through. */
  canWrite(channelId: string): boolean {
    return !this.sendChannels?.length || this.sendChannels.includes(channelId);
  }

  private assertWritable(channelId: string): void {
    if (!this.canWrite(channelId)) {
      throw new Error(
        `Writing to ${channelId} is not allowed: this bot may only write to ${this.sendChannels?.join(', ')} (SLACK_SEND_CHANNELS)`,
      );
    }
  }

  // ── Acknowledgement reaction ──
  // Slack has no typing indicator for bots, so "received" is shown as a
  // reaction on the message that addressed the bot, removed when the bot next
  // posts in that conversation or after ACK_TTL_MS, whichever comes first.

  /** `added` settles once reactions.add is answered or its request fails, so a
   *  removal never overtakes an add Slack has answered. An add whose request
   *  timed out can still reach Slack after the removal. */
  private ackPending = new Map<string, Map<string, AckEntry>>();

  private armAck(channelId: string, ts: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => void this.clearAck(channelId, ts), ms);
    timer.unref?.();
    return timer;
  }

  /** Forget `entry`, unless a newer entry has taken its place. */
  private dropAck(channelId: string, ts: string, entry: AckEntry): void {
    const pending = this.ackPending.get(channelId);
    if (!pending || pending.get(ts) !== entry) return;
    clearTimeout(entry.timer);
    pending.delete(ts);
    if (pending.size === 0) this.ackPending.delete(channelId);
  }

  /** Mark an addressed message as received. Best-effort: never throws. */
  async acknowledge(channelId: string, ts: string): Promise<void> {
    if (!this.ackReaction || this.stopping) return;
    if (this.ackPending.get(channelId)?.has(ts)) return; // Slack delivered the event twice
    const added = this.addReaction(channelId, ts, this.ackReaction).then(
      () => true,
      // The add counts as there, and is removed like an added one, when it may
      // have landed: already_reacted says it's there; Slack's failure while
      // handling it leaves it unknown, as the explainer says (internal_error
      // and fatal_error can take effect in part); and so does an HTTP error or
      // a request that failed after it may have reached Slack. Slack's
      // refusals, its rate limits (a 429, or ratelimited in a 200) and
      // request_timeout say it didn't act, a connection never made reached
      // nothing, and this server's own refusal, such as the write allow-list's,
      // sent nothing. Slack answers a removal of one that isn't there with
      // no_reaction.
      (err: { code?: unknown; original?: { code?: unknown }; data?: { error?: unknown } } | null) => {
        if (err?.code === ErrorCode.RequestError) return !connectionNeverMade(err.original?.code);
        if (err?.code === ErrorCode.HTTPError) return true;
        const answer = err?.code === ErrorCode.PlatformError ? err.data?.error : undefined;
        return typeof answer === 'string' && MAY_HAVE_LANDED.has(answer);
      },
    );
    // Recorded before the add resolves, so a reply that lands first still removes it.
    let pending = this.ackPending.get(channelId);
    if (!pending) this.ackPending.set(channelId, (pending = new Map()));
    const entry: AckEntry = { timer: this.armAck(channelId, ts, ACK_TTL_MS), added, tries: 0 };
    pending.set(ts, entry);
    if (!(await added)) this.dropAck(channelId, ts, entry); // not there, so nothing to remove
  }

  /** Remove the reaction from one message, or from every pending message in the
   *  conversation. A removal that failed without an answer from Slack (rate
   *  limit, HTTP or network error) is tried again; one Slack refused is not. */
  async clearAck(channelId: string, ts?: string): Promise<void> {
    const pending = this.ackPending.get(channelId);
    if (!pending || !this.ackReaction) return;
    const targets = ts === undefined ? [...pending.keys()] : pending.has(ts) ? [ts] : [];
    await Promise.all(targets.map((t) => {
      const entry = pending.get(t);
      if (!entry) return;
      // Posts, expiry, and shutdown share one removal, including the wait
      // for reactions.add. Reserve it before any asynchronous work settles.
      entry.removing ??= this.removeAck(channelId, t, entry).finally(() => {
        entry.removing = undefined;
      });
      return entry.removing;
    }));
  }

  private async removeAck(channelId: string, ts: string, entry: AckEntry): Promise<void> {
    clearTimeout(entry.timer);
    if (!(await entry.added)) return this.dropAck(channelId, ts, entry);
    entry.tries++;
    try {
      await this.web.reactions.remove({ channel: channelId, timestamp: ts, name: this.ackReaction! });
      this.dropAck(channelId, ts, entry);
    } catch (err) {
      // Slack's own answer (data.error) will be the same next time. The fifth
      // failure drops the entry, so no sixth attempt can start.
      const answered = !!(err as { data?: { error?: string } } | null)?.data?.error;
      if (answered || this.stopping || entry.tries >= ACK_MAX_TRIES) this.dropAck(channelId, ts, entry);
      else entry.timer = this.armAck(channelId, ts, ACK_RETRY_MS);
    }
  }

  async sendMessage(
    channelId: string,
    text: string,
    opts: { threadTs?: string } = {},
  ): Promise<{ messageId: string }> {
    this.assertWritable(channelId);
    await this.assertNotDm(channelId);
    const result = await this.web.chat.postMessage({
      channel: channelId,
      text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
    void outsideCallTime(() => this.clearAck(channelId));
    return { messageId: result.ts ? String(result.ts) : '' };
  }

  /** Upload a file into a conversation, in the three steps of Slack's
   *  working-with-files page: files.getUploadURLExternal gives an upload URL
   *  and the file's ID, the file's bytes go to that URL, and
   *  files.completeUploadExternal shares the file. Same write checks as
   *  sendMessage. Needs the files:write scope.
   *
   *  A file is shared only at the last step, so a failure before it shared
   *  nothing. Once the first step has given the file its ID, a failure leaves
   *  that file on its error (fileLeftByUpload) for rollback, with whether
   *  Slack may have shared it: only if the last step's own request may have
   *  taken effect. An answer that names no file throws UploadNotConfirmed,
   *  whose file rides on it the same way, possibly shared. `shareTs` is the
   *  message that shared the file, when the answer names it: it holds the
   *  comment, which rollback deletes after the file. */
  async uploadFile(
    channelId: string,
    file: { filename: string; data: Buffer; title?: string; comment?: string; threadTs?: string },
  ): Promise<{ fileId: string; shareTs?: string }> {
    this.assertWritable(channelId);
    await this.assertNotDm(channelId);
    const target = await this.web.files.getUploadURLExternal({ filename: file.filename, length: file.data.byteLength });
    const url = target.upload_url;
    const fileId = target.file_id;
    if (typeof fileId !== 'string' || !fileId) {
      throw new Error("files.getUploadURLExternal: Slack's answer gave no file ID, so nothing was uploaded");
    }
    // Slack gave the file its ID at the first step, so whatever fails from
    // here leaves that file for a rollback to delete. Only the last step's
    // own request can have shared it.
    const left = (err: unknown, mayHaveShared: boolean): unknown => {
      if (err !== null && typeof err === 'object') filesLeft.set(err, { fileId, mayHaveShared });
      return err;
    };
    if (typeof url !== 'string' || !url) {
      throw left(new Error("files.getUploadURLExternal: Slack's answer gave no upload URL, so nothing was uploaded"), false);
    }
    try {
      await this.postFileBytes(url, file.data);
    } catch (err) {
      throw left(err, false);
    }
    let answer: Awaited<ReturnType<SlackWebLike['files']['completeUploadExternal']>>;
    try {
      answer = await this.web.files.completeUploadExternal({
        files: [{ id: fileId, title: file.title ?? file.filename }],
        channel_id: channelId,
        ...(file.comment ? { initial_comment: file.comment } : {}),
        ...(file.threadTs ? { thread_ts: file.threadTs } : {}),
      });
    } catch (err) {
      throw left(err, !cannotHaveLanded(err));
    }
    const shared = answer.files?.find((f) => f.id === fileId);
    if (!shared) throw left(new UploadNotConfirmed(fileId), true);
    // The working reaction comes off whatever time the call has left, as a
    // sent message's does.
    void outsideCallTime(() => this.clearAck(channelId));
    return { fileId, shareTs: sharingTs(shared, channelId) };
  }

  /** Posts a file's bytes to the upload URL Slack gave, as Slack's
   *  working-with-files page does: the bytes as the body. Like every request a
   *  call makes, it keeps the start rule and the client's timeout, which
   *  covers the whole post. The URL needs no token. */
  private async postFileBytes(url: string, data: Buffer): Promise<void> {
    assertRequestFits("The upload of the file's bytes", SLACK_CLIENT_OPTIONS.timeout);
    try {
      const answer = await fetch(url, {
        method: 'POST',
        body: data,
        headers: { 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(SLACK_CLIENT_OPTIONS.timeout),
      });
      await answer.arrayBuffer();
      if (!answer.ok) throw new UploadBytesFailed(answer.status);
    } catch (err) {
      if (err instanceof UploadBytesFailed) throw err;
      throw new UploadBytesFailed((err as { name?: unknown } | null)?.name === 'TimeoutError' ? 'TimeoutError' : 'transit');
    }
  }

  /** With SLACK_DISABLE_DMS, only a conversation Slack confirmed to be a
   *  channel may be written to or read. Every write path and both history
   *  reads call this. An ID is not enough: a group DM ID looks like a channel
   *  ID, and a user ID (U…) posts into that user's DM. An unknown ID is asked
   *  about until Slack confirms it; if Slack cannot say, it is refused. */
  private async assertNotDm(channelId: string): Promise<void> {
    if (!this.disableDms || this.channelIds.has(channelId)) return;
    const refuse = (why: string) =>
      new Error(`Conversation ${channelId} ${why}; direct messages are disabled for this bot (SLACK_DISABLE_DMS)`);
    if (this.dmIds.has(channelId) || channelId.startsWith('D')) throw refuse('is a DM');
    try {
      await this.getConversationMeta(channelId); // fills channelIds for this very ID, or not
    } catch (err) {
      // A check that couldn't be made and can pass (rate-limited, out of its
      // call's time, failed on the way or by Slack's own failure) keeps its
      // error for the explainer, which reads it as this request's, made
      // before the write: nothing was written, and calling again can confirm
      // the conversation. Anything else, Slack's refusal included, leaves it
      // unconfirmed, and the write is refused.
      if (waitToAskAgain(err, 'conversations.info')) throw err;
      throw refuse(`could not be confirmed as a channel (${(err as Error).message})`);
    }
    if (!this.channelIds.has(channelId)) throw refuse('is not a channel');
  }

  async sendDM(userId: string, text: string): Promise<{ messageId: string; channelId: string }> {
    if (this.disableDms) throw new Error('Direct messages are disabled for this bot (SLACK_DISABLE_DMS)');
    // A DM ID starts with D. If the allow-list names none, no DM can be written,
    // so don't open one just to find that out.
    if (this.sendChannels?.length && !this.sendChannels.some((id) => id.startsWith('D'))) {
      throw new Error('Writing to a direct message is not allowed: SLACK_SEND_CHANNELS lists no DM conversation');
    }
    const open = await this.web.conversations.open({ users: userId });
    const channelId = open.channel?.id;
    if (!channelId) throw new Error(`Could not open a DM with user ${userId}`);
    const { messageId } = await this.sendMessage(channelId, text);
    return { messageId, channelId };
  }

  async editMessage(channelId: string, ts: string, text: string): Promise<void> {
    this.assertWritable(channelId);
    await this.assertNotDm(channelId);
    await this.web.chat.update({ channel: channelId, ts, text });
  }

  async deleteMessage(channelId: string, ts: string): Promise<void> {
    this.assertWritable(channelId);
    await this.assertNotDm(channelId);
    await this.web.chat.delete({ channel: channelId, ts });
  }

  /** Deletes a file this bot uploaded, with the same write checks as a
   *  message's delete. */
  async deleteFile(channelId: string, fileId: string): Promise<void> {
    this.assertWritable(channelId);
    await this.assertNotDm(channelId);
    await this.web.files.delete({ file: fileId });
  }

  async addReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    this.assertWritable(channelId);
    await this.assertNotDm(channelId);
    await this.web.reactions.add({ channel: channelId, timestamp: ts, name: reactionName(emoji) });
  }

  // ── History ──

  /** Channel-level history, oldest-first. Thread replies are NOT included
   *  (Slack requires conversations.replies per thread — see fetchThread). */
  async fetchHistory(
    channelId: string,
    opts: { limit?: number; oldest?: string; latest?: string } = {},
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
    await this.assertNotDm(channelId);
    const { messages, truncated } = await fetchSlackHistory(this.web, {
      channel: channelId,
      ...(opts.oldest !== undefined ? { oldest: opts.oldest } : {}),
      ...(opts.latest !== undefined ? { latest: opts.latest } : {}),
      maxMessages: opts.limit ?? 50,
    });
    return { messages: await this.shapeHistory(messages), truncated };
  }

  /** All replies in a thread (the parent message is included first). */
  async fetchThread(
    channelId: string,
    threadTs: string,
    limit = 100,
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
    await this.assertNotDm(channelId);
    const collected: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    let truncated = false;
    do {
      const result = await this.web.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: Math.min(200, limit - collected.length),
        cursor,
      });
      collected.push(...((result.messages ?? []) as SlackHistoryMessage[]));
      cursor = result.response_metadata?.next_cursor || undefined;
      if (cursor && collected.length >= limit) {
        truncated = true;
        cursor = undefined;
      }
    } while (cursor);
    // conversations.replies returns oldest-first already.
    return { messages: await this.shapeHistory(collected), truncated };
  }

  private async shapeHistory(messages: SlackHistoryMessage[]): Promise<HistoryMessage[]> {
    // Pre-resolve author + mentioned user names in one pass.
    const ids = new Set<string>();
    for (const msg of messages) {
      if (msg.user) ids.add(msg.user);
      for (const id of extractSlackUserIds(msg.text ?? '')) ids.add(id);
    }
    await this.resolveUserNames(Array.from(ids));

    return messages.map((msg) => ({
      id: String(msg.ts ?? ''),
      authorId: msg.user,
      authorName: msg.user ? (this.userNameCache.get(msg.user) ?? msg.user) : (msg.username ?? 'bot'),
      content: formatSlackText(msg.text ?? '', this.userNameCache),
      threadTs: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
      timestamp: new Date(parseFloat(msg.ts ?? '0') * 1000),
      attachments: (msg.files ?? []).map((f) => ({
        name: f.name ?? 'attachment',
        mimeType: f.mimetype,
        url: f.url_private,
      })),
    }));
  }

  // ── Users ──

  async findUsers(query: string, max = 25): Promise<SlackUserMatch[]> {
    const q = query.toLowerCase();
    if (!q) throw new Error('query is required');
    const matches: SlackUserMatch[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.web.users.list({ limit: 200, cursor });
      for (const raw of (result.members ?? []) as Array<{
        id?: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean;
        profile?: { display_name?: string };
      }>) {
        if (!raw.id || raw.deleted || raw.is_bot) continue;
        const name = raw.name?.toLowerCase() ?? '';
        const realName = raw.real_name?.toLowerCase() ?? '';
        const displayName = raw.profile?.display_name?.toLowerCase() ?? '';
        if (name.includes(q) || realName.includes(q) || displayName.includes(q)) {
          matches.push({
            userId: raw.id,
            username: raw.name,
            realName: raw.real_name,
            displayName: raw.profile?.display_name,
          });
          if (matches.length >= max) break;
        }
      }
      cursor = matches.length >= max
        ? undefined
        : (result.response_metadata?.next_cursor || undefined);
    } while (cursor);
    return matches;
  }

  // ── Incoming events ──

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!event || event.type !== 'message') return;
    if (!CONTENT_SUBTYPES.has(event.subtype)) return;
    // Self-filter: skip our own messages and other bots' (bot_id covers
    // bot_message-without-subtype edge cases like app-posted file shares).
    if (event.bot_id) return;
    if (this.botUserId !== null && event.user === this.botUserId) return;
    // A real user content message always carries channel, user, and ts;
    // a malformed payload missing any of them is dropped, not crashed on
    // (parseFloat(undefined) → NaN → toISOString() throws).
    if (!event.channel || !event.user || !event.ts) return;

    const isDM = event.channel_type === 'im' || event.channel.startsWith('D');
    // Only what Slack marks as a channel gets through, not merely what isn't marked a DM.
    if (this.disableDms && event.channel_type !== 'channel' && event.channel_type !== 'group') return;
    if (isDM && this.dmUsers && this.dmUsers.length > 0 && !this.dmUsers.includes(event.user)) {
      return; // DM whitelist active and this sender isn't on it
    }

    // Resolve author + mentioned users before formatting.
    const mentionIds = extractSlackUserIds(event.text ?? '');
    await this.resolveUserNames([event.user, ...mentionIds]);
    const authorName = this.userNameCache.get(event.user) ?? event.user;

    const attachments: AttachmentRef[] = (event.files ?? [])
      .filter((f): f is { url_private: string; name?: string; mimetype?: string } => !!f.url_private)
      .map((f) => {
        const name = f.name ?? 'attachment';
        const mime = f.mimetype || classifyExtension(name).mimeType;
        return {
          path: f.url_private, // needs Bearer bot-token auth to fetch
          name,
          mimeType: mime,
          isImage: mime.startsWith('image/'),
        };
      });

    const msg: SlackMessageData = {
      channelId: event.channel,
      id: String(event.ts),
      threadTs: event.thread_ts || event.root?.thread_ts || undefined,
      authorId: String(event.user),
      authorName,
      content: event.text ?? '',
      cleanContent: formatSlackText(event.text ?? '', this.userNameCache),
      mentionIds,
      // Personal mention of the bot — hosts use this to gate wake policy.
      // @here/@channel broadcasts deliberately don't count.
      mentionsBot: this.botUserId !== null && mentionIds.includes(this.botUserId),
      isDM,
      channelType: event.channel_type,
      teamId: event.team,
      timestamp: new Date(parseFloat(event.ts) * 1000),
      attachments,
    };

    for (const handler of this.messageHandlers) handler(msg);
  }

  /** Resolve user IDs into this adapter's cache (shared logic in content.ts).
   *  Returns the error of each lookup left uncached. */
  private async resolveUserNames(userIds: Array<string | undefined>): Promise<Map<string, unknown>> {
    return resolveSlackUserNames(
      this.web,
      this.userNameCache,
      userIds.filter((id): id is string => !!id),
    );
  }
}
