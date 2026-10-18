- Two messages arriving close together in one conversation could reach the
  host in the wrong order: each was handled on its own, and the lookup of the
  author's and mentions' names before delivery takes different times, so a
  later message could be delivered, and become the reply target, before an
  earlier one. Events are now handled one at a time per conversation, in
  arrival order; conversations stay independent.
