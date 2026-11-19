`main-send-dm.json` records the complete public `tools/call` results from main
`d885b862` for `send_dm({userId: 'U1', content: 'hi'})` with policy unset.
The client opens D1, then rejects the post (or returns no timestamp); the
`open timeout` control rejects before opening. Error constructors and inputs
are specified in `legacySendDm.test.ts`. Capture used the real main adapter,
server and in-memory host harness on Node 22.23.3, not the policy formatter.
The static snapshots intentionally preserve main's wording, including its
pre-open timeout guidance. Policy-mode outcome regressions remain separate.
