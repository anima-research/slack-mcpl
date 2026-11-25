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
 * Typing: Slack has no typing indicator for bots outside RTM. channels/typing
 * is shown instead as a thread status ("is thinking…",
 * assistant.threads.setStatus, which works in channels with chat:write since
 * 2026-03) on an accepted addressed thread still waiting for an answer.
 *
 * Event handling salvaged from zulip-mcp PR #8's SlackAdapter.
 */

import { MAX_MESSAGE_TEXT_APPEND, renderMessageText } from './message-text.js';
import { setMaxListeners } from 'node:events';
import { isConversationRow, isDirectoryRow, isMemberRow, pageProblem, paginationLimits, type PaginationLimits, type PageTruncation } from './pagination.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WebClient, ErrorCode, LogLevel, type Logger, type WebAPICallResult, type WebClientOptions } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { associatedFile, FILE_ID, policyFileRefs, privateFileUrl, type PolicyFileRef } from './file-access.js';
import { clock } from './clock.js';
import { SlackAccessDenied, SlackAccessUnverified, SlackAccessGrantDenied, SlackFileAccessUnverified, SlackScopeEvidenceError, SlackAccessInputError, accessContextOriginalMessage, withAccessContext, SlackAccessPolicy, type SlackAccessPolicyConfig } from './access-policy.js';
import { NOTHING_RETURNED, SLACK_TS, readBounded, readOptions, type HistoryReadResult, type ReadStop } from './history-read.js';
import {
  formatSlackText,
  extractSlackUserIds,
  resolveSlackUserNames,
  fetchSlackHistory,
  classifyExtension,
  reactionName,
  SLACK_CODE,
  SLACK_FAILED,
  connectionNeverMade,
  type AttachmentRef,
  type SlackHistoryMessage,
} from './content.js';

/** An acknowledgement reaction is removed after this, replied to or not. */
export const ACK_TTL_MS = 10 * 60 * 1000;
/** A removal that failed in a way that can pass is tried again after this,
 *  up to ACK_MAX_TRIES tries in all. */
const ACK_RETRY_MS = 60 * 1000;
const ACK_MAX_TRIES = 5;
/** Slack's answers to a write after which it may have taken effect:
 *  already_reacted, to an acknowledgement's add, and the failures the
 *  explainer calls an unknown outcome. */
const MAY_HAVE_LANDED = new Set(['already_reacted', 'internal_error', 'fatal_error', 'service_unavailable', 'file_update_failed']);
/** The host refreshes typing every few seconds; Slack keeps a thread status
 *  for 2 minutes, so it is set again only after this. */
export const STATUS_REFRESH_MS = 60 * 1000;
const STATUS_TEXT = 'is thinking…';
const STATUS_THREAD_REFUSALS = new Set(['invalid_thread_ts']);

/** This adapter confirmed a DM or a conversation it cannot treat as a channel. */
class ChannelOnlyRefusal extends Error {}

/** Failure before an effect's authorization boundary, including embedded clients. */
const accessAdmissionFailures = new WeakSet<object>();
export function failedAccessAdmission(err: unknown): boolean {
  return errorChain(err).some(value => accessAdmissionFailures.has(value));
}

/** Bounded cause traversal; wrappers retain per-occurrence request provenance. */
function errorChain(err: unknown): object[] {
  const chain: object[] = [];
  while (err !== null && typeof err === 'object' && chain.length < 16 && !chain.includes(err)) {
    chain.push(err);
    if (clientErrorSources.has(err)) break; // The cause belongs to an earlier/client occurrence.
    // A cause accessor that throws ends the chain; formatting an error never throws for it.
    try { err = (err as { cause?: unknown }).cause; } catch { break; }
  }
  return chain;
}

/** Raw client errors are reusable, even when frozen or rethrown by an embedder.
 * Only a fresh occurrence may acquire admission, context or effect marks. */
// Only the client request boundary advances this clock. All observations,
// positive or negative, retain the producing request's issue serial: the
// serial of the send that produced the answer. SlackWebClient's resend after
// a rate limit takes a fresh serial when it actually goes out.
let observationSerial = 0;
const requestIssue = new AsyncLocalStorage<{ issued: number }>();
/** Stamp the current wrapped call's next send (no-op outside the policy view). */
function issueRequest(): void {
  const issue = requestIssue.getStore();
  if (issue) issue.issued = ++observationSerial;
}
const responseIssued = new WeakMap<object, number>();
const clientErrorSources = new WeakMap<object, object>();
function clientErrorOccurrence(err: object, method: string): object {
  let source = err;
  while (clientErrorSources.has(source)) source = clientErrorSources.get(source)!;
  // Read source accessors with their branded receiver (DOMException/private
  // fields), but keep all per-call annotations on a fresh carrier.
  const target = Object.create(source instanceof OutOfCallTime && source.method !== method ? Error.prototype : Object.getPrototypeOf(source));
  Object.defineProperties(target, {
    message: { value: accessContextOriginalMessage(source) ?? (source as Error).message ?? 'Slack request failed', writable: true, configurable: true },
    cause: { value: source, configurable: true },
  });
  const failure = new Proxy(target, {
    get(target, key, receiver) {
      return Object.hasOwn(target, key) ? Reflect.get(target, key, receiver) : Reflect.get(source, key, source);
    },
  });
  clientErrorSources.set(failure, source);
  failedRequests.set(failure, method);
  return failure;
}

/** Authoritative refusals read from a fresh Slack metadata response (such as
 *  non-membership), as opposed to local policy denials. */
const metadataRefusals = new WeakSet<object>();

/** A stored refusal is evidence, not an occurrence: each operation that
 *  rethrows it gets its own carrier, so one operation's context, admission
 *  and effect marks never reach another's error. */
function refusalOccurrence(refusal: unknown): unknown {
  if (refusal === null || typeof refusal !== 'object') return refusal;
  if (clientErrorSources.has(refusal)) return clientErrorOccurrence(refusal, failedRequests.get(refusal) ?? 'conversations.info');
  const copy = Object.assign(Object.create(Object.getPrototypeOf(refusal)), refusal) as Error;
  Object.defineProperties(copy, {
    message: { value: accessContextOriginalMessage(refusal) ?? (refusal as Error).message, writable: true, configurable: true },
    cause: { value: refusal, configurable: true },
  });
  Error.captureStackTrace(copy);
  return copy;
}

/** A lazy view keeps supported injected-client method replacements observable.
 * No client object/error is mutated. Local policy errors keep their identity
 * after this boundary, so nested contexts and rollback share one occurrence. */
function isolateClientErrors(web: SlackWebLike, enabled: () => boolean, observe: (method: string, args: unknown[], answer: unknown, error: boolean, issued: number) => void): SlackWebLike {
  const views = new WeakMap<object, Map<string, object>>();
  const view = (source: object, path: string): object => {
    let paths = views.get(source);
    if (!paths) views.set(source, paths = new Map());
    let proxy = paths.get(path);
    if (proxy) return proxy;
    // An empty target also permits frozen client namespaces: wrapping a frozen
    // method directly on its source would violate Proxy get invariants.
    proxy = new Proxy({}, {
      get(_target, key) {
        const value = Reflect.get(source, key, source);
        // Without a policy the client is main's, untouched: no wrapper, so a
        // callable namespace keeps its methods.
        if (!enabled()) return value;
        const method = path ? `${path}.${String(key)}` : String(key);
        if (typeof value === 'function') return async (...args: unknown[]) => {
          const issue = { issued: ++observationSerial };
          let result: unknown;
          try { result = await requestIssue.run(issue, () => Reflect.apply(value, source, args)); }
          catch (err) {
            if (!enabled()) throw err;
            const { issued } = issue;
            const failure = clientErrorOccurrence(err !== null && typeof err === 'object' ? err : new Error('Slack client rejected without an error', { cause: err }), method);
            observe(method, args, failure, true, issued);
            throw failure;
          }
          if (!enabled()) return result;
          const { issued } = issue;
          // A fresh carrier also isolates reused/frozen response objects. Request
          // provenance belongs to this occurrence, never to client-owned data.
          if (result !== null && typeof result === 'object') {
            result = new Proxy(result, {});
            responseIssued.set(result as object, issued);
          }
          observe(method, args, result, false, issued);
          return result;
        };
        return value !== null && typeof value === 'object' ? view(value, method) : value;
      },
      // Preserve test/embedding method replacement through the adapter view.
      set(_target, key, value) { return Reflect.set(source, key, value); },
      deleteProperty(_target, key) { return Reflect.deleteProperty(source, key); },
      defineProperty(_target, key, descriptor) { return Reflect.defineProperty(source, key, descriptor); },
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        return descriptor && { ...descriptor, configurable: true };
      },
      ownKeys() { return Reflect.ownKeys(source); },
    });
    paths.set(path, proxy);
    return proxy;
  };
  return view(web, '') as SlackWebLike;
}

/** The history grant a freshly admitted conversation's kind needs. */
function historyScope(conversation: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean }): string {
  return conversation.is_mpim ? 'mpim:history' : conversation.is_im ? 'im:history'
    : conversation.is_private ? 'groups:history' : 'channels:history';
}

/** Content-free policy diagnostics: never log Slack payloads, text or stacks. */
export function policyFailureSummary(err: unknown): string {
  const code = slackRefusal(err);
  if (code) return `Slack refusal ${code.slice(0, 64)}`;
  if (err instanceof NoReadableConversations) return 'no readable conversation grants; ask the host to grant read scopes and reinstall';
  if (err instanceof SlackAccessGrantDenied) {
    const scope = /granted scope '([a-z]+:[a-z.]+)'/.exec(accessContextOriginalMessage(err) ?? err.message)?.[1];
    return `missing Slack grant${scope ? ` ${scope}` : ''}; whoever runs this host can add it to the app and reinstall`;
  }
  // The listing's malformed-cursor refusal is fixed text naming no conversation, so it is kept like a cycle's.
  if (err instanceof SlackAccessUnverified && err.message === LISTING_CURSOR_UNVERIFIED) return err.message;
  if (err instanceof SlackAccessDenied) return err.authoritative ? 'access refused' : 'access evidence unavailable';
  if (err instanceof LocalFailure || err instanceof SlackScopeEvidenceError) return err.message;
  const kind = (err as { code?: unknown } | null)?.code;
  if ([ErrorCode.RateLimitedError, ErrorCode.RequestError, ErrorCode.HTTPError].includes(kind as ErrorCode)) return String(kind);
  if (err instanceof OutOfCallTime) return 'out of call time; nothing was sent';
  // Local outcomes are not Slack failures.
  if (err instanceof Error && /\b(?:admission|listing) (?:was )?stopped\b/i.test(err.message)) return 'stopped at shutdown';
  if (err instanceof TypeError) return 'missing or malformed result (local check)';
  // Not necessarily Slack's: a host handler or local check can fail here too.
  return 'unclassified failure (details withheld); outcome may be unknown';
}

/** Slack's code, when Slack refused the call; undefined for any other error,
 *  an answer with no code in Slack's form (SLACK_CODE) included. */
export function slackRefusal(err: unknown): string | undefined {
  const e = err as { code?: unknown; data?: { error?: unknown } } | null;
  const code = e?.code === ErrorCode.PlatformError ? e.data?.error : undefined;
  return typeof code === 'string' && SLACK_CODE.test(code) ? code : undefined;
}

/** Whether Slack refused `err`'s request in its form and will refuse it the
 *  same way again: a refusal that isn't Slack's own failure (SLACK_FAILED), so
 *  one waitToAskAgain gives no wait. */
export function refusedForGood(err: unknown): boolean {
  if (err instanceof SlackAccessDenied) return err.authoritative;
  const code = slackRefusal(err);
  return code !== undefined && !SLACK_FAILED.has(code);
}

/** Slack's lasting refusals of access to a conversation's metadata or
 *  messages, or to the token: evidence that vetoes a later transient
 *  fallback. Other lasting refusals (invalid_arguments, invalid_cursor, …)
 *  say nothing about access and stay out. */
export const ACCESS_REFUSALS = new Set([
  'not_in_channel', 'channel_not_found', 'invalid_channel_id', 'missing_scope', 'is_archived',
  'access_denied', 'restricted_action', 'no_permission', 'not_allowed_token_type',
  'team_access_not_granted', 'ekm_access_denied', 'org_login_required',
  'not_authed', 'invalid_auth', 'token_revoked', 'token_expired', 'account_inactive',
]);

/** Slack's refusals of the token itself, whatever conversation was asked about. */
const TOKEN_REFUSALS = new Set(['not_authed', 'invalid_auth', 'token_revoked', 'token_expired', 'account_inactive']);

/** Slack's answers to conversations.info that it has no such conversation to
 *  show this bot (channel_not_found), or that the id isn't one at all
 *  (invalid_channel_id). */
const NOT_SHOWN = new Set(['channel_not_found', 'invalid_channel_id']);

/** What can change Slack's answer to a check of a conversation (with DMs off)
 *  that a later one wouldn't pass either: another conversation, or whoever
 *  runs this host. A check waitToAskAgain says can pass doesn't come here:
 *  assertNotDm leaves its error to the explainer. A rate limit's answer
 *  without the Retry-After the client needs does come here, and is told to
 *  try again shortly. */
function afterFailedCheck(err: unknown): string {
  const e = err as { data?: { needed?: unknown } } | null;
  const code = slackRefusal(err);
  // Not Slack's refusal, nor a failure waitToAskAgain names, such as a rate
  // limit's answer without the Retry-After the client needs.
  if (code === undefined) return 'Try again shortly.';
  if (NOT_SHOWN.has(code)) return 'list_channels shows the ones it can use.';
  if (code === 'missing_scope') {
    const needed = typeof e?.data?.needed === 'string' && e.data.needed ? ` (Slack names ${e.data.needed})` : '';
    return (
      `Calling again won't change that until whoever runs this host adds the scope it needs${needed} to the ` +
      "Slack app's bot token scopes and reinstalls the app."
    );
  }
  return "Calling again won't change Slack's answer; only whoever runs this host, or the workspace's admins, can.";
}

/** The read scope conversations.list needs for each conversation type. */
const TYPE_SCOPE: Record<string, string> = {
  public_channel: 'channels:read',
  private_channel: 'groups:read',
  im: 'im:read',
  mpim: 'mpim:read',
};

/** Each conversation type in an agent's words. */
const TYPE_WORDS: Record<string, string> = {
  public_channel: 'public channels',
  private_channel: 'private channels',
  im: 'DMs',
  mpim: 'group DMs',
};

const andList = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** The scopes a Slack answer, or a refusal's data, reports the token has, or
 *  undefined when it reports none. Slack returns an x-oauth-scopes header with
 *  every response, naming the token's scopes, and the client splits it on
 *  commas, so a blank header comes back as ['']. A blank or empty list is read
 *  as a header that didn't come through, not as a token without scopes. */
function reportedScopes(metadata: unknown, policy = false): string[] | undefined {
  const scopes = (metadata as { scopes?: unknown } | null | undefined)?.scopes;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return undefined;
  const named = policy ? scopes.map(scope => scope.trim()).filter(Boolean) : scopes.filter((scope) => scope !== '');
  return named.length > 0 ? named : undefined;
}

/** A listing's conversations, and the enabled types it left out because the
 *  token's scopes can't read them. */
