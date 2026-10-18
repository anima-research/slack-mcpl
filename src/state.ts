/**
 * Checkpoint tracking for slack.messaging rollback.
 *
 * Tracks messages and files sent by the bot. On rollback, attempts to
 * delete items sent after the target checkpoint (best-effort).
 */

import { randomUUID } from 'node:crypto';

export interface SentMessage {
  kind: 'message';
  /** Slack message ts. */
  messageId: string;
  channelId: string;
  content: string;
  timestamp: string;
}

export interface UploadedFile {
  kind: 'file';
  fileId: string;
  channelId: string;
  /** The message that shared the file, when Slack's answer named it: it holds
   *  the upload's comment. */
  shareTs?: string;
  /** Whether a comment may have gone out with the file: the upload had one,
   *  and Slack may have shared the file. */
  comment: boolean;
  timestamp: string;
}

type SentItem = SentMessage | UploadedFile;

export interface Checkpoint {
  id: string;
  parent: string | null;
  /** Index into the sent items array — everything at this index and after was sent post-checkpoint. */
  sentCount: number;
}

export class StateTracker {
  private sentItems: SentItem[] = [];
  private checkpoints: Map<string, Checkpoint> = new Map();
  private currentCheckpoint: string | null = null;

  /** Record a message we sent (so we can undo it on rollback). */
  recordSent(messageId: string, channelId: string, content: string): void {
    this.sentItems.push({
      kind: 'message',
      messageId,
      channelId,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  /** Track the Slack file itself, which files.delete removes, and the message
   *  that shared it, when known, which chat.delete removes. */
  recordUploaded(fileId: string, channelId: string, share: { shareTs?: string; comment: boolean }): void {
    this.sentItems.push({
      kind: 'file',
      fileId,
      channelId,
      ...(share.shareTs ? { shareTs: share.shareTs } : {}),
      comment: share.comment,
      timestamp: new Date().toISOString(),
    });
  }

  /** Create a new checkpoint. Returns the checkpoint ID. */
  createCheckpoint(): string {
    const id = `chk_${randomUUID().slice(0, 8)}`;
    this.checkpoints.set(id, {
      id,
      parent: this.currentCheckpoint,
      sentCount: this.sentItems.length,
    });
    this.currentCheckpoint = id;
    return id;
  }

  /** Get the current checkpoint ID. */
  get current(): string | null {
    return this.currentCheckpoint;
  }

  /**
   * Roll back to a checkpoint. Returns items that should be deleted
   * (sent after the checkpoint).
   */
  rollback(checkpointId: string): SentItem[] | null {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return null;

    // Get items sent after this checkpoint
    const toDelete = this.sentItems.slice(checkpoint.sentCount);

    // Create a new branch — don't delete old checkpoints, just branch from here
    this.sentItems = this.sentItems.slice(0, checkpoint.sentCount);
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
