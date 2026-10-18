- `list_channels`, `refresh_channels`, and the listing when a host grants
  `channels.register` ask `conversations.list` only for the conversation types
  the token has a read scope for, as Slack last reported its scopes: `auth.test`
  at startup, then each listing's answer, a refusal's included. A token without
  `mpim:read` used to fail the whole call with `missing_scope` when DMs were
  enabled, since the server asked for `mpim` too; it now lists the public,
  private and DM conversations it can see, and a token without `im:read`
  likewise drops `im`. Nothing changes for a token that has all four read
  scopes. A listing whose answer changes which types the token can read starts
  over once with them, so a scope granted while the server runs is listed from
  the call that first sees it. `list_channels` and `refresh_channels` say which
  kinds a listing left out and the scopes they need. With no readable type, the
  server asks `auth.test` once for the token's scopes, and if they still read no
  type, the call fails naming the read scopes. Each change to the types left
  out is logged on stderr. Missing or blank scope metadata keeps the last known
  set, and while the scopes are unknown, every enabled type is asked for, as
  before.
