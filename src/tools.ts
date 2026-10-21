/**
 * MCP tool definitions and input types for Slack operations.
 * These tools work in both MCP and MCPL mode.
 */
import { mebibytes, type PathUploadPolicy } from './upload-path.js';
import {AUTHOR_ID, PARENT_IDS, READ_LIMITS} from './history-read.js';

const readProperties = {
  maxScanned: {type: 'integer', ...READ_LIMITS.maxScanned, description: 'Candidate messages scanned per call, independently of returned matches'},
  maxBytes: {type: 'integer', ...READ_LIMITS.maxBytes, description: 'Maximum UTF-8 bytes of the complete result JSON. A message that does not fit beside the ones before it is left for the next call'},
  oldest: {type: 'string', description: 'Exclusive lower Slack timestamp bound'},
  latest: {type: 'string', description: 'Exclusive upper Slack timestamp bound'},
  cursor: {type: 'string', description: 'pagination.nextCursor from an earlier call, with the same channel, thread, time bounds and filters'},
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** MCP `_meta`. `tools/list` adds `mcpl/class` from src/tool-classes.ts. */
  _meta?: Record<string, unknown>;
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
      'answer shows one; otherwise pass its `id=`, which starts a thread under it. In ' +
      'fetch_history and fetch_thread results, pass its `rootTs`, which names the thread it\'s in, or the message itself.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        messageId: { type: 'string', description: 'Thread ID (ts): the message\'s `thread=` if it has one, else its `id=`; in fetch_history and fetch_thread results, its `rootTs`' },
        content: { type: 'string', description: 'Reply text (Slack mrkdwn)' },
      },
      required: ['channelId', 'messageId', 'content'],
    },
  },
  {
    name: 'upload_file',
    description:
      'Upload a file to a Slack conversation, optionally into a thread and with a message. ' +
      'Pass the file as text (content) or as base64 (contentBase64), not both: at most 5 MiB of file bytes, ' +
      'after base64 is decoded or text is encoded as UTF-8. ' +
      'Same write rules as send_message.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack conversation ID' },
        filename: { type: 'string', description: 'File name shown in Slack, with extension (e.g. positions.csv)' },
        content: { type: 'string', description: 'File contents as text' },
        contentBase64: { type: 'string', description: 'File contents as canonical RFC 4648 base64 with required padding, for binary files; no whitespace or data URI prefix' },
        messageId: { type: 'string', description: 'Thread to upload into: the message\'s `thread=` if it has one, else its `id=`; in fetch_history and fetch_thread results, its `rootTs`' },
        comment: { type: 'string', description: 'Message posted with the file (Slack mrkdwn)' },
        title: { type: 'string', description: 'Title shown above the file; defaults to the file name' },
      },
      required: ['channelId', 'filename'],
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
      'List Slack conversations: channels the bot is a member of, private channels, and, unless this host ' +
      "has turned direct messages off, DMs and group DMs: each kind the bot's token has the read scope for. An " +
      "answer that leaves out a kind the token can't read says which, beside the list. Set includeNonMember to " +
      'also list public channels the bot has not ' +
      'joined (it cannot receive events from or post to those without being invited).',
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
      'Re-scan the Slack conversations the bot is in and register any that the host does not ' +
      'yet know about. Use this if the bot was invited to a new channel after startup and it ' +
      'is not showing up in your channel list.',
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
      'to bound the range. Substring and exact author-ID predicates are ANDed. Check pagination.scanComplete ' +
      'and stopReason: zero bounded matches does not prove absence. To go on to older messages, call again with ' +
      'the same arguments and cursor set to pagination.nextCursor.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...readProperties,
        channelId: { type: 'string', description: 'Slack conversation ID' },
        limit: { type: 'integer', ...READ_LIMITS.limit, default: 50, description: 'Maximum matching messages returned per call' },
        textContains: {type: 'string', minLength: 1, maxLength: 256, description: "Literal substring of a message's content as returned, except that a mentioned user appears only by their user ID, as @U… (uid:U…), not by name; case-insensitive by default; no regex"},
        caseSensitive: {type: 'boolean', default: false, description: 'Use exact case for textContains; otherwise JavaScript Unicode toLowerCase, without normalization'},
        authorIds: {type: 'array', minItems: 1, maxItems: 50, items: {type: 'string', pattern: AUTHOR_ID.source}, description: "Match any exact author ID, a message's authorId or authorBotId, AND textContains; missing authors do not match"},
      },
      required: ['channelId'],
    },
  },
  {
    name: 'fetch_thread',
    description:
      'Fetch a bounded part of one Slack thread, oldest-first (parent first on a call without oldest or cursor). ' +
      `${PARENT_IDS}. Check pagination.scanComplete and stopReason. To go on to newer replies, call again with the ` +
      'same arguments and cursor set to pagination.nextCursor.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...readProperties,
        channelId: { type: 'string', description: 'Slack conversation ID' },
        threadTs: { type: 'string', description: 'Parent message ID (ts) of the thread' },
        limit: { type: 'integer', ...READ_LIMITS.limit, default: 100, description: 'Maximum messages returned, including the parent when present' },
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
    description:
      'List the Slack conversations subscribed for ambient message delivery. When every member ' +
      'conversation is subscribed (member mode), lists the muted ones instead.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/** Inline-only remains the default; path capability is operator configuration. */
export function toolDefinitionsForPathUploads(policy?: PathUploadPolicy): ToolDefinition[] {
  if (!policy) return toolDefinitions;
  const boundary = policy.mode === 'restricted'
    ? 'Only configured directories on the connector filesystem are admitted; symlinks below roots are refused.'
    : 'The operator explicitly permits any regular file readable by the connector account; symlinks are allowed.';
  return toolDefinitions.map(tool => tool.name !== 'upload_file' ? tool : {
    ...tool,
    description:
      'Upload a file to a Slack conversation, optionally into a thread and with a message. ' +
      'Pass exactly one of path (a file on this server\'s filesystem), content (text) or contentBase64 (base64). ' +
      'Inline content is capped at 5 MiB of file bytes, after base64 is decoded or text is encoded as UTF-8; ' +
      `path files up to ${mebibytes(policy.maxBytes)} (${policy.maxBytes} bytes), the operator's limit. ` +
      'Same write rules as send_message. ' + boundary,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        path: {type: 'string', description: 'Absolute regular-file path on the connector filesystem/account, not necessarily the agent host. ' + boundary},
        filename: {type: 'string', description: 'Slack filename; required for inline data, defaults to basename for path uploads'},
      },
      required: ['channelId'],
    },
  });
}
