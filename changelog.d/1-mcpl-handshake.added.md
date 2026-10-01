- MCPL 0.5 policy handshake (#1): the server answers the host's
  `featureSets/update` Request with a degradation receipt (§6.7) and gates
  channel registration, push events, `channels/publish` and tools on the
  capability grant. Under an MCPL 0.5 host, channels and push events now
  reach the agent; before, only tools worked. Built on
  `@animalabs/mcpl-core` ^0.3.0.
