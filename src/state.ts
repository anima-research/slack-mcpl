/**
 * Checkpoint tracking for slack.messaging rollback.
 *
 * Tracks the messages and files sent by the bot. On rollback, attempts to
 * delete the ones the target checkpoint's state doesn't hold (best-effort).
 *
 * Checkpoints form a tree: each one's parent is the checkpoint current when it
 * was made, so a rollback starts a new branch from its target. An item
 * belongs to the first checkpoint made after it was sent, whose state is the
 * first to hold it. A checkpoint's state then holds the items that belong to
 * it or to a checkpoint before it on its branch, so a rollback can find them
 * whatever branch it comes from.
 */

import { randomUUID } from 'node:crypto';

export interface SentMessage {
  kind: 'message';
  /** Slack message ts. */
  messageId: string;
  channelId: string;
  content: string;
  timestamp: string;
  /** The first checkpoint made after it was sent; undefined until one is. */
  checkpoint?: string;
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
  /** The first checkpoint made after it was uploaded; undefined until one is. */
  checkpoint?: string;
}

type SentItem = SentMessage | UploadedFile;

export interface Checkpoint {
  id: string;
  parent: string | null;
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

  /** Forget a sent message deleted outside rollback, so no rollback deletes it
   *  again. An upload's sharing message stays with its file: a rollback that
   *  rolls the file back asks to delete the message too, and counts it
   *  deleted when Slack answers message_not_found. */
  forgetSent(channelId: string, messageId: string): void {
    this.sentItems = this.sentItems.filter((m) => m.kind !== 'message' || m.channelId !== channelId || m.messageId !== messageId);
  }

  /** Create a new checkpoint. Returns the checkpoint ID: a whole UUID, so no
   *  two checkpoints share one, which would close a loop in the tree, and one
   *  from an earlier process isn't taken for a checkpoint of this one. */
  createCheckpoint(): string {
    const id = `chk_${randomUUID()}`;
    this.checkpoints.set(id, { id, parent: this.currentCheckpoint });
    // The items no checkpoint covers yet are always the last ones recorded:
    // recordSent and recordUploaded append, a rollback keeps only covered
    // ones, and forgetSent keeps the order. So the walk stops at the first
    // covered one.
    for (let i = this.sentItems.length - 1; i >= 0 && this.sentItems[i].checkpoint === undefined; i--) {
      this.sentItems[i].checkpoint = id;
    }
    this.currentCheckpoint = id;
    return id;
  }

  /** Get the current checkpoint ID. */
  get current(): string | null {
    return this.currentCheckpoint;
  }

  /**
   * Roll back to a checkpoint. Returns the items that should be deleted:
   * those its state doesn't hold, whichever branch they were sent on. Its
   * branch's own items that an earlier rollback deleted don't come back.
   */
  rollback(checkpointId: string): SentItem[] | null {
    if (!this.checkpoints.has(checkpointId)) return null;

    const lineage = new Set<string>();
    for (let at: string | null = checkpointId; at !== null; at = this.checkpoints.get(at)!.parent) lineage.add(at);
    const held = (m: SentItem) => m.checkpoint !== undefined && lineage.has(m.checkpoint);

    const toDelete = this.sentItems.filter((m) => !held(m));
    this.sentItems = this.sentItems.filter(held);
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
