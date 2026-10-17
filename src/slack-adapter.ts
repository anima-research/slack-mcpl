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

import { WebClient, ErrorCode, type WebClientOptions } from '@slack/web-api';
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
/** Slack's answers to an acknowledgement's add after which it may be there:
 *  already_reacted, and the failures the explainer calls an unknown outcome. */
const MAY_HAVE_LANDED = new Set(['already_reacted', 'internal_error', 'fatal_error', 'service_unavailable']);

type AckEntry = { timer: ReturnType<typeof setTimeout>; added: Promise<boolean>; tries: number };

/** How long work no call waits on waits before asking Slack again after a
 *  failure that gives no Retry-After. */
const FAILED_WAIT_SECONDS = 30;

/** Why work no call waits on, such as channel registration, waits before
 *  asking Slack again after a request to `method`: Slack rate-limited it and
 *  asked for this many seconds (`limited`), or it failed in a way that can
 *  pass: in transit, with an HTTP error, or by Slack's own failure (`failed`). */
export interface SlackWait {
  method: string;
  seconds: number;
  why: 'limited' | 'failed';
}

/** The wait before asking Slack again after `err` from a request to `method`,
 *  for work no call waits on; undefined when Slack's answer will be the same
 *  next time, or `err` isn't the client's. */
export function waitToAskAgain(err: unknown, method: string): SlackWait | undefined {
  const e = err as { code?: unknown; retryAfter?: unknown; data?: { error?: unknown } } | null;
  if (e?.code === ErrorCode.RateLimitedError && typeof e.retryAfter === 'number') {
    return { method, seconds: e.retryAfter, why: 'limited' };
  }
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
 * Slack's Retry-After (rejectRateLimitedCalls). A failure in transit comes
 * back without the request being sent again (no retries), so this client never
 * sends a post that may have reached Slack a second time. A request fails once
 * Slack has gone 10 seconds without answering, or without sending more of its
 * answer, inside the host's own request timeout (30 s by mcpl-core's default,
 * 60 s by agent-framework's); an answer that keeps arriving a little at a time
 * isn't cut off. With the client's defaults, a rate limit or a network failure
 * was retried inside the call for up to about 30 minutes, and every request
 * behind it waited, since requests are handled one at a time.
 */
export const SLACK_CLIENT_OPTIONS = {
  rejectRateLimitedCalls: true,
  retryConfig: { retries: 0 },
  timeout: 10_000,
} satisfies WebClientOptions;

/**
 * The two Web API clients connectSlack builds. auth.test's keeps the client's
 * default patience: a Slack that can't be reached at launch is retried,
 * rather than ending the process, and each try has the same timeout as every
 * other call. Every request after startup goes through the adapter's, built
 * with SLACK_CLIENT_OPTIONS.
 */
export function slackClients(token: string): { auth: WebClient; web: WebClient } {
  return {
    auth: new WebClient(token, { timeout: SLACK_CLIENT_OPTIONS.timeout }),
    web: new WebClient(token, SLACK_CLIENT_OPTIONS),
  };
}

/**
 * Connect to Slack and build an adapter: auth.test resolves the bot's own
 * user ID (for self-filtering and mention detection) and the team name
 * (for channel labels), then Socket Mode is wired but not yet started —
 * call start() after registering the message handler.
 */
export async function connectSlack(config: SlackAdapterConfig): Promise<SlackAdapter> {
  const clients = slackClients(config.botToken);
  const auth = await clients.auth.auth.test();
  const socket = new SocketModeClient({ appToken: config.appToken });
  return new SlackAdapter(
    // WebClient satisfies SlackWebLike at runtime; the cast bridges the
    // parameter-width gap (SlackWebLike takes loose records so tests can
    // inject fakes, WebClient's methods want their exact argument types).
    clients.web as unknown as SlackWebLike,
    socket,
    (auth.user_id as string | undefined) ?? null,
    (auth.team as string | undefined) ?? '',
    config.dmUsers,
    config.sendChannels,
    config.disableDms,
    config.ackReaction,
  );
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
   *  A page Slack rate-limits, or that fails in a way that can pass, ends the
   *  listing, unless `waitOut` is given, for a listing that runs in the
   *  background. Then the page, or the name of a DM's user, is asked for again
   *  once `waitOut` resolves (waitToAskAgain says how long). A DM whose name
   *  is still missing carries `nameWait`. */
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
    await Promise.all(targets.map(async (t) => {
      const entry = pending.get(t);
      if (!entry) return;
      clearTimeout(entry.timer);
      if (!(await entry.added)) return this.dropAck(channelId, t, entry);
      try {
        await this.web.reactions.remove({ channel: channelId, timestamp: t, name: this.ackReaction! });
        this.dropAck(channelId, t, entry);
      } catch (err) {
        // Slack's own answer (data.error) will be the same next time.
        const answered = !!(err as { data?: { error?: string } }).data?.error;
        if (answered || ++entry.tries >= ACK_MAX_TRIES) this.dropAck(channelId, t, entry);
        else entry.timer = this.armAck(channelId, t, ACK_RETRY_MS);
      }
    }));
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
    void this.clearAck(channelId);
    return { messageId: result.ts ? String(result.ts) : '' };
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
