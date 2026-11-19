- Support exact joined group-DM IDs when explicit access policy is enabled
  (unchanged without a policy):
  reads require `mpim:read` and history requires `mpim:history`; writes also
  require a write-channel pin and the operation's write scope.
  New group-DM labels apply only on the policy path. No setting enables this yet;
  existing deployments are unchanged.
  Listings skip unnamed entries marked as group DMs before metadata lookup and registration guidance
  accounts for named group DMs even when no one-to-one peers are allowed.
  Group-DM admission intersects `SLACK_DISABLE_DMS` on every read and effect;
  the single-peer `SLACK_DM_USERS` filter does not apply to group DMs.
