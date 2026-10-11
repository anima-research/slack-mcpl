- With `--tcp`, an error the TCP server emits while a client is being served
  (an accept that fails for the next client, say) is logged, and serving
  goes on. Before, mcpl-core 0.3.0's `acceptTcp` left an 'error' listener
  behind for each accepted connection, which swallowed such an error unseen;
  with a release carrying anima-research/mcpl-core-ts#12, which stops that
  leak, nothing would have heard it, and the process would have ended. An
  error while the server waits for a client still ends the process, as
  before.
