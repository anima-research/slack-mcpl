/**
 * MCP tool definitions and input types for Slack operations.
 * These tools work in both MCP and MCPL mode.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description:
      'Send a message to a Slack conversation (channel, private channel, DM, or group DM). ' +
      'Supports Slack mrkdwn; use <@USER_ID> for mentions (find_user resolves names to IDs).',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID (C… channel, G… private/group, D… DM)' },
        content: { type: 'string', description: 'Message text (Slack mrkdwn)' },
      },
      required: ['channelId', 'content'],
    },
  },
  {
    name: 'reply_message',
    description:
      'Reply in a thread of a Slack conversation. Incoming messages show `thread=` when they ' +
      'are already in a thread and `id=` always. Pass the `thread=` value if the message you ' +
      'answer shows one; otherwise pass its `id=`, which starts a thread under it.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        messageId: { type: 'string', description: 'Thread ID (ts): the message\'s `thread=` if it has one, else its `id=`' },
        content: { type: 'string', description: 'Reply text (Slack mrkdwn)' },
      },
      required: ['channelId', 'messageId', 'content'],
    },
  },
  {
    name: 'send_dm',
    description: 'Send a direct message to a Slack user (opens the DM conversation if needed)',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Slack user ID (U…)' },
        content: { type: 'string', description: 'Message text (Slack mrkdwn)' },
      },
      required: ['userId', 'content'],
    },
  },
  {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a Slack message',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        messageId: { type: 'string', description: 'Message ID (ts) to react to' },
        emoji: { type: 'string', description: 'Emoji name, with or without colons (e.g. thumbsup or :thumbsup:)' },
      },
      required: ['channelId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        messageId: { type: 'string', description: 'Message ID (ts) to edit' },
        content: { type: 'string', description: 'New message text' },
      },
      required: ['channelId', 'messageId', 'content'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        messageId: { type: 'string', description: 'Message ID (ts) to delete' },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'list_channels',
    description:
      'List Slack conversations: channels the bot is a member of, private channels, DMs, ' +
      'and group DMs. Set includeNonMember to also list public channels the bot has not joined ' +
      '(it cannot receive events from or post to those without being invited).',
    inputSchema: {
      type: 'object',
      properties: {
        includeNonMember: {
          type: 'boolean',
          description: 'Also include public channels the bot is not a member of (default false)',
        },
      },
    },
  },
  {
    name: 'refresh_channels',
    description:
      'Re-scan every Slack conversation the bot can currently see and register any that the ' +
      'host does not yet know about. Use this if the bot was invited to a new channel after ' +
      'startup and it is not showing up in your channel list.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'fetch_history',
    description:
      'Fetch message history from a Slack conversation, oldest-first. Covers channel-level ' +
      'messages only — replies inside threads are not returned (use fetch_thread for those), ' +
      'so an active thread can look quiet here. Use `oldest`/`latest` (message IDs / ts values) ' +
      'to bound the range; pagination is automatic.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        limit: { type: 'number', description: 'Max messages to fetch (default 50)' },
        oldest: {
          type: 'string',
          description: 'Only fetch messages newer than this ts (exclusive). Use the newest ID you already have.',
        },
        latest: {
          type: 'string',
          description: 'Only fetch messages older than this ts (exclusive). Use the oldest ID you already have to page back.',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'fetch_thread',
    description:
      'Fetch all replies in a Slack thread, oldest-first (the parent message comes first). ' +
      'Use the thread\'s parent message ID — incoming thread replies carry it as threadId.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        threadTs: { type: 'string', description: 'Parent message ID (ts) of the thread' },
        limit: { type: 'number', description: 'Max messages to fetch (default 100)' },
      },
      required: ['channelId', 'threadTs'],
    },
  },
  {
    name: 'find_user',
    description:
      'Find Slack users by name (username, real name, or display name substring). Returns ' +
      'user IDs for mentions and DMs — use <@USER_ID> in message text to mention.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment to search for (case-insensitive)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_attachment',
    description:
      'Fetch a Slack file attachment by URL and return its bytes inline: images as image ' +
      'blocks, text-ish files decoded, other binary as base64. URLs come from incoming ' +
      'message attachment refs (url_private, fetched with bot auth). Max 5MB.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full url_private of the Slack file (https://files.slack.com/…)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'subscribe_channel',
    description:
      'Subscribe to ambient (non-mention) messages from a Slack conversation. ' +
      'Direct mentions and DMs always come through regardless of subscriptions; ' +
      'this only controls passive awareness of channel chatter. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID to subscribe to' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'unsubscribe_channel',
    description:
      'Stop receiving ambient messages from a Slack conversation. Mentions and DMs ' +
      'from there will still arrive. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID to unsubscribe from' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'list_subscriptions',
    description: 'List the Slack conversations currently subscribed for ambient message delivery',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
