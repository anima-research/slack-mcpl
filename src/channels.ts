/**
 * MCPL channel management — maps Slack conversations to MCPL ChannelDescriptors.
 */

import type { ChannelCapabilities, ChannelDescriptor } from '@animalabs/mcpl-core';
import type { SlackConversationInfo } from './slack-adapter.js';

/**
 * Where a channels/publish lands (MCPL RFC-011 `capabilities.publish`).
 * Every Slack conversation can hold threads, and this server posts exactly
 * where a publish carrying `threadId` asks — that thread, or top level for
 * `null` — or refuses it with nothing posted (see publishTargeted). An error
 * after the post was sent (a lost connection, Slack's internal_error or
 * fatal_error) is RFC-011's third outcome, unconfirmed. Local until
 * @animalabs/mcpl-core ships the RFC-011 types.
 */
export type SlackChannelDescriptor = ChannelDescriptor & {
  capabilities?: ChannelCapabilities & { publish?: { target: 'exact' } };
};
export const PUBLISH_TARGET = { target: 'exact' } as const;

/** MCPL channel ID format: slack:<conversationId>. Slack conversation IDs are
 *  workspace-unique and immutable, so no second component is needed. */
export function mcplChannelId(conversationId: string): string {
  return `slack:${conversationId}`;
}

/** Parse an MCPL channel ID back to a conversation ID. Returns null if not a slack channel. */
export function parseMcplChannelId(id: string): { conversationId: string } | null {
  if (!id.startsWith('slack:')) return null;
  const conversationId = id.slice('slack:'.length);
  if (!conversationId) return null;
  return { conversationId };
}

/** Convert a Slack conversation to an MCPL ChannelDescriptor. */
export function toDescriptor(conv: SlackConversationInfo, teamName: string, writable = true): SlackChannelDescriptor {
  const label =
    conv.kind === 'dm' ? `DM: @${conv.name} (${teamName})` :
    conv.kind === 'group_dm' ? `Group DM: ${conv.name} (${teamName})` :
    `#${conv.name} (${teamName})`;
  return {
    id: mcplChannelId(conv.id),
    type: 'slack',
    label,
    // A conversation the bot may not write to is inbound only.
    direction: writable ? 'bidirectional' : 'inbound',
    address: { channelId: conv.id, ...(conv.userId ? { userId: conv.userId } : {}) },
    metadata: {
      kind: conv.kind,
      ...(conv.topic ? { topic: conv.topic } : {}),
      isMember: conv.isMember,
      ...(conv.numMembers !== undefined ? { numMembers: conv.numMembers } : {}),
    },
    capabilities: { publish: PUBLISH_TARGET },
  };
}

/**
 * Tracks which channels are registered (known to host) and which are open
 * (host has explicitly opened them for bidirectional message flow).
 */
export class ChannelManager {
  /** All registered channel descriptors, keyed by MCPL channel ID. */
  private registered = new Map<string, ChannelDescriptor>();

  /** Set of open channel IDs (subset of registered). */
  private openChannels = new Set<string>();

  registerAll(descriptors: ChannelDescriptor[]): void {
    for (const d of descriptors) {
      this.registered.set(d.id, d);
    }
  }

  register(descriptor: ChannelDescriptor): void {
    this.registered.set(descriptor.id, descriptor);
  }

  unregister(id: string): boolean {
    this.openChannels.delete(id);
    return this.registered.delete(id);
  }

  open(id: string): ChannelDescriptor | undefined {
    const desc = this.registered.get(id);
    if (desc) {
      this.openChannels.add(id);
    }
    return desc;
  }

  /** Open a channel by Slack conversation ID. Returns the descriptor if found. */
  openByConversationId(conversationId: string): ChannelDescriptor | undefined {
    return this.open(mcplChannelId(conversationId));
  }

  close(id: string): boolean {
    return this.openChannels.delete(id);
  }

  isOpen(id: string): boolean {
    return this.openChannels.has(id);
  }

  get(id: string): ChannelDescriptor | undefined {
    return this.registered.get(id);
  }

  getAll(): ChannelDescriptor[] {
    return [...this.registered.values()];
  }

  getOpen(): ChannelDescriptor[] {
    return [...this.openChannels]
      .map((id) => this.registered.get(id))
      .filter((d): d is ChannelDescriptor => d !== undefined);
  }
}
