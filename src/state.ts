/**
 * Checkpoint tracking for slack.messaging rollback.
 *
 * Tracks messages sent by the bot. On rollback, attempts to delete the
 * messages the target checkpoint's state doesn't hold (best-effort).
 *
 * Checkpoints form a tree: each one's parent is the checkpoint current when it
 * was made, so a rollback starts a new branch from its target. A message
 * belongs to the first checkpoint made after it was sent, whose state is the
 * first to hold it. A checkpoint's state then holds the messages that belong
 * to it or to a checkpoint before it on its branch, so a rollback can find
 * them whatever branch it comes from.
 */

import { randomUUID } from 'node:crypto';

export interface SentMessage {
  /** Slack message ts. */
  messageId: string;
  channelId: string;
  content: string;
  timestamp: string;
  /** The first checkpoint made after it was sent; undefined until one is. */
  checkpoint?: string;
}

export interface Checkpoint {
  id: string;
  parent: string | null;
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

  /** Forget a message deleted outside rollback, so no rollback deletes it
   *  again. */
  forgetSent(channelId: string, messageId: string): void {
    this.sentMessages = this.sentMessages.filter((m) => m.channelId !== channelId || m.messageId !== messageId);
  }

  /** Create a new checkpoint. Returns the checkpoint ID: a whole UUID, so no
   *  two checkpoints share one, which would close a loop in the tree, and one
   *  from an earlier process isn't taken for a checkpoint of this one. */
  createCheckpoint(): string {
    const id = `chk_${randomUUID()}`;
    this.checkpoints.set(id, { id, parent: this.currentCheckpoint });
    // The messages no checkpoint covers yet are always the last ones
    // recorded: recordSent appends, a rollback keeps only covered ones, and
    // forgetSent keeps the order. So the walk stops at the first covered one.
    for (let i = this.sentMessages.length - 1; i >= 0 && this.sentMessages[i].checkpoint === undefined; i--) {
      this.sentMessages[i].checkpoint = id;
    }
    this.currentCheckpoint = id;
    return id;
  }

  /** Get the current checkpoint ID. */
  get current(): string | null {
    return this.currentCheckpoint;
  }

  /**
   * Roll back to a checkpoint. Returns the messages that should be deleted:
   * those its state doesn't hold, whichever branch they were sent on. Its
   * branch's own messages that an earlier rollback deleted don't come back.
   */
  rollback(checkpointId: string): SentMessage[] | null {
    if (!this.checkpoints.has(checkpointId)) return null;

    const lineage = new Set<string>();
    for (let at: string | null = checkpointId; at !== null; at = this.checkpoints.get(at)!.parent) lineage.add(at);
    const held = (m: SentMessage) => m.checkpoint !== undefined && lineage.has(m.checkpoint);

    const toDelete = this.sentMessages.filter((m) => !held(m));
    this.sentMessages = this.sentMessages.filter(held);
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