export interface SlackListing {
  truncation?: PageTruncation;
  conversations: SlackConversationInfo[];
  leftOut: string[];
  /** Already-registered IDs seen in this scan but not re-admitted by refresh. */
  skippedKnown?: number;
  /** Background candidates skipped because fresh admission failed, or, in a
   *  foreground scan, the candidates its early stop left unchecked (at least 1). */
  admissionFailures?: number;
  /** Why a foreground scan stopped early and returned only the rows it had
   *  admitted: a rate limit (including a shared Retry-After that leaves no
   *  room) or the host call's deadline. Shutdown throws instead. */
  admissionStop?: { reason: 'rate_limited' | 'call_deadline'; retryAfterSeconds?: number };
}

/** What a listing's answer says of the types it left out, or '' when it left
 *  none out. */
export function leftOutNote(leftOut: string[]): string {
  if (leftOut.length === 0) return '';
  const scopes = leftOut.map((type) => TYPE_SCOPE[type]);
  const one = leftOut.length === 1;
  return `This listing leaves out ${andList(leftOut.map((type) => TYPE_WORDS[type]))}: this bot's token doesn't have ` +
    `${andList(scopes)}, the read scope${one ? '' : 's'} Slack needs to list ${one ? 'them' : 'those'}. Whoever runs ` +
    `this host can add ${one ? 'it' : 'them'} to the app's bot token scopes and reinstall the app to the workspace. ` +
    `Calling again won't list ${one ? 'them' : 'those'} until then.`;
}

/** A listing with no type to ask for: the token has the read scope of none of
 *  the types this server lists, as Slack last reported its scopes. `needed`
 *  holds those read scopes. */
export class NoReadableConversations extends Error {
  constructor(readonly needed: string[]) {
    super(`This bot's token has none of the read scopes ${andList(needed)}`);
    this.name = 'NoReadableConversations';
  }
}

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
 *  pass: in transit, with an HTTP error, by Slack's own failure, with an
 *  answer not in Slack's form, or by not being sent because its call was out
 *  of time (`failed`). */
export interface SlackWait {
  method: string;
  seconds: number;
  why: 'limited' | 'failed';
  /** Independent candidate admission budget, when applicable. */
  attempts?: number;
}

/** The wait before asking Slack again after `err` from a request to `method`,
 *  for work no call waits on; undefined when Slack's answer will be the same
 *  next time, or `err` isn't the client's. A request the host is waiting on
 *  waits out only a `limited` one, within its budget (SlackWebClient). */
export function waitToAskAgain(err: unknown, method: string, policy = false): SlackWait | undefined {
  if (policy && slackRefusal(err) === 'ratelimited') {
    const seconds = retryAfterSeconds(err);
    if (seconds !== undefined) return { method, seconds, why: 'limited' };
  }
  const e = err as { code?: unknown; retryAfter?: unknown } | null;
  if (e?.code === ErrorCode.RateLimitedError && typeof e.retryAfter === 'number') {
    return { method, seconds: e.retryAfter, why: 'limited' };
  }
  // A request its call's time left no room for can go out in a later call.
  // Only a request made for a call can get it, and work no call waits on
  // never does, so its wait is left at none.
  if (err instanceof OutOfCallTime) return { method, seconds: 0, why: 'failed' };
  const refused = slackRefusal(err);
  if (policy && refused === 'ratelimited') return { method, seconds: retryAfterSeconds(err) ?? FAILED_WAIT_SECONDS, why: 'limited' };
  const failedAtSlack = refused !== undefined && SLACK_FAILED.has(refused);
  // An answer not in Slack's form shows nothing about what Slack did.
  const unreadable = e?.code === ErrorCode.PlatformError && refused === undefined;
  if (e?.code === ErrorCode.RequestError || e?.code === ErrorCode.HTTPError || failedAtSlack || unreadable) {
    return { method, seconds: FAILED_WAIT_SECONDS, why: 'failed' };
  }
  return undefined;
}

/** The seconds Slack asked a rate-limited request to wait: a 429's
 *  Retry-After, or one that came with a ratelimited refusal in an HTTP 200,
 *  which the client puts in its response_metadata. They're kept only as a
 *  safe integer, at most 16 digits of JSON, which bounds a read result's own
 *  bytes (history-read.ts), and not below 0. */
export function retryAfterSeconds(err: unknown): number | undefined {
  const e = err as { code?: unknown; retryAfter?: unknown; data?: { response_metadata?: { retryAfter?: unknown } } } | null;
  const seconds = e?.code === ErrorCode.RateLimitedError ? e.retryAfter : e?.data?.response_metadata?.retryAfter;
  return Number.isSafeInteger(seconds) && (seconds as number) >= 0 ? (seconds as number) : undefined;
}

/** Why a read tool's page failing stops the read with what it has, rather
 *  than failing it: the call's time had no room for the page, or Slack
 *  rate-limited it, with an HTTP 429 longer than the call could wait or with
 *  a ratelimited refusal in an HTTP 200, which the client never waits out,
 *  with Slack's seconds when they came (retryAfterSeconds). */
function readStop(err: unknown): ReadStop | undefined {
  if (err instanceof OutOfCallTime) return { reason: 'time_limit' };
  const e = err as { code?: unknown } | null;
  if (e?.code !== ErrorCode.RateLimitedError && slackRefusal(err) !== 'ratelimited') return undefined;
  const seconds = retryAfterSeconds(err);
  return { reason: 'rate_limited', ...(seconds === undefined ? {} : { retryAfter: seconds }) };
}

/** Called by a listing no call waits on before it asks Slack again: with the
 *  wait, and how many times in a row this request has needed one. Rejecting
 *  ends the listing with that error, unless it's GaveUp on a DM's name. */
export type SlackWaitOut = (wait: SlackWait, inARow: number) => Promise<void>;

const SCOPES_UNAVAILABLE = 'Slack scope metadata is unavailable; list_channels can refresh it, otherwise ask whoever runs this host to refresh reported permissions or restart before retrying';

/** A failure composed here from constant text and Slack IDs only, so a
 *  content-free policy log may repeat its message. */
export class LocalFailure extends Error {}

/** What a SlackWaitOut rejects with when it gives up on a request rather than
 *  on the whole listing. A page given up ends the listing; a DM whose user's
 *  name is given up is labelled with the user's id, as a refused lookup is. */
export class GaveUp extends LocalFailure {
  constructor(message: string) {
    super(message);
    this.name = 'GaveUp';
  }
}

/** Message subtypes that represent real user content. Everything else
 * (message_changed, message_deleted, channel_join, bot_message, …) is noise
 * for the inference loop. */
const CONTENT_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast', 'me_message']);

/** One stderr line per acknowledged event that won't be delivered: Slack
 *  won't replay it, so the line names it, its thread root, and the read that
 *  recovers it. `when` qualifies that read, such as after a restart. */
function droppedEvent(event: SlackMessageEvent, why: string, when = ''): void {
  // A thread_broadcast may name its parent only in root.thread_ts.
  const thread = event.thread_ts ?? event.root?.thread_ts;
  const root = typeof thread === 'string' && thread !== event.ts ? thread : undefined;
  console.error(`[slack-mcpl] Dropped message ${event.ts} in ${event.channel}${root ? ` (thread ${root})` : ''}: ${why}. ` +
    `Slack will not replay it; ${when}recover it with ${root ? `fetch_thread for thread ${root}` : 'fetch_history'}.`);
}

/** The fields of a Socket Mode message event this adapter dereferences.
 * Payloads come off the wire — everything is optional until checked. */
interface SlackMessageEvent {
  client_msg_id?: string;
  type?: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  attachments?: unknown;
  blocks?: unknown;
  ts?: string;
  thread_ts?: string;
  /** On a thread_broadcast the parent may be named only here. */
  root?: { thread_ts?: string };
  bot_id?: string;
  channel_type?: string;
  team?: string;
  files?: Array<{ id?: unknown; url_private?: string; name?: string; mimetype?: string }>;
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
  /** Label group DMs distinctly only on the explicit-policy path. */
  policyGroupDm?: true;
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
  /** Original Slack text (before supplemental payload rendering). */
  rawContent?: string;
  /** Rendered mrkdwn content. */
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
  /** The bot that posted it, when Slack names one. */
  authorBotId?: string;
  authorName: string;
  content: string;
  /** A reply's parent. */
  threadTs?: string;
  /** The thread it belongs to: its parent's ts, or its own. */
  rootTs: string;
  /** Its replies, when Slack gives a count; missing means unknown. */
  replyCount?: number;
  timestamp: Date;
  attachments: Array<PolicyFileRef | { name: string; mimeType?: string; url?: string; channelId?: never }>;
}

export interface SlackUserMatch {
  userId: string;
  username?: string;
  realName?: string;
  displayName?: string;
}

/** Why a policy listing refused a page whose cursor isn't a string. */
const LISTING_CURSOR_UNVERIFIED = 'Conversation listing could not be verified: Slack returned a malformed pagination cursor; retry once, then ask the host operator to investigate';

/** Complete searches retain the legacy array; partial searches must be handled explicitly. */
/** Why findUsers refused a policy directory page (pageProblem). */
const DIRECTORY_PAGE_REFUSALS = {
  container: 'Slack returned an invalid directory; retry once, then ask the host to investigate',
  row: 'Slack returned a malformed directory row; retry once, then ask the host to investigate',
  cursor: 'Slack returned a malformed pagination cursor; retry once, then ask the host to investigate',
  cycle: 'Slack repeated a pagination cursor (cursor cycle). Retry once; if it persists, ask whoever runs this host to investigate the Slack response.',
} as const;

export type SlackUserSearchResult = SlackUserMatch[] | {
  matches: SlackUserMatch[]; truncated: true; reason: 'page_limit' | 'match_limit'; pages: number; limit: number;
};

export interface SlackAdapterConfig {
  pagination?: Partial<PaginationLimits>;
  accessPolicy?: SlackAccessPolicyConfig;
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
  const chain = errorChain(err);
  // Main's lookup is direct: only a chain holding a policy client occurrence
  // carries request provenance through causes.
  if (!chain.some(value => clientErrorSources.has(value))) return err !== null && typeof err === 'object' ? failedRequests.get(err) : undefined;
  return chain.map(value => failedRequests.get(value)).find(method => method !== undefined);
}

/** The file an upload left when it failed after its first step, and whether
 *  Slack may have shared it. */
export interface FileLeft {
  fileId: string;
  mayHaveShared: boolean;
  policy?: true;
}
const filesLeft = new WeakMap<object, FileLeft>();

/** The file an upload left when it failed after its first step, which a
 *  rollback attempts to clean up, and whether Slack may have shared it; undefined for
 *  any other error. */
export function fileLeftByUpload(err: unknown): FileLeft | undefined {
  return err !== null && typeof err === 'object' ? filesLeft.get(err) : undefined;
}

/** A UTF-16 surrogate without its pair. */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Refuses a message's text that the client can't send as it is. In
 *  @slack/web-api 7.19.0 the request interceptor builds the form body with
 *  node:querystring (dist/WebClient.js:606), which takes a lone surrogate and
 *  the code unit after it as one pair, so Slack would post a different
 *  character, and throws "URI malformed" for one that ends the text. The
 *  other fields a post, an edit or a DM's opening sends are ids, which the
 *  agent or the host passed, or a publish's thread, which this server took
 *  from Slack, and they aren't checked: a pair made from a lone surrogate is
 *  outside the Basic Multilingual Plane, so an id with one inside names no
 *  conversation, message or user, whose ids are letters, digits and dots.
 *  Slack documents a not-found error for each of them but thread_ts. For
 *  that one, a pair names no message, as any wrong messageId does, which
 *  this leaves as it is. An id that ends with one makes the client throw
 *  before anything is sent. */
function assertSendable(text: string, notDone: string): void {
  if (LONE_SURROGATE.test(text)) {
    throw new Error(`${notDone}: the text holds a lone UTF-16 surrogate, which UTF-8 can't encode: remove it.`);
  }
}

/** Whether a request's failure is taken to leave it undone: the call's time
 *  left no room to send it, the connection to Slack was never made, Slack
 *  refused it or rate-limited it, or the error is neither one of the client's
 *  request, HTTP or platform errors nor a TypeError. A failure Slack says may
 *  have taken effect (MAY_HAVE_LANDED), an answer not in Slack's form, an HTTP
 *  error, a timeout, a connection that failed once made, or a TypeError
 *  doesn't say.
 *
 *  Taking an error the client doesn't classify as undone turns round the
 *  messaging contract's default, "possibly done" unless it's known to come
 *  before the write, so it rests on the client. In @slack/web-api 7.19.0's
 *  makeRequest (dist/WebClient.js:476-518), a failure of the request itself
 *  becomes a coded request error (:514-515), a status other than 200 a coded
 *  HTTP error (:504-505), and apiCall makes a refusal in a 200 a coded
 *  platform error (:231-236). Its other errors are thrown before the request
 *  is sent, such as Node's URIError (ERR_INVALID_URI) for a lone surrogate
 *  that ends a field while the request interceptor builds the body (:606;
 *  assertSendable keeps one out of a message's text), or after a 429
 *  (:498, and :501's "Retry header did not contain a valid timeout"), but for
 *  the TypeErrors it throws after a 200, reading an answer not in the shape of
 *  Slack's: a JSON body that isn't an object (:668), or response_metadata
 *  whose warnings or messages aren't lists (:205-211), as a broken proxy might
 *  send. So a TypeError keeps the contract's default. Taking one as undone
 *  risks the duplicate post the default is there to prevent, while a
 *  TypeError from a bug of this server's before a request costs the agent a
 *  check, and, when it's thrown inside a post's request, a rollback's note of
 *  a post that may remain. (buildResult's JSON parse at :656 is for
 *  admin.analytics.getFile, which this server doesn't call.) Apart from
 *  TypeErrors, in that version an error the client doesn't classify means
 *  Slack never took the call.
 *
 *  It rests on SLACK_CLIENT_OPTIONS too. With retryConfig's retries: 0, the
 *  client sends a request once, so the error read here never follows an
 *  earlier attempt Slack may have taken: SlackWebClient sends one again only
 *  after a 429, which Slack didn't take. With rejectRateLimitedCalls, a 429
 *  with a usable Retry-After is the coded rate-limited error (:483), so of the
 *  plain errors after a 429 only :501's is reached here; :498's needs it off.
 *  Check this again when the client or SLACK_CLIENT_OPTIONS change. */
function cannotHaveLanded(err: unknown): boolean {
  const e = err as { code?: unknown; original?: { code?: unknown } } | null;
  switch (e?.code) {
    case ErrorCode.RequestError:
      return connectionNeverMade(e.original?.code);
    case ErrorCode.HTTPError:
      return false;
    case ErrorCode.PlatformError: {
      const refused = slackRefusal(err);
      return refused !== undefined && !MAY_HAVE_LANDED.has(refused);
    }
    default:
      // The SDK's unclassified errors are pre-send, but an injected policy
      // client has no such guarantee. An unclassified occurrence after the
      // post starts must remain uncertain. Explicit deadlines/429s are safe.
      if (err !== null && typeof err === 'object' && clientErrorSources.has(err)
          && !(err instanceof OutOfCallTime) && e?.code !== ErrorCode.RateLimitedError) return false;
      return !(err instanceof TypeError);
  }
}

/** A post this server can't name: chat.postMessage answered without the
 *  message's ts, or failed in a way that may have posted it. */
export interface PostLeft {
  channelId: string;
  /** Opt-in formatter provenance; legacy calls retain their exact responses. */
  policy?: boolean;
  /** Policy mode: the token had the history grant this conversation's kind needs. */
  historyReadable?: boolean;
  /** The thread it was posted into, for a reply. */
  threadTs?: string;
}
const postsLeft = new WeakMap<object, PostLeft>();

/** The post a failed sendMessage may have left, which a rollback says may
 *  remain; undefined for any other error, such as a refusal or one from a
 *  request before the post. */
