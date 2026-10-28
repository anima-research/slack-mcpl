- With `--tcp`, the server keeps serving through what it can survive. An
  error the TCP server emits once it's listening (an accept that fails, say)
  is logged whenever it comes, whether a client is being served or not; a
  failure to listen still ends the process. A client that leaves before
  `initialize`, or whose serving fails, ends only its own connection, and
  the next client is served. Before, a server error could end the process,
  and a client leaving before `initialize` did.
- With `--tcp`, a client that connects while another is being served is
  refused at once. Before, it was left connected and never read, holding its
  connection open until the process exited.
- A Slack message is no longer forwarded once for each client served so far.
  The server added a message forwarder for each client it served and never
  removed one, so with `--tcp` the third client got every message three
  times.
- A line from the host that isn't JSON is logged, and the connection goes
  on. Before, it ended the process.
- On stdio, stdout carries only the protocol: `Client initialized` and
  `Client disconnected` go to stderr, as every other log line does. A host
  that closes stdin before `initialize` now ends the process with exit 0, as
  when it closes it later, where it used to log a fatal error and exit 1.
