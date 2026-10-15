- `list_channels` (and the startup listing behind channel registration) asks
  `conversations.list` only for the conversation types the token has a read
  scope for, as reported by `auth.test`. A token without `mpim:read` used to
  fail the whole call with `missing_scope`, since the server always asked for
  `mpim` too; it now lists the public, private and DM conversations it can see.
  A token without `im:read` likewise drops `im`. Nothing changes for a token
  that has all four read scopes.
