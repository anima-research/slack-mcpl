- Every tool in `tools/list` declares its MCPL RFC-008 class in
  `_meta["mcpl/class"]`: the messaging, history, attachment, user and
  channel-listing tools are `comms`; `refresh_channels` and the subscription
  tools are `control`. Hosts use the class to decide what tool-lifecycle
  observers may see, and never share `comms` arguments. Other `_meta` keys
  are kept, and tool names, descriptions and schemas are unchanged.
