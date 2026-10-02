- `push/event` origin now carries `mcplChannelId` (`slack:<conversationId>`),
  as zulip-mcp's does (#5). A host could not tell which channel a push came
  from, so a reply or a typing indicator for a conversation it had not opened
  (an unopened channel, a DM) had nowhere to go.
