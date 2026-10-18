- `list_channels`, `refresh_channels`, and the listing when a host grants
  `channels.register` ask `conversations.list` only for the conversation types
  the token has a read scope for, as Slack has reported its scopes: `auth.test`
  at startup, then each listing's answer, a refusal's included, though not an
  HTTP error such as a 429, which the client hands on without them. Slack never
  narrows a token's scopes, so an answer naming fewer than known takes none
  away. A token without `mpim:read` used to fail the whole call with
  `missing_scope` when DMs were enabled, since the server asked for `mpim`
  too; it now lists the public, private and DM conversations it can see, and
  a token without `im:read` likewise drops `im`. Nothing changes for a token
  that has all four read scopes. A listing whose answer changes which types
  the token can read starts over with them, as often as they change, so a
  scope granted while the server runs is listed by the listing whose answer
  first reports it. `list_channels` and `refresh_channels` say which kinds a
  listing left out and the scopes they need. A listing that starts with no
  readable type asks `auth.test` for the token's current scopes, and if they
  still read no type, the call fails naming the read scopes. One whose refusal
  reports scopes that read no type fails the same way at once, since those
  are Slack's latest. A listing in the background waits and asks `auth.test`
  again when it's rate-limited or fails in a way that can pass, as it does
  for a page. Each change to the types left out is logged on stderr. Missing
  or blank scope metadata keeps the last known set, and while the scopes are
  unknown, every enabled type is asked for, as before.
