/**
 * SlackMcplServer — main MCPL server orchestrator.
 *
 * Handles the JSON-RPC main loop: initialize handshake, method dispatch,
 * and forwarding Slack events to the connected host.
 *
 * Follows the pattern of discord-mcpl's DiscordMcplServer (which in turn
 * follows zero-k/game-manager/src/mcpl_server.rs); Slack domain logic
 * salvaged from zulip-mcp PR #8.
 */

import {
  McplConnection,
  textContent,
  method,
} from '@animalabs/mcpl-core';

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  McplCapabilities,
  McplInitializeParams,
  McplInitializeResult,
  InitializeCapabilities,
  FeatureSetsUpdateParams,
  PushEventParams,
  ChannelsRegisterParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelsIncomingParams,
  ChannelsListResult,
  StateRollbackParams,
  StateRollbackResult,
  ChannelDescriptor,
  ContentBlock,
} from '@animalabs/mcpl-core';

import type { SlackAdapter, SlackMessageData } from './slack-adapter.js';
import { toolDefinitions } from './tools.js';
import { buildFeatureSets, buildServerCapabilities, featureSetForTool, MESSAGING_FEATURE_SET } from './feature-sets.js';
import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor } from './channels.js';
import { StateTracker } from './state.js';
import { CapabilityGrant } from './grant.js';
import { McplRpcError, capabilityDenied } from './errors.js';
import {
  fetchAttachmentBytes,
  parseSlackAttachmentUrl,
  toFetchResult,
  type AttachmentRef,
} from './content.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Diagnostic file logger — bypasses the host's stderr capture. Set
// SLACK_MCPL_DEBUG_LOG in the spawn env to a writable absolute path to
// enable; leave unset for no-op.
const _DEBUG_LOG_PATH = process.env.SLACK_MCPL_DEBUG_LOG;
function dbg(tag: string, info: Record<string, unknown> = {}): void {
  if (!_DEBUG_LOG_PATH) return;
  try {
    appendFileSync(
      _DEBUG_LOG_PATH,
      `${new Date().toISOString()} ${tag} ${JSON.stringify(info)}\n`,
    );
  } catch {
    // Logging is best-effort; never break the server because of it.
  }
}

/** The bracketed header in front of an incoming message, e.g.
 *  `[#support (acme) thread=1718000000.000100 id=1718000000.000200] `. */
export function locationHeader(loc: {
  conversation?: string;
  teamName?: string;
  threadTs?: string;
  messageId: string;
}): string {
  const parts: string[] = [];
  if (loc.conversation) parts.push(loc.conversation);
  if (loc.teamName) parts.push(`(${loc.teamName})`);
  if (loc.threadTs) parts.push(`thread=${loc.threadTs}`);
  parts.push(`id=${loc.messageId}`);
  return `[${parts.join(' ')}] `;
}

/** One backscroll line, e.g. `[2024-06-10T05:33:20.000Z thread=1718000000.000100 id=1718000000.000150] Ann: hi`.
 *  A thread reply names its parent, so the agent can reply into that thread. */