export function postLeftBy(err: unknown): PostLeft | undefined {
  return err !== null && typeof err === 'object' ? postsLeft.get(err) : undefined;
}

/** chat.postMessage answered without the message's ts: whether it posted
 *  can't be told, and if it did, the message can't be named. */
export class PostNotConfirmed extends Error {
  constructor(readonly channelId: string) {
    super(`chat.postMessage: the answer named no message in ${channelId}`);
    this.name = 'PostNotConfirmed';
  }
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
  if (call && clock.now() + requestMs > call.deadline) {
    throw new OutOfCallTime(method, Math.min(CALL_SECONDS, Math.ceil((clock.now() - call.arrived) / 1000)));
  }
}

/** The monotonic time by which a request of the current host call must start
 *  to fit its timeout before the call's deadline; undefined outside a call. */
function latestRequestStart(): number | undefined {
  const call = callTime.getStore();
  return call ? clock.monotonic() + (call.deadline - clock.now()) - SLACK_CLIENT_OPTIONS.timeout : undefined;
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
        clock.now() + wait.seconds * 1000 + this.requestMs > call.deadline
      ) {
        throw err;
      }
      call.secondsLeft -= wait.seconds;
      await clock.sleep(wait.seconds * 1000);
      // The resend is a newer Slack request than any issued during the wait.
      issueRequest();
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
 * user ID (for self-filtering and mention detection), team name (for channel
 * labels), and token scopes used to narrow conversation listings, then Socket
 * Mode is wired but not yet started — call start() after registering the
 * message handler. `slackApiUrl` is Slack's own unless given, as
 * slackClients' is.
 */
