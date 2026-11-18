import { inspect } from 'node:util';

/** Trusted host data only; getters and iterators may execute host code.
 * Internal preparation only: no connector setting installs this policy yet. */
export interface SlackAccessPolicyConfig {
  readonly readJoinedChannels: boolean;
  readonly writeChannels: readonly string[];
  readonly dmUsers: readonly string[];
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
const ALLOWED_KEYS = new Set(REQUIRED_KEYS);

/** One strict, unversioned format for future embedded and JSON callers.
 * Snapshot before validating to retain the values checked. This is not a sandbox
 * for hostile JavaScript objects, accessors, proxies or iterators. */
export function parseAccessPolicy(value: unknown): SlackAccessPolicyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Slack access policy: expected an object');
  const config = value as Record<string, unknown>;
  const keys = new Set(Reflect.ownKeys(config));
  if ([...REQUIRED_KEYS].some((key) => !keys.has(key))
      || [...keys].some((key) => !ALLOWED_KEYS.has(key))) throw new Error(`Invalid Slack access policy: missing keys ${[...REQUIRED_KEYS].filter(key => !keys.has(key)).map(String).join(', ') || 'none'}; unknown keys ${rejectedValue([...keys].filter(key => !ALLOWED_KEYS.has(key)))}`);
  const { readJoinedChannels, writeChannels, dmUsers } = config;
  const channels = Array.isArray(writeChannels) ? Array.from(writeChannels) : writeChannels;
  const users = Array.isArray(dmUsers) ? Array.from(dmUsers) : dmUsers;
  if (typeof readJoinedChannels !== 'boolean') throw new Error('Invalid Slack access policy: readJoinedChannels must be boolean');
  validateIds(channels, CHANNEL_ID, 'writeChannels');
  validateIds(users, USER_ID, 'dmUsers');
  return Object.freeze({ readJoinedChannels, writeChannels: Object.freeze(channels), dmUsers: Object.freeze(users) });
}

/** Pure decisions over trusted host-supplied metadata: no Slack calls or cached membership.
 * Snapshots provide consistency, not isolation from hostile JavaScript inputs. */
export class SlackAccessPolicy {
  private readonly writeChannels: ReadonlySet<string>;
  private readonly dmUsers: ReadonlySet<string>;
  private readonly readJoinedChannels: boolean;

  constructor(config: SlackAccessPolicyConfig) {
    const parsed = parseAccessPolicy(config);
    this.writeChannels = new Set(parsed.writeChannels);
    this.dmUsers = new Set(parsed.dmUsers);
    this.readJoinedChannels = parsed.readJoinedChannels;
  }

  get dmsWritable(): boolean { return this.dmUsers.size > 0; }

  /** A synchronous configuration hint, never an authorization decision. */
  mayWrite(channelId: string): boolean {
    return (this.readJoinedChannels && this.writeChannels.has(channelId)) || (channelId.startsWith('D') && this.dmsWritable);
  }

  requireScope(scopes: readonly string[] | undefined, needed: string): void {
    scopes = Array.isArray(scopes) ? Array.from(scopes) : scopes;
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) throw new Error(`Slack scope metadata is unavailable or malformed; requires granted scope evidence for ${rejectedValue(needed)}; supply a string array of Slack-reported grants`);
    if (!scopes.includes(needed)) throw new Error(`Slack access requires granted scope ${rejectedValue(needed)}`);
  }

  requireDmUser(userId: string): void {
    if (!this.dmUsers.has(userId)) throw new Error(`Direct messages with ${rejectedValue(userId)} are not allowed by the Slack access policy dmUsers`);
  }

  /** The caller must supply fresh, exact metadata. Checks metadata read scope only;
   * callers must separately require the history scope before reading messages. Group DMs are unsupported. */
  requireReadable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined): 'channel' | 'private_channel' | 'dm' {
    if (!conversation) throw new Error(`Conversation ${rejectedValue(channelId)} has missing metadata`);
    conversation = Object.assign(Object.create(null), conversation) as AccessConversation;
    if (typeof channelId !== 'string' || typeof conversation.id !== 'string' || conversation.id !== channelId) throw new Error(`Conversation ${rejectedValue(channelId)} has mismatched identity metadata`);
    if (conversation.is_mpim === true) throw new Error('Group direct messages are unsupported in this version');
    if (conversation.is_im === true) {
      if ((conversation.is_mpim !== undefined && conversation.is_mpim !== false)
          || !DM_ID.test(channelId) || (typeof conversation.user !== 'string' || !USER_ID.test(conversation.user))) throw new Error(`Conversation ${rejectedValue(channelId)} has invalid DM metadata (expected D-prefixed id, U/W-prefixed user, is_im:true and is_mpim:false or absent)`);
      this.requireScope(scopes, 'im:read');
      this.requireDmUser(conversation.user);
      return 'dm';
    }
    if (conversation.is_im !== false || conversation.is_mpim !== false || typeof conversation.is_private !== 'boolean'
        || !CHANNEL_ID.test(channelId)) {
      throw new Error(`Conversation ${rejectedValue(channelId)} has invalid channel metadata (expected C/G-prefixed id, is_im:false, is_mpim:false and boolean is_private)`);
    }
    if (conversation.is_member !== true) throw new Error(`Conversation ${rejectedValue(channelId)} is not a confirmed joined channel`);
    if (!this.readJoinedChannels) throw new Error('Joined-channel reads are disabled by the Slack access policy readJoinedChannels');
    this.requireScope(scopes, conversation.is_private ? 'groups:read' : 'channels:read');
    return conversation.is_private ? 'private_channel' : 'channel';
  }

  requireWritable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined, writeScope: string): void {
    if (!['chat:write', 'files:write', 'reactions:write'].includes(writeScope)) throw new Error(`Unsupported Slack write scope ${rejectedValue(writeScope)}; expected chat:write, files:write or reactions:write`);
    scopes = Array.isArray(scopes) ? Array.from(scopes) : scopes;
    const kind = this.requireReadable(channelId, conversation, scopes);
    if (kind !== 'dm' && !this.writeChannels.has(channelId)) throw new Error(`Writing to ${rejectedValue(channelId)} is not allowed by the Slack access policy writeChannels`);
    this.requireScope(scopes, writeScope);
  }
}