export function backscrollLine(m: {
  id: string;
  threadTs?: string;
  timestamp: Date;
  authorName: string;
  content: string;
  attachments: Array<{ name: string }>;
}): string {
  const att = m.attachments.length > 0 ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]` : '';
  const thread = m.threadTs ? ` thread=${m.threadTs}` : '';
  return `[${m.timestamp.toISOString()}${thread} id=${m.id}] ${m.authorName}: ${m.content}${att}`;
}

/** The `<backscroll>` block given with the first message from a conversation. */
export function backscrollBlock(
  messages: Parameters<typeof backscrollLine>[0][],
  where: { channelName?: string; isDM: boolean },
): string {
  const attrs: string[] = [];
  if (where.channelName && !where.isDM) attrs.push(`channel="#${where.channelName}"`);
  if (where.isDM) attrs.push('dm="true"');
  attrs.push(`count="${messages.length}"`);
  return [`<backscroll ${attrs.join(' ')}>`, ...messages.map(backscrollLine), '</backscroll>'].join('\n');
}

export class SlackMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private grant = new CapabilityGrant(buildFeatureSets());
  private channelManager = new ChannelManager();
  private stateTracker = new StateTracker();

  /** Conversations the agent has opted into for ambient (non-mention,
   *  non-DM) message delivery. Mentions and DMs always come through
   *  regardless — this only gates passive awareness of channel chatter.
   *  Persisted to `SLACK_SUBSCRIPTIONS_FILE` (a JSON array of conversation
   *  IDs) so the list survives restarts. */
  private subscribedChannels = new Set<string>();
  private subscriptionsLoaded = false;

  /** Per-conversation ts of the newest message forwarded to the host this
   *  process. Used to bound the first-interaction backscroll fetch. In-memory
   *  only — resets on restart. */
  private forwardedWatermark = new Map<string, string>();

  /** Thread routing for host publishes: the thread_ts of the most recent
   *  incoming message per conversation. channels/publish carries no thread
   *  information, so "reply where the conversation is" is reconstructed
   *  here — a publish goes into the last incoming message's thread, or
   *  top-level when the conversation isn't threaded. */
  private lastIncomingThreadTs = new Map<string, string | undefined>();
  /** Thread of each conversation's newest incoming message (its own ts when
   *  top-level): where the typing status goes. */
  private lastIncomingRoot = new Map<string, string>();

  /** Most recently active conversation (either direction) — used to decide
   *  when an incoming message needs a location header. */
  private lastChannelId: string | null = null;

  /** How many backscroll messages to fetch on first interaction. Tunable via
   *  SLACK_BACKSCROLL_LIMIT; clamped to [1, 1000], default 50. */
  private get backscrollLimit(): number {
    const raw = process.env.SLACK_BACKSCROLL_LIMIT;
    if (!raw) return 50;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 1000 ? n : 50;
  }

  /** Conversations muted with unsubscribe_channel while every member channel
   *  counts as subscribed (`subscribeMemberChannels`). */
  private mutedChannels = new Set<string>();

  /** Conversations whose read-only note the agent has been given. */
  private readOnlyNoted = new Set<string>();

  /**
   * `subscribeMemberChannels`: Slack only delivers message events from
   * conversations the bot is a member of, so every delivered conversation
   * counts as subscribed: inviting the bot is the opt-in.
   */
  constructor(
    private slack: SlackAdapter,
    private opts: { subscribeMemberChannels?: boolean } = {},
  ) {}

  /**
   * Serve a single connection. Blocks until the connection closes.
   * The Slack adapter should already be connected before calling this.
   */
  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;

    // Every connection starts from nothing (§5.3) — a previous peer's grant
    // is not this peer's.
    this.grant.reset();
    this.readOnlyNoted.clear(); // a new host has not been told

    // Set up Slack event forwarding
    this.setupSlackForwarding();

    // Handshake
    await this.handleInitialize();

    // Main loop
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          await this.handleRequest(msg.request);
        } else {
          this.handleNotification(msg.notification);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'ConnectionClosedError') {
        console.log('[slack-mcpl] Client disconnected');
      } else {
        console.error('[slack-mcpl] Connection error:', err);
      }
    }

    this.conn = null;
  }

  // ── Initialize Handshake ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;

    // Wait for initialize request
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      console.error('[slack-mcpl] Expected initialize request, got:', msg);
      conn.close();
      return;
    }

    const params = msg.request.params as McplInitializeParams | undefined;

    // Detect MCPL support
    const clientMcpl = params?.capabilities?.experimental?.mcpl;
    this.mcplEnabled = clientMcpl !== undefined;
    dbg('handleInitialize', {
      mcplEnabled: this.mcplEnabled,
      clientName: params?.clientInfo?.name,
    });

    // Output routing ("where does a plain-text reply go") is a HOST concern —
    // the host publishes text-only turns to the conversational locus via
    // channels/publish, so no contextHooks are declared here (same rationale
    // as discord-mcpl; see LOCUS-ROUTING-DESIGN.md).
    const serverCaps: McplCapabilities = buildServerCapabilities();

    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled && {
        experimental: { mcpl: serverCaps },
      }),
    };

    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'slack-mcpl', version: '0.1.0' },
    };

    conn.sendResponse(msg.request.id, result);

    // Wait for initialized notification
    const initedMsg = await conn.nextMessage();
    if (initedMsg.type === 'notification' && initedMsg.notification.method === 'notifications/initialized') {
      console.log('[slack-mcpl] Client initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
    }

    // No default grant here (§5.3): until the host's featureSets/update
    // Request is answered, every capability-dependent behavior — channel
    // registration, push events, privileged inbound methods — stays
    // unavailable. Plain MCP tool calls are unaffected; see callTool below.
  }

  private requireMcpl(): void {
    if (!this.mcplEnabled) {
      throw new McplRpcError(-32601, 'MCPL is not negotiated on this connection');
    }
  }

  // ── Request Dispatch ──

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'tools/list': {
          const tools = this.slack.dmsWritable ? toolDefinitions : toolDefinitions.filter((t) => t.name !== 'send_dm');
          conn.sendResponse(req.id, { tools });
          break;
        }

        case 'tools/call': {
          const result = await this.handleToolCall(
            params.name as string,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          conn.sendResponse(req.id, result);
          break;
        }

        case method.FEATURE_SETS_UPDATE: {
          // §6.7: featureSets/update is a Request carrying the effective
          // grant, and its response is a degradation receipt — what this
          // server WILL DO under the grant it was given. Testimony about
          // consequences, never a claim of entitlement. Only this form can
          // establish a ready state (§5.3).
          this.requireMcpl();
          const couldRegister = this.grant.has('channels.register');
          const receipt = this.grant.apply(params as unknown as FeatureSetsUpdateParams, 'request');
          conn.sendResponse(req.id, receipt);
          // channels/register needs the channels.register capability. Register
          // when the grant first allows it, and again if a later policy turns
          // it from denied to granted. The receipt above is sent first.
          if (!couldRegister && this.grant.has('channels.register')) {
            void this.registerSlackChannels();
          }
          break;
        }

        case method.CHANNELS_LIST: {
          this.requireMcpl();
          if (!this.grant.has('channels.register')) throw capabilityDenied('channels.register');
          const result: ChannelsListResult = {
            channels: this.channelManager.getAll(),
          };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_OPEN: {
          this.requireMcpl();
          if (!this.grant.has('channels.lifecycle')) throw capabilityDenied('channels.lifecycle');
          const openP = params as unknown as ChannelsOpenParams;
          const result = this.handleChannelOpen(openP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_CLOSE: {
          this.requireMcpl();
          if (!this.grant.has('channels.lifecycle')) throw capabilityDenied('channels.lifecycle');
          const closeP = params as unknown as ChannelsCloseParams;
          const closed = this.channelManager.close(closeP.channelId);
          const result: ChannelsCloseResult = { closed };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_PUBLISH: {
          this.requireMcpl();
          if (!this.grant.has('channels.publish')) throw capabilityDenied('channels.publish');
          const pubP = params as unknown as ChannelsPublishParams;
          const result = await this.handlePublish(pubP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.STATE_ROLLBACK: {
          this.requireMcpl();
          const rollbackP = params as unknown as StateRollbackParams;
          const result = await this.handleRollback(rollbackP);
          conn.sendResponse(req.id, result);
          break;
        }

        case 'context/afterInference': {
          // Removed in MCPL 0.5 (replaced by inference/lifecycle) and not
          // declared in capabilities; answered as a harmless no-op in case
          // an older host still calls it.
          conn.sendResponse(req.id, { featureSet: MESSAGING_FEATURE_SET });
          break;
        }

        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      if (err instanceof McplRpcError) {
        conn.sendError(req.id, err.code, err.message, err.data);
        return;
      }
      // Report with full context — tool name, truncated args, stack — so
      // transient failures (Slack 5xx, rate limits, missing scopes) are
      // traceable from the host side.
      const e = err as Error;
      const isToolsCall = req.method === 'tools/call';
      const toolName = isToolsCall ? (params.name as string | undefined) : undefined;
      const toolArgs = isToolsCall
        ? (params.arguments as Record<string, unknown> | undefined)
        : undefined;
      console.error(
        `[slack-mcpl] handleRequest error: method=${req.method}`,
        toolName ? `tool=${toolName}` : '',
        e.stack ?? e.message,
      );
      dbg('handleRequest:error', {
        method: req.method,
        tool: toolName,
        args: toolArgs
          ? Object.fromEntries(
              Object.entries(toolArgs).map(([k, v]) => [
                k,
                typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v,
              ]),
            )
          : undefined,
        error: e.message,
        stack: e.stack?.split('\n').slice(0, 8).join('\n'),
      });
      conn.sendError(req.id, -32603, e.message);
    }
  }

  // ── Notification Dispatch ──

  private handleNotification(notif: JsonRpcNotification): void {
    try {
      this.dispatchNotification(notif);
    } catch (err) {
      // A notification can never be answered; a failing one is logged, never fatal.
      console.error(`[slack-mcpl] notification ${notif.method} failed:`, (err as Error).message);
    }
  }

  private dispatchNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case method.FEATURE_SETS_UPDATE: {
        // §6.7 Notification form: descriptive metadata only. Grant-bearing
        // updates (including the §5.3 initial policy) arrive as a Request.
        if (this.mcplEnabled) {
          this.grant.apply(notif.params as unknown as FeatureSetsUpdateParams, 'notification');
        }
        break;
      }

      // channels.streaming is not declared, so a host should not send these. If
      // one does, ignore them: the reply arrives once, through channels/publish.
      case method.CHANNELS_OUTGOING_CHUNK:
      case method.CHANNELS_OUTGOING_COMPLETE:
        break;

      // Shown as "is thinking…" on the thread of the conversation's newest
      // incoming message: the message that woke the agent.
      case method.CHANNELS_TYPING:
      case 'notifications/typing': {
        if (this.mcplEnabled && !this.grant.has('channels.typing')) break;
        const p = (notif.params ?? {}) as { channelId?: unknown; op?: unknown };
        if (typeof p.channelId !== 'string') break;
        const id = parseMcplChannelId(p.channelId)?.conversationId ?? p.channelId;
        void this.slack.setThreadStatus(id, p.op === 'stop' ? undefined : this.lastIncomingRoot.get(id));
        break;
      }

      default:
        // Ignore unknown notifications
        break;
    }
  }

  // ── Tool Call Handling ──

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ContentBlock[]; isError?: boolean; state?: unknown }> {
    // §14.1/§6.2: in MCPL mode the tool surface itself is gated on the
    // `tools` capability — thrown, not returned, since a missing capability
    // is a protocol-level denial (§5.4), unlike a feature set that is merely
    // temporarily disabled (below). Plain MCP clients (mcplEnabled false)
    // are not subject to a grant — there is none to consult.
    if (this.mcplEnabled && !this.grant.has('tools')) {
      throw capabilityDenied('tools');
    }

    // Check feature set permission
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !this.grant.isFeatureSetActive(fs)) {
      return {
        content: [textContent(`Feature set '${fs}' is not enabled`)],
        isError: true,
      };
    }

    try {
      const result = await this.executeToolCall(name, args);

      // fetch_attachment returns native content blocks (images) via _content
      if (result && typeof result === 'object' && '_content' in (result as Record<string, unknown>)) {
        return { content: (result as { _content: ContentBlock[] })._content };
      }

      // Track checkpoints for rollback-enabled tools
      if (fs === MESSAGING_FEATURE_SET) {
        const cpId = this.stateTracker.createCheckpoint();
        return {
          content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
          state: { checkpoint: cpId },
        };
      }

      return {
        content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
      };
    } catch (err) {
      return {
        content: [textContent((err as Error).message)],
        isError: true,
      };
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case 'send_message': {
        const channelId = this.requireString(args, 'channelId');
        const content = this.requireString(args, 'content');
        const result = await this.slack.sendMessage(channelId, content);
        this.stateTracker.recordSent(result.messageId, channelId, content);
        this.markOutbound(channelId);
        return { messageId: result.messageId };
      }

      case 'reply_message': {
        const channelId = this.requireString(args, 'channelId');
        const content = this.requireString(args, 'content');
        const threadTs = this.requireString(args, 'messageId');
        const result = await this.slack.sendMessage(channelId, content, { threadTs });
        this.stateTracker.recordSent(result.messageId, channelId, content);
        this.markOutbound(channelId);
        return { messageId: result.messageId, threadTs };
      }

      case 'send_dm': {
        const userId = this.requireString(args, 'userId');
        const content = this.requireString(args, 'content');
        const result = await this.slack.sendDM(userId, content);
        this.stateTracker.recordSent(result.messageId, result.channelId, content);
        this.markOutbound(result.channelId);
        return { messageId: result.messageId, channelId: result.channelId };
      }

      case 'add_reaction':
        await this.slack.addReaction(
          this.requireString(args, 'channelId'),
          this.requireString(args, 'messageId'),
          this.requireString(args, 'emoji'),
        );
        return 'Reaction added';

      case 'edit_message':
        await this.slack.editMessage(
          this.requireString(args, 'channelId'),
          this.requireString(args, 'messageId'),
          this.requireString(args, 'content'),
        );
        return 'Message edited';

      case 'delete_message':
        await this.slack.deleteMessage(
          this.requireString(args, 'channelId'),
          this.requireString(args, 'messageId'),
        );
        return 'Message deleted';

      case 'list_channels': {
        const convs = await this.slack.listConversations(args.includeNonMember === true);
        return convs.map((c) => ({
          id: c.id,
          kind: c.kind,
          name: c.kind === 'dm' ? `DM: @${c.name}` : c.name,
          ...(c.topic ? { topic: c.topic } : {}),
          ...(c.kind === 'channel' || c.kind === 'private_channel' ? { isMember: c.isMember } : {}),
          writable: this.slack.canWrite(c.id),
        }));
      }

      case 'refresh_channels':
        return await this.refreshChannels();

      case 'fetch_history': {
        const channelId = this.requireString(args, 'channelId');
        const { messages, truncated } = await this.slack.fetchHistory(channelId, {
          limit: (args.limit as number) ?? 50,
          ...(args.oldest ? { oldest: args.oldest as string } : {}),
          ...(args.latest ? { latest: args.latest as string } : {}),
        });
        return {
          messages: messages.map((m) => this.renderHistoryMessage(m)),
          ...(truncated ? { note: 'Range holds more messages than the limit; the oldest were omitted.' } : {}),
        };
      }

      case 'fetch_thread': {
        const channelId = this.requireString(args, 'channelId');
        const threadTs = this.requireString(args, 'threadTs');
        const { messages, truncated } = await this.slack.fetchThread(
          channelId,
          threadTs,
          (args.limit as number) ?? 100,
        );
        return {
          messages: messages.map((m) => this.renderHistoryMessage(m)),
          ...(truncated ? { note: 'Thread holds more messages than the limit; the newest were omitted.' } : {}),
        };
      }

      case 'find_user': {
        const matches = await this.slack.findUsers(this.requireString(args, 'query'));
        if (matches.length === 0) return { found: false, note: 'No users matched.' };
        return {
          found: true,
          users: matches.map((u) => ({
            userId: u.userId,
            username: u.username,
            realName: u.realName,
            displayName: u.displayName,
            mentionSyntax: `<@${u.userId}>`,
          })),
        };
      }

      case 'fetch_attachment': {
        // The bot token must only be sent to files.slack.com — never to
        // workspace hosts. Enforcement lives in parseSlackAttachmentUrl.
        const url = parseSlackAttachmentUrl(this.requireString(args, 'url'));
        const botToken = process.env.SLACK_BOT_TOKEN || '';
        const headers: Record<string, string> = botToken
          ? { Authorization: `Bearer ${botToken}` }
          : {};
        const fileName = decodeURIComponent(url.pathname.split('/').pop() || 'attachment');
        return toFetchResult(await fetchAttachmentBytes(url.toString(), fileName, { headers }));
      }

      case 'subscribe_channel': {
        this.ensureSubscriptionsLoaded();
        const channelId = this.requireString(args, 'channelId');
        return this.subscribe(channelId)
          ? this.opts.subscribeMemberChannels
            ? `Unmuted conversation ${channelId}: its ambient messages arrive again.`
            : `Subscribed to ambient messages from conversation ${channelId}.`
          : this.opts.subscribeMemberChannels
            ? `Conversation ${channelId} is not muted.`
            : `Already subscribed to conversation ${channelId}.`;
      }

      case 'unsubscribe_channel': {
        this.ensureSubscriptionsLoaded();
        const channelId = this.requireString(args, 'channelId');
        return this.unsubscribe(channelId)
          ? this.opts.subscribeMemberChannels
            ? `Muted ambient messages in conversation ${channelId} until you subscribe_channel it again. Mentions and DMs from there will still arrive.`
            : `Unsubscribed from ambient messages in conversation ${channelId}. Mentions and DMs from there will still arrive.`
          : this.opts.subscribeMemberChannels
            ? `Conversation ${channelId} is already muted.`
            : `Conversation ${channelId} was not subscribed.`;
      }

      case 'list_subscriptions': {
        this.ensureSubscriptionsLoaded();
        if (this.opts.subscribeMemberChannels) {
          return {
            mode: 'member-channels',
            muted: [...this.mutedChannels].sort(),
            note:
              'Ambient messages arrive from every conversation the bot is a member of, except the muted ones. ' +
              'Mentions and DMs always come through.',
          };
        }
        return {
          channels: [...this.subscribedChannels].sort(),
          count: this.subscribedChannels.size,
          note:
            this.subscribedChannels.size === 0
              ? 'No ambient subscriptions. Mentions and DMs are always delivered.'
              : 'Ambient messages from these conversations are delivered. Mentions and DMs always come through regardless.',
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`${key} is required`);
    }
    return v;
  }

  private renderHistoryMessage(m: {
    id: string; authorName: string; content: string; threadTs?: string;
    timestamp: Date; attachments: Array<{ name: string; mimeType?: string; url?: string }>;
  }): Record<string, unknown> {
    return {
      id: m.id,
      author: m.authorName,
      timestamp: m.timestamp.toISOString(),
      ...(m.threadTs ? { threadTs: m.threadTs } : {}),
      content: m.content,
      ...(m.attachments.length > 0
        ? {
            attachments: m.attachments.map((a) =>
              `${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}${a.url ? ` — fetchable via fetch_attachment: ${a.url}` : ''}`,
            ),
          }
        : {}),
    };
  }

  /** Record that the bot just sent to a conversation, for location headers. */
  private markOutbound(channelId: string): void {
    this.lastChannelId = channelId;
  }

  // ── Subscription persistence ──

  /** Path to the JSON file backing ambient subscriptions.
   *  When unset, subscriptions are in-memory only (lost on restart). */
  private subscriptionsFile(): string | undefined {
    const p = process.env.SLACK_SUBSCRIPTIONS_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  /** Lazy-load subscriptions from disk on first access. Idempotent. */
  private ensureSubscriptionsLoaded(): void {
    if (this.subscriptionsLoaded) return;
    this.subscriptionsLoaded = true;
    const path = this.subscriptionsFile();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      // A plain array is the subscribed list; an object also carries the muted one.
      const lists = Array.isArray(parsed) ? { subscribed: parsed, muted: [] } : (parsed ?? {});
      const into = (ids: unknown, set: Set<string>) => {
        if (!Array.isArray(ids)) return;
        for (const id of ids) if (typeof id === 'string' && id.length > 0) set.add(id);
      };
      into(lists.subscribed, this.subscribedChannels);
      into(lists.muted, this.mutedChannels);
      dbg('subscriptions:loaded', { count: this.subscribedChannels.size, path });
    } catch (err) {
      // Corrupt or unreadable file: start with empty set; don't fail boot.
      console.error('[slack-mcpl] Failed to load subscriptions:', (err as Error).message);
    }
  }

  private saveSubscriptions(): void {
    const path = this.subscriptionsFile();
    if (!path) return; // in-memory mode
    try {
      mkdirSync(dirname(path), { recursive: true });
      const subscribed = [...this.subscribedChannels].sort();
      const muted = [...this.mutedChannels].sort();
      writeFileSync(path, JSON.stringify(muted.length > 0 ? { subscribed, muted } : subscribed, null, 2) + '\n');
    } catch (err) {
      console.error('[slack-mcpl] Failed to save subscriptions:', (err as Error).message);
    }
  }

  private isChannelSubscribed(channelId: string): boolean {
    this.ensureSubscriptionsLoaded();
    if (this.opts.subscribeMemberChannels) return !this.mutedChannels.has(channelId);
    return this.subscribedChannels.has(channelId);
  }

  /** Returns true when this changed anything. With `subscribeMemberChannels`
   *  a conversation is subscribed unless muted, so subscribing unmutes. */
  private subscribe(channelId: string): boolean {
    const was = this.isChannelSubscribed(channelId);
    if (this.opts.subscribeMemberChannels) this.mutedChannels.delete(channelId);
    else this.subscribedChannels.add(channelId);
    if (!was) this.saveSubscriptions();
    return !was;
  }

  private unsubscribe(channelId: string): boolean {
    const was = this.isChannelSubscribed(channelId);
    if (this.opts.subscribeMemberChannels) this.mutedChannels.add(channelId);
    else this.subscribedChannels.delete(channelId);
    if (was) this.saveSubscriptions();
    return was;
  }

  // ── Channel Operations ──

  private async registerSlackChannels(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) return;
    if (!this.grant.has('channels.register')) {
      console.error('[slack-mcpl] channels.register not granted; skipping channel registration');
      return;
    }

    let descriptors: ChannelDescriptor[] = [];
    try {
      const convs = await this.slack.listConversations();
      descriptors = convs.map((c) => toDescriptor(c, this.slack.teamName, this.slack.canWrite(c.id)));
    } catch (err) {
      console.error('[slack-mcpl] Failed to enumerate conversations:', (err as Error).message);
      return;
    }
    dbg('registerSlackChannels', { count: descriptors.length });
    if (descriptors.length === 0) return;
    // The grant may have been revoked, or the peer gone, while Slack answered.
    if (this.conn !== conn || !this.grant.has('channels.register')) return;

    this.channelManager.registerAll(descriptors);

    const regParams: ChannelsRegisterParams = { channels: descriptors };
    try {
      await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
    } catch (err) {
      console.error('[slack-mcpl] Failed to register channels:', (err as Error).message);
    }
  }

  /** Register the given descriptors and emit a single `channels/changed`
   *  notification for the ones that weren't already known. Idempotent:
   *  re-registering a known channel refreshes its descriptor but does NOT
   *  re-announce it. Returns the descriptors that were newly added. */
  private registerAndNotifyNew(descriptors: ChannelDescriptor[]): ChannelDescriptor[] {
    // Without the grant, record nothing: a channel marked known here would
    // never be announced after the grant widens.
    if (this.conn && this.mcplEnabled && !this.grant.has('channels.register')) {
      console.error('[slack-mcpl] channels.register not granted; channels stay unannounced');
      return [];
    }
    const added: ChannelDescriptor[] = [];
    for (const d of descriptors) {
      if (!this.channelManager.get(d.id)) added.push(d);
      this.channelManager.register(d);
    }
    if (added.length > 0 && this.conn && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { added });
    }
    return added;
  }

  /** Re-enumerate every conversation currently visible and register any the
   *  host doesn't yet know about — the agent-facing catch-all for "I was
   *  invited to a channel but don't see it". */
  private async refreshChannels(): Promise<{
    visible: number;
    added: Array<{ id: string; label: string }>;
    note: string;
  }> {
    const convs = await this.slack.listConversations();
    const descriptors = convs.map((c) => toDescriptor(c, this.slack.teamName, this.slack.canWrite(c.id)));
    const added = this.registerAndNotifyNew(descriptors);
    return {
      visible: descriptors.length,
      added: added.map((d) => ({ id: d.id, label: d.label })),
      note:
        added.length > 0
          ? `Registered ${added.length} newly-visible conversation(s).`
          : this.mcplEnabled && !this.grant.has('channels.register')
            ? 'The host has not granted channels.register; nothing was announced.'
            : 'No new conversations — the host already knows about every visible one.',
    };
  }

  private handleChannelOpen(params: ChannelsOpenParams): ChannelsOpenResult {
    const addr = params.address as { channelId?: string } | undefined;
    if (params.type === 'slack' && addr?.channelId) {
      const desc = this.channelManager.openByConversationId(addr.channelId);
      if (desc) {
        return { channel: desc };
      }
    }

    // Fall back to the first registered channel of the requested type
    for (const desc of this.channelManager.getAll()) {
      if (desc.type === params.type) {
        this.channelManager.open(desc.id);
        return { channel: desc };
      }
    }

    throw new Error('No matching channel found');
  }

  private async handlePublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      throw new Error(`Invalid channel ID: ${params.channelId}`);
    }

    // Extract text from content blocks
    const text = params.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (!text) {
      dbg('handlePublish:skip', { channelId: params.channelId, reason: 'empty-text' });
      return { delivered: false, messageId: undefined };
    }

    // Reply in the thread of the most recent incoming message on this
    // conversation; top-level when it wasn't threaded.
    const threadTs = this.lastIncomingThreadTs.get(parsed.conversationId);
    const result = await this.slack.sendMessage(
      parsed.conversationId,
      text,
      threadTs ? { threadTs } : {},
    );
    this.stateTracker.recordSent(result.messageId, parsed.conversationId, text);
    this.markOutbound(parsed.conversationId);
    dbg('handlePublish:sent', { channelId: params.channelId, messageId: result.messageId, threadTs });

    return { delivered: true, messageId: result.messageId };
  }

  // ── Rollback ──

  private async handleRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    if (params.featureSet !== MESSAGING_FEATURE_SET) {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: `Feature set '${params.featureSet}' does not support rollback`,
      };
    }

    const toDelete = this.stateTracker.rollback(params.checkpoint);
    if (toDelete === null) {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: 'Checkpoint not found',
      };
    }

    // Best-effort delete sent messages
    let deleted = 0;
    for (const msg of toDelete) {
      try {
        await this.slack.deleteMessage(msg.channelId, msg.messageId);
        deleted++;
      } catch {
        // Best-effort — message may have been deleted by someone else
      }
    }

    return {
      checkpoint: params.checkpoint,
      success: true,
      reason: deleted < toDelete.length
        ? `Rolled back (${deleted}/${toDelete.length} messages deleted)`
        : undefined,
    };
  }

  // ── Slack Event Forwarding ──

  private setupSlackForwarding(): void {
    this.slack.onMessage((msg) => {
      this.handleSlackMessage(msg).catch((err) => {
        console.error('[slack-mcpl] Error forwarding Slack message:', err);
      });
    });
  }

  /** Render attachment refs as a text block the agent can act on. Slack
   *  serves url_private behind bot auth, so bytes are fetched on demand via
   *  fetch_attachment rather than inlined here. */
  private attachmentNote(attachments: AttachmentRef[]): string {
    const lines = attachments.map((a) =>
      `- ${a.name} (${a.mimeType})${a.isImage ? ' — image' : ''}, fetchable via fetch_attachment: ${a.path}`,
    );
    return `[attachments: ${attachments.length}]\n${lines.join('\n')}`;
  }

  private async handleSlackMessage(msg: SlackMessageData): Promise<void> {
    const conn = this.conn;
    dbg('handleSlackMessage:enter', {
      msgId: msg.id,
      channelId: msg.channelId,
      authorId: msg.authorId,
      mentionsBot: msg.mentionsBot,
      isDM: msg.isDM,
      hasConn: !!conn,
      mcplEnabled: this.mcplEnabled,
    });
    if (!conn) return;
    if (!this.mcplEnabled) return; // No push events in MCP-only mode
    // §6.7: a disabled slack.messaging stops its traffic at once — incoming
    // and push alike. False before the initial policy exchange too (§5.3):
    // fail closed until the host's featureSets/update Request is answered.
    if (!this.grant.isFeatureSetActive(MESSAGING_FEATURE_SET)) return;

    // Direct address (mention or DM) always reaches the agent. Ambient
    // messages only flow from subscribed conversations — otherwise every
    // visible channel would pour unbounded noise into context. The wake
    // decision is the host's, via the chat:* tags below.
    const isAddressed = msg.mentionsBot || msg.isDM;
    if (!isAddressed && !this.isChannelSubscribed(msg.channelId)) {
      dbg('handleSlackMessage:drop', { reason: 'ambient-not-subscribed', channelId: msg.channelId });
      return;
    }
    if (isAddressed) void this.slack.acknowledge(msg.channelId, msg.id);

    // First-interaction handling: when about to forward the very first
    // message from this conversation (this process), pull backscroll for
    // context. For channels reached via mention, also auto-subscribe and
    // emit a system note. DMs always come through, so no subscription
    // note for them — just the backscroll.
    this.ensureSubscriptionsLoaded();
    const isFirstInteraction = !this.forwardedWatermark.has(msg.channelId);
    let prefixBlock = '';
    if (isFirstInteraction && isAddressed) {
      let backscroll: Awaited<ReturnType<typeof this.slack.fetchHistory>>['messages'] = [];
      try {
        const res = await this.slack.fetchHistory(msg.channelId, {
          limit: this.backscrollLimit,
          latest: msg.id, // never include the triggering message itself
        });
        // Drop the bot's own past messages — already in the agent's
        // chronicle as assistant turns, no need to re-echo.
        backscroll = res.messages.filter((m) => m.authorId !== this.slack.botUserId);
      } catch (err) {
        dbg('backscroll:fetch-failed', { channelId: msg.channelId, error: (err as Error).message });
      }

      const meta = await this.slack.getConversationMeta(msg.channelId).catch(() => null);
      const blocks: string[] = [];
      // In member mode every conversation is subscribed unless muted, and a
      // mention must not undo a mute.
      if (!msg.isDM && !this.opts.subscribeMemberChannels) {
        const where = meta?.name ? `#${meta.name}` : `conversation ${msg.channelId}`;
        const wasSubscribed = this.isChannelSubscribed(msg.channelId);
        if (!wasSubscribed) {
          this.subscribe(msg.channelId);
          blocks.push(
            `<system>Auto-subscribed to ${where} because you were mentioned. ` +
              `Ambient (non-mention) messages from this conversation will now arrive in your context. ` +
              `Mentions and DMs always come through regardless of subscriptions. ` +
              `To stop ambient delivery from here: unsubscribe_channel("${msg.channelId}").</system>`,
          );
        }
      }
      if (backscroll.length > 0) {
        blocks.push(backscrollBlock(backscroll, { channelName: meta?.name, isDM: msg.isDM }));
      }
      if (blocks.length > 0) {
        prefixBlock = blocks.join('\n') + '\n';
      }
    }

    // Told with the first message the agent gets from here, addressed or not.
    // Counted as told only once the host has taken that message.
    const noteReadOnly = !this.slack.canWrite(msg.channelId) && !this.readOnlyNoted.has(msg.channelId);
    if (noteReadOnly) {
      prefixBlock +=
        `<system>You cannot write to conversation ${msg.channelId}: it is not on the write allow-list. ` +
        `You can read it; do not try to reply there.</system>\n`;
    }

    const channelMcplId = mcplChannelId(msg.channelId);
    const channelIsOpen = this.channelManager.isOpen(channelMcplId);

    // The conversation is named only when it differs from the last
    // communication context (compare BEFORE updating the tracker). The
    // thread and the message ID are given every time: two threads in one
    // channel are otherwise indistinguishable, and replying or reacting to
    // a message needs its ID.
    const contextChanged = this.lastChannelId !== msg.channelId;
    const meta = contextChanged
      ? await this.slack.getConversationMeta(msg.channelId).catch(() => null)
      : null;
    const location = locationHeader({
      conversation: !contextChanged ? undefined : msg.isDM ? 'DM' : meta?.name ? `#${meta.name}` : undefined,
      teamName: contextChanged ? this.slack.teamName : undefined,
      threadTs: msg.threadTs,
      messageId: msg.id,
    });
    const renderedContent = `${prefixBlock}${location}${msg.authorName}: ${msg.cleanContent}`;

    // Advance trackers before forwarding: watermark (bounds future
    // backscroll), thread routing (publishes follow the conversation), and
    // the location-header context.
    this.forwardedWatermark.set(msg.channelId, msg.id);
    this.lastIncomingThreadTs.set(msg.channelId, msg.threadTs);
    this.lastIncomingRoot.set(msg.channelId, msg.threadTs ?? msg.id);
    this.lastChannelId = msg.channelId;

    const contentBlocks: ContentBlock[] = [textContent(renderedContent)];
    if (msg.attachments.length > 0) {
      contentBlocks.push(textContent(this.attachmentNote(msg.attachments)));
    }

    // MCPL RFC-001 event tags — reserved chat:* core, umbrellas included.
    // The host's wake gate routes on these. Other bots' messages never get
    // here (the adapter self-filters bot_id), so from-human is uniform.
    const eventTags: string[] = (() => {
      const t = new Set<string>();
      if (msg.mentionsBot) t.add('chat:mention');
      if (msg.isDM) { t.add('chat:dm'); t.add('chat:private'); }
      t.add(isAddressed ? 'chat:addressed' : 'chat:ambient');
      t.add('chat:from-human');
      if (msg.threadTs) t.add('chat:thread');
      for (const a of msg.attachments) {
        t.add(a.isImage ? 'chat:has-image' : 'chat:has-file');
      }
      return [...t];
    })();

    const metadata = {
      mentionIds: msg.mentionIds,
      mentioned: msg.mentionsBot,
      isMention: msg.mentionsBot,
      isDM: msg.isDM,
      thread_ts: msg.threadTs,
      channel_type: msg.channelType,
      team: msg.teamId,
      rawContent: msg.content,
      botUserId: this.slack.botUserId ?? undefined,
      ...(msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
    };

    // The reaction says "received". If the host does not take the message,
    // take the reaction off.
    const releaseAck = () => {
      if (isAddressed) void this.slack.clearAck(msg.channelId, msg.id);
    };
    const taken = () => {
      if (noteReadOnly) this.readOnlyNoted.add(msg.channelId);
    };

    // If this channel is open, use channels/incoming; otherwise push/event
    if (channelIsOpen) {
      const incomingParams: ChannelsIncomingParams = {
        messages: [{
          channelId: channelMcplId,
          messageId: msg.id,
          threadId: msg.threadTs,
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: contentBlocks,
          metadata,
          tags: eventTags,
        }],
      };

      try {
        const res = (await conn.sendRequest(method.CHANNELS_INCOMING, incomingParams)) as
          | { results?: Array<{ accepted?: boolean }> }
          | undefined;
        dbg('handleSlackMessage:sent', { method: 'channels/incoming', channelMcplId });
        if (res?.results?.[0]?.accepted === false) releaseAck();
        else taken();
      } catch (err) {
        console.error('[slack-mcpl] channels/incoming failed:', (err as Error).message);
        releaseAck();
      }
    } else {
      const pushParams: PushEventParams = {
        featureSet: MESSAGING_FEATURE_SET,
        eventId: `slack_msg_${msg.channelId}_${msg.id}`,
        timestamp: msg.timestamp.toISOString(),
        origin: {
          source: 'slack',
          messageId: msg.id,
          channelId: msg.channelId,
          threadTs: msg.threadTs,
          authorId: msg.authorId,
          authorName: msg.authorName,
          isMention: msg.mentionsBot,
          isDM: msg.isDM,
          team: msg.teamId,
        } as Record<string, unknown>,
        tags: eventTags, // MCPL RFC-001 — the host routes/gates on these
        payload: { content: contentBlocks },
      };

      try {
        const res = (await conn.sendRequest(method.PUSH_EVENT, pushParams)) as { accepted?: boolean } | undefined;
        dbg('handleSlackMessage:sent', { method: 'push/event', channelMcplId });
        if (res?.accepted === false) releaseAck();
        else taken();
      } catch (err) {
        console.error('[slack-mcpl] push/event failed:', (err as Error).message);
        releaseAck();
      }
    }
  }
}
