- Activate explicit-policy adapter admission gates through the opt-in SLACK_ACCESS_POLICY setting. With a policy installed, status
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

- Initial policy event admission slots, including fast refusals, are released at
  least 1.2 seconds apart per adapter; event-loop stalls can bunch actual request starts. Final-delivery checks are not paced. Concurrent events share pending evidence;
  settled evidence is never reused. DMs and mentions take priority over waiting ambient admissions. Waiting
  ambient admissions and ambient delivery envelopes each have a 32-entry drop-oldest
  backlog, with a diagnostic on each drop. Addressed delivery stays FIFO; active
  Slack requests and host handlers have no deadline, so this is not a hard
  end-to-end latency bound. Pacing uses a monotonic clock. This does
  not rate-limit foreground effects, other processes, or the Slack SDK's
  internal retries. No production quota measurements were available offline.
- Policy delivery awaits promises returned by embedded message handlers before
  delivering the next event in that conversation. Shutdown prevents starting
  subsequent handlers but cannot cancel an already-running handler.


- Foreground and background policy candidate admission share initial inbound pacing; foreground rate limits preserve collected rows with an explicit incomplete notice. Background admission and yields to addressed work; retired or exhausted candidates are skipped and counted as incomplete; healthy candidates continue.
- The final delivery recheck, ACK and optional backscroll checks are separate
  from initial-event pacing. The final recheck has its own small retry and
  five-second delivery wait budget, retaining original admission only on classified rate-limit, transport and Slack service failures without known lasting refusals or grant withdrawals. Other failures drop the event and request ACK cleanup, which can itself be refused.
