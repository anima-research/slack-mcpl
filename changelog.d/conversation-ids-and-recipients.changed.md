- Every incoming message's header now names its conversation as
  `channelId=<id>`, as the tools take it: `[DM (acme) channelId=D123 id=…]`,
  `[channelId=C123 thread=… id=…]`. A DM was named only "DM", so an agent
  answering one had to type its id from memory, and one sent an answer to the
  wrong person's DM. The backscroll block carries `channelId="…"` too.
- `send_message`, `reply_message`, `send_dm` and `upload_file` answer with
  `to`, the conversation the write went to as this server lists it
  (`#support (acme)`, `DM: @Ann (acme)`), so a write to the wrong
  conversation shows in the same turn.
