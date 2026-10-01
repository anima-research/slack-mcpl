- `channels/outgoing/chunk` and `channels/outgoing/complete` are ignored
  (#1). The server does not declare `channels.streaming`, so a reply is
  posted once, through `channels/publish`; the text of
  `channels/outgoing/complete` is no longer posted as well.
