- Two messages arriving close together in one conversation could reach the
  host in the wrong order: each was handled on its own, and the lookup of the
  author's and mentions' names before delivery takes different times. The
  earlier message could then reach the host last, and a `channels/publish`
  without a `threadId`, which follows the last message the host took, followed
  it rather than the later one. Each message's lookups still start as it
  arrives, and it is now delivered after the messages that arrived before it
  in its conversation; conversations stay independent.
- README said a publish without a `threadId` follows the last message passed
  to the host whether or not the host accepted it. It follows the last one the
  host took, and the README now says so.
