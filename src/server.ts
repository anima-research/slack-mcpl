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

import {
  GaveUp,
  SLACK_CLIENT_OPTIONS,
  assertRequestFits,
  fileLeftByUpload,
  outsideCallTime,
  withCallTime,
  type SlackAdapter,
  type SlackMessageData,
  type SlackWait,
} from './slack-adapter.js';
import { toolDefinitions } from './tools.js';
import { withToolClasses } from './tool-classes.js';
import { buildFeatureSets, buildServerCapabilities, featureSetForTool, MESSAGING_FEATURE_SET } from './feature-sets.js';
import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor } from './channels.js';
import { StateTracker, type UploadedFile } from './state.js';
import { CapabilityGrant } from './grant.js';
import { McplRpcError, capabilityDenied } from './errors.js';
import { explainSlackError, slackRefusal } from './slack-errors.js';
import {
  fetchAttachmentBytes,
  parseSlackAttachmentUrl,
  toFetchResult,
  type AttachmentRef,
} from './content.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

// tsx runs from src/; the built executable runs from dist/src/. Read the
// release metadata from the package root in either layout, independent of cwd.
const require = createRequire(import.meta.url);
const { version: serverVersion } = require(
  existsSync(new URL('../package.json', import.meta.url)) ? '../package.json' : '../../package.json',
) as { version: string };

/** Registration gives up on a request to Slack, a page of the conversation
 *  list or the name of a DM's user, once this many tries of it in a row have
 *  been rate-limited or failed, with a wait before each try after the first,
 *  so a limit something else keeps using, or a failure that doesn't pass,
 *  holds each request for nine waits at most: each as long as Slack asks
 *  after a rate limit, or 30 s after a failure. */
const REGISTRATION_TRIES = 10;

/** The most bytes upload_file takes inline: the file's bytes, after base64 is
 *  decoded or text is encoded as UTF-8. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** files.delete's answers for a file that's already gone, or that this bot
 *  can't see any more: Slack's own words are "already been deleted" and "does
 *  not exist, or is not visible to the calling user". */
const FILE_GONE = ['file_deleted', 'file_not_found'];

