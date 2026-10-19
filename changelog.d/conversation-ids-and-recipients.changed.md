- Every incoming message's header now names its conversation as
  `channelId=<id>`, as the tools take it: `[DM (acme) channelId=D123 id=…]`,
  `[channelId=C123 thread=… id=…]`. Headers named a conversation only where it
  changed, and a DM only as "DM", so an agent answering by a tool had to look
  the id up with `list_channels` or recall it.
- `send_message`, `reply_message`, `send_dm` and `upload_file` answer with
  `to`, the conversation the write went to as this server lists it
  (`#support (acme)`, `DM: @Ann (acme)`), so a write to the wrong
  conversation shows in the same turn.
