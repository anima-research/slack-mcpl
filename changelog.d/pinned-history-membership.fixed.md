- Opt-in `historyMembershipFallbackChannels` lets explicit-policy public write
  pins use fresh bot history admission without `channels:read`. Operators must
  attest public visibility; history success and C IDs do not prove it. Private
  and DM IDs are excluded, as is overlap with group-DM policy. Unset is unchanged.

- Terminal stale pins no longer hide other conversations. Transient/deadline
  errors, bounded background retries, pagination limits and partial history
  results keep their existing semantics; proof requests are not data pages.

- Normal metadata admission takes precedence when `channels:read` is learned
  during a proof or listing restart. Failed history admission reports that
  nothing was posted, rather than an uncertain write outcome.
