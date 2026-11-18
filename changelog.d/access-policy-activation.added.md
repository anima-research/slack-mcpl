- **Operators:** opt in with `SLACK_ACCESS_POLICY`, a complete JSON policy
  naming joined-channel reads, channel write destinations, DM peers and optional
  group DMs. Invalid/incomplete values stop startup, never revert to legacy.
  Explicit policy intersects `SLACK_DISABLE_DMS`, `SLACK_DM_USERS` and
  `SLACK_SEND_CHANNELS`, retaining and validating these restrictions. See
  `docs/access-policy-migration.md`. `find_user` remains workspace-wide with
  `users:read`, outside conversation confinement. Policy file rollback deletion
  needs `files:read`. Policy background admission allows five attempts per
  candidate, with independent retry counters. Exhausted ordinary candidates or
  retired queue slots are skipped and counted in an incomplete-registration diagnostic; healthy candidates continue. Local vetoes avoid
  unnecessary metadata calls; unsubscribed ambient events are filtered before
  admission, while mentions and DM IDs still require fresh verification. Events retry transient admission failures with
  three attempts and ten seconds of requested retry backoff (including positive jitter),
  excluding admission queues, Slack calls and host delivery;
  concurrent events share only in-flight admission. Timed diagnostics distinguish
  policy denials, transient drops and unexpected verification errors. Existing pinned group-DM effects require
  their operation scope, not mpim:write. Policy file access uses fresh sharing
  evidence and ID references, refuses external files and redirects, and
  rechecks upload targets. Deletion requires recorded upload provenance and
  a current writable share but deletes across all shares; restart or eviction
  from the 1000-entry provenance store requires manual cleanup. Concurrent
  unsharing cannot be made atomic. Legacy DM-name give-up behavior
  is preserved. In legacy and policy conversation listings, directory lookups
  and backscroll, a repeated pagination cursor now fails instead of looping forever,
  unless the requested message or match limit already ended the scan.
- **Hosts and agents:** policy mode replaces the `fetch_attachment` URL argument
  with `channelId`/`fileId`, carries protected attachment ID hints, offers
  `send_dm` only when effective policy permits DM writes, and lists only freshly admitted conversations. `includeNonMember`
  cannot broaden that listing. Named MPIMs use Group DM labels. Leave the policy
  unset to retain the legacy interfaces; see the migration guide before enabling it.

- Cheap activation-specific local vetoes run before policy delivery turns are allocated, retaining denial accounting without queued preparation.
- Policy activation changes list_channels/refresh_channels descriptions and the includeNonMember schema guidance; hosts should refresh cached tool definitions. Startup refusals omit raw policy values to avoid accidental credential disclosure.
