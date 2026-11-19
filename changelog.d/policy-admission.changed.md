- Internal preparation only: dormant explicit-policy adapter admission gates have no supported installer or setting at this layer. With a policy installed, status
  starts latch lasting Slack refusals and authoritative membership refusals from fresh metadata until reset (a missing grant, including Slack's own `missing_scope`, only until Slack reports a changed grant set; local policy denials are simply checked again), and post-transfer
  admission failures keep their actual cause and identify the allocated unshared file. Completion failures
  can leave sharing uncertain; check whether the file was shared before retrying. Unset-policy responses are unchanged; only policy-mode uncertain `send_dm` post errors name the opened DM and explicitly say the message may have been sent.
- Final policy delivery checks run before rendering or delivery-visible state,
  reuse their metadata for labels, and do not await DM names. They retry rate
  limits at most twice within a two-second wait budget and a five-second delivery wait
  bound (the lookup may finish later). Classified rate-limit, transport and Slack service failures retain the original event admission only without a known lasting refusal or withdrawn grant; other failures, including expired wait bounds, drop the message and request acknowledgement cleanup.
  Optional backscroll failures omit context; a lasting access refusal from backscroll (including `access_denied` and `restricted_action`) is ordered evidence that vetoes transient fallback unless a later-issued check succeeded. Unrelated refusals such as `invalid_arguments` do not veto.
- With an explicit policy, refused status starts are not owned; a refused refresh retains the prior visible status until reset can clear it; an attempted status clear forgets ownership
  even if Slack refuses or its outcome is uncertain. Failed clear admission retains
  ownership because no clear was attempted.
- With an explicit policy, a background registration skips and counts individual failed candidates,
  reports its incomplete count, and continues announcing healthy conversations.
  Stopped and superseded scans stop at page and candidate boundaries, including successful ones.
- Agent-facing access refusals describe allowed peers, conversation reads and
  write destinations without exposing host policy property names or raw Slack
  metadata flags. Required Slack grant identifiers remain available for escalation.
- When policy `send_dm` opens a DM but exact destination admission refuses the post, the refusal reports the opened DM and that nothing was posted. Pre-open refusals still open nothing.
- Status refusal latches suppress starts and refreshes, not explicit clears; clears still require fresh write admission.
- Policy client failures receive a fresh occurrence for request, admission, context and effect provenance. Reused, frozen or rethrown client errors cannot inherit marks from earlier calls; the reusable source error stays unchanged.
- Policy access observations retain their Slack request issue order, for positive metadata, refusals and full grant reports. A request the client resends after a rate-limit wait is ordered at its resend. Reconstructing or propagating a known denial is not new evidence; a later-issued successful check can recover without a fourth request. Each operation that meets a stored refusal gets its own error carrier, so context and effect marks never cross operations.
- With a policy, a blank or empty scope report is missing evidence, as without one: the last reported grants stay. A `missing_scope` refusal withdraws the grant Slack names.
- Acknowledged events the adapter drops because it is stopping, including those stopped during admission or name lookup, are logged with their conversation, timestamp and thread root when that step returns. At this layer stop does not cut short an admission retry wait, so an event still waiting when the process exits is not logged.
