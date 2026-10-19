- Two messages arriving close together in one conversation could reach the
  host in the wrong order: each was handled on its own, and the lookup of the
  author's and mentions' names before delivery takes different times. The
  earlier message could then reach the host last, and a `channels/publish`
  without a `threadId`, which follows the last message the host took, followed
  it rather than the later one. Events are now handled one at a time per
  conversation, in arrival order; conversations stay independent.
