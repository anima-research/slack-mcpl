import { inspect } from 'node:util';

/** Trusted host data only; getters and iterators may execute host code.
 * Internal preparation only: no connector setting installs this policy yet. */
export interface SlackAccessPolicyConfig {
  readonly readJoinedChannels: boolean;
  readonly writeChannels: readonly string[];
  readonly dmUsers: readonly string[];
  /** Exact joined group-DM IDs. Writes also need a writeChannels pin. Omit the key when unused. */
  readonly groupDms?: readonly string[];
}

export interface AccessConversation {
  id?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
}

const CHANNEL_ID = /^[CG][A-Z0-9]+$/;
const USER_ID = /^[UW][A-Z0-9]+$/;
const GROUP_DM_ID = /^G[A-Z0-9]+$/;
const DM_ID = /^D[A-Z0-9]+$/;
/** Bounded, single-line diagnostics, including non-JSON embedded values. */
function rejectedValue(value: unknown): string {
  const preview = inspect(value, { depth: 0, maxArrayLength: 3, maxStringLength: 100,
    customInspect: false, getters: false, breakLength: Infinity })
    ;
  let bounded = '';
  // Retain whole code points and whole escapes (including inspect's escapes).
  for (const token of preview.match(/\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])|[\s\S]/gu) ?? []) {
    const escaped = token.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (bounded.length + escaped.length > 180) break;
    bounded += escaped;
  }
  return bounded;
}

