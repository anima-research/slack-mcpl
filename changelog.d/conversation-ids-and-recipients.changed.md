- Every incoming message's header now also names its conversation by its id,
  as `channelId=<id>`, the name the tools take it by:
  `[DM (acme) channelId=D123 id=…]`, `[channelId=C123 thread=… id=…]`.
  Headers named a conversation only where it changed, and a DM only as "DM",
  so an agent answering by a tool needed the id from elsewhere, such as
  `list_channels`.
- `send_message`, `reply_message`, `send_dm` and `upload_file` answer with
  `to`, the label the conversation the write went to was registered under
  (`#support (acme)`, `DM: @Ann (acme)`), so a write to the wrong
  conversation shows in the same turn. A conversation without a registered
  label, as with a plain MCP client or a DM first written in after the
  listing, gets no `to`.
