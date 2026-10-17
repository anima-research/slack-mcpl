- `list_channels`, `refresh_channels`, and the listing when a host grants
  `channels.register` ask
  `conversations.list` only for the conversation types the token has a read
  scope for, initially reported by `auth.test` and refreshed from each listing
  response. A token without `mpim:read` used to fail the whole call with
  `missing_scope` when DMs were enabled, since the server asked for `mpim`
  too; it now lists the public, private and DM conversations it can see.
  A token without `im:read` likewise drops `im`. Nothing changes for a token
  that has all four read scopes. With no readable enabled type, no listing
  request is sent. One connection diagnostic names omitted types and their
  required scopes. Newly granted scopes are used by the next listing; if no
  type is readable, restart after changing grants so `auth.test` can refresh
  them. Missing scope metadata preserves the last known set; if scopes have
  never been reported, the existing request for all enabled types is retained.
