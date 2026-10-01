- **Hosts:** in MCPL mode the server now enforces MCPL 0.5 deny-by-default
  (§5.3) (#1). Until the host sends a grant-bearing `featureSets/update`
  Request, it registers no channels, sends no push events, and refuses every
  tool call and privileged method with a capability-denied error. Hosts on
  agent-framework ≥ 0.9.0 complete this handshake and need no change. A host
  that negotiates MCPL but predates 0.5 now gets nothing from this server;
  it has to upgrade. Unchanged: plain MCP clients (no `experimental.mcpl` in
  `initialize`) are not subject to a grant, and their tools work as before.
