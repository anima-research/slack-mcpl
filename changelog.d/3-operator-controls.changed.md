- `SLACK_SUBSCRIPTIONS_FILE` is written as `{subscribed, muted}` while any
  conversation is muted, and as the plain ID array otherwise (#3). Earlier
  versions read the object form as an empty list, so downgrading after
  muting a conversation loses the persisted subscriptions.
