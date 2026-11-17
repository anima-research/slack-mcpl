- Reaction advice now distinguishes new ACK adds from already-present adoption,
  and conditions unknown-outcome cleanup advice on a still-pending automatic ACK.
  A manual removal refused by the effect-time policy check no longer retires
  pending automatic cleanup as though Slack had refused the removal itself.