/** A UTF-16 surrogate without its pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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
  /** A new registration supersedes work started under an earlier grant. */
  private registrationGeneration = 0;
  /** The latest registration while it runs, and whether it is still the
   *  current one. A refresh_channels then answers at once. */
  private registering: { isCurrent: () => boolean } | undefined;
  private stateTracker = new StateTracker();
  /** Serial delivery within a conversation; different conversations stay independent. */
  private forwarding = new Map<string, Promise<void>>();

  /** Conversations the agent has opted into for ambient (non-mention,
   *  non-DM) message delivery. Mentions and DMs always come through
   *  regardless — this only gates passive awareness of channel chatter.
   *  Persisted to `SLACK_SUBSCRIPTIONS_FILE` (a JSON array of conversation
   *  IDs) so the list survives restarts. */
  private subscribedChannels = new Set<string>();
  private subscriptionsLoaded = false;

  /** Per-conversation ts of the newest message this peer has taken. Its
   *  presence marks the peer's first interaction with the conversation as
   *  done, so a new peer gets its own first-interaction backscroll. */
  private forwardedWatermark = new Map<string, string>();

  /** Conversations the agent has unsubscribed from with unsubscribe_channel
   *  in this process. A mention never auto-subscribes one of these again,
   *  whichever peer it reaches. */
  private unsubscribedByAgent = new Set<string>();

  /** Thread routing for host publishes: the thread_ts of the most recent
   *  incoming message this peer took per conversation. channels/publish carries no thread
   *  information, so "reply where the conversation is" is reconstructed
   *  here — a publish goes into the last incoming message's thread, or
   *  top-level when the conversation isn't threaded. */
  private lastIncomingThreadTs = new Map<string, string | undefined>();

  /** The conversation this peer was last sent a message from, or the bot last
   *  posted in: an incoming message from any other conversation names its
   *  own in its location header. null before the first, and after a message
   *  the host didn't take, unless another conversation is current by then. */
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
  ) {
    // Once for the server's life: the adapter keeps every handler it's
    // given, and each forwards to whichever connection is being served, so
    // one per connection forwarded each message once per connection served.
    this.setupSlackForwarding();
  }

  /**
   * Serve a single connection. Blocks until the connection closes, and
   * resolves however it ends, a client that leaves before initialize
   * included: what ends a connection is that connection's business, not the
   * caller's. The Slack adapter should already be connected before calling
   * this.
   */
  async serve(conn: McplConnection): Promise<void> {
    if (this.conn) {
      conn.close();
      throw new Error('A client is already connected');
    }
    this.conn = conn;

    // Every connection starts from nothing (§5.3). Subscriptions and rollback
    // checkpoints belong to the server, but channel handles and delivery
    // context belong to the peer that established them.
    this.mcplEnabled = false;
    this.grant.reset();
    this.channelManager = new ChannelManager();
    this.readOnlyNoted.clear();
    this.forwardedWatermark.clear();
    this.lastIncomingThreadTs.clear();
    this.lastChannelId = null;
    this.forwarding.clear();

    // The connection emits 'error' for a line that isn't JSON. Unheard,
    // EventEmitter throws it from the stream's callback, where nothing here
    // can catch it, and the process exits. Logged instead, so a bad line
    // costs only itself. (A stream's own error, such as a client's reset,
    // also reaches mcpl-core's readline interface, which hears none, so it
    // still ends the process: mcpl-core-ts#11 is that fix.)
    conn.on('error', (err: unknown) => console.error('[slack-mcpl] Connection error:', err));

    // A call's time counts from when it reaches this server, not from when
    // this loop takes it up, so a call queued behind others answers in time
    // too. The connection emits each request as it parses it, before
    // queueing it for nextMessage() (mcpl-core's routeIncoming).
    const arrivals = new WeakMap<JsonRpcRequest, number>();
    conn.on('request', (req: JsonRpcRequest) => arrivals.set(req, Date.now()));

    try {
      await this.handleInitialize();
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          await withCallTime(arrivals.get(msg.request) ?? Date.now(), () => this.handleRequest(msg.request));
        } else {
          this.handleNotification(msg.notification);
        }
      }
    } catch (err) {
      // stderr, as every log line here: on the stdio transport, stdout is the
      // protocol channel.
      if ((err as Error).name === 'ConnectionClosedError') {
        console.error('[slack-mcpl] Client disconnected');
      } else {
        console.error('[slack-mcpl] Connection error:', err);
      }
    } finally {
      // A failed handshake ends here too: close the connection, so a TCP
      // client isn't left on a socket nobody serves.
      this.conn = null;
      conn.close();
    }
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
      serverInfo: { name: 'slack-mcpl', version: serverVersion },
    };

    conn.sendResponse(msg.request.id, result);

    // Wait for initialized notification
    const initedMsg = await conn.nextMessage();
    if (initedMsg.type === 'notification' && initedMsg.notification.method === 'notifications/initialized') {
      console.error('[slack-mcpl] Client initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
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
    // What a channels/publish posted to, as handlePublish chose it, so that
    // Slack's refusal is explained for the conversation and thread it used.
    const published: Record<string, unknown> = {};

    try {
      switch (req.method) {
        case 'tools/list': {
          const listed = this.slack.dmsWritable ? toolDefinitions : toolDefinitions.filter((t) => t.name !== 'send_dm');
          // MCPL RFC-008: each tool carries its class in _meta['mcpl/class'].
          conn.sendResponse(req.id, { tools: withToolClasses(listed) });
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
            // A registration that throws past its own catches is logged here,
            // so it doesn't end the process.
            void outsideCallTime(() => this.registerSlackChannels())
              .catch((err) => console.error('[slack-mcpl] Channel registration failed:', err));
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
          const result = await this.handlePublish(pubP, published);
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
      // channels/publish is the request whose Slack refusal reaches the host
      // (state/rollback deletes best-effort and reports a count), so it's
      // explained as a tool's is. It names the conversation by its Slack id,
      // without the host's slack: prefix, since the tools the explanation
      // points to take that id.
      const sent = req.method === method.CHANNELS_PUBLISH
        ? explainSlackError(err, { tool: 'channels/publish', args: published })
        : e.message;
      conn.sendError(req.id, -32603, sent);
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

      // Slack's Web API has no typing indicator for bots (the RTM one is
      // deprecated), so typing notifications are accepted and ignored.
      case 'channels/typing':
      case 'notifications/typing':
        break;

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
        content: [textContent(explainSlackError(err, { tool: name, args }))],
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

      case 'upload_file': {
        const channelId = this.requireString(args, 'channelId');
        const filename = this.requireString(args, 'filename');
        // An argument given as JSON null is not given, and an optional one
        // given as an empty string names nothing, so it isn't given either.
        // An optional one given as anything but a string is refused, rather
        // than dropped: a messageId given as a number, say, and dropped would
        // put the file in the conversation, not its thread.
        const given = (k: string) => args[k] !== undefined && args[k] !== null;
        const optional = (k: string): string | undefined => {
          if (!given(k) || args[k] === '') return undefined;
          if (typeof args[k] !== 'string') throw new Error(`${k} must be a string`);
          return args[k] as string;
        };
        if (given('content') === given('contentBase64')) throw new Error('pass exactly one of content or contentBase64');
        const key = given('content') ? 'content' : 'contentBase64';
        const input = args[key];
        if (typeof input !== 'string') throw new Error(`${key} must be a string`);
        if (input.length === 0) throw new Error(`${key} is empty: give the file's content, at least one byte`);
        // UTF-8 can't hold a lone surrogate: Buffer.from would write U+FFFD in
        // its place, so the file or its name would differ from what was given,
        // and the client can't encode one into its request to Slack.
        const loneSurrogate = (k: string, v: string | undefined, remedy: string) => {
          if (v !== undefined && LONE_SURROGATE.test(v)) {
            throw new Error(`${k} holds a lone UTF-16 surrogate, which UTF-8 can't encode: ${remedy}`);
          }
        };
        loneSurrogate('filename', filename, 'remove it from the name');
        let data: Buffer;
        if (key === 'content') {
          loneSurrogate('content', input, 'remove it, or pass the file\'s bytes as contentBase64');
          data = Buffer.from(input, 'utf8');
        } else {
          // Buffer.from skips what isn't base64 and reads a data URI's prefix
          // as bytes, so only base64 that it writes back the same is taken:
          // canonical RFC 4648, with padding and zero unused bits.
          data = Buffer.from(input, 'base64');
          if (data.toString('base64') !== input) {
            throw new Error('contentBase64 must be canonical RFC 4648 base64 with padding, on one line: no line breaks, spaces or data URI');
          }
        }
        if (data.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(
            `inline file too large: ${data.byteLength} bytes, past this server's inline limit of ${MAX_UPLOAD_BYTES} ` +
              'bytes, so upload_file can\'t send it. A smaller file can go, such as this one split into parts.',
          );
        }
        const comment = optional('comment');
        const title = optional('title');
        loneSurrogate('comment', comment, 'remove it from the comment');
        loneSurrogate('title', title, 'remove it from the title');
        let result: { fileId: string; shareTs?: string };
        try {
          result = await this.slack.uploadFile(channelId, { filename, data, title, comment, threadTs: optional('messageId') });
        } catch (err) {
          // An upload that failed after its first step leaves its file for
          // rollback, and its comment only if Slack may have shared the file
          // with it.
          const left = fileLeftByUpload(err);
          if (left) this.stateTracker.recordUploaded(left.fileId, channelId, { comment: comment !== undefined && left.mayHaveShared });
          throw err;
        }
        this.markOutbound(channelId);
        this.stateTracker.recordUploaded(result.fileId, channelId, { shareTs: result.shareTs, comment: comment !== undefined });
        return { fileId: result.fileId };
      }

      case 'send_dm': {
        const userId = this.requireString(args, 'userId');
        const content = this.requireString(args, 'content');
        const result = await this.slack.sendDM(userId, content);
        this.stateTracker.recordSent(result.messageId, result.channelId, content);
        this.markOutbound(result.channelId);
        return { messageId: result.messageId, channelId: result.channelId };
      }

      case 'add_reaction': {
        const channelId = this.requireString(args, 'channelId');
        const messageId = this.requireString(args, 'messageId');
        const emoji = this.requireString(args, 'emoji');
        try {
          await this.slack.addReaction(channelId, messageId, emoji);
        } catch (err) {
          // The reaction the call asks for is there, which is its intent.
          if (slackRefusal(err) === 'already_reacted') {
            return `Nothing changed: message ${messageId} already has this bot's ${emoji} reaction.`;
          }
          throw err;
        }
        return 'Reaction added';
      }

      case 'edit_message':
        await this.slack.editMessage(
          this.requireString(args, 'channelId'),
          this.requireString(args, 'messageId'),
          this.requireString(args, 'content'),
        );
        return 'Message edited';

      case 'delete_message': {
        const channelId = this.requireString(args, 'channelId');
        const messageId = this.requireString(args, 'messageId');
        // Gone from Slack, deleted now or already, so no rollback tries to
        // delete it again. Any other failure keeps it recorded, for a
        // rollback to try.
        try {
          await this.slack.deleteMessage(channelId, messageId);
        } catch (err) {
          if (slackRefusal(err) === 'message_not_found') this.stateTracker.forgetSent(channelId, messageId);
          throw err;
        }
        this.stateTracker.forgetSent(channelId, messageId);
        return 'Message deleted';
      }

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
        // The download is a request this call makes, so it keeps the start rule
        // the client's requests keep, with the client's timeout as its whole
        // time: a stalled file host costs that timeout, not what's left of the
        // call.
        assertRequestFits('The download from files.slack.com', SLACK_CLIENT_OPTIONS.timeout);
        return toFetchResult(await fetchAttachmentBytes(url.toString(), fileName, {
          headers,
          signal: AbortSignal.timeout(SLACK_CLIENT_OPTIONS.timeout),
        }));
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
        this.unsubscribedByAgent.add(channelId);
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

    const generation = ++this.registrationGeneration;
    const isCurrent = () => this.conn === conn && !conn.isClosed &&
      this.registrationGeneration === generation && this.grant.has('channels.register');
    // Until it ends, however it ends, a refresh_channels answers at once
    // while this registration is current.
    const running = { isCurrent };
    this.registering = running;
    try {
      await this.listAndRegister(conn, isCurrent);
    } finally {
      if (this.registering === running) this.registering = undefined;
    }
  }

  private async listAndRegister(conn: McplConnection, isCurrent: () => boolean): Promise<void> {
    let descriptors: ChannelDescriptor[] = [];
    try {
      // This listing runs in the background (a refresh_channels meanwhile
      // answers at once), so a request Slack rate-limits is waited out, as
      // Slack asks, and one that fails in a way that can pass is asked again
      // after a wait, and the listing goes on from there.
      const convs = await this.slack.listConversations(false, (wait, inARow) =>
        this.waitToAskAgain(wait, inARow, isCurrent));
      descriptors = convs.map((c) => toDescriptor(c, this.slack.teamName, this.slack.canWrite(c.id)));
    } catch (err) {
      // One superseded meanwhile stops without a word; the newer one reports.
      if (isCurrent()) {
        const why = err instanceof GaveUp
          ? `${err.message}, so registration stopped; refresh_channels can announce the conversations later`
          : (err as Error).message;
        console.error('[slack-mcpl] Failed to enumerate conversations:', why);
      }
      return;
    }
    dbg('registerSlackChannels', { count: descriptors.length });
    if (descriptors.length === 0) return;
    // A revoke/re-grant can start a newer listing while Slack answers this one.
    if (!isCurrent()) return;

    const regParams: ChannelsRegisterParams = { channels: descriptors };
    let answer: unknown;
    try {
      answer = await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
    } catch (err) {
      console.error('[slack-mcpl] Failed to register channels:', (err as Error).message);
      return;
    }
    if (!isCurrent()) return;
    this.applyRegistrationAnswer(descriptors, answer);
  }

  /** Registration's wait before asking Slack again for a request it was
   *  rate-limited on, or that failed in a way that can pass, after which the
   *  listing asks again. Each wait is logged. It gives up instead once the
   *  request has been tried REGISTRATION_TRIES times in a row. A registration
   *  that is no longer current stops listing, rather than wait or give up, or
   *  once its wait ends. */
  private async waitToAskAgain(wait: SlackWait, inARow: number, isCurrent: () => boolean): Promise<void> {
    const superseded = () => new Error('A newer registration superseded this one');
    // One superseded during its listing would otherwise wait for nothing.
    // Checked before the give-up, which a DM's name survives: a superseded
    // listing that gave up on a name would go on listing.
    if (!isCurrent()) throw superseded();
    if (inARow >= REGISTRATION_TRIES) {
      throw new GaveUp(`Slack rate-limited or failed the same request ${inARow} times in a row`);
    }
    const what = wait.why === 'limited' ? `Slack rate-limited ${wait.method}` : `${wait.method} failed`;
    console.error(`[slack-mcpl] ${what} (try ${inARow} of ${REGISTRATION_TRIES}); registration asks again in ${wait.seconds} s`);
    await new Promise<void>((resolve) => { setTimeout(resolve, wait.seconds * 1000).unref(); });
    if (!isCurrent()) throw superseded();
  }

  /**
   * Apply the host's channels/register answer (§14.5) to each descriptor it
   * itemizes. `accepted: true` makes a descriptor known. `accepted: false`
   * forgets it and closes it if it was open. An omitted or malformed entry
   * counts as unanswered: its descriptor stays as it was, and an unknown
   * one remains available for refresh_channels to announce again.
   */
  private applyRegistrationAnswer(sent: ChannelDescriptor[], answer: unknown): void {
    const results = (answer as { results?: unknown } | null | undefined)?.results;
    if (!Array.isArray(results)) {
      console.error('[slack-mcpl] The host answered channels/register without itemized results, so no channel was accepted');
      return;
    }
    const answered = new Map<string, { accepted: boolean; reason?: unknown }>();
    for (const r of results) {
      const { id, accepted, reason } = (r ?? {}) as { id?: unknown; accepted?: unknown; reason?: unknown };
      if (typeof id === 'string' && typeof accepted === 'boolean') answered.set(id, { accepted, reason });
    }
    const refused: string[] = [];
    const unanswered: string[] = [];
    for (const d of sent) {
      const a = answered.get(d.id);
      if (!a) {
        unanswered.push(d.id);
      } else if (a.accepted) {
        this.channelManager.register(d);
      } else {
        this.channelManager.unregister(d.id);
        refused.push(typeof a.reason === 'string' && a.reason ? `${d.id} (${a.reason})` : d.id);
      }
    }
    // One line per answer, so an operator can see why a conversation never registered.
    if (refused.length > 0 || unanswered.length > 0) {
      console.error(
        `[slack-mcpl] Of ${sent.length} channels sent to channels/register, the host refused ${refused.length}` +
          (refused.length > 0 ? `: ${refused.join(', ')}` : '') +
          `; it left ${unanswered.length} unanswered` +
          (unanswered.length > 0 ? `: ${unanswered.join(', ')}` : ''),
      );
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
    const conn = this.conn;
    // A refresh doesn't list while the latest registration is running and can
    // still register, so that registration's host answer, if it still applies,
    // is applied before this listing instead of racing it; a channel that
    // answer refuses is unknown again, so a refresh after it announces it.
    // Waiting for registration can take longer than the host waits for this
    // call, so a refresh meanwhile answers at once. A registration that is no
    // longer current, after a revoke or a re-grant, on an earlier connection,
    // or on a connection the host hasn't granted channels.register, plain MCP
    // ones included, applies no answer from the host, so it holds no refresh
    // back.
    if (this.registering?.isCurrent()) {
      throw new Error(
        "Nothing was announced to the host: this server is still registering the workspace's conversations. " +
          'Registration announces what it finds, unless it stops early. Once it has ended, refresh_channels lists ' +
          "again and announces anything registration didn't, such as a conversation created since it began; until " +
          'then it answers like this.',
      );
    }
    const gone = () => this.conn !== conn || !!conn?.isClosed;
    const convs = await this.slack.listConversations();
    // The host keeps the label a conversation is first announced with, and a
    // refresh never announces a known one again, so a new DM whose user's name
    // this server couldn't get from Slack just now waits for a later refresh
    // rather than go out labelled with the user's id. One the host already
    // knows stays as it is.
    const unnamed = convs.filter((c) => c.nameWait && !this.channelManager.get(mcplChannelId(c.id)));
    const descriptors = convs
      .filter((c) => !c.nameWait)
      .map((c) => toDescriptor(c, this.slack.teamName, this.slack.canWrite(c.id)));
    // As registration does after its listing: a listing begun for a peer that
    // has since gone neither writes the registry nor announces. The grant is
    // checked next, in registerAndNotifyNew (serve() handles one request at a
    // time, so no featureSets/update lands during the listing).
    if (gone()) {
      return {
        visible: convs.length,
        added: [],
        note: "The host's connection closed while Slack was listing conversations; nothing was announced.",
      };
    }
    const added = this.registerAndNotifyNew(descriptors);
    const notGranted = this.mcplEnabled && !this.grant.has('channels.register');
    const wait = Math.max(1, ...unnamed.map((c) => c.nameWait?.seconds ?? 0));
    const unnamedIds = unnamed.map((c) => `${mcplChannelId(c.id)} (user ${c.userId})`).join(', ');
    const leftOut = notGranted || unnamed.length === 0 ? '' :
      ` Left out ${unnamed.length} DM(s) whose user's name this server couldn't get from Slack just now, since ` +
        `the host keeps the label a conversation is first announced with: ${unnamedIds}. Call refresh_channels ` +
        `again in about ${wait} second${wait === 1 ? '' : 's'} to announce them by name. This server still sends ` +
        'their messages to the host meanwhile.';
    return {
      visible: convs.length,
      added: added.map((d) => ({ id: d.id, label: d.label })),
      note:
        (added.length > 0
          ? `Registered ${added.length} newly-visible conversation(s).`
          : notGranted
            ? 'The host has not granted channels.register; nothing was announced.'
            : unnamed.length > 0
              ? 'No conversation was registered.'
              : 'No new conversations — the host already knows about every visible one.') + leftOut,
    };
  }

  private handleChannelOpen(params: ChannelsOpenParams): ChannelsOpenResult {
    // A non-empty exact id (which mcpl-core prefers) or any address field
    // names something. Open the named channel or fail; even an address we
    // cannot resolve must not open an unrelated conversation instead.
    const addr = params.address as { channelId?: string } | undefined;
    const named = params.channelId
      || (params.type === 'slack' && addr?.channelId ? mcplChannelId(addr.channelId) : undefined);
    if (named || Object.keys(addr ?? {}).length > 0) {
      const desc = named ? this.channelManager.open(named) : undefined;
      if (desc) {
        return { channel: desc };
      }
      throw new Error('No matching channel found');
    }

    // A request that names no channel opens the first registered channel of its type
    for (const desc of this.channelManager.getAll()) {
      if (desc.type === params.type) {
        this.channelManager.open(desc.id);
        return { channel: desc };
      }
    }

    throw new Error('No matching channel found');
  }

  /** `published` gets the conversation and thread the post goes to, before
   *  Slack is asked, for explaining a refusal: an incoming message can move
   *  the conversation's thread while the post is under way. */
  private async handlePublish(
    params: ChannelsPublishParams,
    published: Record<string, unknown>,
  ): Promise<ChannelsPublishResult> {
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
    Object.assign(published, { channelId: parsed.conversationId, threadTs });
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

    // This server's rule, not the spec's: rollback deletes the bot's messages
    // and uploaded files, a slack.messaging write, so it runs only while
    // slack.messaging is active on the connection asking. §5.3 keeps it
    // inactive until that connection's initial policy. A refusal leaves the
    // checkpoint in place.
    if (!this.grant.isFeatureSetActive(MESSAGING_FEATURE_SET)) {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: `Feature set '${MESSAGING_FEATURE_SET}' is not active on this connection`,
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

    // Best-effort delete of sent messages and uploaded files, each counted in
    // its own kind: an upload is its file, then the message that shared it,
    // when Slack's answer named one, and neither delete skips the other. An
    // answer that says the item is already gone counts it as deleted.
    const sent = { message: 0, file: 0 };
    const deleted = { message: 0, file: 0 };
    const attempt = async (kind: 'message' | 'file', what: string, channelId: string, gone: string[], remove: () => Promise<void>) => {
      sent[kind]++;
      try {
        await remove();
        deleted[kind]++;
      } catch (err) {
        const refusal = slackRefusal(err);
        if (refusal !== undefined && gone.includes(refusal)) {
          deleted[kind]++;
          return;
        }
        // Best-effort otherwise: the delete was refused, rate-limited, out of
        // this call's time, or failed on the way. The tracker has dropped it
        // with the branch, so no later rollback tries it again, and an
        // operator finds it here.
        console.error(`[slack-mcpl] Rollback couldn't delete ${what} in ${channelId}: ${(err as Error)?.message ?? String(err)}`);
      }
    };
    for (const item of toDelete) {
      if (item.kind === 'file') {
        await attempt('file', `file ${item.fileId}`, item.channelId, FILE_GONE,
          () => this.slack.deleteFile(item.channelId, item.fileId));
        const { shareTs } = item;
        if (shareTs) {
          await attempt('message', `message ${shareTs}, which shared file ${item.fileId},`, item.channelId, ['message_not_found'],
            () => this.slack.deleteMessage(item.channelId, shareTs));
        }
      } else {
        await attempt('message', `message ${item.messageId}`, item.channelId, ['message_not_found'],
          () => this.slack.deleteMessage(item.channelId, item.messageId));
      }
    }

    // What was deleted of each kind, when something wasn't; and an upload's
    // comment that may be left, when Slack may have shared the file with it
    // and this server doesn't know the message that did.
    const counts = (['message', 'file'] as const)
      .filter((kind) => sent[kind] > 0)
      .map((kind) => `${deleted[kind]}/${sent[kind]} ${kind}s`)
      .join(' and ');
    // chat.delete, with a bot token, takes "only messages posted by that bot";
    // whether Slack counts a file's sharing message as one isn't known, hence
    // "may".
    const commentsLeft = toDelete.filter((item): item is UploadedFile => item.kind === 'file' && item.comment && !item.shareTs);
    const ids = "which fetch_history shows, or fetch_thread if the file went into a thread";
    const notes = [
      ...(deleted.message + deleted.file < sent.message + sent.file ? [`Rolled back (${counts} deleted)`] : []),
      ...(commentsLeft.length === 1
        ? [`The comment of uploaded file ${commentsLeft[0].fileId} may remain in conversation ${commentsLeft[0].channelId}: ` +
          "this server doesn't know the message that shared the file, so no rollback can delete it. delete_message " +
          `may, by that message's id, ${ids}`]
        : commentsLeft.length > 1
          ? [`The comments of uploaded files ${commentsLeft.map((f) => `${f.fileId} in ${f.channelId}`).join(', ')} may remain: ` +
            "this server doesn't know the messages that shared them, so no rollback can delete them. delete_message " +
            `may, by those messages' ids, ${ids}`]
          : []),
    ];
    return {
      checkpoint: params.checkpoint,
      success: true,
      reason: notes.length > 0 ? notes.join('. ') : undefined,
    };
  }

  // ── Slack Event Forwarding ──

  private setupSlackForwarding(): void {
    this.slack.onMessage((msg) => {
      const conn = this.conn;
      if (!conn || !this.mcplEnabled || !this.grant.isFeatureSetActive(MESSAGING_FEATURE_SET)) {
        if ((msg.mentionsBot || msg.isDM) && (!conn || this.mcplEnabled)) {
          const why = conn ? 'slack.messaging is not active' : 'no peer is connected';
          console.error(`[slack-mcpl] Dropped addressed message ${msg.id} in ${msg.channelId} before delivery: ${why}`);
        }
        return;
      }
      if (msg.mentionsBot || msg.isDM) void this.slack.acknowledge(msg.channelId, msg.id);
      const previous = this.forwarding.get(msg.channelId) ?? Promise.resolve();
      const pending = previous.then(() => this.handleSlackMessage(msg, conn)).catch((err) => {
        console.error('[slack-mcpl] Error forwarding Slack message:', err);
      });
      this.forwarding.set(msg.channelId, pending);
      void pending.then(() => {
        if (this.forwarding.get(msg.channelId) === pending) this.forwarding.delete(msg.channelId);
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

  /** Optional delivery context must not hold a conversation behind a stalled
   *  Slack call. A late result is ignored; the client may still finish its call.
   *  A give-up or a failure is logged, since the message goes without what it
   *  looked up. */
  private async deliveryLookup<T>(lookup: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gaveUp = false;
    try {
      return await Promise.race([
        lookup.catch((err: unknown) => {
          if (!gaveUp) console.error(`[slack-mcpl] Couldn't get ${what} (${(err as Error).message}); delivering without it`);
          throw err;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            gaveUp = true;
            console.error(`[slack-mcpl] Gave up on ${what} after 5 s; delivering without it`);
            reject(new Error(`Gave up on ${what} after 5 s`));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The conversation's metadata for a message's note, backscroll and header;
   *  null when Slack can't say, or doesn't within the bound. */
  private lookUpMeta(msg: SlackMessageData) {
    return this.deliveryLookup(this.slack.getConversationMeta(msg.channelId), `the name of conversation ${msg.channelId}`)
      .catch(() => null);
  }

  private async handleSlackMessage(msg: SlackMessageData, conn: McplConnection): Promise<void> {
    const isCurrent = () => this.conn === conn && !conn.isClosed && this.mcplEnabled &&
      this.grant.isFeatureSetActive(MESSAGING_FEATURE_SET);
    dbg('handleSlackMessage:enter', {
      msgId: msg.id,
      channelId: msg.channelId,
      authorId: msg.authorId,
      mentionsBot: msg.mentionsBot,
      isDM: msg.isDM,
      current: isCurrent(),
      mcplEnabled: this.mcplEnabled,
    });
    // Direct address (mention or DM) always reaches the agent. Ambient
    // messages only flow from subscribed conversations — otherwise every
    // visible channel would pour unbounded noise into context. The wake
    // decision is the host's, via the chat:* tags below.
    const isAddressed = msg.mentionsBot || msg.isDM;
    const releaseAck = () => {
      if (isAddressed) void this.slack.clearAck(msg.channelId, msg.id);
    };
    // Queued work belongs to the peer that received it. When that peer has
    // left, or slack.messaging isn't active, before the message reaches it,
    // the message is dropped; an addressed one says so once on stderr.
    const abandon = () => {
      if (!isAddressed) return;
      const why = this.conn === conn && !conn.isClosed ? 'slack.messaging is not active' : 'its peer disconnected';
      console.error(`[slack-mcpl] Dropped addressed message ${msg.id} in ${msg.channelId} before delivery: ${why}`);
      releaseAck();
    };
    // §6.7: a disabled slack.messaging stops its traffic at once — incoming
    // and push alike. False before the initial policy exchange too (§5.3):
    // fail closed until the host's featureSets/update Request is answered.
    if (!isCurrent()) return abandon();

    if (!isAddressed && !this.isChannelSubscribed(msg.channelId)) {
      dbg('handleSlackMessage:drop', { reason: 'ambient-not-subscribed', channelId: msg.channelId });
      return;
    }

    // First-interaction handling: when the very first message from this
    // conversation for this peer is addressed, pull backscroll for context.
    // A mention may also auto-subscribe the conversation, with a system note
    // (below). Both are committed in taken(), once the host has the message
    // that carries them.
    this.ensureSubscriptionsLoaded();
    const isFirstInteraction = !this.forwardedWatermark.has(msg.channelId);
    // The conversation's metadata is looked up at most once per message: the
    // first interaction's note and backscroll and the location header share it.
    // A DM's header says DM and a DM gets no note, so a DM looks up none.
    let meta: Awaited<ReturnType<typeof this.slack.getConversationMeta>> | undefined;
    let backscroll: Awaited<ReturnType<typeof this.slack.fetchHistory>>['messages'] = [];
    if (isFirstInteraction && isAddressed) {
      try {
        const res = await this.deliveryLookup(this.slack.fetchHistory(msg.channelId, {
          limit: this.backscrollLimit,
          latest: msg.id, // never include the triggering message itself
        }), `the backscroll for message ${msg.id} in ${msg.channelId}`);
        // Drop the bot's own past messages — already in the agent's
        // chronicle as assistant turns, no need to re-echo.
        backscroll = res.messages.filter((m) => m.authorId !== this.slack.botUserId);
      } catch (err) {
        dbg('backscroll:fetch-failed', { channelId: msg.channelId, error: (err as Error).message });
      }
      if (!isCurrent()) return abandon();
      if (!msg.isDM) {
        meta = await this.lookUpMeta(msg);
        if (!isCurrent()) return abandon();
      }
    }

    // The conversation is named only when it differs from the last context
    // this peer was sent, which is read here, after the lookups above, since
    // another conversation's message can go out while they run. The thread
    // and the message ID are given every time: two threads in one channel are
    // otherwise indistinguishable, and replying or reacting to a message needs
    // its ID.
    const contextChanged = this.lastChannelId !== msg.channelId;
    if (contextChanged && meta === undefined && !msg.isDM) {
      meta = await this.lookUpMeta(msg);
      if (!isCurrent()) return abandon();
    }

    // Nothing is awaited from here to the send, so what is decided here is
    // what the host is told. An unsubscribe_channel handled by now withholds
    // the note; one handled during the send still stops the subscribe in
    // taken(). In member mode every conversation is subscribed unless muted,
    // and a mention must not undo a mute. DMs always come through, so no
    // subscription note for them — just the backscroll.
    const autoSubscribe = isFirstInteraction && isAddressed && !msg.isDM && !this.opts.subscribeMemberChannels &&
      !this.unsubscribedByAgent.has(msg.channelId) && !this.isChannelSubscribed(msg.channelId);
    const blocks: string[] = [];
    if (autoSubscribe) {
      const where = meta?.name ? `#${meta.name}` : `conversation ${msg.channelId}`;
      blocks.push(
        `<system>Auto-subscribed to ${where} because you were mentioned. ` +
          `Ambient (non-mention) messages from this conversation will now arrive in your context. ` +
          `Mentions and DMs always come through regardless of subscriptions. ` +
          `To stop ambient delivery from here: unsubscribe_channel("${msg.channelId}").</system>`,
      );
    }
    if (backscroll.length > 0) {
      blocks.push(backscrollBlock(backscroll, { channelName: meta?.name, isDM: msg.isDM }));
    }
    // Told with the first message the agent gets from here, addressed or not.
    // Counted as told only once the host has taken that message.
    const noteReadOnly = !this.slack.canWrite(msg.channelId) && !this.readOnlyNoted.has(msg.channelId);
    if (noteReadOnly) {
      blocks.push(
        `<system>You cannot write to conversation ${msg.channelId}: it is not on the write allow-list. ` +
          `You can read it; do not try to reply there.</system>`,
      );
    }
    const prefixBlock = blocks.map((b) => `${b}\n`).join('');

    const channelMcplId = mcplChannelId(msg.channelId);
    const channelIsOpen = this.channelManager.isOpen(channelMcplId);
    // A conversation whose name Slack didn't give is named by its ID.
    const conversation = !contextChanged ? undefined : msg.isDM ? 'DM' : meta?.name ? `#${meta.name}` : msg.channelId;
    const location = locationHeader({
      conversation,
      teamName: contextChanged ? this.slack.teamName : undefined,
      threadTs: msg.threadTs,
      messageId: msg.id,
    });
    // The context is recorded as the message goes out, so the next message
    // is compared with what this peer was sent last.
    this.lastChannelId = msg.channelId;
    const renderedContent = `${prefixBlock}${location}${msg.authorName}: ${msg.cleanContent}`;

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
    // take the reaction off and commit nothing: the next message from here is
    // still a first interaction, and, if this message's context still stands,
    // the next header names its conversation. Once the host takes the
    // auto-subscribe note, subscribe unless the agent unsubscribed during the
    // send. Record per-peer context only for the connection that took it.
    const notTaken = () => {
      releaseAck();
      if (this.conn === conn && this.lastChannelId === msg.channelId) this.lastChannelId = null;
    };
    const taken = () => {
      if (autoSubscribe && !this.unsubscribedByAgent.has(msg.channelId)) this.subscribe(msg.channelId);
      // Acceptance records what this peer received, even if its grant changed.
      if (this.conn !== conn) return;
      this.lastIncomingThreadTs.set(msg.channelId, msg.threadTs);
      this.forwardedWatermark.set(msg.channelId, msg.id);
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

      let res: { results?: Array<{ accepted?: boolean }> } | undefined;
      try {
        res = await conn.sendRequest(method.CHANNELS_INCOMING, incomingParams) as typeof res;
        dbg('handleSlackMessage:sent', { method: 'channels/incoming', channelMcplId });
      } catch (err) {
        console.error(`[slack-mcpl] channels/incoming failed for message ${msg.id} in ${msg.channelId}:`, (err as Error).message);
        notTaken();
        return;
      }
      if (res?.results?.[0]?.accepted === false) notTaken();
      else taken();
    } else {
      const pushParams: PushEventParams = {
        featureSet: MESSAGING_FEATURE_SET,
        eventId: `slack_msg_${msg.channelId}_${msg.id}`,
        timestamp: msg.timestamp.toISOString(),
        origin: {
          source: 'slack',
          messageId: msg.id,
          channelId: msg.channelId,
          // The MCPL channel ID, so a host can route and type to a channel it
          // has not opened (zulip-mcp sends the same field).
          mcplChannelId: channelMcplId,
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

      let res: { accepted?: boolean } | undefined;
      try {
        res = await conn.sendRequest(method.PUSH_EVENT, pushParams) as typeof res;
        dbg('handleSlackMessage:sent', { method: 'push/event', channelMcplId });
      } catch (err) {
        console.error(`[slack-mcpl] push/event failed for message ${msg.id} in ${msg.channelId}:`, (err as Error).message);
        notTaken();
        return;
      }
      if (res?.accepted === false) notTaken();
      else taken();
    }
  }
}