function validateIds(value: unknown, pattern: RegExp, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Slack access policy: ${field} must be an array`);
  const index = value.findIndex(id => typeof id !== 'string' || !pattern.test(id));
  if (index !== -1) {
    const format = pattern === CHANNEL_ID ? 'an uppercase C- or G-prefixed channel ID'
      : pattern === USER_ID ? 'an uppercase U- or W-prefixed user ID'
      : `an uppercase ID matching ${pattern}`;
    throw new Error(`Invalid Slack access policy: ${field}[${index}] rejected ${rejectedValue(value[index])}; expected ${format}`);
  }
}

const REQUIRED_KEYS = new Set<string | symbol>(['readJoinedChannels', 'writeChannels', 'dmUsers']);
const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, 'groupDms']);

/** One strict, unversioned format for future embedded and JSON callers.
 * Snapshot before validating to retain the values checked. This is not a sandbox
 * for hostile JavaScript objects, accessors, proxies or iterators. */
export function parseAccessPolicy(value: unknown): SlackAccessPolicyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Slack access policy');
  const config = value as Record<string, unknown>;
  const keys = new Set(Reflect.ownKeys(config));
  if ([...REQUIRED_KEYS].some((key) => !keys.has(key))
      || [...keys].some((key) => !ALLOWED_KEYS.has(key))) throw new Error(`Invalid Slack access policy: missing keys ${[...REQUIRED_KEYS].filter(key => !keys.has(key)).map(String).join(', ') || 'none'}; unknown keys ${rejectedValue([...keys].filter(key => !ALLOWED_KEYS.has(key)))}`);
  const { readJoinedChannels, writeChannels, dmUsers } = config;
  if ('groupDms' in config && !keys.has('groupDms')) throw new Error('Invalid Slack access policy: groupDms must be an own property');
  const groupDms = keys.has('groupDms') ? config.groupDms : undefined;
  const channels = Array.isArray(writeChannels) ? Array.from(writeChannels) : writeChannels;
  const users = Array.isArray(dmUsers) ? Array.from(dmUsers) : dmUsers;
  const groups = Array.isArray(groupDms) ? Array.from(groupDms) : groupDms;
  if (typeof readJoinedChannels !== 'boolean') throw new Error('Invalid Slack access policy: readJoinedChannels must be boolean');
  validateIds(channels, CHANNEL_ID, 'writeChannels');
  validateIds(users, USER_ID, 'dmUsers');
  if (keys.has('groupDms')) validateIds(groups, GROUP_DM_ID, 'groupDms');
  return Object.freeze({ readJoinedChannels, writeChannels: Object.freeze(channels), dmUsers: Object.freeze(users),
    ...(keys.has('groupDms') ? { groupDms: Object.freeze(groups as string[]) } : {}) });
}

export class SlackAccessDenied extends Error {
  override name = 'SlackAccessDenied';
  constructor(message: string, options?: ErrorOptions, readonly authoritative = true) { super(message, options); }
}

/** Missing, contradictory or no-longer-current membership evidence, not a local policy exclusion. */
export class SlackAccessUnverified extends SlackAccessDenied {
  override name = 'SlackAccessUnverified';
  constructor(message: string, options?: ErrorOptions, authoritative = false) { super(message, options, authoritative); }
}

// File evidence has a different repair path from conversation membership.
export class SlackFileAccessUnverified extends SlackAccessUnverified { override name = 'SlackFileAccessUnverified'; }

// Confirmed file state needs replacement, not operator permission changes.
export class SlackFileUnavailable extends SlackAccessDenied { override name = 'SlackFileUnavailable'; }

/** Invalid caller input, distinct from host-owned access restrictions. */
export class SlackAccessInputError extends Error { override name = 'SlackAccessInputError'; }

/** A missing reported grant is lasting until installation or scope evidence changes. */
export class SlackAccessGrantDenied extends SlackAccessDenied {}

const accessContexts = new WeakMap<object, string>();
const accessContextOriginals = new WeakMap<object, string>();
/** At a new client occurrence, discard even context on rethrown local wrappers. */
export function accessContextOriginalMessage(err: object): string | undefined {
  return accessContextOriginals.get(err);
}
/** Context also survives frozen client errors without replacing their identity. */
export function accessContextMessage(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' ? accessContexts.get(err) : undefined;
}
/** Add operation context while preserving Slack's error code and original cause. */
export async function withAccessContext<T>(notDone: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (err) {
    // Identity carries effect/request provenance; never clone an error here.
    const failure = err !== null && typeof err === 'object' ? err : new Error('Slack request failed', { cause: err });
    if (!accessContextOriginals.has(failure)) accessContextOriginals.set(failure, (failure as Error).message ?? 'Slack request failed');
    const contextual = accessContexts.has(failure);
    const text = accessContexts.get(failure) ?? (failure as Error).message ?? 'Slack request failed';
    const alreadyPrefixed = text.startsWith(`${notDone}:`);
    const remedy = contextual || alreadyPrefixed ? ''
      : err instanceof SlackFileUnavailable ? '. Retrying this file unchanged will not help.'
      : err instanceof SlackFileAccessUnverified ? '. Check the file reference; ask its sender to share a supported file in this conversation, then re-read the message for a current reference.'
      : err instanceof SlackAccessDenied
        ? err.authoritative
          ? '. Retrying unchanged will not help; ask whoever runs this host to check access for this operation.'
          : '. Retry once for fresh evidence; if it persists, ask whoever runs this host to investigate access.'
        : '';
    const message = `${alreadyPrefixed ? '' : `${notDone}: `}${text}${remedy}`;
    accessContexts.set(failure, message);
    try { Object.defineProperty(failure, 'message', { value: message, configurable: true, writable: true }); }
    catch { /* Frozen errors still carry context out-of-band and keep identity. */ }
    throw failure;
  }
}

/** Pure decisions over trusted host metadata: no Slack calls or cached membership.
 * Snapshots provide consistency, not isolation from hostile JavaScript inputs.
 * The user directory is outside this policy's confinement: find_user is gated
 * only on users:read and searches the whole workspace directory, not just
 * admitted DM peers or conversation members. Directory filtering remains a
 * decision for the later activation PR. */
export class SlackAccessPolicy {
  private readonly writeChannels: ReadonlySet<string>;
  private readonly dmUsers: ReadonlySet<string>;
  private readonly groupDms: ReadonlySet<string>;
  private readonly readJoinedChannels: boolean;

  constructor(config: SlackAccessPolicyConfig) {
    const parsed = parseAccessPolicy(config);
    this.writeChannels = new Set(parsed.writeChannels);
    this.dmUsers = new Set(parsed.dmUsers);
    this.groupDms = new Set(parsed.groupDms);
    this.readJoinedChannels = parsed.readJoinedChannels;
  }

  /** Cheap veto only; fresh metadata still decides admission. */
  mayRead(channelId: string): boolean {
    return channelId.startsWith('D') ? this.dmsWritable : this.readJoinedChannels || this.groupDms.has(channelId);
  }
  get groupDmsReadable(): boolean { return this.groupDms.size > 0; }

  get dmsWritable(): boolean { return this.dmUsers.size > 0; }

  /** A synchronous configuration hint, never an authorization decision. */
  mayWrite(channelId: string): boolean {
    return ((this.readJoinedChannels || this.groupDms.has(channelId)) && this.writeChannels.has(channelId)) || (channelId.startsWith('D') && this.dmsWritable);
  }

  /** A rejection-only listing hint; fresh metadata still decides admission. */
  namesGroupDm(channelId: string): boolean { return this.groupDms.has(channelId); }

  requireScope(scopes: readonly string[] | undefined, needed: string): void {
    scopes = Array.isArray(scopes) ? Array.from(scopes) : scopes;
    if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string')) throw new Error(`Slack scope metadata is unavailable or malformed; requires granted scope evidence for ${rejectedValue(needed)}; ask whoever runs this host to refresh Slack-reported permission evidence with list_channels or restart`);
    if (!scopes.includes(needed)) throw new SlackAccessGrantDenied(`Slack access requires granted scope ${rejectedValue(needed)}`);
  }

  mayDmUser(userId: string): boolean { return this.dmUsers.has(userId); }

  requireDmUser(userId: string): void {
    if (!USER_ID.test(userId)) throw new SlackAccessInputError(`Invalid Slack user ID ${rejectedValue(userId)}; use find_user to choose a user`);
    if (!this.mayDmUser(userId)) throw new SlackAccessDenied(`Direct messages with ${rejectedValue(userId)} are not allowed by the Slack access policy for allowed DM peers`);
  }

  /** Conversation evidence only: no mutable grant state or known-refusal inputs. */
  requireReadableMetadata(channelId: string, conversation: AccessConversation | undefined): 'channel' | 'private_channel' | 'dm' | 'group_dm' {
    if (!conversation) throw new SlackAccessUnverified(`Conversation ${rejectedValue(channelId)} has missing metadata`);
    conversation = Object.assign(Object.create(null), conversation) as AccessConversation;
    if (typeof channelId !== 'string' || typeof conversation.id !== 'string' || conversation.id !== channelId) throw new SlackAccessUnverified(`Conversation ${rejectedValue(channelId)} has mismatched identity metadata`);
    if (conversation.is_mpim === true) {
      if (this.groupDms.has(channelId) && conversation.is_member === true && (conversation.is_private === undefined || conversation.is_private === true) && (conversation.is_im === undefined || conversation.is_im === false)) {
        return 'group_dm';
      }
      if (this.groupDms.has(channelId)) throw new SlackAccessUnverified(`Conversation ${rejectedValue(channelId)} group membership could not be verified; check bot membership and Slack metadata`, undefined, conversation.is_member === false);
      throw new SlackAccessDenied('This group direct message is not admitted; ask the host to check its configured group and bot membership');
    }
    if (conversation.is_im === true) {
      if ((conversation.is_mpim !== undefined && conversation.is_mpim !== false)
          || !DM_ID.test(channelId) || (typeof conversation.user !== 'string' || !USER_ID.test(conversation.user))) throw new SlackAccessUnverified(`Conversation ${rejectedValue(channelId)} has invalid DM metadata (direct-message identity or kind could not be verified)`);
      if (!this.mayDmUser(conversation.user)) throw new SlackAccessDenied(`Conversation ${rejectedValue(channelId)} is not an admitted direct message`);
      return 'dm';
    }
    if (conversation.is_member === false) throw new SlackAccessUnverified(`The bot is not in conversation ${rejectedValue(channelId)}; a member can invite it with /invite, then access must be checked again`, undefined, true);
    if (conversation.is_im !== false || conversation.is_mpim !== false || typeof conversation.is_private !== 'boolean'
        || !CHANNEL_ID.test(channelId)) {
      throw new SlackAccessUnverified(`Conversation ${rejectedValue(channelId)} has invalid channel metadata (conversation identity or kind could not be verified)`);
    }
    if (conversation.is_member !== true) throw new SlackAccessUnverified(`Conversation ${rejectedValue(channelId)} membership metadata does not confirm a joined channel`);
    if (!this.readJoinedChannels) throw new SlackAccessDenied('Joined-channel reads are disabled by the Slack access policy for joined-conversation reads');
    return conversation.is_private ? 'private_channel' : 'channel';
  }

  /** Fresh exact metadata and current grants are independent evidence. History
   * scopes are checked separately by callers. */
  requireReadable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined): 'channel' | 'private_channel' | 'dm' | 'group_dm' {
    const kind = this.requireReadableMetadata(channelId, conversation);
    this.requireScope(scopes, kind === 'group_dm' ? 'mpim:read' : kind === 'dm' ? 'im:read' : kind === 'private_channel' ? 'groups:read' : 'channels:read');
    return kind;
  }

  requireWritable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined, writeScope: string): void {
    if (!['chat:write', 'files:write', 'reactions:write'].includes(writeScope)) throw new Error(`Unsupported Slack write scope ${rejectedValue(writeScope)}; expected chat:write, files:write or reactions:write`);
    scopes = Array.isArray(scopes) ? Array.from(scopes) : scopes;
    const kind = this.requireReadable(channelId, conversation, scopes);
    if (kind !== 'dm' && !this.writeChannels.has(channelId)) throw new SlackAccessDenied(`Writing to ${rejectedValue(channelId)} is not allowed by the Slack access policy for write destinations`);
    this.requireScope(scopes, writeScope);
  }
}
