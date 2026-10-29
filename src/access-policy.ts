/** Internal preparation only: no connector setting installs this policy yet. */
export interface SlackAccessPolicyConfig {
  readonly readJoinedChannels: boolean;
  readonly writeChannels: readonly string[];
  readonly dmUsers: readonly string[];
  /** Exact joined group-DM IDs. Writes also need a writeChannels pin. */
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
const idList = (value: unknown, pattern: RegExp): value is string[] =>
  Array.isArray(value) && Array.from(value).every((id) => typeof id === 'string' && pattern.test(id));

const REQUIRED_KEYS = new Set<string | symbol>(['readJoinedChannels', 'writeChannels', 'dmUsers']);
const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, 'groupDms']);

/** One strict, unversioned format for future embedded and JSON callers.
 * Snapshot before validating so accessors cannot change the values we retain. */
export function parseAccessPolicy(value: unknown): SlackAccessPolicyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Slack access policy');
  const config = value as Record<string, unknown>;
  const keys = new Set(Reflect.ownKeys(config));
  if ([...REQUIRED_KEYS].some((key) => !keys.has(key))
      || [...keys].some((key) => !ALLOWED_KEYS.has(key))) throw new Error('Invalid Slack access policy');
  const { readJoinedChannels, writeChannels, dmUsers, groupDms } = config;
  const channels = Array.isArray(writeChannels) ? Array.from(writeChannels) : writeChannels;
  const users = Array.isArray(dmUsers) ? Array.from(dmUsers) : dmUsers;
  const groups = Array.isArray(groupDms) ? Array.from(groupDms) : groupDms;
  if (typeof readJoinedChannels !== 'boolean' || !idList(channels, CHANNEL_ID)
      || !idList(users, USER_ID) || (keys.has('groupDms') && !idList(groups, GROUP_DM_ID))) throw new Error('Invalid Slack access policy');
  return Object.freeze({ readJoinedChannels, writeChannels: Object.freeze(channels), dmUsers: Object.freeze(users),
    ...(keys.has('groupDms') ? { groupDms: Object.freeze(groups as string[]) } : {}) });
}

/** Pure decisions over supplied metadata: no Slack calls or cached membership.
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

  get groupDmsReadable(): boolean { return this.groupDms.size > 0; }

  get dmsWritable(): boolean { return this.dmUsers.size > 0; }

  /** A synchronous configuration hint, never an authorization decision. */
  mayWrite(channelId: string): boolean {
    return this.writeChannels.has(channelId) || (channelId.startsWith('D') && this.dmsWritable);
  }

  requireScope(scopes: readonly string[] | undefined, needed: string): void {
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string') || !scopes.includes(needed)) throw new Error(`Slack access requires granted scope ${needed}`);
  }

  requireDmUser(userId: string): void {
    if (!this.dmUsers.has(userId)) throw new Error(`Direct messages with ${userId} are not allowed by the Slack access policy`);
  }

  /** The caller must supply fresh, exact metadata, including group membership. */
  requireReadable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined): 'channel' | 'private_channel' | 'dm' | 'group_dm' {
    if (conversation?.id === channelId && conversation.is_mpim === true
        && (conversation.is_im === undefined || conversation.is_im === false)
        && GROUP_DM_ID.test(channelId) && this.groupDms.has(channelId) && conversation.is_member === true) {
      this.requireScope(scopes, 'mpim:read');
      return 'group_dm';
    }
    if (!conversation || conversation.id !== channelId || conversation.is_mpim === true) {
      throw new Error(`Conversation ${channelId} has missing or unsupported membership metadata`);
    }
    if (conversation.is_im === true) {
      if ((conversation.is_mpim !== undefined && conversation.is_mpim !== false)
          || !DM_ID.test(channelId) || typeof conversation.user !== 'string') throw new Error(`Conversation ${channelId} has invalid DM metadata`);
      this.requireScope(scopes, 'im:read');
      this.requireDmUser(conversation.user);
      return 'dm';
    }
    if (conversation.is_im !== false || conversation.is_mpim !== false || typeof conversation.is_private !== 'boolean'
        || !CHANNEL_ID.test(channelId) || conversation.is_member !== true || !this.readJoinedChannels) {
      throw new Error(`Conversation ${channelId} is not a confirmed joined channel`);
    }
    this.requireScope(scopes, conversation.is_private ? 'groups:read' : 'channels:read');
    return conversation.is_private ? 'private_channel' : 'channel';
  }

  requireWritable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined, writeScope: string): void {
    const kind = this.requireReadable(channelId, conversation, scopes);
    if (kind !== 'dm' && !this.writeChannels.has(channelId)) throw new Error(`Writing to ${channelId} is not allowed by the Slack access policy`);
    if (kind === 'group_dm') this.requireScope(scopes, 'mpim:write');
    this.requireScope(scopes, writeScope);
  }
}
