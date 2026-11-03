- **Operators:** opt in with `SLACK_ACCESS_POLICY`, a complete JSON policy
  naming joined-channel reads, channel write destinations, DM peers and optional
  group DMs. Invalid/incomplete values stop startup, never revert to legacy.
  Explicit policy replaces `SLACK_DISABLE_DMS`, `SLACK_DM_USERS` and
  `SLACK_SEND_CHANNELS`, warning about remaining ignored settings. See
  `docs/access-policy-migration.md`. `find_user` remains workspace-wide with
  `users:read`, outside conversation confinement. Policy file rollback deletion
  needs `files:read`. Policy background admission allows five attempts per
  candidate, with independent retry counters. Legacy DM-name give-up behavior
  is preserved. In legacy and policy conversation listings, directory lookups
  and backscroll, a repeated pagination cursor now fails instead of looping forever.
