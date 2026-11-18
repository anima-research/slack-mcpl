- Add opt-in `historyMembershipFallbackChannels` for public write pins without
  `channels:read`, using fresh bot history membership proof per operation.
  Operators attest public visibility: modern private channels also have C IDs
  and can pass proof with `groups:history`. Legacy G private IDs, DMs and
  group DMs are excluded; private pins discovered when a listing with
  groups:read reaches their page, or by non-public inbound channel_type markers,
  are excluded from history fallback for the process lifetime. Normal metadata
  decides once channels:read is learned.
  Unset is unchanged. Normal metadata takes precedence once its scope is learned.
  Terminal stale pins are isolated; transient proof failures remain retryable
  and failed proof before a write reports that nothing was posted.
  Channel proofs share conversations.history quota; thread data uses conversations.replies quota. Inbound local policy vetoes and the
  preparation subscription check run before proof. That check waits for earlier
  addressed deliveries, not every earlier ambient delivery; preparations can
  overlap before their ordered delivery turns. Delivery checks subscription
  separately at its ordered turn. Surviving events require proof
  before content delivery;
  do not use on installations limited to one history request per minute.
  Background pin registration retries transient auth scope-refresh failures.
  Exhausted or retired pin proofs are counted as incomplete registration without losing other admitted registrations. Background pin attempts, including retries, share the inbound admission scheduler.
  Uploads cost two proofs: before uploading bytes and before sharing.
- Foreground candidate rate limits retain collected rows with an explicit incomplete notice. Other non-stale proof failures can refuse the entire listing and name
  the required repair. Candidate-local stale/access refusals are isolated and
  other admitted conversations can still be returned. Background candidate-local
  failures, including missing_scope, are skipped and counted. Unresolved pin failures remain counted across type/scope restarts, which do not retry the pin loop; a restarted metadata scan can reconcile a pin by successful admission or definitive denial; foreground
  authentication refusals still fail the listing.
- Explicit policy also changes list_channels/refresh_channels descriptions and includeNonMember schema guidance, subscription tool descriptions and advertised
  feature-set guidance to describe admitted conversations rather than an
  unrestricted workspace inventory. Unset-policy descriptions are unchanged.
- Listing admission uses fresh metadata when the relevant grant is available,
  or a fresh history proof for an eligible attested fallback pin. Final delivery
  uses one bounded recheck before rendering and delivery-visible state; transient
  failures retain original event admission only after rechecking known private-pin vetoes, lasting refusals and current grants. Expiry of the five-second delivery wait drops the event and requests ACK cleanup, even without a veto. Initial-event pacing and diagnostics
  are separate from the final check's small retry budget and per-message logs.
- Background registration skips and counts failed or retired candidates while
  announcing healthy ones. A successful untruncated refresh clears an earlier
  incomplete count even when some conversation types remain unreadable.
- History-proof rate limits extend the shared inbound admission cooldown, just
  like metadata-proof rate limits. Thread data pages use the separate replies
  quota; proofs and channel/backscroll data pages use the history quota.
