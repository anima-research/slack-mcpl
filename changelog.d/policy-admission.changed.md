- Activate explicit-policy adapter admission gates through the opt-in SLACK_ACCESS_POLICY setting. With a policy installed, status
  starts latch lasting Slack refusals and authoritative membership refusals from fresh metadata until reset (a missing grant, including Slack's own `missing_scope`, only until Slack reports a changed grant set; local policy denials are simply checked again), and post-transfer
  admission failures keep their actual cause and identify the allocated unshared file. Completion failures
  can leave sharing uncertain; check whether the file was shared before retrying. Legacy authorization and unset-policy `send_dm` responses are unchanged; bounded pagination is documented separately. only policy-mode uncertain `send_dm` post errors name the opened DM and explicitly say the message may have been sent.
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
- Acknowledged events the adapter drops at or after shutdown (including during admission or name lookup), behind a retired ambient admission slot, or on a failed preparation or handler are each logged with their conversation, timestamp, thread root (from `thread_ts` or `root.thread_ts`) and the read that recovers them, once the step they were in returns: a request or handler still running when the process exits leaves no log. Failed admissions and local policy exclusions are not logged per message: to keep an outage or a busy excluded conversation from flooding stderr, they are counted by reason in a content-free summary flushed at most once a minute and at shutdown. That summary names no conversation, message or thread, so recovering those messages means reading the conversations where traffic was expected. Unsubscribed ambient traffic is dropped without a count.

- Initial policy event admission slots, including fast refusals, are released at
  least 1.2 seconds apart per adapter; event-loop stalls can bunch actual request starts. Final-delivery checks are not paced. Concurrent events share pending evidence;
  a settled admission never authorizes a later event. Ordered observations (the
  last successful check, later lasting refusals and grant withdrawals) are
  consulted only to veto, or keep, a transient-failure delivery fallback. DMs and mentions take priority over waiting ambient admissions. Waiting
  ambient admissions and ambient delivery envelopes each have a 32-entry drop-oldest
  backlog, with a diagnostic on each drop. Addressed delivery stays FIFO; active
  Slack requests and host handlers have no deadline, so this is not a hard
  end-to-end latency bound. Pacing uses a monotonic clock. This does
  not rate-limit foreground effects, other processes, or the Slack SDK's
  internal retries. No production quota measurements were available offline.
- Policy delivery awaits promises returned by embedded message handlers before
  delivering the next event in that conversation. Shutdown prevents starting
  subsequent handlers but cannot cancel an already-running handler.


- Foreground and background policy candidate admission share initial inbound pacing. A foreground `list_channels` or `refresh_channels` scan whose next candidate is rate-limited, or whose next pacing slot or request no longer fits the call's 25-second deadline, returns the rows it admitted with an explicit incomplete notice (with Slack's Retry-After when known) instead of an error. It never waits in the pacer past that deadline, and its candidates are not evicted as ambient backlog. With fast Slack responses and no other traffic, about 13 candidates fit one call. There is no continuation: a new call starts over, so conversations past that point are not reached by calling again, and the notice says to ask whoever runs this host for a missing conversation's ID. When a Slack Retry-After on the shared pacer is what leaves no room, the notice reports the rate limit and its remaining wait instead of the deadline. A conversations.list page that is rate-limited still fails the call. Background admission yields to addressed work; retired or exhausted candidates are skipped and counted as incomplete; healthy candidates continue.
- The final delivery recheck, ACK and optional backscroll checks are separate
  from initial-event pacing. The final recheck has its own small retry and
  five-second delivery wait budget, retaining original admission only on classified rate-limit, transport and Slack service failures without known lasting refusals or grant withdrawals. Other failures drop the event and request ACK cleanup, which can itself be refused.
- Uncertain policy posts choose the history check from the freshly admitted conversation kind (a G ID can be a private channel or a group DM), and say whom to ask when the host does not offer that history tool. A final-admission drop names the thread root and the read that recovers it.
- With `readJoinedChannels: false`, a policy listing requests only the DM and group-DM types, so excluded ordinary channels are neither enumerated nor paced; with no admitted kind enabled it lists nothing without asking Slack.
