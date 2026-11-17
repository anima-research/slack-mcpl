- `fetch_history` and `fetch_thread` now include reaction names, counts and
  whether Slack's user list includes this bot (ownership is omitted when unknown,
  not reported as false for a truncated list). Invalid entries are skipped and
  invalid counts omitted. Each message lists at most 20 valid reactions and
  reports how many were omitted, within the existing byte limit.
  Messages without reactions and live incoming messages are unchanged; no new
  scope or API call is needed.
- `remove_reaction` removes the bot's own reaction, with the same arguments,
  `slack.messaging` feature set, `reactions:write` scope and write restrictions
  as `add_reaction`. A missing own reaction is a clear error; removing the ACK
  emoji also retires that message's pending ACK cleanup when it is gone.
  Joining an already-running ACK cleanup that confirms removal or `no_reaction`
  returns a successful "Nothing changed" without a second Slack call. Joining
  cleanup that gives up after failure instead makes a fresh removal attempt and
  reports Slack's answer. Manual ACK removal shares the automatic cleanup's
  five-attempt budget and terminal-failure rules.
