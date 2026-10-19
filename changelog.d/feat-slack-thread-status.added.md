- `channels/typing` is shown as a thread status ("is thinking…") on the thread
  of the message the agent is answering, through `assistant.threads.setStatus`,
  which Slack opened to `chat:write` apps in channels in March 2026. Only in
  conversations the bot may write to; cleared on `op: 'stop'`, when the bot
  posts in that thread (a stop still clears it, in case Slack hasn't), or by
  Slack after 2 minutes. The messaging feature set
  now declares `channels.typing`.
  The thread it lands on is learned per connection: a new peer starts
  without one, so its typing never shows on a thread from before it connected.
