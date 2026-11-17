- `fetch_history` and `fetch_thread` now include reaction names, counts and
  whether Slack's user list includes this bot (ownership is omitted when unknown,
  not reported as false for a truncated list). Invalid entries are skipped and
  invalid counts omitted. Each message lists at most 20 valid reactions and
  reports how many were omitted, within the existing byte limit.
  Messages without reactions and live incoming messages are unchanged; no new
  scope or API call is needed.
- `remove_reaction` removes the bot's own reaction, with the same arguments,
  `slack.messaging` feature set, `reactions:write` scope and write restrictions
  as `add_reaction`. A missing own reaction succeeds with "Nothing changed:
  message X has no &lt;emoji&gt; reaction from this bot"; removing the ACK emoji
  also retires that message's pending ACK cleanup when it is gone.
  Joining an already-running ACK cleanup that confirms removal or `no_reaction`
  returns a successful "Nothing changed" without a second Slack call. Joining
  cleanup that gives up after failure instead makes a fresh removal attempt and
  reports Slack's answer. Manual ACK removal shares the automatic cleanup's
  five-attempt budget and terminal-failure rules; concurrent joiners wait for the in-flight
  removal, then may each retry serially after transient failures.
- When `SLACK_ACK_REACTION` is set, the read and reaction tool descriptions
  name the automatic ACK emoji and explain its lifecycle. Adding it explicitly
  adopts the reaction on success or `already_reacted`, retiring unsent automatic
  cleanup and retries, not a removal already sent. Failed adds do not adopt.
  This also applies after automatic cleanup has finished. Redelivered events
  cannot recreate cleanup for that message for 10 minutes in this process only,
  not across restarts.
- Preserve an agent's explicit ACK-emoji reaction when a delivery installs
  automatic cleanup while the agent's add is in flight. Confirmed adoption
  now retires that newly pending cleanup as well.
- Automatic ACK retries run outside the triggering tool call's deadline; unsent
  manual refusals do not consume the cleanup retry budget. A concurrent removal
  already sent before adoption may still land, but its failure will not retry.
- Confirmed explicit ACK adoption cancels cleanup still waiting for the
  automatic add, including during shutdown. In-flight removals remain joinable,
  but cannot schedule automatic retries after adoption.
- A new explicit ACK-emoji add reports "Reaction added"; an already-present
  ACK reports "ACK adopted" rather than "Nothing changed". Both adopt the ACK;
  deadline diagnostics include time waiting on background coordination.
- An unsent manual ACK removal preserves the existing automatic expiry or retry deadline.
