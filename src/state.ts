/**
 * Checkpoint tracking for slack.messaging rollback.
 *
 * Tracks messages sent by the bot. On rollback, attempts to
 * delete messages sent after the target checkpoint (best-effort).
 */

import { randomUUID } from 'node:crypto';

export interface SentMessage {
  /** Slack message ts. */
  messageId: string;
  channelId: string;
  content: string;
  timestamp: string;
}

export interface Checkpoint {
  id: string;
  parent: string | null;
  /** Index into the sent messages array — everything at this index and after was sent post-checkpoint. */
  sentCount: number;
}

export class StateTracker {
  private sentMessages: SentMessage[] = [];
  private checkpoints: Map<string, Checkpoint> = new Map();
  private currentCheckpoint: string | null = null;

  /** Record a message we sent (so we can undo it on rollback). */
  recordSent(messageId: string, channelId: string, content: string): void {
    this.sentMessages.push({
      messageId,
      channelId,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  /** Create a new checkpoint. Returns the checkpoint ID. */
  createCheckpoint(): string {
    const id = `chk_${randomUUID().slice(0, 8)}`;
    this.checkpoints.set(id, {
      id,
      parent: this.currentCheckpoint,
      sentCount: this.sentMessages.length,
    });
    this.currentCheckpoint = id;
    return id;
  }

  /** Get the current checkpoint ID. */
  get current(): string | null {
    return this.currentCheckpoint;
  }

  /**
   * Roll back to a checkpoint. Returns messages that should be deleted
   * (sent after the checkpoint).
   */
  rollback(checkpointId: string): SentMessage[] | null {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return null;

    // Get messages sent after this checkpoint
    const toDelete = this.sentMessages.slice(checkpoint.sentCount);

    // Create a new branch — don't delete old checkpoints, just branch from here
    this.sentMessages = this.sentMessages.slice(0, checkpoint.sentCount);
    this.currentCheckpoint = checkpointId;

    return toDelete;
  }

  /** Get the last checkpoint state (for returning to host in tool responses). */
  getCheckpointState(): { checkpoint: string; parent: string | null } | null {
    if (!this.currentCheckpoint) return null;
    const cp = this.checkpoints.get(this.currentCheckpoint);
    if (!cp) return null;
    return { checkpoint: cp.id, parent: cp.parent };
  }
}
