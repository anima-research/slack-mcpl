/**
 * Feature Set Declarations — MCPL 0.5 (SPEC §5.1, §6.1, §6.2).
 *
 * Declares this server's feature sets and builds the manifest
 * (`experimental.mcpl`) presented at `initialize`.
 *
 *   slack.messaging     — real-time delivery + channel management
 *   slack.history       — reading back through conversations (tools)
 *   slack.subscriptions — ambient-message subscription management (tools)
 *
 * `uses` is a closed vocabulary in 0.5 (§6.2) and derivation is fail-closed
 * (§6.4): an inaccurate declaration disables the feature set. Every path below
 * is justified by a call site, not by aspiration:
 *
 *   channels.register  — registerSlackChannels sends channels/register;
 *                        registerAndNotifyNew sends channels/changed
 *   channels.lifecycle — server.ts handles channels/open and channels/close
 *   channels.publish   — server.ts handles channels/publish
 *   channels.incoming  — handleSlackMessage sends channels/incoming for open channels
 *   channels.streaming — server.ts buffers channels/outgoing/chunk and finalizes
 *                        on channels/outgoing/complete
 *   pushEvents         — handleSlackMessage sends push/event for addressed
 *                        messages on channels the host has not opened
 *   tools              — the MCP tool surface of this server
 *
 * Deliberately NOT declared: channels.acknowledge (no handler for
 * channels/acknowledge), channels.typing (the adapter has no typing
 * indicator — Slack's Web API exposes none for bots).
 */

import type { CapabilityPath, FeatureSetDeclaration, McplManifest, TagOntology } from '@animalabs/mcpl-core';

export const MESSAGING_FEATURE_SET = 'slack.messaging';
export const HISTORY_FEATURE_SET = 'slack.history';
export const SUBSCRIPTIONS_FEATURE_SET = 'slack.subscriptions';

/** MCPL RFC-001 — tags carried on Slack message events (emits umbrellas
 *  directly, so no host-side implication expansion is needed). */
export const SLACK_TAG_ONTOLOGY: TagOntology = {
  coreTags: [
    'chat:addressed', 'chat:mention', 'chat:dm', 'chat:ambient',
    'chat:private', 'chat:from-human', 'chat:thread',
    'chat:has-image', 'chat:has-file',
  ],
  defaultTreatment: [
    { tagsAny: ['chat:addressed'], behavior: 'immediate' },
    { tagsAny: ['chat:ambient'], behavior: { throttle: { perMs: 120000 } } },
  ],
  // Slack-specific extensions (e.g. slack:broadcast) may be emitted in
  // future; consumers should tolerate undeclared tags.
  open: true,
};

export function buildFeatureSets(): Record<string, FeatureSetDeclaration> {
  const messagingUses: CapabilityPath[] = [
    'tools',
    'channels.register',
    'channels.lifecycle',
    'channels.publish',
    'channels.incoming',
    'channels.streaming',
    'pushEvents',
  ];

  return {
    [MESSAGING_FEATURE_SET]: {
      description: 'Send, read, react to messages in Slack conversations',
      uses: messagingUses,
      // §8.1: what this server sent since a checkpoint can be undone
      // (state/rollback deletes the bot's own messages).
      rollback: true,
      tagOntology: SLACK_TAG_ONTOLOGY,
    },
    [HISTORY_FEATURE_SET]: {
      description: 'Fetch message and thread history from Slack conversations',
      uses: ['tools'],
    },
    [SUBSCRIPTIONS_FEATURE_SET]: {
      description:
        'Manage per-conversation ambient-message subscriptions (which conversations ' +
        'deliver non-mention messages for passive awareness). Mentions and DMs are ' +
        'always delivered and are not affected by subscriptions.',
      uses: ['tools'],
    },
  };
}

export function buildServerCapabilities(): McplManifest {
  return {
    version: '0.5',
    pushEvents: true,
    channels: {
      register: true,
      lifecycle: true,
      publish: true,
      incoming: true,
      streaming: true,
    },
    featureSets: buildFeatureSets(),
  };
}

/** Get the feature set that owns a given tool. Returns undefined for always-available tools. */
export function featureSetForTool(toolName: string): string | undefined {
  switch (toolName) {
    case 'send_message':
    case 'reply_message':
    case 'send_dm':
    case 'add_reaction':
    case 'edit_message':
    case 'delete_message':
      return MESSAGING_FEATURE_SET;
    case 'fetch_history':
    case 'fetch_thread':
    case 'fetch_attachment':
      return HISTORY_FEATURE_SET;
    case 'subscribe_channel':
    case 'unsubscribe_channel':
    case 'list_subscriptions':
      return SUBSCRIPTIONS_FEATURE_SET;
    case 'list_channels':
    case 'refresh_channels':
    case 'find_user':
      return undefined; // Always available
    default:
      return undefined;
  }
}
