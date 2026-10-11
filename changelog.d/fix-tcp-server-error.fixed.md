- With `--tcp`, the server keeps serving through what it can survive. An
  error the TCP server emits (an accept that fails, say) is logged whenever
  it comes, whether a client is being served or not. A client that leaves
  before `initialize`, or whose serving fails, ends only its own
  connection, and the next client is served. Before, any of these could
  end the process.
- With `--tcp`, a client that connects while another is being served is
  refused at once. Before, it was left connected and never read, holding
  its connection open until the process exited.
- Each Slack message reaches the host once. The server added a message
  forwarder for each client it served and never removed one, so with
  `--tcp` the third client got every message three times.
- A line from the host that isn't JSON is logged, and the connection goes
  on. Before, it ended the process.
