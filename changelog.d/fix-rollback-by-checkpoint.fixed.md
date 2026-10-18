- A rollback to a checkpoint on a branch an earlier rollback left could
  delete only part of what was sent after that checkpoint, or nothing, and
  still answer success. Checkpoints were indexes into one list of sent
  messages, which a rollback cut short. Now each sent message belongs to the
  first checkpoint made after it, and a rollback deletes the messages its
  checkpoint's state doesn't hold, whichever branch they were sent on. A
  message `delete_message` removed, or Slack says is already gone, is no
  longer tried again by a later rollback, and a rollback's delete that Slack
  answers `message_not_found` counts as done. Checkpoint IDs are whole UUIDs,
  so no two checkpoints share one.
