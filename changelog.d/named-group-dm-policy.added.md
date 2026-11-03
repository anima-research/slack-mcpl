- Prepare dormant explicit access-policy support for exact joined group-DM IDs:
  reads require `mpim:read` and history requires `mpim:history`; writes also
  require a write-channel pin, `mpim:write`, and the operation's write scope.
  New group-DM labels apply only on the policy path. No setting enables this yet;
  existing deployments are unchanged.
