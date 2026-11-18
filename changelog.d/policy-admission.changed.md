- Internal preparation only: dormant explicit-policy adapter admission gates have no supported installer or setting at this layer. With a policy installed, status
  refreshes latch lasting Slack metadata refusals until reset and post-transfer
  admission failures identify the allocated unshared file. Completion failures
  can leave sharing uncertain; check whether the file was shared before retrying. Unset-policy responses are unchanged; only policy-mode uncertain `send_dm` post errors name the opened DM and explicitly say the message may have been sent.
- Final policy delivery checks run before rendering or delivery-visible state,
  reuse their metadata for labels, and do not await DM names. They retry rate
  limits at most twice within a two-second wait budget and a five-second delivery wait
  bound (the lookup may finish later). Classified rate-limit, transport and Slack service failures retain the original event admission only without a known lasting refusal or withdrawn grant; other failures, including expired wait bounds, drop the message and request acknowledgement cleanup.
  Optional backscroll failures omit context; known lasting admission refusals veto transient fallback.
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
- Policy access observations retain their Slack request issue order, for positive metadata, refusals and full grant reports. Reconstructing or propagating a known denial is not new evidence; a later-issued successful check can recover without a fourth request.
