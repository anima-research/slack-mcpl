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

import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import {
  formatSlackText,
  extractSlackUserIds,
  resolveSlackUserNames,
  fetchSlackHistory,
  classifyExtension,
  type AttachmentRef,
  type SlackHistoryMessage,
} from './content.js';

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
}

/**
 * Connect to Slack and build an adapter: auth.test resolves the bot's own
 * user ID (for self-filtering and mention detection) and the team name
 * (for channel labels), then Socket Mode is wired but not yet started —
 * call start() after registering the message handler.
 */
export async function connectSlack(config: SlackAdapterConfig): Promise<SlackAdapter> {
  const web = new WebClient(config.botToken);
  const auth = await web.auth.test();
  const socket = new SocketModeClient({ appToken: config.appToken });
  return new SlackAdapter(
    // WebClient satisfies SlackWebLike at runtime; the cast bridges the
    // parameter-width gap (SlackWebLike takes loose records so tests can
    // inject fakes, WebClient's methods want their exact argument types).
    web as unknown as SlackWebLike,
    socket,
    (auth.user_id as string | undefined) ?? null,
    (auth.team as string | undefined) ?? '',
    config.dmUsers,
    config.sendChannels,
    config.disableDms,
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

  constructor(
    private web: SlackWebLike,
    private socket: SlackSocketLike,
    readonly botUserId: string | null,
    readonly teamName: string,
    private dmUsers?: string[],
    private sendChannels?: string[],
    private disableDms = false,
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
    if (this.socketStarted) {
      await this.socket.disconnect().catch(() => {});
      this.socketStarted = false;
    }
  }

  // ── Conversations ──

  /** Enumerate conversations the bot can act in: member channels, DMs, and
   *  group DMs. conversations.list also returns public channels the bot is
   *  NOT a member of (no events, no posting without joining) — those are
   *  excluded here; list_channels with includeNonMember surfaces them. */
  async listConversations(includeNonMember = false): Promise<SlackConversationInfo[]> {
    const out: SlackConversationInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.web.conversations.list({
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const raw of (result.channels ?? []) as SlackApiConversation[]) {
        const info = await this.describeConversation(raw);
        if (!info) continue;
        if (!includeNonMember && info.kind === 'channel' && !info.isMember) continue;
        out.push(info);
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  async getConversationMeta(channelId: string): Promise<SlackConversationInfo | null> {
    const info = await this.web.conversations.info({ channel: channelId });
    return this.describeConversation((info.channel ?? {}) as SlackApiConversation);
  }

  private async describeConversation(conv: SlackApiConversation): Promise<SlackConversationInfo | null> {
    if (!conv.id) return null;
    if (conv.is_im) {
      // DM: label with the human's name so the host can scope/whitelist it.
      await this.resolveUserNames([conv.user]);
      const userName = (conv.user ? this.userNameCache.get(conv.user) : undefined) ?? conv.user ?? conv.id;
      return { id: conv.id, kind: 'dm', name: userName, userId: conv.user, isMember: true };
    }
    if (conv.is_mpim) {
      return { id: conv.id, kind: 'group_dm', name: conv.name ?? conv.id, isMember: true };
    }
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
  private assertWritable(channelId: string): void {
    if (this.sendChannels?.length && !this.sendChannels.includes(channelId)) {
      throw new Error(
        `Writing to ${channelId} is not allowed: this bot may only write to ${this.sendChannels.join(', ')} (SLACK_SEND_CHANNELS)`,
      );
    }
  }

  async sendMessage(
    channelId: string,
    text: string,
    opts: { threadTs?: string } = {},
  ): Promise<{ messageId: string }> {
    this.assertWritable(channelId);
    const result = await this.web.chat.postMessage({
      channel: channelId,
      text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
    return { messageId: result.ts ? String(result.ts) : '' };
  }

  /** DM and group-DM conversation IDs start with D; mpim ones with G are
   *  indistinguishable from private channels by ID, so the scope list is
   *  what keeps group DMs out. */
  private assertNotDm(channelId: string): void {
    if (this.disableDms && channelId.startsWith('D')) {
      throw new Error('Direct messages are disabled for this bot (SLACK_DISABLE_DMS)');
    }
  }

  async sendDM(userId: string, text: string): Promise<{ messageId: string; channelId: string }> {
    if (this.disableDms) throw new Error('Direct messages are disabled for this bot (SLACK_DISABLE_DMS)');
    const open = await this.web.conversations.open({ users: userId });
    const channelId = open.channel?.id;
    if (!channelId) throw new Error(`Could not open a DM with user ${userId}`);
    const { messageId } = await this.sendMessage(channelId, text);
    return { messageId, channelId };
  }

  async editMessage(channelId: string, ts: string, text: string): Promise<void> {
    this.assertWritable(channelId);
    await this.web.chat.update({ channel: channelId, ts, text });
  }

  async deleteMessage(channelId: string, ts: string): Promise<void> {
    this.assertWritable(channelId);
    await this.web.chat.delete({ channel: channelId, ts });
  }

  async addReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    this.assertWritable(channelId);
    // Slack wants the bare emoji name; accept :name: and strip the colons.
    await this.web.reactions.add({ channel: channelId, timestamp: ts, name: emoji.replace(/:/g, '') });
  }

  // ── History ──

  /** Channel-level history, oldest-first. Thread replies are NOT included
   *  (Slack requires conversations.replies per thread — see fetchThread). */
  async fetchHistory(
    channelId: string,
    opts: { limit?: number; oldest?: string; latest?: string } = {},
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
    this.assertNotDm(channelId);
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
    this.assertNotDm(channelId);
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
    if (this.disableDms && (isDM || event.channel_type === 'mpim')) return;
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
      threadTs: event.thread_ts || undefined,
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

  /** Resolve user IDs into this adapter's cache (shared logic in content.ts). */
  private async resolveUserNames(userIds: Array<string | undefined>): Promise<void> {
    await resolveSlackUserNames(
      this.web,
      this.userNameCache,
      userIds.filter((id): id is string => !!id),
    );
  }
}
