- `channels/typing` is shown as a thread status ("is thinking…") on the thread
  of the message the agent is answering, through `assistant.threads.setStatus`,
  which Slack opened to `chat:write` apps in channels in March 2026. Only in
  conversations the bot may write to; cleared on `op: 'stop'`, when the bot
  posts in that thread, or by Slack after 2 minutes. The messaging feature set
  now declares `channels.typing`.