export async function connectSlack(config: SlackAdapterConfig, slackApiUrl?: string): Promise<SlackAdapter> {
  const pagination = paginationLimits(config.pagination);
  const policy = config.accessPolicy === undefined ? undefined : new SlackAccessPolicy(config.accessPolicy);
  const clients = slackClients(config.botToken, config.appToken, slackApiUrl);
  const auth = await clients.auth.auth.test();
  // With a policy, startup grants are normalized like every later report.
  const scopes = reportedScopes(auth.response_metadata, policy !== undefined);
  if (policy && !scopes) throw new Error('SLACK_ACCESS_POLICY requires reported Slack scope metadata: auth.test returned no usable scope metadata; check the Slack response and any intermediary, then restart at startup');
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
    // Granted scopes, from the x-oauth-scopes header of auth.test.
    scopes,
    policy,
    pagination,
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
    list(args: Record<string, unknown>): Promise<{ channels?: unknown[]; response_metadata?: { next_cursor?: string; scopes?: string[] } }>;
    info(args: { channel: string }): Promise<{ channel?: unknown; response_metadata?: unknown }>;
    members?(args: { channel: string; limit: number; cursor?: string }): Promise<{
      members?: unknown; response_metadata?: { next_cursor?: unknown; scopes?: unknown; acceptedScopes?: unknown };
    }>;
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
    history(args: Record<string, unknown>): Promise<{ messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>;
    replies(args: Record<string, unknown>): Promise<{ messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>;
  };
  auth: {
    test(): Promise<{ response_metadata?: { scopes?: string[] } }>;
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
  assistant?: {
    threads: { setStatus(args: { channel_id: string; thread_ts: string; status: string }): Promise<unknown> };
  };
  files: {
    info?(args: { file: string }): Promise<{ file?: unknown }>;
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

const EVENT_SHUTDOWN = Symbol('event shutdown');

export class SlackAdapter {
  /** Each conversation's last event's turn, which the next event's delivery
   *  waits for. */
  private inbound = new Map<string, Promise<void>>();
  private userNameCache = new Map<string, string>();
  private messageHandlers: Array<(msg: SlackMessageData) => unknown> = [];
  private socketStarted = false;
  /** Conversations Slack reported as DMs or group DMs, and as channels. IDs
   *  alone don't tell them apart. */
  private dmIds = new Set<string>();
  private channelIds = new Set<string>();

  get dmsDisabled(): boolean {
    if (this.accessPolicy) return this.disableDms || !this.accessPolicy.dmsWritable
      || (this.dmUsers !== undefined && !this.dmUsers.some((user) => this.accessPolicy!.mayDmUser(user)));
    return this.disableDms;
  }

  /** Whether registration guidance may describe the listing as channels only. */
  get listsChannelsOnly(): boolean {
    return !this.conversationTypes().some((type) => type === 'im' || type === 'mpim');
  }

  /** Can send_dm succeed at all? A DM ID starts with D. */
  get dmsWritable(): boolean {
    return !this.dmsDisabled && (!this.sendChannels?.length || this.sendChannels.some((id) => this.hasAccessPolicy ? /^D[A-Z0-9]+$/.test(id) : id.startsWith('D')));
  }

  private admissionStop = new AbortController();
  private stopping = false;
  get isStopping(): boolean { return this.stopping; }

  /** The bot token's scopes, as Slack has reported them with auth.test's
   *  answers and with metadata/listing answers and refusals. Policy reports
   *  replace the known set; legacy reports accumulate. Undefined while unknown. */
  private scopes: string[] | undefined;
  private readonly pagination: Readonly<PaginationLimits>;

  constructor(
    private web: SlackWebLike,
    private socket: SlackSocketLike,
    readonly botUserId: string | null,
    readonly teamName: string,
    private dmUsers?: string[],
    private sendChannels?: string[],
    private disableDms = false,
    private ackReaction?: string,
    /** The bot token's scopes, as auth.test reported them; undefined, or an
     *  empty list, is unknown; only legacy listings ask for every type. */
    scopes?: string[],
    private readonly accessPolicy?: SlackAccessPolicy,
    pagination?: Partial<PaginationLimits>,
  ) {
    this.web = isolateClientErrors(web, () => this.hasAccessPolicy, (method, args, answer, error, issued) => {
      const payload = error ? (answer as { data?: unknown } | null)?.data : answer;
      const scopes = reportedScopes((payload as { response_metadata?: unknown } | null)?.response_metadata, true);
      this.observeScopes(scopes, issued);
      const channelId = (args[0] as { channel?: unknown } | undefined)?.channel;
      const code = error ? slackRefusal(answer) : undefined;
      // "needed" can list several requirements, not just the missing ones.
      // Preserve grants reported by this response; without a scope report,
      // fall back to its "provided" field or withdraw the named requirements.
      const { needed, provided } = (payload as { needed?: unknown; provided?: unknown } | null) ?? {};
      if (code === 'missing_scope' && typeof needed === 'string' && this.scopes && issued >= this.scopesIssued) {
        const granted = new Set(scopes ?? (typeof provided === 'string' ? provided.split(',').map(scope => scope.trim()) : []));
        const missing = new Set(needed.split(',').map(scope => scope.trim()).filter(scope => !granted.has(scope)));
        this.observeScopes(this.scopes.filter(scope => !missing.has(scope)), issued);
      }
      // A token-wide refusal holds for every conversation until any newer
      // request succeeds; a channel's own refusal only for that channel.
      // A success is remembered even with no refusal stored, so an older refusal answered later can't latch.
      if (code !== undefined && TOKEN_REFUSALS.has(code) && issued >= (this.tokenRefusal?.issued ?? 0) && issued > this.tokenWorkedIssued) {
        this.tokenRefusal = { issued, refusal: answer };
        this.tokenRefusalSeen = { count: this.tokenRefusalSeen.count + 1, refusal: answer };
      }
      else if (!error && issued > this.tokenWorkedIssued) {
        this.tokenWorkedIssued = issued;
        if (this.tokenRefusal && issued > this.tokenRefusal.issued) this.tokenRefusal = undefined;
      }
      if (error && ['conversations.info', 'conversations.members', 'conversations.history', 'conversations.replies'].includes(method) && typeof channelId === 'string'
          && ACCESS_REFUSALS.has(code ?? '')) {
        this.observeDelivery(channelId, { issued, refusal: answer });
      }
    });
    setMaxListeners(0, this.admissionStop.signal);
    this.pagination = paginationLimits(pagination);
    this.scopes = reportedScopes({ scopes }, this.accessPolicy !== undefined);
    if (this.accessPolicy) {
      const missing = this.accessPolicy.diagnosticScopes(this.disableDms, this.dmUsers, this.sendChannels).filter((scope) => !this.scopes?.includes(scope));
      if (missing.length) console.error(`[slack-mcpl] Access policy: unavailable scopes: ${missing.join(', ')}. Affected operations are denied. Ask the workspace administrator to review bot token grants and reinstall the app if needed.`);
    }
    const omitted = this.leftOutTypes();
    if (omitted.length) this.logLeftOut(omitted, '');
    this.socket.on('message', ({ event, ack }) => {
      // Always ack first — Slack redelivers unacked envelopes.
      void Promise.resolve().then(() => ack()).catch(() => { /* ignore */ });
      if (this.accessPolicy) { this.enqueuePolicyEvent(event); return; }
      // Legacy event preparation/delivery remains unchanged by policy queues.
      const prepared = this.prepareMessageEvent(event).then(
        msg => ({ ok: true as const, msg }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const key = typeof event?.channel === 'string' ? event.channel : '';
      const turn = (this.inbound.get(key) ?? Promise.resolve())
        .then(() => prepared)
        .then(done => {
          if (!done.ok) throw done.error;
          if (done.msg) for (const handler of this.messageHandlers) handler(done.msg);
        })
        .catch(error => console.error('[slack-mcpl] Failed to handle Slack message event:', error));
      this.inbound.set(key, turn);
      void turn.then(() => { if (this.inbound.get(key) === turn) this.inbound.delete(key); });
    });
  }

  /** An acknowledged content event this adapter won't deliver because it is
   *  stopping. Slack won't replay it, so the operator is told which one. */
  private dropAtStop(event: SlackMessageEvent | undefined, why = 'at shutdown'): undefined {
    if (!event || event.type !== 'message' || !CONTENT_SUBTYPES.has(event.subtype) || event.bot_id
        || event.user === this.botUserId || typeof event.channel !== 'string' || typeof event.ts !== 'string') return;
    droppedEvent(event, why, 'after restart, ');
  }

  // Bound waiting ambient envelopes, including those behind a stalled host.
  // Active handlers cannot be cancelled. Addressed work is FIFO but admission failures and shutdown can drop events.
  private policyTurns = new Map<string, Array<{
    event: SlackMessageEvent;
    addressed: boolean;
    prepared?: ReturnType<SlackAdapter['settlePolicyEvent']>;
  }>>();
  private policyAddressedPending = new Map<string, number>();
  private ambientTurns: Array<{ event: SlackMessageEvent; addressed: boolean }> = [];
  private settlePolicyEvent(event: SlackMessageEvent) {
    return this.prepareMessageEvent(event).then(
      msg => ({ ok: true as const, msg }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  private enqueuePolicyEvent(event: SlackMessageEvent): void {
    if (!event || event.type !== 'message' || !CONTENT_SUBTYPES.has(event.subtype)
        || event.bot_id || event.user === this.botUserId || !event.channel || !event.user || !event.ts) return;
    const key = typeof event?.channel === 'string' ? event.channel : '';
    const addressed = key.startsWith('D') || (this.botUserId !== null
      && typeof event?.text === 'string' && extractSlackUserIds(event.text).includes(this.botUserId));
    if (!addressed && !this.policyAddressedPending.has(key) && this.ambientMessageFilter && !this.ambientMessageFilter(key)) return;
    if ((event.channel_type === 'mpim' && (this.disableDms || !this.accessPolicy!.namesGroupDm(key)))
        || (key.startsWith('D') && (this.dmsDisabled || !this.accessPolicy!.mayDmUser(event.user)
          || (this.dmUsers && !this.dmUsers.includes(event.user))))) return this.noteAdmissionFailure('event');
    // Configuration exclusions need neither a delivery entry nor an admission slot.
    if (!this.accessPolicy!.mayRead(key)) return this.noteAdmissionFailure('event');
    // An eligible event acknowledged after stop began is named, not dropped silently.
    if (this.stopping) { this.dropAtStop(event, 'after shutdown began'); return; }
    // Waiting ambient envelopes own no preparation. Only the bounded batch
    // selected by the delivery loop may start lookups.
    const item = { event, addressed, prepared: addressed ? this.settlePolicyEvent(event) : undefined };
    if (addressed) this.policyAddressedPending.set(key, (this.policyAddressedPending.get(key) ?? 0) + 1);
    const queue = this.policyTurns.get(key) ?? [];
    queue.push(item);
    this.policyTurns.set(key, queue);
    if (!addressed) {
      this.ambientTurns.push(item);
      if (this.ambientTurns.length > 32) {
        const oldest = this.ambientTurns.shift()!;
        const waiting = this.policyTurns.get(oldest.event?.channel ?? '');
        const index = waiting?.indexOf(oldest) ?? -1;
        if (index >= 0) waiting!.splice(index, 1);
        droppedEvent(oldest.event, 'ambient delivery backlog limit 32');
      }
    }
    if (this.inbound.has(key)) return;
    const turn = Promise.resolve().then(async () => {
      try {
      while (queue.length) {
        // Overlap the next ambient run, but never prepare past an addressed
        // delivery whose handler may commit a subscription.
        for (const pending of queue) {
          if (pending.addressed) break;
          pending.prepared ??= this.settlePolicyEvent(pending.event);
        }
        const next = queue.shift()!;
        const index = this.ambientTurns.indexOf(next);
        if (index >= 0) this.ambientTurns.splice(index, 1);
        // Lazy ambient preparation observes the last addressed handler's commit.
        try {
        if (this.stopping) { this.dropAtStop(next.event); continue; }
        const done = await (next.prepared ?? this.settlePolicyEvent(next.event));
        if (!done.ok && done.error === EVENT_SHUTDOWN) { this.dropAtStop(next.event); continue; }
        if (!done.ok) { droppedEvent(next.event, `preparation failed: ${policyFailureSummary(done.error)}`); continue; }
        // Stop can arrive while preparation awaited a slot, admission or a name.
        if (this.stopping) { this.dropAtStop(next.event); continue; }
        if (done.msg) for (const [index, handler] of this.messageHandlers.entries()) {
          if (this.stopping) { this.dropAtStop(next.event, `at shutdown before handler ${index + 1} of ${this.messageHandlers.length}`); break; }
          try { await handler(done.msg); }
          catch (error) { droppedEvent(next.event, `handler failed: ${policyFailureSummary(error)}`); break; }
        }
        } finally {
          if (next.addressed) {
            const count = Math.max(0, (this.policyAddressedPending.get(key) ?? 1) - 1);
            if (count) this.policyAddressedPending.set(key, count);
            else this.policyAddressedPending.delete(key);
          }
        }
      }
      } finally { this.policyTurns.delete(key); this.policyAddressedPending.delete(key); this.inbound.delete(key); }
    });
    this.inbound.set(key, turn);
  }

  private ambientMessageFilter?: (channelId: string) => boolean;

  /** An ambient event the subscription filter now drops, unless an addressed
   *  delivery in its conversation (which may subscribe it) is still pending. */
  private ambientUnsubscribed(channel: string, priority: { addressed: boolean }): boolean {
    return !priority.addressed && !this.policyAddressedPending.has(channel)
      && !!this.ambientMessageFilter && !this.ambientMessageFilter(channel);
  }

  /** Cheap delivery veto only, never authorization. Addressed events bypass it. */
  setAmbientMessageFilter(filter: (channelId: string) => boolean): void {
    this.ambientMessageFilter = filter;
  }

  onMessage(handler: (msg: SlackMessageData) => unknown): void {
    this.messageHandlers.push(handler);
  }

  /** Open the Socket Mode connection. Resolves once connected. */
  async start(): Promise<void> {
    if (this.socketStarted) return;
    await this.socket.start();
    this.socketStarted = true;
  }

  async stop(): Promise<void> {
    // Best effort: clear reactions and statuses together before going away.
    // index.ts gives shutdown five seconds; no new starts while that runs.
    this.stopping = true;
    if (this.accessPolicy) {
      this.admissionStop.abort();
      for (const item of this.eventAdmissionQueue.splice(0)) item.resolve(false);
      for (const queue of this.policyTurns.values()) {
        for (const item of queue.splice(0)) this.dropAtStop(item.event);
      }
      this.ambientTurns.length = 0;
      this.policyAddressedPending.clear();
    }
    this.flushAdmissionFailures();
    await Promise.all([this.hasAccessPolicy ? this.clearThreadStatuses() : this.resetThreadStatuses(), ...[...this.ackPending.keys()].map((c) => this.clearAck(c))]);
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

  private conversationTypes(): string[] {
    // Without joined-channel reads, ordinary channels are neither listed nor paced.
    if (this.accessPolicy) return [...(this.accessPolicy.joinedChannelsReadable ? ['public_channel', 'private_channel'] : []), ...(!this.dmsDisabled ? ['im'] : []),
      ...(!this.disableDms && this.accessPolicy.groupDmsReadable ? ['mpim'] : [])];
    return this.disableDms ? ['public_channel', 'private_channel'] : Object.keys(TYPE_SCOPE);
  }

  /** Legacy mode requests every enabled type while scopes are unknown;
   *  policy mode fails closed until grants are reported. */
  private readableTypes(): string[] {
    return this.conversationTypes().filter((type) => this.scopes ? this.scopes.includes(TYPE_SCOPE[type]) : !this.accessPolicy);
  }

  /** The enabled types the token's scopes can't read: none while they're
   *  unknown. */
  private leftOutTypes(): string[] {
    return this.conversationTypes().filter((type) => this.scopes && !this.scopes.includes(TYPE_SCOPE[type]));
  }

  private logLeftOut(omitted: string[], now: '' | 'now '): void {
    console.error(omitted.length
      ? `[slack-mcpl] Conversation listing ${now}omits types without a granted read scope: ${omitted.map((type) => `${type} (requires ${TYPE_SCOPE[type]})`).join(', ')}.`
      : '[slack-mcpl] Conversation listing now asks for every type it lists: the token has each one\'s read scope.');
  }

  /** One ordered full grant report, not independently re-stamped withdrawals. */
  private scopesIssued = 0;
  private observeScopes(reported: string[] | undefined, issued: number): void {
    if (!reported || issued < this.scopesIssued) return;
    this.scopesIssued = issued;
    this.replaceScopes(reported);
  }

  /** Legacy ingestion only. Policy responses are observed once at the client boundary. */
  private takeScopes(reported: string[] | undefined): void {
    if (this.accessPolicy || !reported) return;
    this.replaceScopes([...(this.scopes ?? []), ...reported]);
  }

  private replaceScopes(reported: string[]): void {
    const before = this.leftOutTypes().join(',');
    const changed = [...new Set(reported)].sort().join(',') !== [...(this.scopes ?? [])].sort().join(',');
    this.scopes = [...new Set(reported)];
    if (changed) this.statusGrantRefused.clear();
    const omitted = this.leftOutTypes();
    if (omitted.join(',') !== before) this.logLeftOut(omitted, 'now ');
  }

  /** Policy includeNonMember never broadens membership admission.
   * Enumerate conversations the bot can act in: member channels, DMs, and
   *  group DMs. includeNonMember broadens legacy results only; policy requires membership. Of the types whose read scopes Slack has reported the token
   *  has (legacy mode requests every enabled type while scopes are unknown; policy mode admits none). Slack reports the
   *  scopes with each answer, and the client hands them on with an answer or a
   *  refusal, though not with an HTTP error such as a 429. A listing whose
   *  types they change, by its own answer or another listing's, starts over
   *  with the new types, whether the change is seen at one of its answers or as
   *  it ends, so its answer reflects the scopes known when it returns, and
   *  `leftOut` names the enabled types its token cannot read (newly granted types may remain unscanned at a page limit). With no type to ask
   *  for, auth.test is asked for the scopes, and if they read no type either,
   *  legacy mode throws NoReadableConversations; policy mode returns an empty listing with leftOut. conversations.list also returns public
   *  channels the bot is NOT a member of (no events, no posting without
   *  joining) — those are excluded here; list_channels with includeNonMember
   *  surfaces them.
   *
   *  A page Slack rate-limits past what a call's client waits out, or that
   *  its call's deadline leaves no time for (SlackWebClient), ends a policy
   *  foreground listing with its admitted rows and an incomplete result.
   *  Background scans with `waitOut` may retry those or other transient
   *  failures. Then the page, or the name of a DM's
   *  user, is asked for again once `waitOut` resolves (waitToAskAgain says how
   *  long), even when the types changed meanwhile. A DM whose name is still
   *  missing carries `nameWait`. */
  // Policy mode always requires confirmed membership, regardless of includeNonMember.
  async listConversations(includeNonMember = false, waitOut?: SlackWaitOut, isCurrent: () => boolean = () => true, known?: (id: string) => boolean): Promise<SlackListing> {
    const checkCurrent = () => {
      if (this.accessPolicy && this.stopping) throw new Error('Conversation listing stopped');
      if (!isCurrent()) throw new Error('A newer registration superseded this one');
    };
    checkCurrent();
    const noneReadable = () => new NoReadableConversations(this.conversationTypes().map((type) => TYPE_SCOPE[type]));
    let types = this.readableTypes();
    if (this.accessPolicy && Array.isArray(this.scopes) && types.length === 0) {
      if (this.conversationTypes().length) {
        for (let attempt = 1; ; attempt++) {
          checkCurrent();
          try { this.takeScopes(reportedScopes((await this.web.auth.test()).response_metadata)); checkCurrent(); break; }
          catch (err) {
            checkCurrent();
            this.takeScopes(reportedScopes((err as { data?: { response_metadata?: unknown } } | null)?.data?.response_metadata));
            const wait = waitToAskAgain(err, 'auth.test', this.hasAccessPolicy);
            if (!wait || !waitOut) throw err;
            await waitOut(wait, attempt);
          }
        }
        types = this.readableTypes();
      }
      if (!types.length) return { conversations: [], leftOut: this.conversationTypes() };
    }
    let out: SlackConversationInfo[] = [];
    const rowScopes = new Map<string, string>();
    let cursor: string | undefined;
    let limited = 0;
    let admissionFailures = 0;
    const skippedKnown = new Set<string>();
    const checked = new Set<string>();
    const cursors = new Set<string>();
    const names = { waitOut };
    let pages = 0;
    const listing = (truncation?: PageTruncation): SlackListing => ({
      conversations: this.accessPolicy ? out.filter(row => {
        const needed = rowScopes.get(row.id);
        return !needed || this.scopes?.includes(needed);
      }) : out, leftOut: this.conversationTypes().filter((type) => !types.includes(type)),
      ...(skippedKnown.size ? { skippedKnown: skippedKnown.size } : {}),
      ...(truncation ? { truncation } : {}),
      ...(admissionFailures ? { admissionFailures } : {}),
    });
    // A listing keeps its types while it pages, so a cursor keeps its meaning,
    // and starts over whenever the types the token can read change. Once
    // Slack has reported scopes, legacy observations only grow; policy mode
    // instead uses the latest reported grant set, including withdrawals.
    const startOver = (): boolean => {
      const now = this.readableTypes();
      if (now.join(',') === types.join(',')) return false;
      // At the cap, reconcile withdrawals against each retained row instead
      // of fetching another page or exposing rows under withdrawn grants.
      if (pages >= this.pagination.conversations) return true;
      if (now.length === 0 && !this.accessPolicy) throw noneReadable();
      types = now;
      out = [];
      rowScopes.clear();
      cursor = undefined;
      limited = 0;
      admissionFailures = 0;
      skippedKnown.clear();
      checked.clear();
      cursors.clear();
      return true;
    };
    // A foreground scan that can't check its next candidate returns the rows it
    // admitted, marked incomplete, rather than discarding them: unless the
    // readable types changed meanwhile, whose rows startOver discards.
    // Its rows pass the same filter as any other return, and a scan that also
    // reached its page cap keeps that signal.
    let pageHasMore = false;
    const stopEarly = (stop: NonNullable<SlackListing['admissionStop']>): SlackListing => {
      startOver();
      const capped = pageHasMore && pages >= this.pagination.conversations;
      return { ...listing(capped ? { reason: 'page_limit', pages, limit: this.pagination.conversations } : undefined),
        admissionFailures: admissionFailures + 1, admissionStop: stop };
    };
    for (;;) {
      checkCurrent();
      if (this.accessPolicy && Array.isArray(this.scopes) && types.length === 0) return listing();
      if (pages >= this.pagination.conversations) {
        // Refresh diagnostics; listing() also filters rows under withdrawn scopes.
        types = this.readableTypes();
        return listing({ reason: 'page_limit', pages, limit: this.pagination.conversations });
      }
      let result: Awaited<ReturnType<SlackWebLike['conversations']['list']>>;
      try {
        // Slack refuses the whole call when one type lacks its read scope, and
        // an empty types value has undocumented behavior, so a listing never
        // sends one: with no type to ask for, the scopes held may be older
        // than the token's, and auth.test reports them. In the background it's
        // waited out and asked again like a page.
        if (types.length === 0) {
          this.takeScopes(reportedScopes((await this.web.auth.test()).response_metadata));
          limited = 0;
          types = this.readableTypes();
          if (this.accessPolicy && !Array.isArray(this.scopes)) throw new SlackScopeEvidenceError(SCOPES_UNAVAILABLE);
          if (types.length === 0) throw noneReadable();
          continue;
        }
        result = await this.web.conversations.list({
          types: types.join(','),
          exclude_archived: true,
          limit: 200,
          cursor,
        });
      } catch (err) {
        checkCurrent();
        const method = types.length > 0 ? 'conversations.list' : 'auth.test';
        this.takeScopes(reportedScopes((err as { data?: { response_metadata?: unknown } } | null)?.data?.response_metadata));
        if (this.accessPolicy && !waitOut && method === 'conversations.list') {
          const stop = readStop(err);
          if (stop?.reason === 'time_limit') return stopEarly({ reason: 'call_deadline' });
          if (stop?.reason === 'rate_limited') return stopEarly({
            reason: 'rate_limited', ...(stop.retryAfter === undefined ? {} : { retryAfterSeconds: stop.retryAfter }),
          });
        }
        const changed = startOver();
        // A rate limit, or a failure that can pass, is waited out before
        // anything is asked again, even when the types changed meanwhile, or
        // ends a listing nothing waits out. A refusal whose scopes changed the
        // types starts over at once.
        const wait = waitToAskAgain(err, method, this.hasAccessPolicy);
        if (wait) {
          if (!waitOut) throw err;
          await waitOut(wait, ++limited);
          continue;
        }
        if (changed) continue;
        throw err;
      }
      checkCurrent();
      pages++; // Count even empty pages and responses discarded by a scope restart.
      pageHasMore = !!result.response_metadata?.next_cursor;
      limited = 0;
      this.takeScopes(reportedScopes(result.response_metadata));
      // The whole page, every row and its cursor, repetition included, is
      // validated (pageProblem) before anything can return or start over: a
      // scope restart, a candidate's rate limit or the call's deadline must
      // not turn a malformed page into a complete or partial listing. A
      // non-string cursor (0, null, an object) is malformed, not the end.
      if (this.accessPolicy) {
        const problem = pageProblem(result.channels, result.response_metadata?.next_cursor as unknown, cursors, isConversationRow);
        if (problem === 'container') throw new LocalFailure('Slack conversation page is malformed; retry once, then ask the host to investigate');
        if (problem === 'cursor') throw new SlackAccessUnverified(LISTING_CURSOR_UNVERIFIED);
        if (problem === 'row') throw new LocalFailure('No conversations were returned: malformed Slack listing candidate; retry once, then ask whoever runs this host to investigate');
        if (problem === 'cycle') throw new LocalFailure('No listing was returned: Slack repeated a pagination cursor (cursor cycle). Retry once; if it persists, ask whoever runs this host to investigate the Slack response.');
      }
      if (startOver() && pages < this.pagination.conversations) continue;
      for (let raw of (result.channels ?? []) as SlackApiConversation[]) {
        checkCurrent();
        if (this.accessPolicy) {
          let admitted: SlackApiConversation | undefined;
          try {
          if (!raw.id || checked.has(raw.id) || !this.accessPolicy.mayRead(raw.id)) continue;
          // Avoid a metadata request for every unjoined public workspace channel.
          if (raw.is_im === false && raw.is_mpim === false && raw.is_member === false && !this.accessPolicy.namesGroupDm(raw.id)) continue;
          // A malformed listed peer is no hint at all: fresh metadata decides.
          if (raw.is_im && (this.dmsDisabled || (typeof raw.user === 'string' && /^[UW][A-Z0-9]+$/.test(raw.user)
              && (!this.accessPolicy.mayDmUser(raw.user) || (this.dmUsers !== undefined && !this.dmUsers.includes(raw.user)))))) continue;
          if (raw.is_mpim && !this.accessPolicy.namesGroupDm(raw.id)) continue;
          checked.add(raw.id);
          // Refresh only registers new IDs. Seeing a known ID here is not admission evidence.
          if (known?.(raw.id)) { skippedKnown.add(raw.id); continue; }
          for (let attempts = 0; ; attempts++) {
            try {
              // A foreground listing outside a host call has no deadline, but is still foreground: never evicted as ambient.
              if (!await this.paceEventAdmission(raw.id, { addressed: false }, waitOut ? undefined : latestRequestStart() ?? Infinity)) {
                checkCurrent();
                const cooldown = this.admissionCooldownUntil - clock.monotonic();
                if (!waitOut) return stopEarly(cooldown > 0 ? { reason: 'rate_limited', retryAfterSeconds: cooldown / 1000 } : { reason: 'call_deadline' });
                throw new LocalFailure(`Conversation listing incomplete: admission slot for ${raw.id} was retired; retry refresh_channels after the backlog clears`);
              }
              checkCurrent();
              if (this.stopping) throw new Error(`Conversation listing incomplete: admission stopped before checking ${raw.id}; restart the connector then refresh_channels`);
              admitted = await this.readAccessConversation(raw.id); checkCurrent(); break;
            }
            catch (err) {
              checkCurrent();
              const method = failedRequest(err) ?? 'conversations.info';
              const wait = waitToAskAgain(err, method, this.hasAccessPolicy) ?? (slackRefusal(err) === 'ratelimited'
                ? { method, seconds: retryAfterSeconds(err) ?? FAILED_WAIT_SECONDS, why: 'limited' as const } : undefined);
              if (method === 'conversations.info') this.holdAdmissions(wait);
              if (wait && waitOut && attempts < 4) { await waitOut({ ...wait, attempts: 5 }, attempts + 1); continue; }
              if ((!waitOut && err instanceof SlackAccessDenied && !err.authoritative) || (!(err instanceof SlackAccessDenied) && !NOT_SHOWN.has(slackRefusal(err) ?? ''))) throw err;
              if (waitOut && err instanceof SlackAccessDenied && !err.authoritative) admissionFailures++;
              this.noteAdmissionFailure('listing', err, !!wait);
              break;

            }
          }
          } catch (err) {
            checkCurrent();
            const limit = waitToAskAgain(err, failedRequest(err) ?? 'conversations.info', this.hasAccessPolicy);
            if (!waitOut && limit?.why === 'limited') return stopEarly({ reason: 'rate_limited', ...(Number.isFinite(limit.seconds) ? { retryAfterSeconds: limit.seconds } : {}) });
            if (!waitOut && err instanceof OutOfCallTime) return stopEarly({ reason: 'call_deadline' });
            if (!waitOut) throw err;
            admissionFailures++;
            console.error(`[slack-mcpl] Registration candidate ${typeof raw?.id === "string" && /^[CGD][A-Z0-9]{1,80}$/.test(raw.id) ? raw.id : "unknown"} skipped: admission failed; count is incomplete: ${policyFailureSummary(err)}`);
          }
          if (!admitted) continue;
          raw = admitted;
        }
        checkCurrent();
        const info = await this.describeConversation(raw, names);
        if (this.accessPolicy) checkCurrent();
        if (!info) continue;
        if (!includeNonMember && info.kind === 'channel' && !info.isMember) continue;
        if (this.accessPolicy) rowScopes.set(info.id, raw.is_mpim ? 'mpim:read' : raw.is_im ? 'im:read' : raw.is_private ? 'groups:read' : 'channels:read');
        out.push(info);
      }
      // A cursor from an obsolete type scan has no meaning after a restart.
      // Policy only: main's unset listing asks for its next page first.
      if (this.accessPolicy && startOver()) continue;
      cursor = result.response_metadata?.next_cursor || undefined;
      // Another listing's answer may have changed the scopes while this page's
      // DM names were looked up, so they're checked once more before it ends.
      if (!cursor && !startOver()) {
        return listing();
      }
    }
  }

  async getConversationMeta(channelId: string, forDelivery = false): Promise<SlackConversationInfo | null> {
    if (this.accessPolicy) {
      const conversation = forDelivery
        ? await this.retryEventAdmission(channelId, { addressed: true }, true)
        : await this.readAccessConversation(channelId);
      // A delivery check must not await an optional DM display-name lookup.
      if (forDelivery && (this.stopping || !conversation)) throw new Error('Delivery admission was stopped');
      if (forDelivery && conversation?.is_im) return null;
      return this.describeConversation(conversation!);
    }
    const info = await this.web.conversations.info({ channel: channelId });
    return this.describeConversation((info.channel ?? {}) as SlackApiConversation);
  }

  private deliveryObservations = new Map<string, { issued: number } & (
    { conversation: SlackApiConversation } | { refusal: unknown }
  )>();

  private observeDelivery(channelId: string, observation: { issued: number } & (
    { conversation: SlackApiConversation } | { refusal: unknown }
  )): void {
    if ((this.deliveryObservations.get(channelId)?.issued ?? 0) <= observation.issued) {
      this.deliveryObservations.set(channelId, observation);
    }
  }

  /** Interpret only this response's metadata, never a denial derived from grants
   * or another request's known veto. Neither propagation nor local checks observe. */
  private observeDeliveryConversation(channelId: string, conversation: SlackApiConversation | undefined, issued: number): void {
    try { this.accessPolicy!.requireReadableMetadata(channelId, conversation); }
    catch (err) {
      if (err instanceof SlackAccessDenied && err.authoritative) {
        metadataRefusals.add(err);
        this.observeDelivery(channelId, { issued, refusal: err });
      }
      return;
    }
    this.observeDelivery(channelId, { issued, conversation: conversation! });
  }

  private tokenRefusal?: { issued: number; refusal: unknown };
  private tokenWorkedIssued = 0;
  /** Every token refusal latched, kept after a newer success clears the
   *  latch, so an upload can tell one observed while it was pending. */
  private tokenRefusalSeen: { count: number; refusal: unknown } = { count: 0, refusal: undefined };

  private assertNoKnownDeliveryRefusal(channelId: string): void {
    const observation = this.deliveryObservations.get(channelId);
    if (observation && 'refusal' in observation) throw refusalOccurrence(observation.refusal);
  }

  /** Synchronous veto only: a transient failure cannot undo known refusal or grant withdrawal. */
  assertKnownDeliveryAdmission(channelId: string): void {
    if (!this.accessPolicy) return;
    if (this.stopping) throw new Error('Delivery admission was stopped');
    if (this.tokenRefusal) throw refusalOccurrence(this.tokenRefusal.refusal);
    this.assertNoKnownDeliveryRefusal(channelId);
    const observation = this.deliveryObservations.get(channelId);
    const conversation = observation && 'conversation' in observation ? observation.conversation : undefined;
    this.accessPolicy.requireReadable(channelId, conversation, this.scopes);
    this.accessPolicy.requireScope(this.scopes, historyScope(conversation!));
  }

  /** Only fresh exact metadata authorizes access; cached labels/kinds never do. */
  private async readAccessConversation(channelId: string): Promise<SlackApiConversation> {
    if (!this.accessPolicy) throw new Error('Slack access policy is not configured');
    if (!/^[CGD][A-Z0-9]+$/.test(channelId)) throw new SlackAccessInputError(`Invalid Slack conversation ID ${JSON.stringify(channelId)}; use list_channels to choose a conversation`);
    if (channelId.startsWith('D') && this.dmsDisabled) throw new SlackAccessDenied('Direct messages are not admitted on this host');
    if (!this.accessPolicy.mayRead(channelId)) throw new SlackAccessDenied(`Conversation ${channelId} is excluded by the Slack access policy`);
    if (!Array.isArray(this.scopes)) throw new SlackScopeEvidenceError(SCOPES_UNAVAILABLE);

    const result = await this.web.conversations.info({ channel: channelId });
    let issued = responseIssued.get(result)!;
    // Snapshot the channel: a reused client object mutated later must not
    // change evidence already stored for this response.
    let conversation = (result.channel !== null && typeof result.channel === 'object' ? { ...result.channel } : result.channel) as SlackApiConversation | undefined;
    if (conversation?.id === channelId && conversation.is_mpim === true && this.disableDms) {
      throw new SlackAccessDenied('Group direct messages are turned off on this host');
    }
    if (conversation?.id === channelId && conversation.is_mpim === true && conversation.is_member === undefined
        && (conversation.is_im === undefined || conversation.is_im === false) && this.accessPolicy.namesGroupDm(channelId)) {
      this.accessPolicy.requireScope(this.scopes, 'mpim:read');
      const membership = await this.isGroupMember(channelId);
      if (membership !== undefined) {
        conversation = { ...conversation, is_member: membership.member };
        issued = membership.issued;
      }
    }
    this.observeDeliveryConversation(channelId, conversation, issued);
    this.assertNoKnownDeliveryRefusal(channelId);
    this.accessPolicy.requireReadable(channelId, conversation, this.scopes);
    if (conversation!.is_mpim && this.disableDms) {
      throw new SlackAccessDenied('Group direct messages are turned off on this host');
    }
    if (conversation!.is_im && this.dmUsers && !this.dmUsers.includes(conversation!.user!)) throw new SlackAccessDenied(`Conversation ${channelId} is not an admitted direct message`);
    return conversation!;
  }

  /** Policy admission intersects both legacy DM guards on every read/effect. */
  private requirePolicyDmUser(userId: string): void {
    this.accessPolicy!.requireDmUser(userId);
    if (this.disableDms) throw new SlackAccessDenied('Direct messages are turned off on this host');
    if (this.dmUsers && !this.dmUsers.includes(userId)) {
      throw new SlackAccessDenied(`Direct messages with ${userId} are not allowed by this host`);
    }
  }

  /** A missing info membership flag is not proof. Never cache this evidence. */
  private async isGroupMember(channel: string): Promise<{ member: boolean; issued: number } | undefined> {
    if (!this.botUserId || !this.web.conversations.members) return undefined;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const result = await this.web.conversations.members({ channel, limit: 200, ...(cursor ? { cursor } : {}) });
      const issued = responseIssued.get(result)!;
      const next: unknown = result?.response_metadata?.next_cursor;
      // The whole page is validated (pageProblem) before either answer:
      // a malformed or repeated cursor leaves membership unverified.
      if (pageProblem(result?.members, next, seen, isMemberRow) || (typeof next === 'string' && next.trim() !== next)) return undefined;
      if ((result.members as string[]).includes(this.botUserId)) return { member: true, issued };
      if (!next) return { member: false, issued };
      cursor = next as string;
    }
    return undefined;
  }

  private admissionFailures = new Map<string, { count: number; kind: 'event' | 'listing' }>();
  private admissionLogTimer?: ReturnType<typeof setTimeout>;
  private flushAdmissionFailures(): void {
    if (this.admissionLogTimer) clearTimeout(this.admissionLogTimer);
    this.admissionLogTimer = undefined;
    for (const [reason, { count, kind }] of this.admissionFailures) {
      console.error(`[slack-mcpl] Access admission ${reason}: ${count}; ${kind === 'listing' ? 'not listed' : reason.startsWith('denied by policy') ? 'no content delivered for them; the same access policy or host DM restriction (SLACK_DM_USERS, SLACK_DISABLE_DMS) refuses reading them, so no recovery read applies unless whoever runs this host changes that configuration' : 'no content delivered for them; no automatic replay; this summary names no conversation, message or thread, so once access is restored recover by reading the conversations where traffic was expected around this time (fetch_history, or fetch_thread for threads you know)'}.${reason.startsWith('required scope unavailable') ? ' Ask the operator to restore the required Slack grant.' : kind === 'listing' && reason.startsWith('could not verify') ? ' Retry skipped listings with refresh_channels where available.' : reason.startsWith('verification failed') ? ' Ask the operator to investigate credentials and the Slack response before retrying.' : ''}`);
    }
    this.admissionFailures.clear();
  }

  /** Separate loss from routine denials; flush even when the burst ends. */
  private noteAdmissionFailure(kind: 'event' | 'listing', error: unknown = new SlackAccessDenied('Local veto'), unverifiable = false): void {
    const missingScope = error instanceof SlackAccessDenied ? /requires granted scope ['"]?([a-z]+:(?:read|write|history))/.exec(error.message)?.[1] : undefined;
    const reason = error === EVENT_SHUTDOWN ? 'message dropped (shutdown)' : unverifiable
      ? `could not verify (rate limit or transient), ${kind === 'event' ? 'message dropped' : 'listing candidate skipped'}`
      : missingScope ? `required scope unavailable (${kind}, ${missingScope})`
      : error instanceof SlackAccessUnverified ? `verification failed (${kind}, membership_metadata)`
      : error instanceof SlackAccessDenied ? `denied by policy (${kind})`
      : `verification failed (${kind}, ${/^[a-z_]{1,80}$/.test(slackRefusal(error) ?? '') ? slackRefusal(error) : 'unexpected_error'})`;
    this.admissionFailures.set(reason, { count: (this.admissionFailures.get(reason)?.count ?? 0) + 1, kind });
    if (this.stopping) { this.flushAdmissionFailures(); return; }
    if (!this.admissionLogTimer) {
      this.admissionLogTimer = setTimeout(() => this.flushAdmissionFailures(), 60_000);
      this.admissionLogTimer.unref();
    }
  }

  /** One check per call, including cursor continuation, not per history page. */
  private async requireHistoryConversation(channelId: string, notDone: string): Promise<SlackApiConversation | undefined> {
    if (!this.accessPolicy) { await this.assertNotDm(channelId, notDone); return; }
    return withAccessContext(notDone, async () => {
      const conversation = await this.readAccessConversation(channelId);
      this.accessPolicy!.requireScope(this.scopes, historyScope(conversation));
      return conversation;
    });
  }

  /** Cheap vetoes precede fresh admission; neither authorizes an effect alone. */
  private async requireWritableConversation(channelId: string, scope: string, notDone: string): Promise<SlackApiConversation | undefined> {
    if (!this.accessPolicy) { this.assertWritable(channelId, notDone); return; }
    return withAccessContext(notDone, async () => {
      if (!/^[CGD][A-Z0-9]+$/.test(channelId)) throw new SlackAccessInputError(`Invalid Slack conversation ID ${JSON.stringify(channelId)}; use list_channels to choose a conversation`);
      if (!this.accessPolicy!.mayWrite(channelId)) throw new SlackAccessDenied(`Writing to ${channelId} is not allowed by the Slack access policy; use list_channels to find writable alternatives`);
      this.assertWritable(channelId, notDone);
      const conversation = await this.readAccessConversation(channelId);
      this.accessPolicy!.requireWritable(channelId, conversation, this.scopes, scope);
      return conversation;
    }).catch(err => {
      // Preserve identity-keyed request/effect provenance through admission too.
      if (err !== null && typeof err === 'object') accessAdmissionFailures.add(err);
      throw err;
    });
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
        nameWait = waitToAskAgain(failed, 'users.info', this.hasAccessPolicy);
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
      return { id: conv.id, kind: 'group_dm', name: conv.name ?? conv.id, isMember: true,
        ...(this.accessPolicy ? { policyGroupDm: true as const } : {}) };
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
    if (this.accessPolicy && (!this.accessPolicy.mayWrite(channelId) || (channelId.startsWith('D') && this.dmsDisabled))) return false;
    return !this.sendChannels?.length || this.sendChannels.includes(channelId);
  }

  /** `notDone` opens the refusal: what the call would have done, as not done. */
  private assertWritable(channelId: string, notDone: string): void {
    if (!this.canWrite(channelId)) {
      if (this.accessPolicy) throw new SlackAccessDenied(`${notDone}: writing to ${channelId} is not allowed on this host. Use list_channels to find writable alternatives. Retrying unchanged will not help; ask whoever runs this host to check write access.`);
      throw new (this.accessPolicy ? SlackAccessDenied : Error)(
        `${notDone}: this bot may write only to ${this.sendChannels?.join(', ')}, and ${channelId} isn't one of ` +
          'them. list_channels marks the conversations it may write to with writable: true. Calling again ' +
          "won't change that; whoever runs this host decides where it may write.",
      );
    }
  }

  // ── Acknowledgement reaction ──
  // Independently of typing, "received" is shown as a reaction on the message
  // that addressed the bot, removed at the bot's next
  // post in that conversation that Slack confirms, or after ACK_TTL_MS,
  // whichever comes first.

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

  private statusOn = new Map<string, { ts: string; at: number }>();
  private statusQueue = new Map<string, Promise<void>>();
  private statusRefused = new Set<string>();
  private statusEpoch = 0;

  /** Missing-grant latches end when Slack reports a changed grant set, not only at a peer change. */
  private statusGrantRefused = new Set<string>();

  private statusRefusedFor(channelId: string, threadTs: string): boolean {
    return this.statusRefused.has(channelId) || this.statusRefused.has(`${channelId} ${threadTs}`) || this.statusGrantRefused.has(channelId);
  }

  /** Best effort, only in writable conversations. Undefined explicitly clears. */
  setThreadStatus(channelId: string, threadTs: string | undefined): Promise<void> {
    const epoch = this.statusEpoch;
    const turn = (this.statusQueue.get(channelId) ?? Promise.resolve()).then(async () => {
      if (threadTs && (this.stopping || epoch !== this.statusEpoch)) return;
      const cur = this.statusOn.get(channelId);
      if (threadTs && cur?.ts === threadTs && clock.now() - cur.at < STATUS_REFRESH_MS) return;
      if (cur && cur.ts !== threadTs) {
        const clear = await this.callStatus(channelId, cur.ts, '');
        if (clear === 'not_attempted') return;
        this.statusOn.delete(channelId);
      }
      if (!threadTs || !this.canWrite(channelId) || !this.web.assistant || this.statusRefusedFor(channelId, threadTs)) return;
      try {
        await this.assertNotDm(channelId, 'No thread status was set');
      } catch (err) {
        // Only confirmed policy refusals or Slack's lasting original answer
        // suppress later starts. A code-less client failure may pass next time.
        const lasting = err instanceof ChannelOnlyRefusal || (err instanceof Error && refusedForGood(err.cause));
        if (epoch === this.statusEpoch && lasting) {
          this.statusRefused.add(channelId);
        }
        console.error(`[slack-mcpl] thread status on ${channelId} refused:`, this.accessPolicy ? policyFailureSummary(err) : err instanceof Error ? err.message : err);
        return;
      }
      if (this.stopping || epoch !== this.statusEpoch) return;
      const entry = { ts: threadTs, at: clock.now() };
      this.statusOn.set(channelId, entry);
      const outcome = await this.callStatus(channelId, threadTs, STATUS_TEXT);
      if (outcome === 'not_attempted') {
        if (cur?.ts === threadTs) this.statusOn.set(channelId, cur); else this.statusOn.delete(channelId);
      } else if (outcome !== 'ok') {
        if (outcome === 'refused') {
          if (this.hasAccessPolicy && cur?.ts === threadTs) this.statusOn.set(channelId, cur);
          else this.statusOn.delete(channelId);
        }
        else if (this.hasAccessPolicy && cur?.ts === threadTs) this.statusOn.set(channelId, cur);
        else entry.at = -Infinity;
      }
    }).catch((err: unknown) => {
      try { console.error(`[slack-mcpl] thread status on ${channelId} failed:`, this.accessPolicy ? policyFailureSummary(err) : err); } catch { /* best effort */ }
    });
    this.statusQueue.set(channelId, turn);
    void turn.then(() => { if (this.statusQueue.get(channelId) === turn) this.statusQueue.delete(channelId); });
    return turn;
  }

  /** A peer change also releases lasting refusals. */
  async resetThreadStatuses(): Promise<void> {
    this.statusRefused.clear();
    this.statusGrantRefused.clear();
    await this.clearThreadStatuses();
  }

  /** Retire queued starts and clear owned statuses without releasing refusals. */
  async clearThreadStatuses(): Promise<void> {
    this.statusEpoch++;
    const channels = new Set([...this.statusQueue.keys(), ...this.statusOn.keys()]);
    await Promise.all([...channels].map((id) => this.setThreadStatus(id, undefined)));
  }

  private async callStatus(channelId: string, threadTs: string, status: string): Promise<'ok' | 'refused' | 'uncertain' | 'not_attempted'> {
    if (!this.web.assistant) return 'uncertain';
    if (status && this.hasAccessPolicy && this.statusRefusedFor(channelId, threadTs)) return 'not_attempted';
    const epoch = this.statusEpoch;
    let attempted = false;
    try {
      if (this.hasAccessPolicy) {
        await this.requireWritableConversation(channelId, 'chat:write', status ? 'No thread status was set' : 'Thread status was not cleared; the old status may remain');
        if (status && (this.stopping || epoch !== this.statusEpoch)) return 'not_attempted';
      }
      attempted = true;
      await this.web.assistant.threads.setStatus({ channel_id: channelId, thread_ts: threadTs, status });
      return 'ok';
    } catch (err) {
      if (!status || !this.statusRefusedFor(channelId, threadTs)) {
        if (this.accessPolicy) console.error(`[slack-mcpl] thread status ${status ? 'set' : 'clear'} on ${channelId} failed${status ? '' : ' (the previous status may still be visible)'}:`, policyFailureSummary(err));
        else console.error(`[slack-mcpl] thread status on ${channelId} failed:`, err instanceof Error ? err.message : err);
      }
      const refused = refusedForGood(err);
      // Refusals Slack evidenced latch: its lasting refusals and authoritative
      // refusals from fresh metadata (membership) until the peer changes, a
      // missing grant until Slack reports a changed grant set. Local policy
      // denials cost no request and are simply checked again.
      const evidenced = !(err instanceof SlackAccessDenied) || err instanceof SlackAccessGrantDenied
        || errorChain(err).some(value => metadataRefusals.has(value));
      if ((status || this.hasAccessPolicy) && epoch === this.statusEpoch && refused && evidenced) {
        // Slack's own missing_scope names a withdrawn grant too, so a changed grant report releases it.
        if (err instanceof SlackAccessGrantDenied || (this.hasAccessPolicy && errorChain(err).some(value => slackRefusal(value) === 'missing_scope'))) this.statusGrantRefused.add(channelId);
        else this.statusRefused.add(STATUS_THREAD_REFUSALS.has(slackRefusal(err) ?? '') ? `${channelId} ${threadTs}` : channelId);
      }
      if (!attempted) return 'not_attempted';
      return refused ? 'refused' : 'uncertain';
    }
  }

  /** Mark an addressed message as received. Best-effort: never throws. */
  async acknowledge(channelId: string, ts: string): Promise<void> {
    if (!this.ackReaction || this.stopping) return;
    if (this.ackPending.get(channelId)?.has(ts)) return; // Slack delivered the event twice
    const added = this.addReaction(channelId, ts, this.ackReaction, true).then(
      () => true,
      // The add counts as there, and is removed like an added one, when it may
      // have landed, by the rule that reads a post's failure
      // (cannotHaveLanded): already_reacted says it's there; Slack's failure
      // while handling it leaves it unknown, as the explainer says
      // (internal_error and fatal_error can take effect in part); and so does
      // an HTTP error, an answer not in Slack's form or one the client can't
      // read (a TypeError), or a request that failed after it may have reached
      // Slack. Slack's other refusals, its rate limits (a 429, or ratelimited
      // in a 200) and request_timeout say it didn't act, a connection never
      // made reached nothing, and this server's own refusal, such as the write
      // allow-list's, sent nothing. So did a failure of a request before the
      // add, such as the DM check's conversations.info. Slack answers a
      // removal of one that isn't there with no_reaction.
      (err: unknown) => {
        if (failedAccessAdmission(err)) {
          // Not an outcome to keep quiet: the ACK is missing because admission refused it.
          if (this.accessPolicy) console.error(`[slack-mcpl] acknowledgement reaction on ${ts} in ${channelId} not added: ${policyFailureSummary(err)}`);
          return false;
        }
        const failed = failedRequest(err);
        if (failed !== undefined && failed !== 'reactions.add') return false;
        return !cannotHaveLanded(err);
      },
    );
    // Recorded before the add resolves, so a reply Slack confirms first still removes it.
    let pending = this.ackPending.get(channelId);
    if (!pending) this.ackPending.set(channelId, (pending = new Map()));
    const entry: AckEntry = { timer: this.armAck(channelId, ts, ACK_TTL_MS), added, tries: 0 };
    pending.set(ts, entry);
    if (!(await added)) this.dropAck(channelId, ts, entry); // not there, so nothing to remove
  }

  /** Remove the reaction from one message, or from every pending message in the
   *  conversation. A removal that failed in a way that can pass (a rate
   *  limit, an HTTP error, a network failure or Slack's own failure) is tried
   *  again; one Slack refused is not. */
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
      if (this.accessPolicy) await this.requireWritableConversation(channelId, 'reactions:write', 'No reaction was removed');
      await this.web.reactions.remove({ channel: channelId, timestamp: ts, name: this.ackReaction! });
      this.dropAck(channelId, ts, entry);
    } catch (err) {
      // Slack's refusal will be the same next time. A rate limit, an HTTP
      // error, a failure in transit or Slack's own failure can pass. The fifth
      // failure drops the entry, so no sixth attempt can start.
      if (refusedForGood(err) || this.stopping || entry.tries >= ACK_MAX_TRIES) {
        if (this.accessPolicy) console.error(`[slack-mcpl] ACK cleanup retired for ${channelId} ${ts}; reaction may remain: ${policyFailureSummary(err)}`);
        this.dropAck(channelId, ts, entry);
      }
      else entry.timer = this.armAck(channelId, ts, ACK_RETRY_MS);
    }
  }

  /** `notDone` opens this server's own refusals: send_dm's reads "Nothing was
   *  sent". A post that fails in a way that may have posted it (one
   *  cannotHaveLanded doesn't rule out), or whose answer names no message
   *  (PostNotConfirmed), marks its error with what it may have left
   *  (postLeftBy), for rollback. */
  async sendMessage(
    channelId: string,
    text: string,
    opts: { threadTs?: string } = {},
    notDone = 'Nothing was posted',
  ): Promise<{ messageId: string }> {
    // Policy admission precedes text validation. Without policy, preserve the
    // legacy allow-list, text, then DM-check refusal order.
    const admitted = await this.requireWritableConversation(channelId, 'chat:write', notDone);
    assertSendable(text, notDone);
    await this.assertNotDm(channelId, notDone);
    return this.postValidatedMessage(channelId, text, opts, admitted);
  }

  /** Called only after write admission, including sendDM's exact peer check. */
  private async postValidatedMessage(channelId: string, text: string, opts: { threadTs?: string } = {},
    admitted?: SlackApiConversation): Promise<{ messageId: string }> {
    const left = (err: unknown): unknown => {
      if (err !== null && typeof err === 'object') {
        // The admitted kind, not the ID prefix, names the history grant (G is also a group DM).
        postsLeft.set(err, { channelId, ...(this.accessPolicy ? { policy: true, historyReadable: !!admitted && !!this.scopes?.includes(historyScope(admitted)) } : {}), ...(opts.threadTs ? { threadTs: opts.threadTs } : {}) });
      }
      return err;
    };
    let result: { ts?: string };
    try {
      result = await this.web.chat.postMessage({
        channel: channelId,
        text,
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      });
    } catch (err) {
      throw cannotHaveLanded(err) ? err : left(err);
    }
    // An answer whose ts isn't a message's id, a string with something in it,
    // names nothing the agent or a rollback could edit, reply to or delete,
    // and can't show the post went through, so it reads as an unknown
    // outcome, as a failure that may have posted does.
    if (this.accessPolicy && !result) throw left(new PostNotConfirmed(channelId));
    if (typeof result.ts !== 'string' || !result.ts) throw left(new PostNotConfirmed(channelId));
    void outsideCallTime(() => this.clearAck(channelId));
    return { messageId: result.ts };
  }

  /** File argument/provenance mode follows the construction-time policy. */
  get hasAccessPolicy(): boolean { return this.accessPolicy !== undefined; }
  /** Provenance originates only in this adapter's upload ticket response, never caller pairs. */
  private policyUploads = new Map<string, string>();

  private async readAssociatedFile(channelId: string, fileId: string): Promise<Record<string, unknown>> {
    this.accessPolicy!.requireScope(this.scopes, 'files:read');
    if (!FILE_ID.test(fileId)) throw new SlackFileAccessUnverified('File access could not be verified: the file ID is not a Slack file ID');
    // A host-side capability gap, not a file-reference problem: no sender can fix it.
    if (!this.web.files.info) throw new SlackAccessUnverified('File access could not be verified: file metadata support is unavailable; ask whoever runs this host to enable files.info support');
    // A metadata refusal is not a successful deletion: in particular, do not let
    // files.info's file_not_found be counted as files.delete's already-gone answer.
    let result: { file?: unknown };
    try { result = await this.web.files.info({ file: fileId }); }
    catch (err) {
      const failure = err !== null && typeof err === 'object' ? err
        : new Error('Slack file metadata request failed', { cause: err });
      const method = failedRequest(err);
      if (method) failedRequests.set(failure, method);

      accessAdmissionFailures.add(failure);
      throw failure;
    }
    // Evidence observed while files.info was pending, a withdrawn grant or a
    // newer refusal of the conversation, still stops the byte effect.
    this.accessPolicy!.requireScope(this.scopes, 'files:read');
    this.assertNoKnownDeliveryRefusal(channelId);
    return associatedFile(result?.file, fileId, channelId);
  }

  /** Fresh admission and file evidence on every call; no raw metadata leaves the adapter. */
  async resolveFileDownload(channelId: string, fileId: string): Promise<URL> {
    if (!this.accessPolicy) throw new Error('Slack access policy is not configured');
    return withAccessContext('Nothing was fetched', async () => {
      if (!FILE_ID.test(fileId)) throw new SlackAccessInputError(`Invalid Slack file ID ${JSON.stringify(fileId)}; use a fileId shown by fetch_history or fetch_thread`);
      this.accessPolicy!.requireScope(this.scopes, 'files:read');
      await this.readAccessConversation(channelId);
      return privateFileUrl(await this.readAssociatedFile(channelId, fileId));
    });
  }

  private messageFileRefs(files: unknown, channelId: string): PolicyFileRef[] {
    try { this.accessPolicy!.requireScope(this.scopes, 'files:read'); }
    catch { return policyFileRefs(files, channelId).map(ref => ({ channelId, name: 'attachment (download unavailable)', isImage: ref.isImage, downloadUnavailable: 'files:read' as const })); }
    return policyFileRefs(files, channelId);
  }

  /** Upload a file into a conversation, in the three steps of Slack's
   *  working-with-files page: files.getUploadURLExternal gives an upload URL
   *  and the file's ID, the file's bytes go to that URL, and
   *  files.completeUploadExternal shares the file. Same write checks as
   *  sendMessage, but for assertSendable: upload_file refuses a lone surrogate
   *  in the file's name, content, title and comment in the server, before
   *  this is called. Needs the files:write scope.
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
    const refusalsBefore = this.tokenRefusalSeen.count;
    await this.requireWritableConversation(channelId, 'files:write', 'Nothing was uploaded');
    await this.assertNotDm(channelId, 'Nothing was uploaded');
    const target = await this.web.files.getUploadURLExternal({ filename: file.filename, length: file.data.byteLength });
    const url = target.upload_url;
    const fileId = target.file_id;
    if (typeof fileId !== 'string' || !fileId) {
      throw new Error("files.getUploadURLExternal: Slack's answer gave no file ID, so nothing was uploaded");
    }
    // Slack gave the file its ID at the first step, so whatever fails from
    // here leaves that file for rollback to attempt cleanup (policy still requires association). Only the last step's
    // own request can have shared it.
    const left = (err: unknown, mayHaveShared: boolean): unknown => {
      if (err === null || typeof err !== 'object') {
        if (!this.accessPolicy) return err; // Preserve legacy thrown value and tracking.
        err = new Error(String(err), { cause: err });
      }
      filesLeft.set(err as object, { fileId, mayHaveShared, ...(this.accessPolicy ? { policy: true as const } : {}) });
      return err;
    };
    if (this.accessPolicy) {
      if (!FILE_ID.test(fileId)) throw left(new Error('Slack upload returned an invalid file ID'), false);
      this.policyUploads.set(fileId, channelId);
      // Fixed insertion-order cap: evicted uploads fail closed at rollback and
      // may need manual cleanup. Checking an entry does not refresh its age.
      if (this.policyUploads.size > 1000) {
        this.policyUploads.delete(this.policyUploads.keys().next().value!);
      }
    }
    if (typeof url !== 'string' || !url) {
      throw left(new Error("files.getUploadURLExternal: Slack's answer gave no upload URL, so nothing was uploaded"), false);
    }
    try {
      if (this.accessPolicy) {
        const targetUrl = new URL(url);
        if (targetUrl.protocol !== 'https:' || targetUrl.username || targetUrl.password) throw new Error('Invalid Slack upload URL');
        // The byte POST carries no bot token. Stop before transfer for a
        // latched token refusal, a withdrawn files:write grant or a known
        // conversation refusal. A refusal that wins the issue-order latch
        // while the upload is pending still stops transfer if a later-issued
        // success clears the latch. A refusal from an older-issued request
        // can lose to a newer success and never be counted here.
        if (this.tokenRefusal) throw refusalOccurrence(this.tokenRefusal.refusal);
        if (this.tokenRefusalSeen.count !== refusalsBefore) throw refusalOccurrence(this.tokenRefusalSeen.refusal);
        this.accessPolicy.requireScope(this.scopes, 'files:write');
        this.assertNoKnownDeliveryRefusal(channelId);
      }
      await this.postFileBytes(url, file.data);
    } catch (err) {
      throw left(err, false);
    }
    if (this.accessPolicy) {
      try { await this.requireWritableConversation(channelId, 'files:write', 'Nothing was shared'); }
      catch (err) {
        throw left(err, false);
      }
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
    // An answer whose files aren't a list of files names none. Policy mode
    // also keeps a null answer from an injected client on that path.
    const files: unknown = this.accessPolicy ? (answer as { files?: unknown } | null | undefined)?.files : answer.files;
    const shared = Array.isArray(files)
      ? (files as Array<SlackUploadedFile | null>).find((f) => f !== null && typeof f === 'object' && f.id === fileId)
      : undefined;
    if (!shared) throw left(new UploadNotConfirmed(fileId), true);
    // The working reaction comes off whatever time the call has left, as a
    // sent message's does.
    void outsideCallTime(() => this.clearAck(channelId));
    return { fileId, shareTs: sharingTs(shared, channelId) };
  }

  /** Posts a file's bytes to the upload URL Slack gave, as Slack's
   *  working-with-files page does: the bytes as the body. Like every request a
   *  call makes, it keeps the start rule for the client's timeout, and
   *  AbortSignal.timeout ends the whole post at that length: the bytes, the
   *  answer and its body. The client's own timeout ends only a pause in an
   *  answer (SlackWebClient). The URL needs no token. */
  private async postFileBytes(url: string, data: Buffer): Promise<void> {
    assertRequestFits("The upload of the file's bytes", SLACK_CLIENT_OPTIONS.timeout);
    const timeout = AbortSignal.timeout(SLACK_CLIENT_OPTIONS.timeout);
    try {
      const answer = await fetch(url, {
        method: 'POST',
        ...(this.accessPolicy ? { redirect: 'manual' as const } : {}),
        body: data,
        headers: { 'content-type': 'application/octet-stream' },
        signal: timeout,
      });
      if (this.accessPolicy && answer.status >= 300 && answer.status < 400) {
        try { void answer.body?.cancel().catch(() => {}); } catch { /* disposal must not replace the redirect refusal */ }
        throw new SlackAccessDenied('Nothing was shared: this server refuses upload redirects. Ask whoever runs this host to investigate the upload endpoint.');
      }
      await answer.arrayBuffer();
      if (!answer.ok) throw new UploadBytesFailed(answer.status);
    } catch (err) {
      if (err instanceof UploadBytesFailed || err instanceof SlackAccessDenied) throw err;
      // Only the timeout aborts this post, and the error an abort gives
      // depends on the runtime and on when it lands: Node 22's fetch (22.12.0
      // and 22.23.3 alike) gives an AbortError for a body not yet being read,
      // where Node 24 gives the signal's TimeoutError. So the signal says
      // whether it fired.
      throw new UploadBytesFailed(timeout.aborted ? 'TimeoutError' : 'transit');
    }
  }

  /** With SLACK_DISABLE_DMS, only a conversation Slack confirmed to be a
   *  channel may be written to or read. Every write path and both history
   *  reads call this. An ID is not enough: a group DM ID looks like a channel
   *  ID, and a user ID (U…) posts into that user's DM. An unknown ID is asked
   *  about until Slack confirms it; if Slack cannot say, it is refused. */
  private async assertNotDm(channelId: string, notDone: string): Promise<void> {
    // Policy callers have already checked fresh admission, including both legacy DM guards.
    if (this.accessPolicy) return;
    if (!this.disableDms || this.channelIds.has(channelId)) return;
    const refuse = (why: string) =>
      new ChannelOnlyRefusal(
        `${notDone}: ${channelId} ${why}, and this bot works only in channels here, since direct messages are ` +
          'turned off. list_channels shows the ones it can use.',
      );
    if (this.dmIds.has(channelId) || channelId.startsWith('D')) throw refuse('is a direct message or group DM');
    try {
      await this.getConversationMeta(channelId); // fills channelIds for this very ID, or not
    } catch (err) {
      // A check that couldn't be made and can pass (rate-limited, out of its
      // call's time, failed on the way or by Slack's own failure) keeps its
      // error for the explainer, which reads it as this request's, made
      // before the write: nothing was written, and calling again can confirm
      // the conversation. Anything else, Slack's refusal included, leaves it
      // unconfirmed, and the write is refused.
      if (waitToAskAgain(err, 'conversations.info', this.hasAccessPolicy)) throw err;
      const answer = slackRefusal(err);
      const why = answer !== undefined ? `Slack answered ${answer}` : (err as Error).message;
      throw new Error(
        `${notDone}: Slack couldn't confirm ${channelId} is a channel (${why}), and with direct messages turned ` +
          `off, this bot works only in conversations Slack confirms are channels. ${afterFailedCheck(err)}`,
        { cause: err },
      );
    }
    if (!this.channelIds.has(channelId)) throw refuse("isn't a channel");
  }

  async sendDM(userId: string, text: string): Promise<{ messageId: string; channelId: string }> {
    const toChannels =
      'To reach people, post in a channel with send_message; list_channels marks where this bot may write with ' +
      'writable: true.';
    if (this.disableDms) {
      throw new (this.accessPolicy ? SlackAccessDenied : Error)(
        "Nothing was sent: direct messages are turned off on this host, so send_dm can't reach anyone. Calling " +
          `again won't change that; whoever runs this host decides whether this bot may send DMs. ${toChannels}`,
      );
    }
    // A DM ID starts with D. If the allow-list names none, no DM can be written,
    // so don't open one just to find that out.
    if (this.sendChannels?.length && !this.sendChannels.some((id) => this.hasAccessPolicy ? /^D[A-Z0-9]+$/.test(id) : id.startsWith('D'))) {
      if (this.accessPolicy) throw new SlackAccessDenied('Nothing was sent: direct-message writes are not allowed on this host. Use list_channels to find writable alternatives. Retrying unchanged will not help; ask whoever runs this host to check write access.');
      throw new Error(
        `Nothing was sent: this bot may write only to ${this.sendChannels.join(', ')}, none of them a direct ` +
          "message, so send_dm can't reach anyone. Calling again won't change that; whoever runs this host decides " +
          `where it may write. ${toChannels}`,
      );
    }
    if (this.accessPolicy) {
      const channelId = await withAccessContext('Nothing was sent', async () => {
        this.requirePolicyDmUser(userId);
        this.accessPolicy!.requireScope(this.scopes, 'im:write');
        this.accessPolicy!.requireScope(this.scopes, 'im:read');
        this.accessPolicy!.requireScope(this.scopes, 'chat:write');
        assertSendable(text, 'Nothing was sent');
        const open = await this.web.conversations.open({ users: userId });
        if (!open.channel?.id) throw new Error(`Nothing was sent: Slack did not return a DM ID for user ${userId}; a DM may have been opened. Try again shortly`);
        return open.channel.id;
      });
      const notPosted = `DM ${channelId} was opened, but nothing was posted`;
      const admitted = await withAccessContext(notPosted, async () => {
        const conversation = await this.requireWritableConversation(channelId, 'chat:write', notPosted);
        if (conversation?.is_im !== true || conversation.user !== userId) throw new SlackAccessDenied(`Opened DM ${channelId} does not match requested user ${userId}`);
        return conversation;
      });
      // A post may have landed. Do not put it inside a pre-effect outcome wrapper.
      const { messageId } = await withAccessContext(`DM ${channelId} was opened`, () => this.postValidatedMessage(channelId, text, {}, admitted));
      return { messageId, channelId };
    }
    // Before the DM is opened, as above.
    assertSendable(text, 'Nothing was sent');
    const open = await this.web.conversations.open({ users: userId });
    const channelId = open.channel?.id;
    if (!channelId) {
      throw new Error(
        `Nothing was sent: Slack opened no DM with user ${userId}. Check the id with find_user, which returns ` +
          "each person's userId, and call again.",
      );
    }
    const { messageId } = await this.sendMessage(channelId, text, {}, 'Nothing was sent');
    return { messageId, channelId };
  }

  async editMessage(channelId: string, ts: string, text: string): Promise<void> {
    // In the order sendMessage's checks run.
    await this.requireWritableConversation(channelId, 'chat:write', "The message wasn't changed");
    assertSendable(text, "The message wasn't changed");
    await this.assertNotDm(channelId, "The message wasn't changed");
    await this.web.chat.update({ channel: channelId, ts, text });
  }

  async deleteMessage(channelId: string, ts: string): Promise<void> {
    await this.requireWritableConversation(channelId, 'chat:write', 'Nothing was deleted');
    await this.assertNotDm(channelId, 'Nothing was deleted');
    await this.web.chat.delete({ channel: channelId, ts });
  }

  /** Forget local upload provenance without deleting the Slack file. */
  forgetUpload(fileId: string): void { this.policyUploads.delete(fileId); }

  /** Deletes a file this bot uploaded, with the same conversation write
   *  admission as a message's delete; the effect grant is files:write, not
   *  chat:write. */
  async deleteFile(channelId: string, fileId: string): Promise<void> {
    await this.requireWritableConversation(channelId, 'files:write', 'Nothing was deleted');
    await this.assertNotDm(channelId, 'Nothing was deleted');
    if (this.accessPolicy) {
      if (this.policyUploads.get(fileId) !== channelId) throw new SlackAccessDenied('File deletion requires a recorded upload to this conversation');
      await this.readAssociatedFile(channelId, fileId);
      this.accessPolicy.requireScope(this.scopes, 'files:write');
    }
    // Global deletion: other shares are affected too, even when this target is authorized.
    await this.web.files.delete({ file: fileId });
    this.policyUploads.delete(fileId);
  }

  async addReaction(channelId: string, ts: string, emoji: string, acknowledgement = false): Promise<void> {
    await this.requireWritableConversation(channelId, 'reactions:write', 'No reaction was added');
    await this.assertNotDm(channelId, 'No reaction was added');
    if (acknowledgement && this.hasAccessPolicy && this.stopping) {
      const failure = new Error('Acknowledgement stopped before reaction add');
      accessAdmissionFailures.add(failure);
      throw failure;
    }
    await this.web.reactions.add({ channel: channelId, timestamp: ts, name: reactionName(emoji) });
  }

  // ── History ──

  /** fetch_history's read: bounded and filtered, saying whether it covered
   *  its range, with a cursor to continue (history-read.ts). Its pages go
   *  through this adapter's client, after the same DM check as every read.
   *  Backscroll keeps fetchHistory, its own pager, and both shape messages
   *  with shapeHistory. */
  async readHistory(channelId: string, args: Record<string, unknown>): Promise<HistoryReadResult> {
    const opts = readOptions(args, 'history', channelId);
    await this.requireHistoryConversation(channelId, NOTHING_RETURNED);
    return readBounded(opts, {
      policyAttachments: this.hasAccessPolicy,
      strictPages: this.hasAccessPolicy,
      page: (at, limit) => this.web.conversations.history({
        channel: channelId, limit, inclusive: false,
        // Each page sends latest alone, the position or the read's latest, or
        // else no bound, for Slack's own now. Slack's reference says such a
        // page holds the newest messages before latest, which backscroll's
        // requests, sent with latest alone, rely on too. oldest is never sent:
        // readBounded ends the range at the first message at or before it, so
        // coverage rests neither on the host's clock nor on how Slack anchors
        // a page when oldest is sent, which a live run reported on #32 found
        // to differ from Slack's reference.
        ...(at ? { latest: at } : {}),
      }),
      shape: (messages) => this.shapeHistory(messages, channelId),
      writable: this.canWrite(channelId),
      stopped: readStop,
    });
  }

  /** fetch_thread's read, as readHistory's, paging forward through one
   *  thread from its parent. */
  async readThread(channelId: string, threadTs: string, args: Record<string, unknown>): Promise<HistoryReadResult> {
    const opts = readOptions(args, 'thread', channelId, threadTs);
    await this.requireHistoryConversation(channelId, NOTHING_RETURNED);
    return readBounded(opts, {
      policyAttachments: this.hasAccessPolicy,
      strictPages: this.hasAccessPolicy,
      page: (at, limit) => this.web.conversations.replies({
        channel: channelId, ts: threadTs, limit, inclusive: false,
        ...(at ? { oldest: at } : {}), ...(opts.latest ? { latest: opts.latest } : {}),
      }),
      shape: (messages) => this.shapeHistory(messages, channelId),
      writable: this.canWrite(channelId),
      stopped: readStop,
    });
  }

  /** Channel-level history, oldest-first, for backscroll. Thread replies
   *  are NOT included (Slack requires conversations.replies per thread, as
   *  readThread asks). */
  async fetchHistory(
    channelId: string,
    opts: { limit?: number; oldest?: string; latest?: string; signal?: AbortSignal } = {},
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean; stopReason?: 'message_limit' | 'page_limit' }> {
    opts.signal?.throwIfAborted();
    await this.requireHistoryConversation(channelId, 'Nothing was read');
    if (this.accessPolicy && this.stopping) throw new Error('History stopped before requesting a page');
    const { messages, truncated, stopReason } = await fetchSlackHistory(this.web, {
      channel: channelId,
      ...(opts.oldest !== undefined ? { oldest: opts.oldest } : {}),
      ...(opts.latest !== undefined ? { latest: opts.latest } : {}),
      maxMessages: opts.limit ?? 50,
      signal: opts.signal,
      maxPages: this.pagination.backscroll,
      rejectCursorCycles: this.hasAccessPolicy,
    });
    return { messages: await this.shapeHistory(messages, channelId, 2000, opts.signal), truncated, ...(stopReason ? { stopReason } : {}) };
  }

  private async shapeHistory(messages: SlackHistoryMessage[], channelId: string, maxAppend = MAX_MESSAGE_TEXT_APPEND, signal?: AbortSignal): Promise<HistoryMessage[]> {
    // Supplemental-only mentions never spend the read's call budget or grow
    // the name cache. All delivery paths use an existing name or the raw ID.
    signal?.throwIfAborted();
    const ids = new Set<string>();
    const texts: string[] = [];
    for (let index = 0; index < messages.length; index++) {
      // Large backscroll windows must not monopolize Socket Mode's loop.
      if (index > 0 && index % 10 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
        signal?.throwIfAborted();
      }
      const msg = messages[index];
      // Leave malformed legacy rows to the existing author scan's error.
      texts.push(msg == null ? '' : renderMessageText(msg, maxAppend));
    }
    for (const msg of messages) {
      if (msg.user) ids.add(msg.user);
      for (const id of extractSlackUserIds(msg.text ?? '')) ids.add(id);
    }
    await this.resolveUserNames(Array.from(ids), signal);
    signal?.throwIfAborted();

    return messages.map((msg, index) => {
      const id = String(msg.ts ?? '');
      // The thread a message belongs to: the one its parent's ts names, as
      // Slack reports it, or the message's own.
      const reported = [msg.thread_ts, msg.root?.thread_ts, msg.root?.ts].find((ts) => typeof ts === 'string' && SLACK_TS.test(ts));
      const count = msg.reply_count;
      return {
      id,
      authorId: msg.user,
      ...(msg.bot_id ? { authorBotId: msg.bot_id } : {}),
      authorName: msg.user ? (this.userNameCache.get(msg.user) ?? msg.user) : (msg.username ?? 'bot'),
      content: formatMessageText(msg.text ?? '', texts[index], this.userNameCache),
      threadTs: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
      rootTs: reported ?? id,
      // Missing means unknown, not none.
      ...(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? { replyCount: count } : {}),
      timestamp: new Date(parseFloat(msg.ts ?? '0') * 1000),
      // References carry message provenance, not download authority.
      attachments: this.accessPolicy ? this.messageFileRefs(msg.files, channelId) : (msg.files ?? []).map((f) => ({
        name: f.name ?? 'attachment',
        mimeType: f.mimetype,
        url: f.url_private,
      })),
      };
    });
  }

  // ── Users ──

  /** Without a policy, keep the original directory search, including its
   *  match-limit and cursor decisions. The tool opts into bounded search. */
  async findUsers(query: string, max = 25): Promise<SlackUserSearchResult> {
    if (this.accessPolicy) return this.findUsersBounded(query, max);
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

  /** Directory search for find_user and callers opting into page bounds. */
  async findUsersBounded(query: string, max = 25): Promise<SlackUserSearchResult> {
    if (!this.accessPolicy) return this.findUsersBoundedUnset(query, max);
    await withAccessContext('No users were returned', async () => this.accessPolicy?.requireScope(this.scopes, 'users:read'));
    const q = query.toLowerCase();
    if (!q) throw new Error('query is required');
    const matches: SlackUserMatch[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let pages = 0;
    do {
      const result = await this.web.users.list({ limit: 200, cursor });
      pages++;
      // The whole page, every row and its cursor, repetition included, is
      // validated (pageProblem) before a match is taken or the search stops
      // at its match or page limit.
      const next: unknown = result?.response_metadata?.next_cursor;
      const problem = pageProblem(result?.members, next, cursors, isDirectoryRow);
      if (problem) throw new Error(`No users were returned: ${DIRECTORY_PAGE_REFUSALS[problem]}`);
      const members = result.members as Array<{
        id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean;
        profile?: { display_name?: string } | null;
      }>;
      let unexamined = false;
      for (let index = 0; index < members.length; index++) {
        const raw = members[index]!;
        if (raw.deleted || raw.is_bot) continue;
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
          if (matches.length >= max) { unexamined = index < members.length - 1; break; }
        }
      }
      if (matches.length >= max && (unexamined || next)) {
        return { matches, truncated: true, reason: 'match_limit', pages, limit: max };
      }
      cursor = matches.length >= max ? undefined : ((next as string | undefined) || undefined);
      if (cursor && pages >= this.pagination.users) {
        return { matches, truncated: true, reason: 'page_limit', pages, limit: this.pagination.users };
      }
    } while (cursor);
    return matches;
  }

  /** The bounded search keeps legacy member iteration without page validation. */
  private async findUsersBoundedUnset(query: string, max: number): Promise<SlackUserSearchResult> {
    const q = query.toLowerCase();
    if (!q) throw new Error('query is required');
    const matches: SlackUserMatch[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await this.web.users.list({ limit: 200, cursor });
      pages++;
      let examined = 0;
      for (const raw of (result.members ?? []) as Array<{
        id?: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean;
        profile?: { display_name?: string };
      }>) {
        examined++;
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
      if (matches.length >= max && (examined < ((result.members ?? []) as unknown[]).length || result.response_metadata?.next_cursor)) {
        return { matches, truncated: true, reason: 'match_limit', pages, limit: max };
      }
      cursor = matches.length >= max
        ? undefined
        : (result.response_metadata?.next_cursor || undefined);
      // Documented limit: the page budget.
      if (cursor && pages >= this.pagination.users) {
        return { matches, truncated: true, reason: 'page_limit', pages, limit: this.pagination.users };
      }
    } while (cursor);
    return matches;
  }

  // ── Incoming events ──

  // Share only pending evidence, never settled positive or negative results.
  private eventAdmissions = new Map<string, { priority: { addressed: boolean }; request: Promise<SlackApiConversation | undefined> }>();
  private sharedEventAdmission(channel: string, addressed: boolean): Promise<SlackApiConversation | undefined> {
    const pending = this.eventAdmissions.get(channel);
    if (pending) {
      if (addressed) pending.priority.addressed = true;
      return pending.request;
    }
    // Keep promotion through in-flight checks and backoff, not just queued slots.
    const priority = { addressed };
    const request = this.retryEventAdmission(channel, priority).finally(() => {
      if (this.eventAdmissions.get(channel)?.priority === priority) this.eventAdmissions.delete(channel);
    });
    this.eventAdmissions.set(channel, { priority, request });
    return request;
  }

  // Pace initial admission slot releases across channels, including fast
  // refusals. Never cache a settled authorization or weaken fresh checks.
  private eventAdmissionQueue: Array<{ channel: string; priority: { addressed: boolean }; latest?: number; resolve: (admit: boolean) => void; reject: (error: unknown) => void }> = [];
  private admissionPacing = false;
  private nextEventAdmissionAt = 0;
  /** Until when a Slack Retry-After holds shared admission, so a foreground
   *  listing stopped by it reports the rate limit, not its own deadline. */
  private admissionCooldownUntil = 0;
  private holdAdmissions(wait: Pick<SlackWait, 'seconds' | 'why'> | undefined): void {
    // A huge finite Retry-After whose milliseconds overflow would hold admission forever.
    if (wait?.why !== 'limited' || !Number.isFinite(wait.seconds * 1000) || wait.seconds < 0) return;
    this.admissionCooldownUntil = Math.max(this.admissionCooldownUntil, clock.monotonic() + wait.seconds * 1000);
    this.nextEventAdmissionAt = Math.max(this.nextEventAdmissionAt, this.admissionCooldownUntil);
  }
  /** `latest`, for a foreground candidate, is the monotonic time by which its
   *  request must start: a slot that can't be released by then resolves false
   *  at once, instead of holding the host call past its deadline. Such
   *  candidates are bounded by their call and never evicted as ambient work. */
  private paceEventAdmission(channel: string, priority: { addressed: boolean }, latest?: number): Promise<boolean> {
    const slot = new Promise<boolean>((resolve, reject) => {
      if (latest !== undefined && latest < Math.max(clock.monotonic(), this.nextEventAdmissionAt)) { resolve(false); return; }
      this.eventAdmissionQueue.push({ channel, priority, latest, resolve, reject });
      const ambient = this.eventAdmissionQueue.filter(item => !item.priority.addressed && item.latest === undefined);
      if (ambient.length > 32) {
        const oldest = ambient[0]!;
        this.eventAdmissionQueue.splice(this.eventAdmissionQueue.indexOf(oldest), 1);
        if (this.eventAdmissions.get(oldest.channel)?.priority === oldest.priority) this.eventAdmissions.delete(oldest.channel);
        oldest.resolve(false);
        console.error(`[slack-mcpl] dropped oldest ambient admission for ${oldest.channel}: backlog limit 32; automatic replay is unavailable; use refresh_channels for registration, fetch_history for channel messages or fetch_thread for replies.`);
      }
    });
    void this.drainEventAdmissions();
    return slot;
  }

  private async drainEventAdmissions(): Promise<void> {
    if (this.admissionPacing) return;
    this.admissionPacing = true;
    try {
      while (this.eventAdmissionQueue.length) {
        const delay = Math.max(0, this.nextEventAdmissionAt - clock.monotonic());
        if (this.stopping) {
          for (const item of this.eventAdmissionQueue.splice(0)) item.resolve(false);
          break;
        }
        // A foreground slot that can't be released before its call's request
        // deadline ends that call's scan now, not after the wait.
        for (const late of this.eventAdmissionQueue.filter(item => item.latest !== undefined && item.latest < clock.monotonic() + delay)) {
          this.eventAdmissionQueue.splice(this.eventAdmissionQueue.indexOf(late), 1);
          late.resolve(false);
        }
        if (!this.eventAdmissionQueue.length) break;
        if (delay) { await clock.sleep(Math.min(delay, 2_147_483_647), { signal: this.admissionStop.signal }); continue; }
        // Select AFTER the wait: addressed work, then foreground, then oldest ambient.
        const addressed = this.eventAdmissionQueue.findIndex(item => item.priority.addressed);
        const foreground = addressed < 0 ? this.eventAdmissionQueue.findIndex(item => item.latest !== undefined) : -1;
        const item = this.eventAdmissionQueue.splice(Math.max(addressed, foreground, 0), 1)[0]!;
        this.nextEventAdmissionAt = clock.monotonic() + 1200;
        item.resolve(true);
        await Promise.resolve(); // let the released attempt start before reserving another slot
      }
    } catch (error) {
      for (const item of this.eventAdmissionQueue.splice(0)) item.reject(error);
    } finally { this.admissionPacing = false; }
  }

  private async retryEventAdmission(channel: string, priority: { addressed: boolean }, forDelivery = false): Promise<SlackApiConversation | undefined> {
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      if (this.stopping) throw new Error('Conversation admission stopped');
      if (!forDelivery && !await this.paceEventAdmission(channel, priority)) return undefined;
      // Unsubscribed while it waited for its slot: the server would filter it,
      // so it spends no admission quota.
      if (this.ambientUnsubscribed(channel, priority)) return undefined;
      if (this.stopping) throw new Error('Conversation admission stopped');
      try { return await this.requireHistoryConversation(channel, 'Nothing was delivered'); }
      catch (err) {
        const wait = waitToAskAgain(err, failedRequest(err) ?? 'conversations.info', this.hasAccessPolicy)
          ?? (slackRefusal(err) === 'ratelimited'
            ? { seconds: retryAfterSeconds(err) ?? FAILED_WAIT_SECONDS, why: 'limited' as const } : undefined);
        if (failedRequest(err) === 'conversations.info') this.holdAdmissions(wait);
        const minimum = wait?.why === 'failed' ? 1 : wait?.seconds;
        // Positive jitter respects Retry-After; budget includes jitter.
        const seconds = minimum === undefined ? NaN : minimum + (forDelivery ? 0 : Math.random() * 0.25);
        if (wait && attempt < 3 && Number.isFinite(seconds) && minimum! >= 0
            && waited + seconds <= (forDelivery ? 2 : 10) && !this.stopping) {
          waited += seconds;
          await clock.sleep(seconds * 1000, { unref: true, signal: this.admissionStop.signal });

          if (!this.stopping) continue;
        }
        throw err;
      }
    }
  }

  /** An event's checks and its author's and mentions' names, and the message
   *  they make, or undefined for an event that isn't delivered. */
  private async prepareMessageEvent(event: SlackMessageEvent): Promise<SlackMessageData | undefined> {
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

    let channelType = event.channel_type;
    let isDM = event.channel_type === 'im' || event.channel.startsWith('D');
    if (this.accessPolicy) {
      // Skip undeliverable ambient traffic before spending the shared info quota.
      // D IDs (not the untrusted channel_type hint) and exact bot mentions
      // bypass this veto; neither bypasses fresh admission below.
      const addressed = event.channel.startsWith('D') || (this.botUserId !== null
        && typeof event.text === 'string' && extractSlackUserIds(event.text).includes(this.botUserId));
      if (!addressed && this.ambientMessageFilter && !this.ambientMessageFilter(event.channel)) return;
      if (this.stopping) throw EVENT_SHUTDOWN;
      // Local checks can only deny; fresh metadata remains authoritative.
      if ((event.channel_type === 'mpim' && (this.disableDms || !this.accessPolicy.namesGroupDm(event.channel)))
          || (event.channel.startsWith('D') && !this.accessPolicy.namesGroupDm(event.channel) && (this.dmsDisabled || !this.accessPolicy.mayDmUser(event.user)
          || (this.dmUsers && !this.dmUsers.includes(event.user))))
          || (!isDM && !this.accessPolicy.joinedChannelsReadable && !this.accessPolicy.namesGroupDm(event.channel))) {
        this.noteAdmissionFailure('event');
        return;
      }
      try {
        const conversation = await this.sharedEventAdmission(event.channel, addressed);
        if (this.stopping) throw EVENT_SHUTDOWN;
        // Each event sharing a retired admission is named, not only the slot.
        if (!conversation) {
          if (!this.ambientUnsubscribed(event.channel, { addressed })) droppedEvent(event, 'its admission slot was retired from the 32-entry ambient admission backlog');
          return;
        }
        isDM = conversation?.is_im === true;
        channelType = conversation?.is_im ? 'im' : conversation?.is_mpim ? 'mpim' : conversation?.is_private ? 'group' : 'channel';
        if (isDM && conversation?.user !== event.user) throw new SlackAccessDenied('DM peer mismatch');
      } catch (err) {
        if (this.stopping) throw EVENT_SHUTDOWN;
        const transient = !!waitToAskAgain(err, failedRequest(err) ?? 'conversations.info', this.hasAccessPolicy)
          || slackRefusal(err) === 'ratelimited';
        this.noteAdmissionFailure('event', err, transient);
        return;
      }
    }
    // Only what Slack marks as a channel gets through, not merely what isn't marked a DM.
    if (!this.accessPolicy && this.disableDms && event.channel_type !== 'channel' && event.channel_type !== 'group') return;
    if (!this.accessPolicy && isDM && this.dmUsers && !this.dmUsers.includes(event.user)) {
      return; // DM whitelist active and this sender isn't on it
    }

    // Resolve the author and original-text mentions only. Supplemental names
    // are display-only: use the cache, never delay delivery for a lookup.
    await Promise.resolve(); // Socket Mode queues ack first; yield before rendering.
    const text = renderMessageText(event);
    const mentionIds = extractSlackUserIds(event.text ?? '');
    await this.resolveUserNames([event.user, ...mentionIds]);
    if (this.accessPolicy && this.stopping) throw EVENT_SHUTDOWN;
    const authorName = this.userNameCache.get(event.user) ?? event.user;

    // No private URLs in policy references, including ID-only Slack Connect stubs.
    const attachments: AttachmentRef[] = this.accessPolicy ? this.messageFileRefs(event.files, event.channel) : (event.files ?? [])
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
      ...(text !== (event.text ?? '') ? { rawContent: event.text ?? '' } : {}),
      content: text,
      cleanContent: formatMessageText(event.text ?? '', text, this.userNameCache),
      mentionIds,
      // Personal mention of the bot — hosts use this to gate wake policy.
      // @here/@channel broadcasts deliberately don't count.
      mentionsBot: this.botUserId !== null && mentionIds.includes(this.botUserId),
      isDM,
      channelType,
      teamId: event.team,
      timestamp: new Date(parseFloat(event.ts) * 1000),
      attachments,
    };
    return msg;
  }

  /** Resolve user IDs into this adapter's cache (shared logic in content.ts).
   *  Returns the error of each lookup left uncached. */
  private async resolveUserNames(userIds: Array<string | undefined>, signal?: AbortSignal): Promise<Map<string, unknown>> {
    return resolveSlackUserNames(
      this.web,
      this.userNameCache,
      userIds.filter((id): id is string => !!id),
      signal,
    );
  }
}

/** The renderer preserves original text as a prefix. Format that prefix
 * separately so only original occurrences retain Slack's fallback labels. */
function formatMessageText(original: string, rendered: string, cache: Map<string, string>): string {
  const supplemental = rendered.slice(original.length);
  const names = new Map(extractSlackUserIds(supplemental).map(id => [id, cache.get(id) ?? id]));
  return formatSlackText(original, cache) + formatSlackText(supplemental, names);
}
