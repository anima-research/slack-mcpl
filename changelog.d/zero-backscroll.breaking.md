- **Operators:** `SLACK_BACKSCROLL_LIMIT=0`, or a value whose leading base-10
  integer is 0 (such as `0junk` or `0.5`), now disables automatic backscroll
  instead of falling back to 50 messages. To keep the previous automatic
  history read, unset the variable or set it to 50. Non-zero parsed limits,
  the default of 50, and explicit `fetch_history` / `fetch_thread` reads are
  unchanged.
